'use strict';

/**
 * Checks for the two monitoring roles and the visibility model they sit in.
 *
 * These rules are the kind that silently rot: a visibility rule that drifts looks
 * like a working screen, a self-audit restriction that stops firing looks like a
 * permitted inspection, and an expiry that stops being enforced looks like a
 * normal sign-in. None of them produce an error when they break, so each is
 * asserted against the running system rather than trusted.
 *
 * The design being tested was arrived at by rejecting an earlier one: roles were
 * to be ranked in levels, with a higher level able to see everyone beneath it.
 * That was refused because GxP separates duties functionally, not by seniority -
 * a QA manager cannot close a record they authored, and an administrator cannot
 * be the sole approver of anything. The assertions below encode the replacement.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); }
  else { failed += 1; process.stdout.write(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}\n`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a snippet inside the project, against a given database. */
function run(code, dbFile) {
  const { execFileSync } = require('node:child_process');
  try {
    return {
      ok: true,
      out: execFileSync(NODE, ['-e', code], {
        cwd: ROOT,
        env: { ...process.env, PV_DB_FILE: dbFile, PV_BUILTIN_ACCOUNTS: '1' },
        encoding: 'utf8',
        timeout: 60000,
      }).trim(),
    };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}${err.message}` };
  }
}

async function main() {
  process.stdout.write('\n  LeebertyPV -  monitoring roles and visibility\n\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-roles-'));
  const dbFile = path.join(dataDir, 'pv.db');
  const port = 8810 + Math.floor(Math.random() * 40);
  let child = null;

  try {
    // Seed an instance the checks can read.
    const seeded = run(
      "const d=require('./src/core/db');const s=require('./src/seed');d.open();s.run({silent:true});d.close();",
      dbFile
    );
    check('the instance seeds', seeded.ok, seeded.out.slice(-300));
    // Provision the built-in personas as well. The external inspector is one of
    // them, and provisioning normally happens when the server starts - a test that
    // only runs the two seeders would have no external auditor to test, and would
    // report a failure of the feature rather than a gap in the fixture.
    const provisioned = run(`
      const acc = require('./src/domain/accounts');
      const db = require('./src/core/db'); db.open();
      const s = acc.provision(null, { ip: '127.0.0.1', userAgent: 'test', sessionId: null });
      const ext = db.get("SELECT username FROM users WHERE role='auditor_external'");
      process.stdout.write(JSON.stringify({ enabled: s.enabled, created: s.created, refreshed: s.refreshed, external: ext ? ext.username : null }));
      db.close();
    `, dbFile);
    check('the built-in cast is provisioned, including the external inspector',
      provisioned.ok && JSON.parse(provisioned.out || '{}').external,
      provisioned.out.slice(-260));
    const { execFileSync } = require('node:child_process');
    execFileSync(NODE, [path.join(ROOT, 'scripts', 'seed-demo.js')], {
      cwd: ROOT, env: { ...process.env, PV_DB_FILE: dbFile, PV_BUILTIN_ACCOUNTS: '1' }, stdio: 'ignore', timeout: 120000,
    });

    // ---- the visibility model ---------------------------------------------
    const vis = run(`
      const v = require('./src/domain/visibility');
      const a = require('./src/domain/accounts');
      const db = require('./src/core/db'); db.open();
      const home = a.homeAreasByRole();
      const areas = (r) => Object.keys(home[r] || {});
      const see = (x, y) => v.canSeePerson({ role: x, homeAreas: areas(x) }, { role: y, homeAreas: areas(y) });
      const out = {
        scope_qa_manager: v.scopeFor('qa_manager', areas('qa_manager')).scope,
        scope_pv_writer: v.scopeFor('pv_writer', areas('pv_writer')).scope,
        scope_system_admin: v.scopeFor('system_admin', []).scope,
        sameArea: see('pv_writer', 'pv_medical').allowed,
        otherArea: see('pv_writer', 'safety_committee').allowed,
        qaCrosses: see('qa_manager', 'pv_medical').allowed,
        auditorCrosses: see('qa_auditor', 'pv_officer').allowed,
        externalCrosses: see('auditor_external', 'pv_officer').allowed,
        adminCrosses: see('system_admin', 'pv_writer').allowed,
        reasonCarried: Boolean(see('pv_writer', 'safety_committee').reason),
      };
      db.close();
      process.stdout.write(JSON.stringify(out));
    `, dbFile);
    check('the visibility model runs', vis.ok, vis.out.slice(-300));
    if (vis.ok) {
      const d = JSON.parse(vis.out);
      check('a cross-domain function sees across areas',
        d.scope_qa_manager === 'cross_domain' && d.qaCrosses && d.auditorCrosses && d.externalCrosses,
        JSON.stringify(d));
      check('a domain role sees only its own area',
        d.scope_pv_writer === 'own_area' && d.sameArea && !d.otherArea,
        JSON.stringify(d));
      check('an administrator gains no visibility from technical access',
        d.scope_system_admin === 'public' && !d.adminCrosses,
        `scope=${d.scope_system_admin} crosses=${d.adminCrosses}`);
      check('every refusal carries its reason', d.reasonCarried);
    }

    // ---- the internal auditor may not inspect their own area ---------------
    const sod = run(`
      const insp = require('./src/domain/inspections');
      const db = require('./src/core/db'); db.open();
      const ctx = { ip: '127.0.0.1', userAgent: 'test' };
      const auditor = db.get("SELECT * FROM users WHERE role='qa_auditor' AND status='active' ORDER BY id LIMIT 1");
      const qam = db.get("SELECT * FROM users WHERE role='qa_manager' AND status='active' ORDER BY id LIMIT 1");
      const attempt = (actor, areas) => {
        try {
          const r = insp.createInspection({ title: 'probe', inspectionType: 'self_inspection', gxpAreas: areas }, actor, ctx);
          db.run('DELETE FROM inspections WHERE code = ?', [r.code]);
          return { refused: false };
        } catch (e) { return { refused: true, code: e.code, status: e.status }; }
      };
      // The PV auditor persona declares GVP as its area; the independence rule
      // falls back to the account's declared areas when the role has no derived
      // home areas, so the refusal must hold for that declaration.
      const home = JSON.parse(auditor.gxp_areas || '[]');
      const out = {
        homeAreas: home,
        ownArea: home.length ? attempt(auditor, [home[0]]) : { refused: true, code: 'NO_HOME' },
        foreignArea: attempt(auditor, ['ICSR']),
        qaManagerOwnArea: attempt(qam, home.length ? [home[0]] : ['GVP']),
        refusalLogged: db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE action='inspection_self_audit_refused'").n,
      };
      db.close();
      process.stdout.write(JSON.stringify(out));
    `, dbFile);
    check('the self-audit rule runs', sod.ok, sod.out.slice(-300));
    if (sod.ok) {
      const d = JSON.parse(sod.out);
      check('an internal auditor is refused in their own area',
        d.ownArea.refused && d.ownArea.code === 'SELF_AUDIT_NOT_INDEPENDENT',
        JSON.stringify(d.ownArea));
      check('an internal auditor may inspect an area they do not work in',
        !d.foreignArea.refused, JSON.stringify(d.foreignArea));
      check('a QA manager may inspect their own area (management review)',
        !d.qaManagerOwnArea.refused, JSON.stringify(d.qaManagerOwnArea));
      check('a refused self-audit is itself recorded',
        d.refusalLogged > 0, `${d.refusalLogged} entries`);
    }

    // ---- time-boxed external access ----------------------------------------
    // The account is looked up by role and explicitly reset first, because an
    // earlier check may legitimately have left it expired - that is what the rule
    // does. A test that only finds active accounts would skip silently the moment
    // the feature it is testing actually fired.
    const exp = run(`
      const auth = require('./src/core/auth');
      const db = require('./src/core/db'); db.open();
      const acc = require('./src/domain/accounts');
      const ctx = { ip: '127.0.0.1', userAgent: 'test' };
      const ext = db.get("SELECT * FROM users WHERE role='auditor_external' ORDER BY id LIMIT 1");
      // A bare return is illegal in an eval'd script, so the missing case is a
      // branch rather than an early exit.
      if (!ext) {
        process.stdout.write(JSON.stringify({ missing: true }));
      } else {
        db.run("UPDATE users SET access_expires_at=NULL, status='active' WHERE id=?", [ext.id]);
        const tryLogin = () => auth.login({
          username: ext.username, password: acc.BUILTIN_PASSWORD, ctx,
        });
        const none = tryLogin();
        db.run("UPDATE users SET access_expires_at=?, status='active' WHERE id=?", [new Date(Date.now()+86400000).toISOString(), ext.id]);
        const future = tryLogin();
        db.run("UPDATE users SET access_expires_at=?, status='active' WHERE id=?", [new Date(Date.now()-3600000).toISOString(), ext.id]);
        const past = tryLogin();
        const statusAfter = db.get('SELECT status FROM users WHERE id=?', [ext.id]).status;
        const logged = db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE action='account_expired'").n;
        db.run("UPDATE users SET access_expires_at=NULL, status='active' WHERE id=?", [ext.id]);
        process.stdout.write(JSON.stringify({
          username: ext.username,
          noExpiry: none.ok, future: future.ok,
          pastRefused: !past.ok, pastCode: past.code, pastReason: past.reason,
          statusAfter, logged,
        }));
      }
      db.close();
    `, dbFile);
    check('the expiry rule runs', exp.ok, exp.out.slice(-300));
    if (exp.ok) {
      const d = JSON.parse(exp.out);
      check('an external inspector account exists to test', !d.missing, JSON.stringify(d));
      check('an account with no end date signs in', d.noExpiry);
      check('an account whose access has not yet ended signs in', d.future);
      check('an expired account is refused',
        d.pastRefused && d.pastCode === 'ACCESS_EXPIRED', JSON.stringify(d));
      check('the refusal says why, rather than looking like a wrong password',
        Boolean(d.pastReason) && /到期|expired/i.test(d.pastReason), d.pastReason);
      check('an expired account is marked expired', d.statusAfter === 'expired', d.statusAfter);
      check('the expiry is recorded in the audit trail', d.logged > 0, `${d.logged} entries`);
    }

    // ---- the two roles are genuinely different ------------------------------
    const roles = run(`
      const rbac = require('./src/core/rbac');
      const a = rbac.permissionsFor('qa_auditor'), b = rbac.permissionsFor('auditor_external');
      const has = (set, p) => set.includes('*') || set.includes(p);
      process.stdout.write(JSON.stringify({
        internalCount: a.length, externalCount: b.length,
        internalCanCreate: has(a, 'record.create'),
        externalCanCreate: has(b, 'record.create'),
        internalCanInspect: has(a, 'inspection.manage'),
        externalCanInspect: has(b, 'inspection.manage'),
        externalReadOnly: Boolean(rbac.ROLES.auditor_external.readOnly),
        internalReadOnly: Boolean(rbac.ROLES.qa_auditor.readOnly),
      }));
    `, dbFile);
    check('both roles exist with distinct permissions', roles.ok, roles.out.slice(-200));
    if (roles.ok) {
      const d = JSON.parse(roles.out);
      check('the internal auditor can act: create records and run inspections',
        d.internalCanCreate && d.internalCanInspect && !d.internalReadOnly, JSON.stringify(d));
      check('the external inspector is strictly read-only',
        !d.externalCanCreate && !d.externalCanInspect && d.externalReadOnly, JSON.stringify(d));
    }

    // ---- and the instance still serves -------------------------------------
    child = spawn(NODE, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env, PV_DB_FILE: dbFile, PV_BUILTIN_ACCOUNTS: '1',
        PV_PORT: String(port), PV_HOST: '127.0.0.1', PV_MONITOR: '0',
      },
      stdio: 'ignore',
    });
    let up = false;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.status === 200) { up = true; break; }
      } catch { /* not yet */ }
      await sleep(400);
    }
    check('the instance still starts and serves after these changes', up);

    if (up) {
      const choices = await (await fetch(`http://127.0.0.1:${port}/api/login-choices`)).json();
      const icsr = choices.domains.find((d) => d.code === 'ICSR');
      const gvp = choices.domains.find((d) => d.code === 'GVP');
      check('a domain offers only the identities that work in it',
        icsr && gvp && icsr.personaCount < gvp.personaCount && icsr.personaCount > 0,
        `ICSR ${icsr && icsr.personaCount}, GVP ${gvp && gvp.personaCount}`);
      check('the domains are not all the same list',
        new Set(choices.domains.map((d) => d.personaCount)).size > 1,
        choices.domains.map((d) => `${d.code}:${d.personaCount}`).join(' '));
      const admin = choices.personas.find((p) => p.role === 'system_admin');
      check('the administrator is offered no domain to enter',
        !admin || !choices.domains.some((d) => d.personaRoles.includes('system_admin')),
        'system_admin appears in a domain roster');

      // ---- export of the audit trail is itself recorded --------------------
      const signIn = async (role) => {
        const who = choices.personas.find((p) => p.role === role);
        if (!who) return null;
        const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: who.username, password: choices.password }),
        });
        if (r.status !== 200) return null;
        return { cookie: r.headers.get('set-cookie').split(';')[0], username: who.username };
      };

      const ext = await signIn('auditor_external');
      check('the external inspector can sign in', Boolean(ext));
      if (ext) {
        const before = await (await fetch(`http://127.0.0.1:${port}/api/audit?action=export`,
          { headers: { cookie: ext.cookie } })).json();
        const beforeCount = (before.rows || []).length;

        const csv = await fetch(`http://127.0.0.1:${port}/api/audit/export?format=csv`,
          { headers: { cookie: ext.cookie } });
        const text = await csv.text();
        check('the external inspector can export the audit trail',
          csv.status === 200 && text.split('\n').length > 10,
          `HTTP ${csv.status}, ${text.split('\n').length} lines`);

        const after = await (await fetch(`http://127.0.0.1:${port}/api/audit?action=export`,
          { headers: { cookie: ext.cookie } })).json();
        const rows = after.rows || [];
        check('the export added an entry to the audit trail',
          rows.length === beforeCount + 1, `${beforeCount} -> ${rows.length}`);
        const entry = rows.find((r) => r.actor_username === ext.username);
        check('the export entry names who took the copy',
          Boolean(entry), JSON.stringify(rows[0] || {}).slice(0, 160));
        check('the export entry records how much left and under what filter',
          Boolean(entry) && /entries/.test(String(entry.reason)) && /\d+/.test(String(entry.reason)),
          entry ? String(entry.reason).slice(0, 120) : 'no entry');

        // The chain is verified as somebody who holds audit.verify. The external
        // inspector deliberately does not: recomputing the hash chain is a
        // technical integrity operation performed by the organisation, and the
        // inspector receives the result rather than running it. That is a design
        // decision, so this asserts the boundary as well as the outcome.
        const verifyDenied = await fetch(`http://127.0.0.1:${port}/api/audit/verify`,
          { headers: { cookie: ext.cookie } });
        check('the external inspector cannot recompute the audit chain',
          verifyDenied.status === 403, `status ${verifyDenied.status}`);

        const verifier = await signIn('qa_manager');
        if (verifier) {
          const verify = await (await fetch(`http://127.0.0.1:${port}/api/audit/verify`,
            { headers: { cookie: verifier.cookie } })).json();
          check('the chain still verifies after the export was recorded',
            verify.ok === true, JSON.stringify(verify).slice(0, 160));
        }
      }

      // ---- the domain payload carries the visibility decisions -------------
      const qaLogin = await signIn('qa_manager');
      const pvMedicalLogin = await signIn('pv_medical');
      check('a signed-in viewer is available for the visibility checks', Boolean(qaLogin));
      if (qaLogin) {
        const d = await (await fetch(`http://127.0.0.1:${port}/api/domain/ICSR`,
          { headers: { cookie: qaLogin.cookie } })).json();
        check('the domain payload carries a visibility decision per participant',
          d.visibility && d.visibility.decisions
            && Object.keys(d.visibility.decisions).length === d.participants.length,
          `${d.visibility && Object.keys(d.visibility.decisions).length} decisions for ${d.participants.length} roles`);
        check('a cross-domain viewer is told they may see everyone',
          d.visibility.scope === 'cross_domain'
            && Object.values(d.visibility.decisions).every((x) => x.allowed),
          `scope=${d.visibility.scope}`);
        check('every decision carries a reason the interface can show',
          Object.values(d.visibility.decisions).every((x) => x.reason && x.reasonEn),
          JSON.stringify(Object.values(d.visibility.decisions)[0] || {}).slice(0, 140));
      }

      const adminLogin = await signIn('system_admin');
      if (!adminLogin) {
        // The administrator is provisioned rather than seeded; make one if absent.
        process.stdout.write('  (no administrator persona to check the refusal path)\n');
      }
    }
  } finally {
    if (child) { try { child.kill(); } catch { /* gone */ } }
    await sleep(700);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n  Monitoring-roles test crashed: ${err.stack}\n\n`);
  process.exit(1);
});
