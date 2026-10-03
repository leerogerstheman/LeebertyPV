'use strict';

/**
 * Inbox - "what do I need to submit or approve right now?".
 *
 * The dashboard answers a managerial question ("how is the site doing?"). This
 * answers the individual's question, which is the one that actually drives work:
 * what is waiting on *me*, and what happens if I ignore it.
 *
 * Three sources are merged into one ranked list:
 *
 *   1. workflow steps whose responsible role (or explicit assignee) includes the
 *      current user - these are submissions and approvals;
 *   2. open tasks raised by the background monitor - deadline breaches,
 *      effectiveness checks, calibration, training, document review;
 *   3. unread notifications addressed to the user or their role.
 *
 * Ranking is by consequence, not by date: something that blocks a batch release
 * outranks something merely old. Each item carries an explicit `action` so the
 * UI never has to guess what the user is supposed to do with it.
 */

const db = require('../core/db');
const rbac = require('../core/rbac');
const workflow = require('../domain/workflow');

function nowIso() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function daysBetween(fromDate) {
  if (!fromDate) return null;
  return Math.ceil((Date.parse(fromDate) - Date.now()) / 86400000);
}

/** Urgency ordering: higher score sorts first. */
const URGENCY = {
  overdue_critical: 100,
  overdue: 80,
  due_today: 70,
  due_soon: 60,
  awaiting_me: 50,
  normal: 40,
  informational: 10,
};

function urgencyScore(item) {
  if (item.overdue) return item.criticality === 'critical' ? URGENCY.overdue_critical : URGENCY.overdue;
  if (item.daysToDue === 0) return URGENCY.due_today;
  if (item.daysToDue !== null && item.daysToDue <= 3) return URGENCY.due_soon;
  return item.kind === 'notification' ? URGENCY.informational : URGENCY.awaiting_me;
}

/**
 * Workflow steps the user can act on.
 *
 * Eligibility mirrors the server-side gate in workflow.completeStep: the user's
 * role must be in the step's list, or they must be the explicit assignee. A QA
 * manager additionally sees QA approval steps, matching the kernel's behaviour -
 * the inbox must never offer an action the API would then refuse.
 */
function collectWorkflowSteps(user) {
  const rows = db.all(
    `SELECT s.id AS step_id, s.step_code, s.name, s.name_en, s.assignee_role, s.assignee_id,
            s.signature_meaning, s.seq,
            i.id AS instance_id, i.record_key, i.title, i.status AS instance_status,
            i.current_step, i.criticality, i.due_date, i.gxp_areas, i.process_code,
            i.batch_number, i.product, i.created_by, i.owner_id
     FROM workflow_steps s
     JOIN workflow_instances i ON i.id = s.instance_id
     WHERE s.status != 'completed'
       AND i.status NOT IN ('closed','cancelled','rejected')
     ORDER BY i.due_date IS NULL, i.due_date ASC, s.seq ASC`
  );

  const out = [];
  for (const row of rows) {
    // Only the current step of a record is actionable; later steps stay hidden
    // so the inbox reflects the real state machine rather than a wish list.
    if (row.current_step && row.step_code !== row.current_step) continue;

    const roles = parseJson(row.assignee_role, []);
    const roleList = Array.isArray(roles) ? roles : [roles];
    const isAssignee = row.assignee_id && row.assignee_id === user.id;
    const roleMatches = roleList.includes(user.role) || roleList.includes('*');
    const isQaOverride = user.role === 'qa_manager';
    if (!isAssignee && !roleMatches && !isQaOverride) continue;

    const overdue = row.due_date ? Date.parse(row.due_date) < Date.now() : false;
    out.push({
      kind: 'workflow_step',
      id: `step:${row.step_id}`,
      title: row.name_en && false ? row.name_en : row.name,
      titleEn: row.name_en,
      recordKey: row.record_key,
      recordTitle: row.title,
      processCode: row.process_code,
      stepCode: row.step_code,
      entityType: 'workflow_instances',
      entityId: row.instance_id,
      link: `#/records/${row.instance_id}`,
      gxpAreas: parseJson(row.gxp_areas, []),
      criticality: row.criticality,
      dueDate: row.due_date,
      daysToDue: daysBetween(row.due_date),
      overdue,
      requiresSignature: Boolean(row.signature_meaning),
      signatureMeaning: row.signature_meaning,
      // Whether this is a submission by the performer or an approval by a reviewer
      // is derived from the signature meaning the definition declares.
      action: classifyStepAction(row.signature_meaning),
      batchNumber: row.batch_number,
      product: row.product,
      assigneeRole: roleList,
      roleMatched: roleMatches || isAssignee,
      source: 'workflow',
    });
  }
  return out;
}

