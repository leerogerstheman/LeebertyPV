'use strict';

/**
 * End-to-end check for the domain workflow explorer.
 *
 * Exercises the real HTTP surface rather than the domain modules directly, so it
 * covers routing, the permission gate on participant management, and the shape
 * the browser actually receives. Run against a scratch database.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const PORT = 8791 + Math.floor(Math.random() * 100);
const DB = path.join(os.tmpdir(), `pv-explorer-${Date.now()}.sqlite`);
const PASSWORD = 'Explorer-Test-2026!';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); }
  else { failed += 1; process.stdout.write(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}\n`); }
}

async function req(method, urlPath, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') };
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  process.stdout.write('\n  LeebertyPV -  workflow explorer end-to-end\n');
  process.stdout.write(`  db: ${DB}\n  port: ${PORT}\n\n`);

  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const env = {
    ...process.env,
    PV_DB_FILE: DB,
    PV_PORT: String(PORT),
    PV_HOST: '127.0.0.1',
    PV_MONITOR: '0',
    PV_SEED: '1',
    PV_BUILTIN_ACCOUNTS: '1',
  };
  const ADMIN = { username: 'exploreradmin', fullName: 'Explorer Administrator', password: PASSWORD };

  // Two generators run before the server: the configuration library first (it
  // loads the GxP areas, process definitions and checklists), then the
  // demonstration dataset. seed-demo.js depends on the former - it fails with
  // "No active process type" if the configuration has not been loaded.
  const runNode = (script) => new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(ROOT, script)], { cwd: ROOT, env, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
  await runNode(path.join('scripts', 'seed.js'));
  await runNode(path.join('scripts', 'seed-demo.js'));

  const child = spawn(NODE, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => { serverOut += d.toString(); });
  child.stderr.on('data', (d) => { serverOut += d.toString(); });

  let cookie = null;
  try {
    const up = await waitForHealth();
    check('server starts and answers /api/health', up, serverOut.slice(-400));
    if (!up) throw new Error('server did not start');

    // ---- sign in -----------------------------------------------------------
    // The instance publishes its demonstration personas at /api/login-choices
    // with the shared credential. Provisioning deliberately does not create a
    // system administrator (that would ship a known privileged account), so the
    // test signs in as the QA manager, who holds user.manage and can therefore
    // exercise the participant-management endpoints.
    const choices = await req('GET', '/api/login-choices');
    check('the instance publishes its login choices', choices.status === 200, `status ${choices.status}`);
    const personas = (choices.body && choices.body.personas) || [];
    const demoPassword = (choices.body && choices.body.password) || null;
    check('login choices include the shared demo credential',
      personas.length > 0 && Boolean(demoPassword), `${personas.length} personas`);

    const manager = personas.find((x) => x.role === 'qa_manager')
      || personas.find((x) => x.role === 'system_admin')
      || personas[0];
    check('a persona holding user.manage is available', Boolean(manager && manager.username),
      personas.map((x) => x.role).join(','));

    const login = await req('POST', '/api/auth/login',
      { username: manager.username, password: demoPassword });
    check('a demonstration persona can sign in', login.status === 200, `status ${login.status}`);
    cookie = login.setCookie ? login.setCookie.split(';')[0] : null;
    check('sign-in returns a session cookie', Boolean(cookie));

    // ---- domain picker data ------------------------------------------------
    const procTypes = await req('GET', '/api/process-types', null, cookie);
    check('GET /api/process-types lists processes', procTypes.status === 200 && Array.isArray(procTypes.body.rows));
    const codes = (procTypes.body.rows || []).map((r) => r.code);
    for (const domain of ['ICSR-EXP', 'ICSR-REG', 'PV-DEV', 'PV-CAPA', 'PV-CHANGE', 'PSUR-COMP', 'SIG-DET', 'SIG-EVAL', 'RMP-LIFE', 'LIT-MON', 'AEFI-EXP', 'COMP-HANDLE']) {
      check(`process type ${domain} is registered`, codes.includes(domain));
    }

    // ---- the explorer payload ---------------------------------------------
    const exp = await req('GET', '/api/explorer/ICSR-EXP', null, cookie);
    check('GET /api/explorer/:code returns the flow', exp.status === 200, `status ${exp.status}`);
    const p = exp.body || {};
    const expSteps = p.steps || [];
    const expParticipants = p.participants || [];
    check('payload carries the process definition', Boolean(p.process && p.process.code === 'ICSR-EXP'));
    check('payload lists annotated steps', Array.isArray(p.steps) && expSteps.length === 8);
    check('steps carry participation kind', expSteps.length > 0 && expSteps.every((s) => Boolean(s.participationKind)));
    check('payload lists participants with duties', expParticipants.length > 0 && expParticipants.every((x) => Boolean(x.duty)));
    check('payload derives hand-offs', Array.isArray(p.handoffs) && p.handoffs.length === 7);
    check('payload exposes the three-state matrix', Boolean(p.matrix && p.matrix.groups.length));
    check('matrix exposes code-enforced constraints', Boolean(p.matrix) && p.matrix.constraintCount >= 15,
      `constraintCount=${p.matrix && p.matrix.constraintCount}`);

    // Every participant must be signable-in for the click-through to work.
    const loginable = expParticipants.filter((x) => x.loginable).length;
    check('every ICSR-EXP participant has an account', expParticipants.length > 0 && loginable === expParticipants.length,
      `${loginable}/${expParticipants.length}`);

    // ---- the three states are genuinely present ---------------------------
    const cellStates = new Set();
    for (const g of (p.matrix ? p.matrix.groups : [])) for (const r of g.rows) for (const c of r.cells) cellStates.add(c.state);
    check('matrix produces all three states', cellStates.has('allowed') && cellStates.has('denied') && cellStates.has('conditional'),
      [...cellStates].join(','));

    // A conditional cell must carry resolvable constraint references, and every
    // referenced constraint must state its reason and its regulatory basis. Cells
    // hold IDs rather than copies, so this also checks the index is complete.
    const cIndex = (p.matrix && p.matrix.constraintIndex) || {};
    let conditionalWithReason = 0;
    let conditionalTotal = 0;
    let danglingIds = 0;
    for (const g of (p.matrix ? p.matrix.groups : [])) {
      for (const r of g.rows) {
        for (const c of r.cells) {
          if (c.state !== 'conditional') continue;
          conditionalTotal += 1;
          const ids = c.constraintIds || [];
          let allGood = ids.length > 0;
          for (const id of ids) {
            const k = cIndex[id];
            if (!k) { danglingIds += 1; allGood = false; continue; }
            if (!k.reason || !k.basis) allGood = false;
          }
          if (allGood) conditionalWithReason += 1;
        }
      }
    }
    check('every conditional cell states its reason and basis',
      conditionalTotal > 0 && conditionalWithReason === conditionalTotal && danglingIds === 0,
      `${conditionalWithReason}/${conditionalTotal} resolved, ${danglingIds} dangling id(s)`);

    // ---- the demo credential is disclosed WITH its warning ----------------
    check('demo login is disclosed', Boolean(p.demoLogin && p.demoLogin.enabled && p.demoLogin.password));
    check('demo login carries the Part 11 warning',
      Boolean(p.demoLogin && p.demoLogin.warning && /11\.300/.test(p.demoLogin.warning)));

    // ---- constraints catalogue --------------------------------------------
    const cons = await req('GET', '/api/constraints', null, cookie);
    check('GET /api/constraints returns the catalogue', cons.status === 200 && cons.body.count >= 15);
    check('constraints name where they are enforced',
      cons.body.constraints.every((c) => Boolean(c.enforcedAt && c.basis)));

    // ---- assignable roles are a closed set --------------------------------
    const roles = await req('GET', '/api/assignable-roles', null, cookie);
    check('GET /api/assignable-roles lists the RBAC roles', roles.status === 200 && roles.body.roles.length === 15,
      `count=${roles.body.roles && roles.body.roles.length}`);
    check('assignable roles state they cannot be invented', Boolean(roles.body.note));

    // ---- role detail -------------------------------------------------------
    const roleDetail = await req('GET', '/api/roles/qa_manager', null, cookie);
    check('GET /api/roles/:role returns permissions', roleDetail.status === 200 && roleDetail.body.rows.length > 20);
    check('role detail summarises the three states',
      roleDetail.body.summary.allowed + roleDetail.body.summary.conditional + roleDetail.body.summary.denied > 0);

    // ---- participant management -------------------------------------------
    const before = await req('GET', '/api/explorer/PSUR-COMP/participants', null, cookie);
    check('GET participants returns the cast', before.status === 200 && before.body.active.length > 0);
    const castBefore = before.body.active.length;

    const addUnknown = await req('POST', '/api/explorer/PSUR-COMP/participants',
      { role: 'chief_wizard', reason: 'should be refused' }, cookie);
    check('an invented role is refused', addUnknown.status === 400 && addUnknown.body.error === 'UNKNOWN_ROLE',
      `status ${addUnknown.status} code ${addUnknown.body && addUnknown.body.error}`);

    const add = await req('POST', '/api/explorer/PSUR-COMP/participants',
      { role: 'trainer', reason: 'Explorer test: add the trainer role' }, cookie);
    check('a real role can be added', add.status === 201, `status ${add.status}`);
    check('the cast grew by one', add.body.active.length === castBefore + 1,
      `${castBefore} -> ${add.body.active.length}`);

    const addAgain = await req('POST', '/api/explorer/PSUR-COMP/participants',
      { role: 'trainer', reason: 'duplicate' }, cookie);
    check('adding the same role twice is refused', addAgain.status === 409 && addAgain.body.error === 'ALREADY_PARTICIPANT',
      `status ${addAgain.status} code ${addAgain.body && addAgain.body.error}`);

    const remove = await req('DELETE', '/api/explorer/PSUR-COMP/participants/trainer',
      { reason: 'Explorer test: remove it again' }, cookie);
    check('a participant can be removed', remove.status === 200 && remove.body.active.length === castBefore);

    // ---- unknown process ---------------------------------------------------
    const missing = await req('GET', '/api/explorer/NOT-A-PROCESS', null, cookie);
    check('an unknown process returns 404', missing.status === 404);

    // ---- the removal left a trace in the audit trail -----------------------
    const audit = await req('GET', '/api/audit?entityType=demo_participants', null, cookie);
    const entries = (audit.body && (audit.body.rows || audit.body.entries)) || [];
    check('participant changes are written to the audit trail', entries.length >= 2,
      `${entries.length} entries`);
    check('audit entries record that no GxP record was altered',
      entries.length > 0 && entries.every((e) => !e.meta || !e.meta.note || /no GxP record/.test(e.meta.note)));

    // ---- the chain still verifies after all of that ------------------------
    const verify = await req('GET', '/api/audit/verify', null, cookie);
    check('audit chain still verifies', verify.status === 200 && verify.body.ok === true,
      JSON.stringify(verify.body).slice(0, 200));

    // ---- sign in as a participant and confirm the view differs -------------
    const asOperator = await req('POST', '/api/auth/login',
      { username: 'demo.intake', password: require(path.join(ROOT, 'src', 'domain', 'accounts')).BUILTIN_PASSWORD });
    check('a built-in persona can sign in with the demo password', asOperator.status === 200,
      `status ${asOperator.status}`);
    if (asOperator.status === 200) {
      const pCookie = asOperator.setCookie.split(';')[0];
      const pInbox = await req('GET', '/api/inbox', null, pCookie);
      const qCookie = cookie;
      const qaInbox = await req('GET', '/api/inbox', null, qCookie);
      check('the inbox differs between an operator and the QA manager',
        pInbox.status === 200 && qaInbox.status === 200
          && (pInbox.body.counts.toApprove || 0) !== (qaInbox.body.counts.toApprove || 0),
        `operator=${pInbox.body.counts && pInbox.body.counts.toApprove} qa=${qaInbox.body.counts && qaInbox.body.counts.toApprove}`);

      // An operator must not be able to manage participants.
      const forbidden = await req('POST', '/api/explorer/PSUR-COMP/participants',
        { role: 'trainer', reason: 'operator should not be allowed' }, pCookie);
      check('a participant without explorer.manage cannot add participants', forbidden.status === 403,
        `status ${forbidden.status}`);
    }

    // ---- every workflow, every participant, all clickable -----------------
    let allOk = true;
    const problems = [];
    for (const code of codes) {
      const r = await req('GET', `/api/explorer/${encodeURIComponent(code)}`, null, cookie);
      if (r.status !== 200) { allOk = false; problems.push(`${code}: HTTP ${r.status}`); continue; }
      const noAcct = r.body.participants.filter((x) => !x.loginable).map((x) => x.role);
      if (noAcct.length) { allOk = false; problems.push(`${code}: no account for ${noAcct.join(',')}`); }
      if (!r.body.participants.every((x) => x.duty)) { allOk = false; problems.push(`${code}: missing duty text`); }
      if (!r.body.matrix || !r.body.matrix.groups.length) { allOk = false; problems.push(`${code}: empty matrix`); }
    }
    check(`all ${codes.length} workflows expose a complete, clickable explorer`, allOk, problems.join(' | '));
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 600));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB + suffix); } catch { /* already gone */ }
    }
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n  Explorer test crashed: ${err.stack}\n\n`);
  process.exit(1);
});
