'use strict';

/**
 * Background workflow monitor.
 *
 *   node src/daemon/monitor.js                 run continuously (default 5 min cycle)
 *   node src/daemon/monitor.js --once          run a single cycle and exit
 *   node src/daemon/monitor.js --interval 900  cycle every 900 seconds
 *   node src/daemon/monitor.js --verbose       print every action taken
 *
 * WHY A SEPARATE PROCESS
 * ----------------------
 * Everything that "chases" people - due dates, escalations, expiring
 * qualifications, overdue calibrations - was previously computed only when
 * somebody opened a page. That makes the system passive: nothing happens until
 * a human looks. This process closes that gap. It is the difference between a
 * tool you consult and a workflow that runs.
 *
 * AUDIT-TRAIL DISCIPLINE
 * ----------------------
 * A monitor that writes to the audit trail every cycle would drown the ledger in
 * noise and destroy its evidential value, so the rule here is:
 *
 *   audit STATE CHANGES, never scans.
 *
 * A task is created once, escalated once, closed once. Repeated cycles are
 * idempotent. The `notifications.dedupe_key` unique index and the task
 * de-duplication key both make re-running a cycle harmless, which also means the
 * process can be killed and restarted at any time without double-counting.
 *
 * Automated writes are attributed to a `monitor` system actor (actor_id NULL,
 * username 'monitor'), so any auditor can separate machine-generated events from
 * human ones in a single query. The events themselves - a CAPA breaching its
 * target date, an instrument past calibration - are genuine GxP events that
 * *should* be in the ledger.
 *
 * CONCURRENCY
 * -----------
 * The server and this process are separate OS processes sharing one SQLite file
 * in WAL mode, so readers never block writers. Writes are single-statement or
 * wrapped in the shared transaction helper, and `busy_timeout` is set globally,
 * so a cycle overlapping a user action waits rather than failing.
 */

const path = require('node:path');
const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');

// ---------------------------------------------------------------- options ---

function parseArgs(argv) {
  const opts = {
    once: false,
    verbose: false,
    intervalSeconds: Number(process.env.PV_MONITOR_INTERVAL || 300),
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') opts.once = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--interval') opts.intervalSeconds = Number(argv[++i]) || 300;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  // Never hammer the database: a floor of 30 seconds.
  opts.intervalSeconds = Math.max(30, opts.intervalSeconds);
  return opts;
}

const OPTS = parseArgs(process.argv);

function nowIso() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }
function datePlus(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}
function trace(message) { if (OPTS.verbose) log(`  ${message}`); }

/** Every write is attributed to this actor so automated events are separable. */
const SYSTEM_ACTOR = { id: null, username: 'monitor', full_name: '系统监控进程', role: 'system' };
const MONITOR_CTX = { ip: '127.0.0.1', userAgent: 'gxp-monitor', sessionId: null };

/**
 * Per-cycle counters. Reset at the start of every cycle so a returned summary
 * describes *that cycle*, not the lifetime of the process. A caller asking "did
 * this scan create anything?" needs the delta; the running totals below serve
 * the long-running process's shutdown message instead.
 */
const stats = {
  cycles: 0,
  tasksCreated: 0,
  tasksClosed: 0,
  escalated: 0,
  notifications: 0,
  auditEntries: 0,
};

/** Lifetime totals, reported on shutdown so an operator can see the whole run. */
const totals = { tasksCreated: 0, tasksClosed: 0, escalated: 0, notifications: 0, auditEntries: 0 };

function resetCycleStats() {
  stats.tasksCreated = 0;
  stats.tasksClosed = 0;
  stats.escalated = 0;
  stats.notifications = 0;
  stats.auditEntries = 0;
}

function addTotals() {
  totals.tasksCreated += stats.tasksCreated;
  totals.tasksClosed += stats.tasksClosed;
  totals.escalated += stats.escalated;
  totals.notifications += stats.notifications;
  totals.auditEntries += stats.auditEntries;
}

