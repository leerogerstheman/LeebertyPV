'use strict';

/**
 * Verification for the background workflow monitor.
 *
 *   node test/monitor.js
 *
 * Runs entirely against a scratch database file so it can never touch a live
 * instance. It checks three things that matter:
 *
 *   1. Idempotency - a second cycle must not duplicate tasks, notifications or
 *      audit entries. The monitor runs unattended on a timer, so a rule that
 *      fires repeatedly would flood the ledger and the task list.
 *   2. Reconciliation - when the underlying condition is fixed, the task is
 *      closed automatically and that closure is audited.
 *   3. Attribution - every automated write is attributable to the `monitor`
 *      system actor, so machine events stay separable from human ones.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRATCH_DB = path.join(os.tmpdir(), `pv-monitor-${Date.now()}.sqlite`);
process.env.PV_DB_FILE = SCRATCH_DB;
process.env.PV_DATA_DIR = path.dirname(SCRATCH_DB);

const db = require('../src/core/db');
const audit = require('../src/core/audit');
const seed = require('../src/seed');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
}

function count(table, where) {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`;
  return db.get(sql).n;
}

function main() {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(SCRATCH_DB + suffix, { force: true });
  }

  db.open();
  seed.run({ silent: true });

  // The monitor is required *after* the paths are set so it picks up the scratch DB.
  const monitor = require('../src/daemon/monitor');

  // ---------------------------------------------------------------- empty DB --
  let summary = monitor.runCycle();
  check('a cycle on an empty database completes without error',
    summary && typeof summary.elapsedMs === 'number', `elapsed=${summary.elapsedMs}ms`);
  check('an empty database produces no tasks',
    count('tasks') === 0, `tasks=${count('tasks')}`);
  check('an empty database produces no audit entries',
    count('audit_trail') === 0, `entries=${count('audit_trail')}`);
  check('scanning an empty database is fast',
    summary.elapsedMs < 2000, `${summary.elapsedMs}ms`);

  // ------------------------------------------------------- seed demo content --
  // Build the conditions the monitor is supposed to detect, directly, so the
  // test does not depend on the demo generator staying unchanged.
  const at = new Date().toISOString();
  db.run(
    'INSERT INTO users (username, full_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['mtest', 'Monitor Test', 'qa_manager', 'active', at, at]
  );
  const ownerId = db.get('SELECT last_insert_rowid() AS id').id;

  const procType = db.get('SELECT code FROM process_types WHERE requires_effectiveness_check = 1 LIMIT 1').code;

  // (a) an open record past its due date
  db.run(
    'INSERT INTO workflow_instances (record_key, process_code, title, status, current_step, gxp_areas, ' +
    'criticality, owner_id, due_date, record_version, created_at, updated_at, data_json) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ['TEST-LATE-1', procType, 'Overdue test record', 'in_assessment', 'investigation',
      '["GVP"]', 'major', ownerId, new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
      1, at, at, '{}']
  );
  const lateRecordId = db.get('SELECT last_insert_rowid() AS id').id;

  // (b) a CAPA with no effectiveness result
  db.run(
    'INSERT INTO workflow_instances (record_key, process_code, title, status, current_step, gxp_areas, ' +
    'criticality, owner_id, due_date, record_version, created_at, updated_at, data_json) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ['TEST-CAPA-1', procType, 'CAPA without effectiveness', 'in_implementation', 'implementation',
      '["GVP"]', 'major', ownerId, new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
      1, at, at, '{}']
  );

  // (c) an instrument past calibration
  db.run(
    'INSERT INTO equipment (asset_no, name, department, gxp_areas, criticality, status, ' +
    'calibration_required, calibration_interval_days, next_calibration_date, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['TEST-EQ-1', 'Overdue instrument', 'QC', '["GVP"]', 'critical', 'in_service', 1, 365,
      new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), at, at]
  );

  // (d) an effective document past its periodic review
  db.run(
    'INSERT INTO documents (doc_number, title, doc_type, gxp_areas, status, review_period_months, ' +
    'next_review_date, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['TEST-DOC-1', 'Overdue SOP', 'sop', '["GVP"]', 'effective', 24,
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), ownerId, at, at]
  );

  // ------------------------------------------------------------- first cycle --
  const auditBefore = count('audit_trail');
  summary = monitor.runCycle();

  const tasksAfterFirst = count('tasks');
  check('the first cycle creates tasks for the seeded conditions',
    tasksAfterFirst >= 4, `tasks=${tasksAfterFirst}`);
  check('the overdue record produced a deadline task',
    count('tasks', "task_type = 'sla_breach'") >= 1,
    `sla_breach=${count('tasks', "task_type = 'sla_breach'")}`);
  check('the CAPA without effectiveness produced a task',
    count('tasks', "task_type = 'effectiveness_check'") >= 1,
    `effectiveness=${count('tasks', "task_type = 'effectiveness_check'")}`);
  check('the uncalibrated instrument produced a task',
    count('tasks', "task_type = 'calibration_overdue'") >= 1,
    `calibration=${count('tasks', "task_type = 'calibration_overdue'")}`);
  check('the document past review produced a task',
    count('tasks', "task_type = 'document_review'") >= 1,
    `document_review=${count('tasks', "task_type = 'document_review'")}`);
  check('the first cycle writes audit entries',
    count('audit_trail') > auditBefore, `entries=${count('audit_trail')}`);

  // ------------------------------------------------------------ idempotency --
  const tasksSnapshot = count('tasks');
  const notifSnapshot = count('notifications');
  const auditSnapshot = count('audit_trail');
  const summary2 = monitor.runCycle();

  check('IDEMPOTENCY: a second cycle creates no duplicate tasks',
    count('tasks') === tasksSnapshot, `before=${tasksSnapshot} after=${count('tasks')}`);
  check('IDEMPOTENCY: a second cycle creates no duplicate notifications',
    count('notifications') === notifSnapshot, `before=${notifSnapshot} after=${count('notifications')}`);
  check('IDEMPOTENCY: a second cycle writes no additional audit entries',
    count('audit_trail') === auditSnapshot, `before=${auditSnapshot} after=${count('audit_trail')}`);
  check('the second cycle reports zero new work',
    summary2.tasksCreated === 0 && summary2.notifications === 0 && summary2.auditEntries === 0,
    `tasks=${summary2.tasksCreated} notifications=${summary2.notifications} audit=${summary2.auditEntries}`);

  // ----------------------------------------------------------- attribution ---
  const monitorEntries = db.all(
    "SELECT action, actor_username, actor_id, severity, meta FROM audit_trail WHERE actor_username = 'monitor'"
  );
  check('automated writes are attributed to the monitor system actor',
    monitorEntries.length > 0, `entries=${monitorEntries.length}`);
  check('the monitor actor carries no user id, so it cannot be mistaken for a person',
    monitorEntries.every((e) => e.actor_id === null),
    `distinct actor_ids=${[...new Set(monitorEntries.map((e) => e.actor_id))].join(',')}`);
  check('automated entries are marked as monitor-generated in their metadata',
    monitorEntries.every((e) => e.meta && String(e.meta).includes('monitor')),
    'every entry carries meta.monitor');
  check('every automated audit entry states a reason',
    monitorEntries.every((e) => e.meta !== null)
    && db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE actor_username = 'monitor' AND (reason IS NULL OR reason = '')").n === 0,
    'all have a reason');
  check('record-level breaches are raised at warning or critical severity',
    db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'deadline_breach' AND severity = 'info'").n === 0,
    'no informational breaches');

  // -------------------------------------------------------- reconciliation ---
  // Fix the underlying conditions and confirm the tasks close themselves.
  db.run('UPDATE workflow_instances SET status = ? WHERE id = ?', ['closed', lateRecordId]);
  db.run('UPDATE equipment SET next_calibration_date = ? WHERE asset_no = ?',
    [new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10), 'TEST-EQ-1']);
  db.run('UPDATE documents SET next_review_date = ? WHERE doc_number = ?',
    [new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10), 'TEST-DOC-1']);

  summary = monitor.runCycle();
  check('RECONCILIATION: tasks whose condition is resolved are auto-closed',
    summary.tasksAutoClosed >= 3, `auto_closed=${summary.tasksAutoClosed}`);
  check('auto-closure is itself audited',
    count('audit_trail', "action = 'task_auto_closed'") >= 3,
    `task_auto_closed=${count('audit_trail', "action = 'task_auto_closed'")}`);
  check('closed tasks no longer appear as open work',
    count('tasks', "status = 'open'") < tasksSnapshot,
    `open now=${count('tasks', "status = 'open'")}`);

  // ---------------------------------------------------------- escalations ----
  // A record more than 30 days late must escalate exactly once.
  db.run(
    'UPDATE workflow_instances SET status = ?, due_date = ? WHERE id = ?',
    ['in_assessment', new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10), lateRecordId]
  );
  const esc1 = monitor.runCycle();
  const escAuditAfter1 = count('audit_trail', "action = 'escalation'");
  const esc2 = monitor.runCycle();
  const escAuditAfter2 = count('audit_trail', "action = 'escalation'");

  check('a record more than 30 days late is escalated',
    esc1.escalated >= 1 && escAuditAfter1 >= 1, `escalated=${esc1.escalated}`);
  check('ESCALATION IS IDEMPOTENT: a further cycle does not escalate again',
    esc2.escalated === 0 && escAuditAfter2 === escAuditAfter1,
    `second cycle escalated=${esc2.escalated} audit ${escAuditAfter1}->${escAuditAfter2}`);
  check('the escalation raises the task priority to critical',
    db.get("SELECT COUNT(*) AS n FROM tasks WHERE entity_id = ? AND priority = 'critical'", [String(lateRecordId)]).n >= 1,
    'priority updated');

  // ------------------------------------------------------- ledger integrity --
  const chain = audit.verifyChain();
  check('the audit chain still verifies after repeated monitor cycles',
    chain.ok === true, `ok=${chain.ok} checked=${chain.checked}`);
  check('the chain grew only through auditable state changes',
    chain.checked === count('audit_trail'), `checked=${chain.checked} rows=${count('audit_trail')}`);

  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(SCRATCH_DB + suffix, { force: true });
  }

  // ----------------------------------------------------------------- report --
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  process.stdout.write('\n  LeebertyPV -  background monitor verification\n');
  process.stdout.write(`  ${'='.repeat(74)}\n\n`);
  for (const item of results) {
    process.stdout.write(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name}\n`);
    if (!item.pass && item.detail) process.stdout.write(`          -> ${item.detail}\n`);
  }
  process.stdout.write(`\n  ${'='.repeat(74)}\n`);
  process.stdout.write(`  ${pass} passed, ${fail} failed (${results.length} checks)\n\n`);
  process.exit(fail ? 1 : 0);
}

try {
  main();
} catch (err) {
  process.stdout.write(`\n  HARNESS ERROR: ${err && err.stack ? err.stack : err}\n\n`);
  const pass = results.filter((r) => r.pass).length;
  for (const item of results) process.stdout.write(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name}\n`);
  process.stdout.write(`\n  ${pass} passed before the crash\n\n`);
  process.exit(2);
}