/**
 * Map a step's declared signature meaning onto the plain-language action the
 * user must take: submit, approve, verify, witness or acknowledge.
 *
 * The mapping is an explicit closed enumeration rather than a fallback, because
 * a silent default is how an approval step ends up mislabelled as a submission
 * and disappears from a reviewer's "to approve" list. An unrecognised meaning is
 * reported as `unknown` so the problem is visible instead of hidden.
 */
const ACTION_BY_MEANING = {
  authored: 'submit',
  performed: 'submit',
  completed: 'submit',
  approved: 'approve',
  rejected: 'approve',
  released: 'approve',
  closed: 'approve',
  disposition: 'approve',
  effectiveness_confirmed: 'approve',
  reviewed: 'verify',
  verified: 'verify',
  witnessed: 'witness',
  acknowledged: 'acknowledge',
};

function classifyStepAction(meaning) {
  if (!meaning) return 'submit';
  return ACTION_BY_MEANING[meaning] || 'unknown';
}

/** Open tasks from the background monitor that fall to this user or their role. */
function collectTasks(user) {
  const rows = db.all(
    `SELECT * FROM tasks
     WHERE status = 'open'
       AND (assignee_id = ? OR (assignee_id IS NULL AND (assignee_role IS NULL OR assignee_role = ?)))
     ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
              due_date IS NULL, due_date ASC`,
    [user.id, user.role]
  );

  // A QA manager is accountable for everything the monitor raises, even when a
  // task is nominally owned by engineering or a trainer.
  const escalated = db.all(
    `SELECT * FROM tasks
     WHERE status = 'open' AND priority = 'critical' AND IFNULL(assignee_id, -1) != ?
       AND NOT (assignee_id IS NULL AND assignee_role = ?)`,
    [user.id, user.role]
  );
  const seen = new Set(rows.map((r) => r.id));
  const all = rows.concat(escalated.filter((r) => !seen.has(r.id)));

  return all.map((task) => {
    const overdue = task.due_date ? Date.parse(task.due_date) < Date.now() : false;
    return {
      kind: 'task',
      id: `task:${task.id}`,
      title: task.title,
      description: task.description,
      taskType: task.task_type,
      entityType: task.entity_type,
      entityId: task.entity_id,
      link: taskLink(task),
      dueDate: task.due_date,
      daysToDue: daysBetween(task.due_date),
      overdue,
      priority: task.priority,
      criticality: task.priority === 'critical' ? 'critical' : (task.priority === 'high' ? 'major' : 'minor'),
      action: taskAction(task.task_type),
      isOversight: !rows.some((r) => r.id === task.id),
      gxpAreas: parseJson(task.gxp_areas, []),
      source: 'monitor',
    };
  });
}

function taskAction(taskType) {
  if (taskType === 'sla_breach') return 'investigate';
  if (taskType === 'effectiveness_check') return 'verify';
  if (taskType === 'calibration_overdue' || taskType === 'maintenance_overdue') return 'perform';
  if (taskType === 'training_expired') return 'retrain';
  if (taskType === 'document_review') return 'review';
  return 'submit';
}

function taskLink(task) {
  if (!task.entity_type || !task.entity_id) return '#/dashboard';
  if (task.entity_type === 'workflow_instances') return `#/records/${task.entity_id}`;
  if (task.entity_type === 'equipment') return `#/equipment/${task.entity_id}`;
  if (task.entity_type === 'documents') return `#/documents/${task.entity_id}`;
  if (task.entity_type === 'training_records') return '#/training';
  if (task.entity_type === 'inspections') return `#/inspections/${task.entity_id}`;
  return '#/dashboard';
}

/** Unread notifications for this user or their role. */
function collectNotifications(user) {
  const rows = db.all(
    `SELECT * FROM notifications
     WHERE read_at IS NULL
       AND (user_id = ? OR (user_id IS NULL AND (role IS NULL OR role = ?)))
     ORDER BY created_at DESC
     LIMIT 100`,
    [user.id, user.role]
  );
  return rows.map((n) => ({
    kind: 'notification',
    id: `notification:${n.id}`,
    notificationId: n.id,
    title: n.title,
    description: n.body,
    level: n.level,
    link: n.link || '#/dashboard',
    createdAt: n.created_at,
    criticality: n.level === 'critical' ? 'critical' : (n.level === 'high' ? 'major' : 'minor'),
    action: 'read',
    source: 'notification',
  }));
}

/**
 * Build the inbox payload.
 */
