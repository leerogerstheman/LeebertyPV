'use strict';

/**
 * Checks for the operational layer: ICSR case processing and account
 * provisioning.
 *
 * WHY THIS EXISTS
 * ---------------
 * The workbench's quality processes (deviation, CAPA, inspection) are credible,
 * but the DATA ENTRY clerk's working day also needs modelling - a pv_data_entry
 * who signs in should find case work. The ICSR-EXP process covers that:
 * intake registers incoming cases, triage owns the clock, data entry codes the
 * events, medical review and closure are signature-gated. This suite drives a
 * real server over HTTP: an ICSR case is created through the API, the data-entry
 * clerk completes the step that is genuinely theirs, and both a step owned by
 * the PV officer and a signature-gated step are refused for the clerk.
 *
 * The second half is account provisioning: the "new user" entry point existed but
 * was reachable only by the administrator, and a new account had no way to declare
 * which areas it works in. The checks here assert the whole chain: create, appear
 * in the identity list, land in the right area, sign in, and be on the audit
 * trail.
 *
 * Everything is driven over HTTP against a real server, because the point is that
 * the integer parts fit together, not that each module works alone.
 */

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); }
  else { failed += 1; process.stdout.write(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}\n`); }
}

async function main() {
  process.stdout.write('\n  LeebertyPV -  operations: ICSR cases and account provisioning\n\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ops-'));
  const dbFile = path.join(dataDir, 'pv.db');
  const port = 8860 + Math.floor(Math.random() * 40);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PV_DB_FILE: dbFile, PV_DATA_DIR: dataDir, PV_BUILTIN_ACCOUNTS: '1',
    PV_PORT: String(port), PV_HOST: '127.0.0.1', PV_MONITOR: '0',
  };
  let server = null;

  // Seeds run against the scratch directory. On a busy machine a seed subprocess
  // can occasionally be starved by leftover file handles from the browser suites
  // that run earlier; one retry after a short pause absorbs that, while any
  // genuine seed error is still surfaced with its output.
  const run = (script) => {
    const attempt = () => execFileSync(NODE, [path.join(ROOT, script)], {
      cwd: ROOT, env, stdio: 'pipe', timeout: 120000,
    });
    try {
      return attempt();
    } catch (err) {
      const detail = `${err.stdout || ''}${err.stderr || ''}`;
      if (/seed\.js$/.test(script) && (err.status === 1 || err.status === 2)) {
        try { return attempt(); } catch (err2) {
          throw new Error(`${script} failed twice: ${err2.message}\n${detail}${err2.stdout || ''}${err2.stderr || ''}`);
        }
      }
      throw new Error(`${script} failed: ${err.message}\n${detail}`);
    }
  };

  try {
    run('scripts/seed.js');
    run('scripts/seed-demo.js');

    server = spawn(NODE, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
    let up = false;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${base}/api/health`); if (r.status === 200) { up = true; break; } } catch { /* not yet */ }
      await sleep(400);
    }
    check('the instance serves', up);
    if (!up) throw new Error('server did not come up');

    // The demonstration credential is read from the module rather than
    // hard-coded, so a credential change cannot silently break this suite.
    const DEMO_PASSWORD = require('../src/domain/accounts').BUILTIN_PASSWORD;
    const login = async (username, password = DEMO_PASSWORD) => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (r.status !== 200) return null;
      return { cookie: r.headers.get('set-cookie').split(';')[0], status: r.status };
    };
    const api = async (method, p, cookie, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await r.json(); } catch { /* non-JSON */ }
      return { status: r.status, json };
    };

    // ---- the ICSR process is registered and demo cases are seeded ---------
    const entry = await login('pv.dataentry');
    check('the data-entry clerk signs in', Boolean(entry));
    const admin = await login('admin');
    check('the system administrator signs in', Boolean(admin));

    const pt = await api('GET', '/api/process-types?', entry.cookie);
    const ptRows = (pt.json && pt.json.rows) || [];
    check('the expedited ICSR process is registered',
      pt.status === 200 && ptRows.some((r) => r.code === 'ICSR-EXP')
        && ptRows.length === 12,
      `${ptRows.length} process types`);

    const icsrList = await api('GET', '/api/records?processCode=ICSR-EXP&limit=100', entry.cookie);
    const demoIcsrs = (icsrList.json.rows || []).filter(
      (r) => (r.processCode || r.process_type) === 'ICSR-EXP'
    );
    check('demonstration ICSR cases are seeded',
      demoIcsrs.length >= 2, `${demoIcsrs.length} ICSR-EXP cases`);

    // ---- the clerk's working day is real work -----------------------------
    // Create a deterministic case through the API so this suite does not depend
    // on the demo generator's current step mix.
    const created = await api('POST', '/api/records', admin.cookie, {
      processCode: 'ICSR-EXP',
      title: 'Suspected hepatic injury with Product X',
      summary: '48-year-old female, jaundice and elevated transaminases 21 days after starting Product X.',
      criticality: 'major',
      occurredAt: new Date().toISOString(),
      product: 'Product X 10 mg',
      data: { reportSource: '医务人员' },
    });
    const caseRec = created.json || {};
    check('an ICSR case can be created through the API',
      created.status === 201 && /^AES-\d{4}-\d{4}$/.test(caseRec.recordKey || ''),
      `status ${created.status} key ${caseRec.recordKey}`);
    check('the ICSR flow starts at intake for the clerk',
      caseRec.currentStep === 'intake', `step ${caseRec.currentStep}`);

    const done = await api('POST', `/api/records/${caseRec.id}/steps/complete`, entry.cookie, {
      stepCode: 'intake',
      formData: {
        reporterName: '刘医生（市一医院）', patientInfo: '女，48岁', awarenessDate: '2026-09-20',
        receivedDate: '2026-09-21', minimalCriteriaComplete: '是',
      },
      comment: 'Intake registered the case',
    });
    check('the data-entry clerk completes the intake step',
      done.status === 200, `status ${done.status}`);
    const after = await api('GET', `/api/records/${caseRec.id}`, entry.cookie);
    check('the case advances to triage, which the clerk does not own',
      (after.json.currentStep || after.json.current_step) === 'triage',
      `step ${after.json.currentStep || after.json.current_step}`);

    const refusedTriage = await api('POST', `/api/records/${caseRec.id}/steps/complete`, entry.cookie, {
      stepCode: 'triage',
      formData: {
        seriousness: '严重', expectedness: '非预期', deathCase: '否',
        reportDeadline: '2026-10-06', routeDecision: '快速报告',
      },
    });
    check('a step owned by the PV officer is refused for the clerk (403)',
      refusedTriage.status === 403, `status ${refusedTriage.status}`);

    // The PV officer owns triage and moves the case on; the signature-gated
    // causality assessment then belongs to medical review, not data entry.
    const officer = await login('pv.officer');
    check('the PV officer signs in', Boolean(officer));
    const triaged = await api('POST', `/api/records/${caseRec.id}/steps/complete`, officer.cookie, {
      stepCode: 'triage',
      formData: {
        seriousness: '严重', expectedness: '非预期', deathCase: '否',
        reportDeadline: '2026-10-06', routeDecision: '快速报告',
      },
    });
    check('the PV officer completes the triage step',
      triaged.status === 200, `status ${triaged.status}`);

    const refusedCausality = await api('POST', `/api/records/${caseRec.id}/steps/complete`, entry.cookie, {
      stepCode: 'causality',
      formData: {},
    });
    check('a signature-gated medical step is refused for the clerk (403)',
      refusedCausality.status === 403, `status ${refusedCausality.status}`);

    // ---- account provisioning: create, list, land, sign in ------------------
    const userCreated = await api('POST', '/api/users', admin.cookie, {
      username: 'new.analyst', fullName: '新入职数据录入员', fullNameEn: 'New Data Entry Analyst',
      role: 'pv_data_entry', department: '药物警戒部', jobTitle: 'PV 数据录入员',
      gxpAreas: ['ICSR'], password: 'Temp-Pass-123!', mustChangePassword: true,
    });
    check('an administrator can create a new user',
      userCreated.status === 201 && userCreated.json.user && userCreated.json.user.username === 'new.analyst',
      `status ${userCreated.status}`);

    const choices = await api('GET', '/api/login-choices?', null);
    const persona = (choices.json.personas || []).find((p) => p.username === 'new.analyst');
    check('the new user appears in the identity list',
      Boolean(persona), JSON.stringify((choices.json.personas || []).map((p) => p.username).slice(-3)));
    check('the new user inherits the role\'s scope and landing',
      persona && persona.scope === 'domain' && persona.landing && persona.landing.domain === 'ICSR',
      JSON.stringify(persona && persona.landing));

    const newLogin = await login('new.analyst', 'Temp-Pass-123!');
    check('the new user can sign in with their own password', Boolean(newLogin), 'login failed');

    const icsr = await api('GET', '/api/domain/ICSR?', entry.cookie);
    const deAccounts = icsr.json.roleAccounts && icsr.json.roleAccounts.pv_data_entry
      ? (icsr.json.roleAccounts.pv_data_entry.accounts || []).map((a) => a.username) : [];
    check('the new analyst appears on the ICSR roster',
      deAccounts.includes('new.analyst'), deAccounts.join(', '));

    const audit = await api('GET', '/api/audit?entityType=users&limit=100', admin.cookie);
    const createEntry = (audit.json.rows || []).find(
      (r) => r.action === 'create' && /new\.analyst/.test(JSON.stringify(r))
    );
    check('account creation is on the audit trail',
      Boolean(createEntry), 'no create entry found');

    const chain = await api('GET', '/api/audit/verify', admin.cookie);
    check('the audit chain verifies after case processing and provisioning',
      chain.json && chain.json.ok === true, JSON.stringify(chain.json).slice(0, 120));
  } finally {
    if (server) { try { server.kill(); } catch { /* gone */ } }
    await sleep(600);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n  Operations test crashed: ${err.stack}\n\n`);
  process.exit(1);
});