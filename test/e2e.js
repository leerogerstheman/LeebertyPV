'use strict';

/**
 * End-to-end verification for the GxP Workbench.
 *
 *   node test/e2e.js
 *
 * Runs against a scratch data directory and a non-default port so it can never
 * touch a live database. Exercises the compliance kernel - audit chain,
 * two-component e-signatures, RBAC, the workflow gates and the inspection
 * escalation path - because those are the parts where a silent break would not
 * be obvious in normal use.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRATCH = path.join(os.tmpdir(), `pv-e2e-${Date.now()}`);
process.env.PV_DATA_DIR = SCRATCH;
process.env.PV_PORT = process.env.PV_TEST_PORT || '8797';
process.env.PV_OPEN_BROWSER = '0';

const BASE = `http://127.0.0.1:${process.env.PV_PORT}`;
const ADMIN = { username: 'e2eadmin', fullName: 'E2E Administrator', password: 'E2e-Str0ng-Pass!' };

const db = require('../src/core/db');
const seed = require('../src/seed');
const serverModule = require('../src/api/server');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
}

let cookie = '';
let httpServer = null;

async function call(method, urlPath, body) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (cookie) init.headers.Cookie = cookie;
  let target = urlPath;
  if (body !== undefined && body !== null) {
    if (method === 'GET') {
      const qs = new URLSearchParams(
        Object.entries(body).filter(([, v]) => v !== undefined && v !== null)
      ).toString();
      if (qs) target += (target.includes('?') ? '&' : '?') + qs;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + target, init);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  let payload = null;
  if (type.includes('json')) payload = await res.json().catch(() => null);
  else payload = await res.text();
  return { status: res.status, body: payload, headers: res.headers };
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  db.open();
  const seeded = seed.run({ silent: true });

  httpServer = await serverModule.start();
  // The real entry point signals readiness after provisioning built-in accounts
  // and starting the monitor; the health endpoint answers 503 until then.
  serverModule.markReady();

  // ---------------------------------------------------------------- health --
  let r = await call('GET', '/api/health');
  check('GET /api/health returns 200 with a verified audit chain',
    r.status === 200 && r.body.ok && r.body.auditChain.ok, `status=${r.status}`);

  // ------------------------------------------------------------- bootstrap --
  r = await call('GET', '/api/bootstrap');
  check('bootstrap is reachable before any account exists',
    r.status === 200 && r.body.setupComplete === false, `status=${r.status}`);
  check('bootstrap exposes the configuration library',
    (r.body.processTypes || []).length === seeded.processTypes
    && (r.body.checklistTemplates || []).length === seeded.checklistTemplates,
    `processes=${(r.body.processTypes || []).length} checklists=${(r.body.checklistTemplates || []).length}`);
  check('bootstrap exposes at least 15 roles and the permission list',
    (r.body.roles || []).length >= 15 && Object.keys(r.body.permissions || {}).length > 30,
    `roles=${(r.body.roles || []).length} permissions=${Object.keys(r.body.permissions || {}).length}`);

  // ------------------------------------------------------ authority checks --
  r = await call('GET', '/api/audit');
  check('the audit trail requires authentication (401)',
    r.status === 401, `status=${r.status}`);

  // ------------------------------------------------------------ first run ---
  r = await call('POST', '/api/setup', { ...ADMIN, siteName: 'E2E Site' });
  check('first-run setup creates an administrator and opens a session',
    r.status === 201 && r.body.user && r.body.user.role === 'system_admin',
    `status=${r.status} role=${r.body.user && r.body.user.role}`);
  check('the administrator holds the wildcard permission',
    r.body.user && Array.isArray(r.body.user.permissions) && r.body.user.permissions.includes('*'),
    JSON.stringify(r.body.user && r.body.user.permissions));

  r = await call('POST', '/api/setup', { username: 'second', fullName: 'Second Admin', password: 'E2e-Str0ng-Pass!' });
  check('setup cannot be run twice (409)',
    r.status === 409, `status=${r.status} code=${r.body.error}`);

  // A non-privileged account is needed to prove the workflow role gate bites;
  // a system administrator deliberately bypasses it. mustChangePassword is
  // cleared so the password-change gate does not mask the role gate.
  r = await call('POST', '/api/users', {
    username: 'operator1', fullName: 'PV Data Entry Operator', role: 'pv_data_entry',
    department: 'Pharmacovigilance', password: '0perator-Str0ng!', mustChangePassword: false,
  });
  check('an operator account can be created with a non-privileged role',
    r.status === 201 && r.body.user.role === 'pv_data_entry', `status=${r.status} err=${r.body.error || ''}`);
  check('a data-entry operator is not granted user administration',
    r.body.user && !r.body.user.permissions.includes('user.manage'),
    JSON.stringify(r.body.user && r.body.user.permissions.slice(0, 4)));

  // -------------------------------------------------------------- workflow --
  r = await call('POST', '/api/records', {
    processCode: 'PV-DEV',
    title: 'Expedited report submitted later than the 15-day timeline',
    summary: 'Case CN-2026-0142 was registered on the 12th day but submitted to the ADR centre on the 19th day.',
    criticality: 'major',
    occurredAt: new Date().toISOString(),
    data: { processArea: '报告提交与时限', impactOnTimelines: '是' },
    batchNumber: 'B2026-100',
    product: 'E2E Tablet 10 mg',
  });
  const dev = r.body;
  check('a deviation record can be created and gets its own record key',
    r.status === 201 && /^DEV-\d{4}-\d{4}$/.test(dev.recordKey || ''), `status=${r.status} key=${dev.recordKey}`);
  check('the workflow engine materialises every step from the JSON definition',
    (dev.steps || []).length >= 6, `steps=${(dev.steps || []).length}`);
  check('the first step is the current step and it is not already completed',
    dev.currentStep === 'report' && (dev.steps || []).some((s) => s.code === 'report' && s.status !== 'completed'),
    `currentStep=${dev.currentStep}`);
  check('each step carries an array of responsible roles',
    (dev.steps || []).length > 1 && Array.isArray(dev.steps[1].assigneeRole) && dev.steps[1].assigneeRole.length > 0,
    `investigate roles=${JSON.stringify((dev.steps[1] || {}).assigneeRole)}`);

  r = await call('POST', '/api/records', { processCode: 'PV-DEV', title: 'x', criticality: 'minor' });
  check('creating a record without the definition\u2019s required fields is rejected (400)',
    r.status === 400 && String(r.body.error).includes('REQUIRED'),
    `status=${r.status} code=${r.body.error}`);

  r = await call('POST', `/api/records/${dev.id}/steps/complete`, {
    stepCode: 'report',
    formData: {
      rep_discoveredBy: 'PV Officer on duty',
      rep_deviationType: '报告时限偏差',
      rep_containment: 'Supplementary report filed and the overdue reason noted',
      rep_detail: 'The case was submitted on day 19 instead of day 15.',
    },
  });
  check('an unsigned step can be completed and the record advances',
    r.status === 200 && r.body.currentStep === 'investigate',
    `status=${r.status} next=${r.body.currentStep}`);
  check('the record status reflects the step transition',
    r.body.status === 'report', `status=${r.body.status}`);

  // Sign in as the operator: the investigation step belongs to QA / the PV
  // officer, not to data entry.
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { username: 'operator1', password: '0perator-Str0ng!' });
  r = await call('POST', `/api/records/${dev.id}/steps/complete`, {
    stepCode: 'investigate',
    formData: {
      inv_method: '5-Why',
      inv_evidence: 'Submission log timestamps',
      inv_rootCause: 'No submission reminder was configured',
      inv_conclusion: 'Process gap confirmed',
    },
  });
  check('a step is refused for a role that the definition does not permit (403)',
    r.status === 403 && r.body.error === 'ROLE_NOT_PERMITTED',
    `status=${r.status} code=${r.body.error}`);

  r = await call('GET', '/api/audit');
  check('the audit trail itself is permission-gated for a shop-floor role (403)',
    r.status === 403 && r.body.error === 'PERMISSION_DENIED',
    `status=${r.status} code=${r.body.error}`);

  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { username: ADMIN.username, password: ADMIN.password });

  // Catch the stale-current-step regression the verifier reported.
  const afterReport = await call('GET', `/api/records/${dev.id}`);
  check('current_step points at the outstanding step, not the completed one',
    afterReport.body.currentStep !== 'report', `currentStep=${afterReport.body.currentStep}`);

  // ---------------------------------------------------- e-signature flow ----
  r = await call('POST', '/api/signatures/challenge', { meaning: 'approved' });
  const nonce = r.body.nonce;
  check('a single-use signing challenge can be issued',
    r.status === 200 && typeof nonce === 'string' && nonce.length > 10, `status=${r.status}`);

  r = await call('POST', '/api/signatures', {
    username: ADMIN.username, password: ADMIN.password, nonce,
    meaning: 'approved', reason: 'Investigation complete and root cause confirmed',
    entityType: 'workflow_instances', entityId: dev.id, recordKey: dev.recordKey, stepCode: 'approve',
  });
  const signature = r.body;
  check('an e-signature is accepted using two distinct identification components',
    r.status === 201 && signature.id, `status=${r.status} err=${r.body.error || ''}`);
  check('the signature manifest carries meaning, printed name and timestamp',
    signature.manifest && signature.printedName && signature.signedAt,
    signature.manifest);

  r = await call('POST', '/api/signatures', {
    username: ADMIN.username, password: ADMIN.password, nonce,
    meaning: 'approved', reason: 'Replay of a used challenge must fail',
    entityType: 'workflow_instances', entityId: dev.id,
  });
  check('a signing challenge cannot be replayed',
    r.status === 400 && ['NONCE_ALREADY_USED', 'NONCE_EXPIRED', 'NONCE_INVALID'].includes(r.body.error),
    `status=${r.status} code=${r.body.error}`);

  r = await call('POST', '/api/signatures', {
    username: ADMIN.username, password: 'Definitely-Wrong-1!', nonce: 'whatever',
    meaning: 'approved', reason: 'Wrong password must not produce a signature',
    entityType: 'workflow_instances', entityId: dev.id,
  });
  check('a signature with the wrong password is refused and logged (401)',
    r.status === 401 && r.body.error === 'SIGNATURE_AUTH_FAILED',
    `status=${r.status} code=${r.body.error}`);

  r = await call('POST', '/api/signatures', {
    username: 'someone.else', password: ADMIN.password, nonce: 'whatever',
    meaning: 'approved', reason: 'Signing as another user must be refused',
    entityType: 'workflow_instances', entityId: dev.id,
  });
  check('a signature cannot be applied under another person\u2019s name',
    r.status === 400 && r.body.error === 'SIGNATURE_IDENTITY_MISMATCH',
    `status=${r.status} code=${r.body.error}`);

  // ---------------------------------------------------------- audit trail ---
  r = await call('GET', '/api/audit', { limit: 300 });
  const actions = (r.body.rows || []).map((x) => x.action);
  check('the audit trail records the e-signature event',
    actions.includes('sign'), `distinct actions=${[...new Set(actions)].join(',')}`);
  check('the audit trail records the record creation event',
    actions.includes('create'), '');
  check('the audit trail records the rejected signature attempt',
    actions.includes('signature_failed'), '');
  check('every audit entry carries a hash-chain link',
    (r.body.rows || []).every((x) => x.chain_hash && x.prev_hash), '');

  r = await call('GET', '/api/audit/verify');
  check('the audit hash chain verifies after all of the above',
    r.status === 200 && r.body.ok === true, `ok=${r.body.ok} checked=${r.body.checked}`);

  r = await call('GET', `/api/audit/reconstruct/${encodeURIComponent(dev.recordKey)}`);
  check('a record can be reconstructed from the audit trail alone',
    r.status === 200 && r.body.state && Object.keys(r.body.state).length > 0,
    `state keys=${r.body.state ? Object.keys(r.body.state).length : 0}`);

  // Read the export as raw bytes: the UTF-8 BOM matters because Excel needs it
  // to render Chinese audit reasons correctly, and a text decode can hide it.
  const csvRes = await fetch(`${BASE}/api/audit/export?format=csv`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const csvBytes = Buffer.from(await csvRes.arrayBuffer());
  const csvType = csvRes.headers.get('content-type') || '';
  check('the audit export is served as CSV with an attachment filename',
    csvRes.status === 200 && csvType.includes('text/csv')
    && String(csvRes.headers.get('content-disposition') || '').includes('attachment'),
    `status=${csvRes.status} type=${csvType}`);
  check('the audit export carries a UTF-8 BOM so Excel reads it correctly',
    csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF,
    `first bytes=${[...csvBytes.slice(0, 3)].join(',')}`);
  const csvText = csvBytes.toString('utf8');
  const csvBody = csvText.charCodeAt(0) === 0xFEFF ? csvText.slice(1) : csvText;
  check('the audit export is real CSV, not a JSON string in CSV clothing',
    csvBody.startsWith('seq,at,actor_username') && csvBody.includes('\r\n'),
    `head=${JSON.stringify(csvBody.slice(0, 46))}`);

  // ---------------------------------------------------------- self-inspect --
  r = await call('GET', '/api/checklists');
  const templates = r.body.rows || [];
  check('checklist templates are registered',
    templates.length >= 3, `n=${templates.length}`);
  check('every checklist template carries a regulatory citation',
    templates.every((x) => x.regulation), '');

  r = await call('POST', '/api/inspections', {
    templateCode: 'ALCOA-DI',
    title: 'Data integrity self inspection',
    scope: 'Data integrity self inspection across ICSR processing and the PV quality system for the first half of 2026.',
  });
  const inspection = r.body;
  check('an inspection is seeded with one finding per requirement',
    r.status === 201 && (inspection.findings || []).length > 10,
    `status=${r.status} findings=${(inspection.findings || []).length}`);

  const finding = (inspection.findings || [])[0];
  r = await call('POST', `/api/findings/${finding.id}/assess`, {
    grade: 'partial',
    objectiveEvidence: 'A data integrity policy exists but was last reviewed in 2023, beyond its 24-month cycle.',
  });
  check('a finding can be graded as partially compliant with evidence',
    r.status === 200 && r.body.grade === 'partial', `status=${r.status} grade=${r.body.grade}`);

  r = await call('POST', `/api/findings/${finding.id}/assess`, { grade: 'gap' });
  check('grading a gap without objective evidence is refused (400)',
    r.status === 400 && r.body.error === 'EVIDENCE_REQUIRED', `status=${r.status} code=${r.body.error}`);

  r = await call('POST', `/api/findings/${finding.id}/escalate`, {
    processCode: 'PV-CAPA', title: 'Review and re-approve the data integrity policy',
  });
  check('a finding escalates into a linked CAPA record',
    r.status === 201 && r.body.workflow && r.body.workflow.recordKey, `key=${r.body.workflow && r.body.workflow.recordKey}`);

  r = await call('GET', `/api/inspections/${inspection.id}`);
  check('the inspection computes a readiness score from the graded items',
    r.status === 200 && typeof r.body.readinessScore === 'number',
    `score=${r.body.readinessScore}`);
  check('inspection progress tracks assessed versus total items',
    r.body.progress && r.body.progress.total > 0 && r.body.progress.assessed >= 1,
    JSON.stringify(r.body.progress && { total: r.body.progress.total, assessed: r.body.progress.assessed }));

  // ------------------------------------------------------ document control --
  r = await call('POST', '/api/documents', {
    docNumber: 'SOP-QA-001',
    title: 'Data integrity management procedure',
    docType: 'sop',
    gxpAreas: ['GVP'],
    department: 'Quality Assurance',
    changeReason: 'New procedure required to close the self-inspection finding.',
  });
  const doc = r.body;
  check('a controlled document can be created in draft',
    r.status === 201 && doc.docNumber === 'SOP-QA-001', `status=${r.status} err=${r.body.error || ''}`);
  const version = (doc.versions || [])[0];

  r = await call('POST', `/api/documents/${doc.id}/versions/${version.version}/transition`, {
    targetStatus: 'in_review', reason: 'Submitted for review by the document owner.',
  });
  check('a document moves from draft to in review',
    r.status === 200 && r.body.status === 'in_review', `status=${r.status} err=${r.body.error || ''}`);

  r = await call('POST', `/api/documents/${doc.id}/versions/${version.version}/transition`, {
    targetStatus: 'approved',
  });
  check('approving a controlled document demands an electronic signature (428)',
    r.status === 428 && r.body.error === 'SIGNATURE_REQUIRED', `status=${r.status} code=${r.body.error}`);

  r = await call('POST', `/api/documents/${doc.id}/versions/${version.version}/transition`, {
    targetStatus: 'superseded', reason: 'Skipping states must not be allowed.',
  });
  check('an invalid document state transition is refused (409)',
    r.status === 409 && r.body.error === 'INVALID_TRANSITION', `status=${r.status} code=${r.body.error}`);

  // ------------------------------------------------------- RBAC enforcement --
  r = await call('POST', '/api/users', {
    username: 'operator1', fullName: 'Duplicate', role: 'viewer', password: 'Dupl1cate-Str0ng!',
  });
  check('a duplicate username is refused because accounts must be unique (409)',
    r.status === 409 && r.body.error === 'USERNAME_EXISTS', `status=${r.status} code=${r.body.error}`);

  r = await call('POST', '/api/users', {
    username: 'weakuser', fullName: 'Weak Password', role: 'viewer', password: 'password',
  });
  check('a password that breaks the site policy is refused (400)',
    r.status === 400 && r.body.error === 'PASSWORD_POLICY', `status=${r.status} code=${r.body.error}`);

  // ------------------------------------------------------------- coverage ---
  r = await call('GET', '/api/compliance/posture');
  const checks = r.body.checks || [];
  const notMet = checks.filter((c) => c.status === 'not_met');
  check('the compliance posture maps every control to a regulatory clause',
    checks.length >= 10 && checks.every((c) => c.clause && c.requirement),
    `checks=${checks.length}`);
  check('no Part 11 / Annex 11 control is reported as unmet out of the box',
    notMet.length === 0, `not met=${notMet.map((c) => c.id).join(',') || 'none'}`);
  check('the shipped default security policy is reported honestly as not yet site-approved',
    checks.some((c) => c.id === 'documented-security-policy' && c.status === 'partial'),
    JSON.stringify((checks.find((c) => c.id === 'documented-security-policy') || {}).evidence || '').slice(0, 120));

  r = await call('GET', '/api/readiness');
  check('the inspection readiness dashboard returns a score and named blockers',
    r.status === 200 && typeof r.body.readinessScore === 'number' && Array.isArray(r.body.blockers),
    `score=${r.body.readinessScore} blockers=${(r.body.blockers || []).length}`);

  r = await call('GET', '/api/dashboard');
  check('the dashboard aggregates without error',
    r.status === 200 && r.body.workflow && r.body.alerts && r.body.coverage,
    `status=${r.status}`);
  check('the dashboard reports the audit chain as intact',
    r.body.readiness && r.body.readiness.auditChain.ok === true, '');

  r = await call('GET', '/api/equipment');
  check('the equipment register is reachable',
    r.status === 200 && Array.isArray(r.body.rows), `status=${r.status}`);

  r = await call('GET', '/api/training/matrix');
  check('the training matrix is reachable',
    r.status === 200 && Array.isArray(r.body.users), `status=${r.status}`);

  r = await call('GET', '/api/training/eligibility/1');
  check('the training gate answers whether a person may perform GxP work',
    r.status === 200 && typeof r.body.allowed === 'boolean', `allowed=${r.body.allowed}`);

  // ------------------------------------------------------------------ final --
  r = await call('GET', '/api/audit/verify');
  check('FINAL: the audit chain still verifies after the entire run',
    r.status === 200 && r.body.ok === true, `ok=${r.body.ok} checked=${r.body.checked}`);
  check('the audit trail grew monotonically throughout the run',
    (r.body.entries || 0) >= 15, `entries=${r.body.entries}`);

  // Server-rendered static assets must be present, otherwise the UI is blank.
  r = await call('GET', '/');
  check('the SPA shell is served at the root path',
    r.status === 200 && String(r.body).includes('id="root"'), `status=${r.status}`);
  r = await call('GET', '/js/app.js');
  check('the client shell script is served',
    r.status === 200 && String(r.body).includes('window.App'), `status=${r.status}`);
}

function report() {
  const pass = results.filter((x) => x.pass).length;
  const fail = results.length - pass;
  process.stdout.write('\n  LeebertyPV -  end-to-end verification\n');
  process.stdout.write(`  ${'='.repeat(78)}\n\n`);
  for (const item of results) {
    const mark = item.pass ? 'PASS' : 'FAIL';
    process.stdout.write(`  ${mark}  ${item.name}\n`);
    if (!item.pass && item.detail) process.stdout.write(`          -> ${item.detail}\n`);
  }
  process.stdout.write(`\n  ${'='.repeat(78)}\n`);
  process.stdout.write(`  ${pass} passed, ${fail} failed (${results.length} checks)\n\n`);
  return fail;
}

(async () => {
  let failed = 1;
  try {
    await main();
    failed = report();
  } catch (err) {
    process.stdout.write(`\n  HARNESS ERROR: ${err && err.stack ? err.stack : err}\n\n`);
    // Still print whatever checks completed before the crash.
    if (results.length) report();
    failed = 1;
  } finally {
    try { if (httpServer) httpServer.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