// ------------------------------------------------------------------ helpers --

/**
 * Create a task unless an open one already exists for the same subject.
 * Returns the new task id, or null when it already existed.
 */
function ensureTask({ dedupeKey, title, description, taskType, entityType, entityId, assigneeId, assigneeRole, dueDate, priority, gxpAreas }) {
  const existing = db.get(
    "SELECT id FROM tasks WHERE status = 'open' AND task_type = ? AND IFNULL(entity_type,'') = ? AND IFNULL(entity_id,'') = ?",
    [taskType, entityType || '', entityId != null ? String(entityId) : '']
  );
  if (existing) return null;

  db.run(
    'INSERT INTO tasks (title, description, task_type, entity_type, entity_id, assignee_id, assignee_role, ' +
    'due_date, status, priority, gxp_areas, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [title, description, taskType, entityType || null, entityId != null ? String(entityId) : null,
      assigneeId || null, assigneeRole || null, dueDate || null, 'open', priority || 'normal',
      gxpAreas ? JSON.stringify(gxpAreas) : null, nowIso()]
  );
  const id = db.get('SELECT last_insert_rowid() AS id').id;
  stats.tasksCreated += 1;
  trace(`task created: ${title}`);
  return { id, dedupeKey };
}

/** Record a system event in the audit trail. One call per genuine event. */
function auditEvent({ action, entityType, entityId, recordKey, reason, oldValue, newValue, severity, meta, gxpAreas }) {
  audit.append({
    action,
    entityType,
    entityId: entityId != null ? String(entityId) : null,
    recordKey: recordKey || null,
    actor: SYSTEM_ACTOR,
    reason,
    oldValue,
    newValue,
    meta,
    ctx: MONITOR_CTX,
    severity: severity || 'info',
    gxpAreas,
  });
  stats.auditEntries += 1;
}

/**
 * Deliver a notification. `dedupeKey` makes this idempotent: the unique index on
 * notifications.dedupe_key means a re-run of the same cycle inserts nothing.
 * Returns true when a new notification was actually stored.
 */
