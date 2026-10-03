'use strict';

/**
 * End-to-end check for first-run provisioning.
 *
 * The claim being tested is the one that matters most to somebody opening this
 * for the first time: a single launch against an empty data directory produces a
 * usable, populated workbench. Everything the application needs - schema, audit
 * key, configuration library, demonstration accounts, demonstration dataset -
 * has to appear without a second command.
 *
 * The counterpart claim matters just as much: a second launch must change
 * nothing. Re-seeding would duplicate records into the audit trail, which is the
 * one thing this system exists to prevent.
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

/**
 * Launch the server against a given data directory and wait until it answers.
 * Returns the child, its collected output, and the port it chose.
 */
async function launch(dataDir, port, extraEnv = {}) {
  const env = {
    ...process.env,
    // PV_DATA_DIR, not just PV_DB_FILE: the audit chain key and the exports
    // and backups folders are derived from it, so isolating only the database
    // would leave the key in the real data directory and the test would be
    // verifying - and polluting - the developer's own instance.
    PV_DATA_DIR: dataDir,
    PV_DB_FILE: path.join(dataDir, 'pv.db'),
    PV_PORT: String(port),
    PV_HOST: '127.0.0.1',
    PV_MONITOR: '0',
    PV_BUILTIN_ACCOUNTS: '1',
    ...extraEnv,
  };

  const child = spawn(NODE, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const deadline = Date.now() + 90000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) {
        const body = await res.json();
        // The readiness gate returns 503 until provisioning finishes, so a 200
        // with a real chain count means the instance is genuinely serving.
        if (body.auditChain && typeof body.auditChain.checked === 'number') { healthy = true; break; }
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return { child, output: () => output, healthy, port };
}

async function stop(child) {
  try { child.kill(); } catch { /* already gone */ }
  await sleep(900);
}

function readCounts(dataDir) {
  const dbPath = path.join(dataDir, 'pv.db');
  if (!fs.existsSync(dbPath)) return null;
  // Read through the application's own module so the schema is what it expects.
  const { execFileSync } = require('node:child_process');
  const script = `
    const db = require(${JSON.stringify(path.join(ROOT, 'src', 'core', 'db'))});
    db.open();
    const one = (sql) => { try { return db.get(sql).n; } catch { return -1; } };
    process.stdout.write(JSON.stringify({
      instances: one('SELECT COUNT(*) AS n FROM workflow_instances'),
      audits: one('SELECT COUNT(*) AS n FROM audit_trail'),
      users: one("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
      processes: one('SELECT COUNT(*) AS n FROM process_types WHERE active = 1'),
      templates: one('SELECT COUNT(*) AS n FROM checklist_templates WHERE active = 1'),
      signatures: one('SELECT COUNT(*) AS n FROM signatures'),
    }));
    db.close();
  `;
  try {
    const out = execFileSync(NODE, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, PV_DB_FILE: dbPath },
      encoding: 'utf8',
      timeout: 30000,
    });
    return JSON.parse(out.trim());
  } catch (err) {
    return { error: err.message };
  }
}

async function main() {
  process.stdout.write('\n  LeebertyPV -  first-run provisioning\n\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-firstrun-'));
  const port = 8770 + Math.floor(Math.random() * 15);
  const port2 = port + 30;
  let first = null;
  let second = null;

  try {
    // ---- the data directory starts empty, with no audit key ----------------
    check('the data directory starts completely empty',
      fs.readdirSync(dataDir).length === 0,
      fs.readdirSync(dataDir).join(', '));

    // ---- ONE launch -------------------------------------------------------
    const started = Date.now();
    first = await launch(dataDir, port);
    const elapsed = (Date.now() - started) / 1000;
    check('a single launch brings the instance up on an empty directory',
      first.healthy, first.output().slice(-500));
    if (!first.healthy) throw new Error('the server did not become healthy');

    // ---- everything it needs appeared by itself ---------------------------
    check('the audit chain key was generated in the isolated data directory',
      fs.existsSync(path.join(dataDir, 'audit-chain.key')),
      fs.readdirSync(dataDir).join(', '));
    check('the database file was created in the isolated data directory',
      fs.existsSync(path.join(dataDir, 'pv.db')),
      fs.readdirSync(dataDir).join(', '));

    const counts = readCounts(dataDir);
    check('the configuration library was loaded',
      counts.processes === 12 && counts.templates === 11,
      `${counts.processes} process types, ${counts.templates} checklists`);
    check('the demonstration accounts were provisioned',
      counts.users >= 20, `${counts.users} active accounts`);
    check('the demonstration dataset was generated',
      counts.instances >= 15, `${counts.instances} quality records`);
    check('the audit trail recorded the seeding',
      counts.audits > 350, `${counts.audits} entries`);
    check('the generated records carry real signatures',
      counts.signatures > 50, `${counts.signatures} signatures`);
    check('provisioning finished in a reasonable time',
      elapsed < 60, `${elapsed.toFixed(1)}s`);

    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    check('the audit chain verifies after provisioning',
      health.auditChain.ok === true, JSON.stringify(health.auditChain).slice(0, 200));

    // ---- the first screen is reachable without a session ------------------
    const domains = await fetch(`http://127.0.0.1:${port}/api/domains`);
    const domainsBody = await domains.json();
    check('the domain picker works immediately, with no session',
      domains.status === 200 && (domainsBody.domains || []).length === 8,
      `status ${domains.status}`);

    const choices = await (await fetch(`http://127.0.0.1:${port}/api/login-choices`)).json();
    check('the identity roster is populated on the domain screens',
      (choices.personas || []).length >= 20, `${(choices.personas || []).length} identities`);

    // ---- a second launch must change nothing ------------------------------
    await stop(first.child);
    first = null;

    second = await launch(dataDir, port2);
    check('a second launch also comes up', second.healthy, second.output().slice(-400));

    const after = readCounts(dataDir);
    check('the second launch did not generate another dataset',
      after.instances === counts.instances,
      `${counts.instances} -> ${after.instances}`);
    check('the second launch did not duplicate audit entries',
      after.audits === counts.audits,
      `${counts.audits} -> ${after.audits}`);
    check('the second launch did not duplicate accounts',
      after.users === counts.users, `${counts.users} -> ${after.users}`);
    check('the audit chain still verifies after the second launch',
      (await (await fetch(`http://127.0.0.1:${port2}/api/health`)).json()).auditChain.ok === true);
  } finally {
    if (first) await stop(first.child);
    if (second) await stop(second.child);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n  First-run test crashed: ${err.stack}\n\n`);
  process.exit(1);
});
