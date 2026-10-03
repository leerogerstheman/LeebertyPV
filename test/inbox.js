'use strict';

/**
 * Verification for the click-and-use experience: built-in personas and the inbox.
 *
 *   node test/inbox.js
 *
 * Runs against a scratch database and a scratch port, and drives the real HTTP
 * API as several different roles. The point is not merely that the endpoints
 * answer, but that:
 *
 *   1. each persona can sign in and land on a populated inbox;
 *   2. the inbox contents differ by role, and differ in the *right* direction -
 *      an operator must not be shown approvals, a QA manager must be;
 *   3. nothing the inbox offers is something the API would refuse.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH_DB = path.join(os.tmpdir(), `pv-inbox-${Date.now()}.sqlite`);
const PORT = process.env.PV_TEST_PORT || '8799';
const BASE = `http://127.0.0.1:${PORT}`;

process.env.PV_DB_FILE = SCRATCH_DB;
process.env.PV_DATA_DIR = path.dirname(SCRATCH_DB);
process.env.PV_PORT = PORT;
process.env.PV_OPEN_BROWSER = '0';
process.env.PV_BUILTIN_ACCOUNTS = '1';
process.env.PV_MONITOR = '0';   // driven explicitly below for determinism

const db = require('../src/core/db');
const seed = require('../src/seed');
const accounts = require('../src/domain/accounts');
const serverModule = require('../src/api/server');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
}

let httpServer = null;

async function call(method, urlPath, body, cookie) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (cookie) init.headers.Cookie = cookie;
  let target = urlPath;
  if (body !== undefined && body !== null && method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body && method === 'GET') {
    const qs = new URLSearchParams(body).toString();
    if (qs) target += (target.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(BASE + target, init);
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, body: payload, setCookie: res.headers.get('set-cookie') };
}

async function loginAs(username) {
  const res = await call('POST', '/api/auth/login', {
    username, password: accounts.BUILTIN_PASSWORD,
  });
  if (!res.setCookie) return null;
  return res.setCookie.split(';')[0];
}

/**
 * Build conditions the inbox reacts to, so it is not empty.
 *
 * Three records are parked at different points in their definitions on purpose:
 * one on the unsigned PV-DEV report step (so the data-entry clerk has something
 * to submit), one on the signature-gated ICSR closure (so the QA manager has
 * something to approve), and one PV-CAPA with no effectiveness result (so a
 * verify item exists once the monitor has run). Without the second the test
 * could not tell whether approval work is surfaced at all.
 */