function notify({ dedupeKey, userId, role, title, body, level, link }) {
  if (dedupeKey) {
    const existing = db.get('SELECT id FROM notifications WHERE dedupe_key = ?', [dedupeKey]);
    if (existing) return false;
  }
  try {
    db.run(
      'INSERT INTO notifications (user_id, role, title, body, level, link, created_at, dedupe_key) VALUES (?,?,?,?,?,?,?,?)',
      [userId || null, role || null, title, body || null, level || 'info', link || null, nowIso(), dedupeKey || null]
    );
    stats.notifications += 1;
    trace(`notification: ${title}`);
    return true;
  } catch (err) {
    // A unique-constraint collision means another instance already sent it.
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

// -------------------------------------------------------------- scan rules ---

/**
 * Rule 1 - workflow deadlines.
 *
 * Two distinct conditions, deliberately separated because they mean different
 * things to a QA manager:
 *   - the RECORD is past its due date (the process as a whole is late)
 *   - the STEP is past its due date (a specific person has not acted)
 */
function scanWorkflowDeadlines() {
  const todayStr = today();

  // 1a. Records past their target completion date.
  const lateRecords = db.all(
    `SELECT id, record_key, process_code, title, owner_id, qa_owner_id, due_date, criticality,
            gxp_areas, current_step,
            CAST(julianday('now') - julianday(due_date) AS INTEGER) AS days_late
     FROM workflow_instances
     WHERE status NOT IN ('closed','cancelled','rejected')
       AND due_date IS NOT NULL AND due_date < ?
     ORDER BY due_date ASC`,
    [todayStr]
  );

  for (const rec of lateRecords) {
    const priority = rec.criticality === 'critical' ? 'critical' : (rec.days_late > 30 ? 'high' : 'normal');
    const created = ensureTask({
      taskType: 'sla_breach',
      entityType: 'workflow_instances',
      entityId: rec.id,
      title: `[超期 ${rec.days_late} 天] ${rec.record_key} ${rec.title}`,
      description: `${rec.process_code} 记录已超过目标完成日期 ${rec.due_date}，当前步骤：${rec.current_step || '—'}。`
        + `请调查延误原因并推进关闭（ICH Q10 / 21 CFR 211.192 对及时性的要求）。`,
      assigneeId: rec.owner_id,
      assigneeRole: 'qa_specialist',
      dueDate: datePlus(3),
      priority,
      gxpAreas: JSON.parse(rec.gxp_areas || '[]'),
    });

    if (created) {
      auditEvent({
        action: 'deadline_breach',
        entityType: 'workflow_instances',
        entityId: rec.id,
        recordKey: rec.record_key,
        reason: `Target completion date ${rec.due_date} passed (${rec.days_late} day(s) late); deadline task raised`,
        newValue: { due_date: rec.due_date, days_late: rec.days_late, current_step: rec.current_step, priority },
        severity: rec.criticality === 'critical' ? 'critical' : 'warning',
        meta: { rule: 'workflow_record_overdue', monitor: true },
        gxpAreas: JSON.parse(rec.gxp_areas || '[]'),
      });
      notify({
        dedupeKey: `record_overdue:${rec.id}`,
        role: 'qa_manager',
        title: `质量记录超期：${rec.record_key}`,
        body: `${rec.title}（超期 ${rec.days_late} 天，当前步骤 ${rec.current_step || '—'}）`,
        level: rec.criticality === 'critical' ? 'critical' : 'high',
        link: `#/records/${rec.id}`,
      });
      // The record owner is told directly as well.
      if (rec.owner_id) {
        notify({
          dedupeKey: `record_overdue_owner:${rec.id}`,
          userId: rec.owner_id,
          title: `你负责的记录已超期：${rec.record_key}`,
          body: `目标完成日期 ${rec.due_date} 已过，请推进处理。`,
          level: 'high',
          link: `#/records/${rec.id}`,
        });
      }
    }

    // 1b. Escalate a record that is badly late and still sitting on the same step.
    if (rec.days_late > 30) {
      const escalKey = `escalate_record:${rec.id}`;
      const already = db.get("SELECT value FROM app_settings WHERE key = ?", [escalKey]);
      if (!already) {
        db.run(
          'INSERT INTO app_settings (key, value, scope, updated_at) VALUES (?,?,?,?)',
          [escalKey, JSON.stringify({ at: nowIso(), daysLate: rec.days_late, step: rec.current_step }), 'monitor', nowIso()]
        );
        db.run("UPDATE tasks SET priority = 'critical' WHERE status = 'open' AND task_type = 'sla_breach' AND entity_id = ?", [String(rec.id)]);
        auditEvent({
          action: 'escalation',
          entityType: 'workflow_instances',
          entityId: rec.id,
          recordKey: rec.record_key,
          reason: `Escalated: record is ${rec.days_late} days past its target date and remains at step "${rec.current_step}"`,
          newValue: { escalated_at: nowIso(), days_late: rec.days_late, priority: 'critical', notified_role: 'qa_manager' },
          severity: 'critical',
          meta: { rule: 'overdue_escalation_30d', monitor: true },
          gxpAreas: JSON.parse(rec.gxp_areas || '[]'),
        });
        notify({
          dedupeKey: escalKey,
          role: 'qa_manager',
          title: `升级：${rec.record_key} 已超期 ${rec.days_late} 天`,
          body: '该记录长期未推进，需要管理评审介入。',
          level: 'critical',
          link: `#/records/${rec.id}`,
        });
        stats.escalated += 1;
      }
    }
  }
  return lateRecords.length;
}

/**
 * Rule 2 - CAPA effectiveness checks.
 *
 * ICH Q10 §3.2.2 requires effectiveness to be evaluated. A CAPA that closed
 * without that evaluation is a finding waiting to happen, so it gets its own
 * rule rather than being folded into the generic deadline rule.
 */
function scanEffectivenessChecks() {
  const due = db.all(
    `SELECT w.id, w.record_key, w.title, w.owner_id, w.effectiveness_check,
            w.gxp_areas, w.status, w.closed_at
     FROM workflow_instances w
     WHERE w.process_code IN (SELECT code FROM process_types WHERE requires_effectiveness_check = 1)
       AND (w.effectiveness_result IS NULL OR w.effectiveness_result = '')
       AND w.status NOT IN ('cancelled','rejected')
       AND w.criticality IS NOT NULL
     ORDER BY w.due_date ASC`
  );

  for (const rec of due) {
    const created = ensureTask({
      taskType: 'effectiveness_check',
      entityType: 'workflow_instances',
      entityId: rec.id,
      title: `待完成有效性检查：${rec.record_key}`,
      description: `${rec.title}。ICH Q10 §3.2.2 要求评估 CAPA 的有效性；未完成有效性检查的 CAPA 不得视为已关闭。`
        + (rec.effectiveness_check ? `计划方法：${rec.effectiveness_check}` : ''),
      assigneeId: rec.owner_id,
      assigneeRole: 'qa_specialist',
      dueDate: datePlus(14),
      priority: 'high',
      gxpAreas: JSON.parse(rec.gxp_areas || '[]'),
    });
    if (created) {
      auditEvent({
        action: 'effectiveness_check_due',
        entityType: 'workflow_instances',
        entityId: rec.id,
        recordKey: rec.record_key,
        reason: 'CAPA has no recorded effectiveness result; task raised (ICH Q10 §3.2.2)',
        severity: 'warning',
        meta: { rule: 'effectiveness_pending', monitor: true },
        gxpAreas: JSON.parse(rec.gxp_areas || '[]'),
      });
      notify({
        dedupeKey: `effectiveness:${rec.id}`,
        role: 'qa_manager',
        title: `CAPA 缺少有效性检查：${rec.record_key}`,
        body: rec.title,
        level: 'high',
        link: `#/records/${rec.id}`,
      });
    }
  }
  return due.length;
}

/**
 * Rule 3 - equipment calibration and maintenance.
 * 21 CFR 211.160(b)(4): data from an uncalibrated instrument is not reliable.
 */
function scanEquipment() {
  const equipment = require('../domain/equipment');
  const report = equipment.calibrationDueReport();
  let raised = 0;

  for (const item of report.overdue) {
    const created = ensureTask({
      taskType: 'calibration_overdue',
      entityType: 'equipment',
      entityId: item.id,
      title: `校准超期：${item.assetNo} ${item.name}`,
      description: `下次校准日期 ${item.nextCalibrationDate} 已过。`
        + '该校准周期内产生的数据可靠性需要评估（21 CFR 211.160(b)(4)），必要时提升为偏差记录。',
      assigneeRole: 'qa_specialist',
      dueDate: datePlus(3),
      priority: 'critical',
      gxpAreas: item.gxpAreas,
    });
    raised += 1;
    if (created) {
      auditEvent({
        action: 'calibration_overdue',
        entityType: 'equipment',
        entityId: item.id,
        recordKey: `equipment:${item.id}`,
        reason: `Calibration overdue since ${item.nextCalibrationDate}`,
        severity: 'critical',
        meta: { rule: 'calibration_overdue', monitor: true, assetNo: item.assetNo },
        gxpAreas: item.gxpAreas,
      });
      notify({
        dedupeKey: `calibration_overdue:${item.id}`,
        role: 'qa_manager',
        title: `仪器校准超期：${item.assetNo}`,
        body: `${item.name} 校准已于 ${item.nextCalibrationDate} 到期。`,
        level: 'critical',
        link: `#/equipment/${item.id}`,
      });
    }
  }

  const soon = db.all(
    "SELECT id, asset_no, name, next_calibration_date, gxp_areas FROM equipment " +
    "WHERE status = 'in_service' AND calibration_required = 1 AND next_calibration_date IS NOT NULL " +
    'AND next_calibration_date >= ? AND next_calibration_date <= ?',
    [today(), datePlus(config.reminder.calibrationWarningDays)]
  );
  for (const item of soon) {
    notify({
      dedupeKey: `calibration_soon:${item.id}:${item.next_calibration_date}`,
      role: 'qa_specialist',
      title: `校准即将到期：${item.asset_no}`,
      body: `${item.name} 校准将于 ${item.next_calibration_date} 到期。`,
      level: 'normal',
      link: `#/equipment/${item.id}`,
    });
  }

  const maint = db.all(
    "SELECT id, asset_no, name, next_maintenance_date FROM equipment " +
    "WHERE status = 'in_service' AND next_maintenance_date IS NOT NULL AND next_maintenance_date < ?",
    [today()]
  );
  for (const item of maint) {
    const created = ensureTask({
      taskType: 'maintenance_overdue',
      entityType: 'equipment',
      entityId: item.id,
      title: `预防性维护超期：${item.asset_no} ${item.name}`,
      description: `计划维护日期 ${item.next_maintenance_date} 已过。延期维护需经评估与批准并留存记录。`,
      assigneeRole: 'qa_specialist',
      dueDate: datePlus(7),
      priority: 'high',
    });
    if (created) {
      auditEvent({
        action: 'maintenance_overdue',
        entityType: 'equipment',
        entityId: item.id,
        recordKey: `equipment:${item.id}`,
        reason: `Preventive maintenance overdue since ${item.next_maintenance_date}`,
        severity: 'warning',
        meta: { rule: 'maintenance_overdue', monitor: true },
      });
    }
  }

  return report.overdue.length;
}

/**
 * Rule 4 - training and qualification.
 * EU GMP Chapter 2.10-2.14: personnel must remain qualified for the tasks they
 * perform. An expired GxP-critical qualification is a release blocker.
 */
function scanTraining() {
  const training = require('../domain/training');
  const report = training.complianceReport();
  let raised = 0;

  for (const item of report.expired) {
    const created = ensureTask({
      taskType: 'training_expired',
      entityType: 'training_records',
      entityId: item.recordId,
      title: `培训过期：${item.userName} — ${item.curriculumCode}`,
      description: `${item.curriculumTitle} 已于 ${item.expiresAt} 过期。`
        + (item.gxpCritical ? '该课程为 GxP 关键课程，在完成再培训前该人员不具备相应操作的资质（EU GMP Ch.2.10-2.14）。' : ''),
      assigneeRole: 'trainer',
      dueDate: datePlus(item.gxpCritical ? 7 : 21),
      priority: item.gxpCritical ? 'critical' : 'normal',
    });
    raised += 1;
    if (created) {
      auditEvent({
        action: 'training_expired',
        entityType: 'training_records',
        entityId: item.recordId,
        recordKey: `training:${item.recordId}`,
        reason: `${item.curriculumCode} expired on ${item.expiresAt}${item.gxpCritical ? ' (GxP-critical)' : ''}`,
        severity: item.gxpCritical ? 'critical' : 'warning',
        meta: { rule: 'training_expired', monitor: true, user: item.userName },
      });
      notify({
        dedupeKey: `training_expired:${item.recordId}`,
        role: 'qa_manager',
        title: `培训过期：${item.userName} — ${item.curriculumCode}`,
        body: `已于 ${item.expiresAt} 过期${item.gxpCritical ? '（GxP 关键课程）' : ''}。`,
        level: item.gxpCritical ? 'critical' : 'high',
        link: '#/training',
      });
    }
  }

  // Overdue assignments: the person is chased directly.
  for (const item of report.overdue) {
    const rec = db.get(
      'SELECT tr.user_id FROM training_records tr WHERE tr.id = ?',
      [item.recordId]
    );
    notify({
      dedupeKey: `training_overdue:${item.recordId}`,
      userId: rec ? rec.user_id : null,
      role: rec ? null : 'trainer',
      title: `培训任务已超期：${item.curriculumCode}`,
      body: `${item.curriculumTitle}，原定完成日期 ${item.dueDate}。`,
      level: 'high',
      link: '#/training',
    });
  }

  return raised;
}

/**
 * Rule 5 - document periodic review.
 * EU GMP Chapter 4: documents must be kept current. An SOP past its review date
 * is a common inspection finding.
 */
function scanDocuments() {
  const report = require('../domain/documents').reviewDueReport();
  let raised = 0;

  for (const doc of report.overdue) {
    const created = ensureTask({
      taskType: 'document_review',
      entityType: 'documents',
      entityId: doc.id,
      title: `文件审核超期：${doc.docNumber}`,
      description: `${doc.title} 的定期审核日期 ${doc.nextReviewDate} 已过（EU GMP 第四章要求文件保持现行有效）。`
        + '请评估内容是否仍然适用，并启动修订或确认沿用。',
      assigneeId: doc.ownerId || null,
      assigneeRole: 'qa_specialist',
      dueDate: datePlus(14),
      priority: 'high',
    });
    raised += 1;
    if (created) {
      auditEvent({
        action: 'document_review_overdue',
        entityType: 'documents',
        entityId: doc.id,
        recordKey: `doc:${doc.docNumber}`,
        reason: `Periodic review date ${doc.nextReviewDate} passed`,
        severity: 'warning',
        meta: { rule: 'document_review_overdue', monitor: true },
      });
      notify({
        dedupeKey: `document_review:${doc.id}`,
        role: 'qa_manager',
        title: `文件审核超期：${doc.docNumber}`,
        body: `${doc.title}（应于 ${doc.nextReviewDate} 完成审核）`,
        level: 'high',
        link: `#/documents/${doc.id}`,
      });
    }
  }
  return raised;
}

/**
 * Rule 6 - housekeeping: close tasks whose underlying condition has gone away.
 *
 * Without this the task list only ever grows, and within a month it is noise
 * that people stop reading. Closing is audited like any other state change.
 */
function closeResolvedTasks() {
  const open = db.all("SELECT * FROM tasks WHERE status = 'open'");
  let closed = 0;

  for (const task of open) {
    let resolved = false;
    let why = null;

    if (task.entity_type === 'workflow_instances' && task.task_type === 'sla_breach') {
      const rec = db.get('SELECT status, due_date, closed_at FROM workflow_instances WHERE id = ?', [Number(task.entity_id)]);
      if (!rec) { resolved = true; why = 'record no longer exists'; }
      else if (['closed', 'cancelled', 'rejected'].includes(rec.status)) { resolved = true; why = `record is ${rec.status}`; }
      else if (rec.due_date && rec.due_date >= today()) { resolved = true; why = `target date moved to ${rec.due_date}`; }
    } else if (task.entity_type === 'workflow_instances' && task.task_type === 'effectiveness_check') {
      const rec = db.get('SELECT effectiveness_result, status FROM workflow_instances WHERE id = ?', [Number(task.entity_id)]);
      if (!rec) { resolved = true; why = 'record no longer exists'; }
      else if (rec.effectiveness_result) { resolved = true; why = `effectiveness result recorded: ${rec.effectiveness_result}`; }
      else if (['cancelled', 'rejected'].includes(rec.status)) { resolved = true; why = `record is ${rec.status}`; }
    } else if (task.entity_type === 'equipment' && task.task_type === 'calibration_overdue') {
      const eq = db.get('SELECT next_calibration_date, status FROM equipment WHERE id = ?', [Number(task.entity_id)]);
      if (!eq) { resolved = true; why = 'equipment no longer exists'; }
      else if (eq.next_calibration_date && eq.next_calibration_date >= today()) { resolved = true; why = `calibration now valid until ${eq.next_calibration_date}`; }
    } else if (task.entity_type === 'equipment' && task.task_type === 'maintenance_overdue') {
      const eq = db.get('SELECT next_maintenance_date FROM equipment WHERE id = ?', [Number(task.entity_id)]);
      if (!eq) { resolved = true; why = 'equipment no longer exists'; }
      else if (eq.next_maintenance_date && eq.next_maintenance_date >= today()) { resolved = true; why = `maintenance now scheduled for ${eq.next_maintenance_date}`; }
    } else if (task.entity_type === 'training_records' && task.task_type === 'training_expired') {
      const tr = db.get('SELECT status, expires_at FROM training_records WHERE id = ?', [Number(task.entity_id)]);
      if (!tr) { resolved = true; why = 'training record no longer exists'; }
      else if (tr.expires_at && tr.expires_at >= today()) { resolved = true; why = `retraining completed, valid until ${tr.expires_at}`; }
    } else if (task.entity_type === 'documents' && task.task_type === 'document_review') {
      const doc = db.get('SELECT next_review_date, status FROM documents WHERE id = ?', [Number(task.entity_id)]);
      if (!doc) { resolved = true; why = 'document no longer exists'; }
      else if (doc.next_review_date && doc.next_review_date >= today()) { resolved = true; why = `next review set to ${doc.next_review_date}`; }
      else if (['obsolete', 'retired'].includes(doc.status)) { resolved = true; why = `document is ${doc.status}`; }
    }

    if (resolved) {
      db.run("UPDATE tasks SET status = 'auto_closed', completed_at = ? WHERE id = ?", [nowIso(), task.id]);
      auditEvent({
        action: 'task_auto_closed',
        entityType: 'tasks',
        entityId: task.id,
        reason: `Condition resolved: ${why}`,
        oldValue: { status: 'open' },
        newValue: { status: 'auto_closed', resolved_because: why },
        meta: { rule: 'task_reconciliation', monitor: true, task_type: task.task_type },
      });
      closed += 1;
      stats.tasksClosed += 1;
      trace(`task ${task.id} auto-closed: ${why}`);
    }
  }
  return closed;
}

/**
 * Rule 7 - stale notifications.
 * Anything read and older than 90 days is pruned so the list stays meaningful.
 * Unread items are never deleted.
 */
function pruneNotifications() {
  const before = db.get("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NOT NULL AND created_at < ?",
    [new Date(Date.now() - 90 * 86400000).toISOString()]).n;
  if (before > 0) {
    db.run("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?",
      [new Date(Date.now() - 90 * 86400000).toISOString()]);
  }
  return before;
}

// ---------------------------------------------------------------- the cycle --

function runCycle() {
  stats.cycles += 1;
  resetCycleStats();
  const started = Date.now();

  const counts = {
    lateRecords: scanWorkflowDeadlines(),
    effectiveness: scanEffectivenessChecks(),
    equipment: scanEquipment(),
    training: scanTraining(),
    documents: scanDocuments(),
  };
  const closed = closeResolvedTasks();
  const pruned = pruneNotifications();

  const elapsed = Date.now() - started;
  addTotals();
  const summary = {
    cycle: stats.cycles,
    at: nowIso(),
    elapsedMs: elapsed,
    conditions: counts,
    tasksCreated: stats.tasksCreated,
    tasksAutoClosed: closed,
    escalated: stats.escalated,
    notifications: stats.notifications,
    auditEntries: stats.auditEntries,
    prunedNotifications: pruned,
    totals: { ...totals },
  };

  log(`cycle ${stats.cycles}: overdue records=${counts.lateRecords} effectiveness=${counts.effectiveness} `
    + `equipment=${counts.equipment} training=${counts.training} documents=${counts.documents} `
    + `| tasks +${stats.tasksCreated} closed ${closed} escalated ${stats.escalated} `
    + `| notifications ${stats.notifications} | ${elapsed} ms`);

  return summary;
}

// ------------------------------------------------------------------- main ---

function main() {
  if (OPTS.help) {
    process.stdout.write([
      '',
      '  LeebertyPV - background workflow monitor',
      '',
      '  Usage:',
      '    node src/daemon/monitor.js                   run continuously (5 min cycle)',
      '    node src/daemon/monitor.js --once            single cycle, then exit',
      '    node src/daemon/monitor.js --interval 900    cycle every 900 s (min 30)',
      '    node src/daemon/monitor.js --verbose         print every action taken',
      '',
      '  What it does each cycle:',
      '    1. workflow records past their target date  -> deadline task + escalation',
      '    2. CAPAs without an effectiveness result     -> task (ICH Q10 §3.2.2)',
      '    3. equipment calibration / maintenance due   -> task + notification',
      '    4. expired GxP training, overdue assignments -> task + notification',
      '    5. documents past periodic review            -> task + notification',
      '    6. tasks whose condition is resolved         -> auto-closed (audited)',
      '    7. read notifications older than 90 days     -> pruned',
      '',
      '  Every state change is written to the audit trail under the "monitor"',
      '  system actor so automated events remain separable from human ones.',
      '',
      '  Environment:',
      '    PV_DATA_DIR            data directory (shared with the server)',
      '    PV_MONITOR_INTERVAL    cycle seconds (default 300)',
      '',
    ].join('\n'));
    process.exit(0);
  }

  db.open();

  // Report the audit chain state at start-up: a monitor must not run on a
  // ledger that no longer verifies, because its own writes would be unprovable.
  const chain = audit.verifyChain();
  if (!chain.ok) {
    process.stderr.write('\n  *** AUDIT TRAIL INTEGRITY FAILURE ***\n');
    process.stderr.write(`  ${chain.reason}\n`);
    process.stderr.write(`  Sequence: ${chain.brokenAt}\n`);
    process.stderr.write('  The monitor will not run against a broken ledger.\n\n');
    process.exit(2);
  }

  process.stdout.write('\n  LeebertyPV - workflow monitor\n');
  process.stdout.write(`  ${'='.repeat(58)}\n`);
  process.stdout.write(`  Database      ${config.dbFile}\n`);
  process.stdout.write(`  Interval      ${OPTS.once ? 'single cycle' : `${OPTS.intervalSeconds} s`}\n`);
  process.stdout.write(`  Audit trail   verified (${chain.checked} entries)\n`);
  process.stdout.write(`  Actor         ${SYSTEM_ACTOR.username} (automated events are labelled)\n\n`);

  if (OPTS.once) {
    runCycle();
    process.stdout.write(`\n  Done: ${stats.tasksCreated} task(s) created, ${stats.tasksClosed} auto-closed, `
      + `${stats.escalated} escalated, ${stats.notifications} notification(s), ${stats.auditEntries} audit entr(ies).\n\n`);
    db.close();
    process.exit(0);
  }

  runCycle();

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n  ${signal} received; monitor stopping.\n`);
    process.stdout.write(`  Cycles: ${stats.cycles - 1}  `
      + `tasks created: ${totals.tasksCreated}  auto-closed: ${totals.tasksClosed}  `
      + `escalations: ${totals.escalated}  notifications: ${totals.notifications}  `
      + `audit entries: ${totals.auditEntries}\n`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const timer = setInterval(() => {
    try {
      runCycle();
    } catch (err) {
      // A failed cycle must never kill the monitor; log and try again next time.
      process.stderr.write(`[${new Date().toISOString()}] cycle failed: ${err.message}\n`);
    }
  }, OPTS.intervalSeconds * 1000);
  timer.unref?.();
  // Keep the process alive deliberately (the timer is unref'd so errors are visible).
  process.stdin.resume();
}

if (require.main === module) {
  main();
}

module.exports = { runCycle, scanWorkflowDeadlines, closeResolvedTasks, stats, totals };