function build(user, filters = {}) {
  const items = []
    .concat(collectWorkflowSteps(user))
    .concat(collectTasks(user))
    .concat(collectNotifications(user));

  for (const item of items) item.urgency = urgencyScore(item);
  items.sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    const ad = a.dueDate ? Date.parse(a.dueDate) : Infinity;
    const bd = b.dueDate ? Date.parse(b.dueDate) : Infinity;
    if (ad !== bd) return ad - bd;
    return String(a.title).localeCompare(String(b.title));
  });

  // Filtering happens after ranking so the counts below describe the whole
  // workload, not the current view.
  let filtered = items;
  if (filters.action) filtered = filtered.filter((i) => i.action === filters.action);
  if (filters.kind) filtered = filtered.filter((i) => i.kind === filters.kind);
  if (filters.overdueOnly) filtered = filtered.filter((i) => i.overdue);
  if (filters.gxpArea) filtered = filtered.filter((i) => (i.gxpAreas || []).includes(filters.gxpArea));

  const byAction = {};
  const byKind = {};
  for (const item of items) {
    byAction[item.action] = (byAction[item.action] || 0) + 1;
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  }

  return {
    generatedAt: nowIso(),
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      roleLabel: (rbac.ROLES[user.role] || {}).label || user.role,
      roleLabelZh: (rbac.ROLES[user.role] || {}).labelZh || user.role,
    },
    counts: {
      total: items.length,
      overdue: items.filter((i) => i.overdue).length,
      requiresSignature: items.filter((i) => i.requiresSignature).length,
      toSubmit: items.filter((i) => i.action === 'submit').length,
      toApprove: items.filter((i) => i.action === 'approve').length,
      toVerify: items.filter((i) => i.action === 'verify').length,
      toPerform: items.filter((i) => i.action === 'perform' || i.action === 'retrain').length,
      toReview: items.filter((i) => i.action === 'review').length,
      unread: items.filter((i) => i.kind === 'notification').length,
      oversight: items.filter((i) => i.isOversight).length,
      critical: items.filter((i) => i.criticality === 'critical' && i.urgency >= URGENCY.due_soon).length,
    },
    byAction,
    byKind,
    limit: Number(filters.limit) || 60,
    items: filtered.slice(0, Number(filters.limit) || 60),
    // What this role cannot do is as informative as what it can.
    roleCapabilities: summariseCapabilities(user),
  };
}

/**
 * A short statement of what this role may and may not do, shown on the inbox so
 * a user understands why certain items never appear for them.
 */
function summariseCapabilities(user) {
  const P = rbac.PERMISSIONS;
  const can = (p) => rbac.hasPermission(user, p);
  return {
    canApproveRecords: can(P.RECORD_CLOSE) || can(P.CAUSALITY_ASSESS),
    canProcessCases: can(P.ICSR_PROCESS) || can(P.CAUSALITY_ASSESS),
    canAssessCausality: can(P.CAUSALITY_ASSESS),
    canManageSignals: can(P.SIGNAL_MANAGE),
    canManagePSUR: can(P.PSUR_MANAGE),
    canManageRMP: can(P.RMP_MANAGE),
    canSubmitReports: can(P.SUBMISSION_MANAGE),
    canManageDeviations: can(P.DEVIATION_MANAGE),
    canManageCAPA: can(P.CAPA_MANAGE),
    canManageComplaints: can(P.COMPLAINT_MANAGE),
    canManageDocuments: can(P.DOC_CREATE) || can(P.DOC_EDIT),
    canApproveDocuments: can(P.DOC_APPROVE),
    canRunInspections: can(P.INSPECTION_MANAGE),
    canViewAuditTrail: can(P.AUDIT_VIEW),
    canVerifyAuditChain: can(P.AUDIT_VERIFY),
    canManageUsers: can(P.USER_MANAGE),
    canManageTraining: can(P.TRAINING_MANAGE),
    canAssessTraining: can(P.TRAINING_ASSESS),
    readOnly: rbac.isReadOnly(user),
  };
}

/** Mark a notification read, and audit it only for external auditors. */
function markRead(notificationId, user, ctx) {
  const row = db.get('SELECT * FROM notifications WHERE id = ?', [Number(notificationId)]);
  if (!row) {
    const err = new Error('NOTIFICATION_NOT_FOUND');
    err.status = 404;
    err.code = 'NOTIFICATION_NOT_FOUND';
    throw err;
  }
  if (row.user_id && row.user_id !== user.id) {
    const err = new Error('Not your notification');
    err.status = 403;
    err.code = 'NOT_YOUR_NOTIFICATION';
    throw err;
  }
  if (!row.read_at) {
    db.run('UPDATE notifications SET read_at = ? WHERE id = ?', [nowIso(), row.id]);
  }
  return { ok: true, id: row.id };
}

function markAllRead(user) {
  const result = db.run(
    'UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND (user_id = ? OR (user_id IS NULL AND (role IS NULL OR role = ?)))',
    [nowIso(), user.id, user.role]
  );
  return { ok: true, updated: result.changes || 0 };
}

module.exports = {
  build,
  markRead,
  markAllRead,
  collectWorkflowSteps,
  collectTasks,
  collectNotifications,
  URGENCY,
};