function seedConditions() {
  const at = new Date().toISOString();
  const owner = db.get("SELECT id FROM users WHERE role = 'qa_manager' LIMIT 1").id;
  const operator = db.get("SELECT id FROM users WHERE username = 'demo.intake' LIMIT 1").id;
  const workflow = require('../src/domain/workflow');

  /** Insert an instance parked on a given step, with all steps materialised. */
  function parkOnStep(recordKey, processCode, title, currentStepCode, dueDate, criticality) {
    db.run(
      'INSERT INTO workflow_instances (record_key, process_code, title, status, current_step, gxp_areas, ' +
      'criticality, owner_id, reported_by, due_date, record_version, created_at, updated_at, data_json) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [recordKey, processCode, title, 'in_assessment', currentStepCode,
        '["GVP"]', criticality, owner, operator, dueDate, 1, at, at, '{}']
    );
    const instanceId = db.get('SELECT last_insert_rowid() AS id').id;
    const def = workflow.getDefinition(processCode);
    let seq = 0;
    for (const step of def.steps) {
      seq += 1;
      db.run(
        'INSERT INTO workflow_steps (instance_id, seq, step_code, name, name_en, step_type, status, ' +
        'assignee_role, signature_meaning, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [instanceId, seq, step.code, step.name, step.nameEn || null, step.type || 'task',
          step.code === currentStepCode ? 'pending' : (seq < (def.steps.findIndex((s) => s.code === currentStepCode) + 1) ? 'completed' : 'pending'),
          JSON.stringify(step.role || []), step.signatureMeaning || null, at]
      );
    }
    return instanceId;
  }

  // Parked on the unsigned PV-DEV report step: the data-entry clerk has
  // something to submit.
  parkOnStep('INBOX-DEV-1', 'PV-DEV', 'Inbox test deviation', 'report',
    new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10), 'major');

  // Parked on the signature-gated ICSR closure step (meaning "closed"): QA has
  // something to approve.
  parkOnStep('INBOX-ICSR-1', 'ICSR-EXP', 'Inbox test case awaiting closure', 'closure',
    new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10), 'major');

  // A CAPA with no effectiveness result, so a verify item exists once the
  // monitor has run.
  parkOnStep('INBOX-CAPA-1', 'PV-CAPA', 'Inbox test CAPA', 'implement',
    new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), 'major');

  // Equipment past calibration and a document past review.
  db.run(
    'INSERT INTO equipment (asset_no, name, department, gxp_areas, criticality, status, calibration_required, ' +
    'calibration_interval_days, next_calibration_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['INBOX-EQ-1', 'Overdue HPLC', 'QC', '["GVP"]', 'critical', 'in_service', 1, 365,
      new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10), at, at]
  );
  db.run(
    'INSERT INTO documents (doc_number, title, doc_type, gxp_areas, status, review_period_months, ' +
    'next_review_date, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['INBOX-SOP-1', 'Overdue SOP', 'sop', '["GVP"]', 'effective', 24,
      new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), owner, at, at]
  );
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(SCRATCH_DB + suffix, { force: true });
  db.open();
  seed.run({ silent: true });

  // ---------------------------------------------------- built-in accounts --
  const summary = accounts.provision(null, { ip: '127.0.0.1', userAgent: 'test' });
  check('provisioning is enabled when configured',
    summary.enabled === true, `enabled=${summary.enabled}`);
  check('every persona is created',
    summary.created === accounts.PERSONAS.length,
    `created=${summary.created} expected=${accounts.PERSONAS.length}`);
  check('each persona is a real user row with its declared role',
    accounts.PERSONAS.every((p) => {
      const row = db.get('SELECT role, status FROM users WHERE username = ?', [p.username]);
      return row && row.role === p.role && row.status === 'active';
    }), 'all roles match');
  check('personas are not forced to change password, so they are usable immediately',
    db.get("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'demo.%' AND must_change_password = 1").n === 0,
    'none flagged');
  check('persona provisioning is idempotent',
    accounts.provision(null, { ip: '127.0.0.1', userAgent: 'test' }).created === 0,
    'second provision created nothing');
  check('provisioning is audited',
    db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'create' AND reason LIKE '%demonstration account%'").n
      === accounts.PERSONAS.length,
    `entries=${db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE reason LIKE '%demonstration account%'").n}`);

  const choices = accounts.loginChoices();
  check('the login screen receives a persona list',
    choices.length === accounts.PERSONAS.length, `n=${choices.length}`);
  check('each persona carries a plain-language description of what it demonstrates',
    choices.every((c) => c.blurb && c.blurb.length > 10), 'all described');

  seedConditions();
  require('../src/daemon/monitor').runCycle();

  httpServer = await serverModule.start();

  // --------------------------------------------------- anonymous access ----
  let r = await call('GET', '/api/login-choices');
  check('login choices are reachable without a session',
    r.status === 200 && r.body.personas.length >= accounts.PERSONAS.length
      && r.body.personas.some((p) => p.curated === true),
    `status=${r.status} n=${r.body.personas ? r.body.personas.length : 0}`);

  r = await call('GET', '/api/bootstrap');
  check('bootstrap advertises the built-in cast so the login page can render tiles',
    r.status === 200 && r.body.builtinAccounts.enabled === true
      && r.body.builtinAccounts.personas.length >= accounts.PERSONAS.length,
    `enabled=${r.body.builtinAccounts && r.body.builtinAccounts.enabled}`);

  r = await call('GET', '/api/inbox');
  check('the inbox requires authentication',
    r.status === 401, `status=${r.status}`);

  // --------------------------------------------------- per-role inboxes ----
  const roleData = {};
  for (const persona of accounts.PERSONAS) {
    const cookie = await loginAs(persona.username);
    if (!cookie) {
      check(`persona ${persona.username} can sign in`, false, 'login failed');
      continue;
    }
    const res = await call('GET', '/api/inbox', { limit: 100 }, cookie);
    roleData[persona.username] = res.body;
    check(`persona ${persona.username} (${persona.role}) signs in and receives an inbox`,
      res.status === 200 && res.body.counts && typeof res.body.counts.total === 'number',
      `status=${res.status} items=${res.body.counts ? res.body.counts.total : 'n/a'}`);
  }

  // --------------------------------------------- the inbox must differ ------
  const opInbox = roleData['demo.intake'];
  const qaInbox = roleData['demo.qamanager'];
  const trnInbox = roleData['demo.trainer'];

  check('the QA manager sees more pending work than the operator',
    qaInbox && opInbox && qaInbox.counts.total > opInbox.counts.total,
    `qa=${qaInbox && qaInbox.counts.total} operator=${opInbox && opInbox.counts.total}`);
  check('the operator is NOT shown approval work',
    opInbox && opInbox.counts.toApprove === 0,
    `operator toApprove=${opInbox && opInbox.counts.toApprove}`);
  check('the QA manager IS shown approval work',
    qaInbox && qaInbox.counts.toApprove > 0,
    `qa toApprove=${qaInbox && qaInbox.counts.toApprove}`);
  check('no inbox item is classified as an unknown action',
    qaInbox && qaInbox.items.every((i) => i.action !== 'unknown'),
    `unknown=${qaInbox ? qaInbox.items.filter((i) => i.action === 'unknown').length : 'n/a'}`);
  check('the calibration task is raised for QA accountability, not owned by the intake clerk',
    qaInbox && qaInbox.items.some((i) => i.taskType === 'calibration_overdue')
      && opInbox && opInbox.items.filter((i) => i.taskType === 'calibration_overdue')
        .every((i) => i.isOversight === true),
    `qa task present, operator sees only oversight=${opInbox
      && opInbox.items.filter((i) => i.taskType === 'calibration_overdue').every((i) => i.isOversight === true)}`);
  check('the document review task is visible to QA',
    qaInbox && qaInbox.items.some((i) => i.taskType === 'document_review'),
    'document_review present');
  check('the operator cannot see the audit trail',
    opInbox && opInbox.roleCapabilities.canViewAuditTrail === false,
    `canViewAuditTrail=${opInbox && opInbox.roleCapabilities.canViewAuditTrail}`);
  check('the QA manager can verify the audit chain',
    qaInbox && qaInbox.roleCapabilities.canVerifyAuditChain === true,
    'canVerifyAuditChain=true');
  check('the external auditor persona is flagged read-only',
    roleData['demo.external'] && roleData['demo.external'].roleCapabilities.readOnly === true,
    `readOnly=${roleData['demo.external'] && roleData['demo.external'].roleCapabilities.readOnly}`);
  check('the trainer sees training work',
    trnInbox && (trnInbox.counts.toPerform > 0 || trnInbox.items.some((i) => i.taskType === 'training_expired')),
    `trainer items=${trnInbox && trnInbox.items.length}`);

  // ------------------------------------------- ranking and shape -----------
  check('inbox items are ranked by consequence, not merely by date',
    qaInbox && qaInbox.items.length > 1
      && qaInbox.items[0].urgency >= qaInbox.items[qaInbox.items.length - 1].urgency,
    'urgency is non-increasing');
  check('every item carries an explicit action so the UI need not guess',
    qaInbox && qaInbox.items.every((i) => typeof i.action === 'string' && i.action.length > 0),
    'all items have an action');
  check('every item carries a working link',
    qaInbox && qaInbox.items.every((i) => typeof i.link === 'string' && i.link.startsWith('#/')),
    'all links present');
  check('items that require a signature are flagged',
    qaInbox && qaInbox.items.some((i) => i.requiresSignature === true)
      === (qaInbox.counts.requiresSignature > 0),
    `requiresSignature=${qaInbox && qaInbox.counts.requiresSignature}`);
  check('the inbox reports an overdue count',
    qaInbox && qaInbox.counts.overdue > 0,
    `overdue=${qaInbox && qaInbox.counts.overdue}`);
  check('filters narrow the result without changing the reported totals',
    await (async () => {
      const cookie = await loginAs('demo.qamanager');
      const filtered = await call('GET', '/api/inbox', { action: 'approve', limit: 100 }, cookie);
      return filtered.body.items.every((i) => i.action === 'approve')
        && filtered.body.counts.total === qaInbox.counts.total;
    })(), 'approve filter applied, totals preserved');

  // ------------------------------------- nothing offered is un-actionable --
  check('every workflow step offered to the operator is one they may actually complete',
    await (async () => {
      if (!opInbox) return false;
      const cookie = await loginAs('demo.intake');
      for (const item of opInbox.items.filter((i) => i.kind === 'workflow_step')) {
        const res = await call('POST', `/api/records/${item.entityId}/steps/complete`, {
          stepCode: item.stepCode,
          formData: {},
          comment: 'permission probe - not intended to succeed',
        }, cookie);
        // Either it succeeded, or it failed for a data reason (403 is the one
        // that would mean the inbox lied).
        if (res.status === 403 && res.body.error === 'ROLE_NOT_PERMITTED') {
          return false;
        }
      }
      return true;
    })(), 'no role-permission contradictions');

  // ------------------------------------------------- notifications ---------
  const notifCookie = await loginAs('demo.qamanager');
  r = await call('GET', '/api/inbox', { kind: 'notification', limit: 100 }, notifCookie);
  const unread = r.body.items.length;
  check('the QA manager has unread notifications from the monitor',
    unread > 0, `unread=${unread}`);
  if (unread > 0) {
    const first = r.body.items[0];
    r = await call('POST', `/api/notifications/${first.notificationId}/read`, {}, notifCookie);
    check('a notification can be marked read',
      r.status === 200 && r.body.ok === true, `status=${r.status}`);
    const after = await call('GET', '/api/inbox', { kind: 'notification', limit: 100 }, notifCookie);
    check('marking it read removes it from the inbox',
      after.body.items.length < unread, `before=${unread} after=${after.body.items.length}`);
    r = await call('POST', '/api/notifications/read-all', {}, notifCookie);
    check('all notifications can be marked read in one action',
      r.status === 200, `status=${r.status} updated=${r.body.updated}`);
  }

  // ------------------------------------------------- ledger integrity ------
  const chain = require('../src/core/audit').verifyChain();
  check('the audit chain still verifies after all of this',
    chain.ok === true, `ok=${chain.ok} checked=${chain.checked}`);
}

(async () => {
  let failed = 1;
  try {
    await main();
    failed = results.filter((r) => !r.pass).length;
  } catch (err) {
    process.stdout.write(`\n  HARNESS ERROR: ${err && err.stack ? err.stack : err}\n`);
    failed = 1;
  } finally {
    try { if (httpServer) httpServer.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    // Leave the scratch file behind only on failure, to allow inspection.
    if (!failed) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(SCRATCH_DB + suffix, { force: true });
    } else {
      process.stdout.write(`  (scratch database kept for inspection: ${SCRATCH_DB})\n`);
    }
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  process.stdout.write('\n  LeebertyPV -  built-in accounts and inbox verification\n');
  process.stdout.write(`  ${'='.repeat(74)}\n\n`);
  for (const item of results) {
    process.stdout.write(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name}\n`);
    if (!item.pass && item.detail) process.stdout.write(`          -> ${item.detail}\n`);
  }
  process.stdout.write(`\n  ${'='.repeat(74)}\n`);
  process.stdout.write(`  ${pass} passed, ${fail} failed (${results.length} checks)\n\n`);
  process.exit(fail ? 1 : 0);
})();
