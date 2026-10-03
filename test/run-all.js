'use strict';

/**
 * Run every suite in order and aggregate the result.
 *
 * Each suite already exits 0 on success and 1 on failure, so this runner
 * aggregates exit codes rather than parsing output. That keeps it independent of
 * how any individual suite words its summary line.
 *
 * Child output is inherited rather than piped: under a confined sandbox a
 * `stdio: 'pipe'` spawn is refused outright, and there is nothing to gain from
 * capturing text that is meant to be read.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Ordered by how much a failure explains. The engine suite runs first because a
 * break there makes every later failure a symptom rather than a cause; the
 * browser suites run last because they are the slowest and the most likely to be
 * skipped.
 */
const SUITES = [
  ['pv-engine.js', 'GVP reporting clock, MedDRA coding, signal detection statistics'],
  ['e2e.js', 'core engine, signatures, permission gates, audit chain'],
  ['monitor.js', 'background scan rules and idempotency'],
  ['inbox.js', 'pending-work aggregation and action classification'],
  ['explorer.js', 'domain workflow view, three-state permission matrix'],
  ['firstrun.js', 'first-run initialisation from an empty directory'],
  ['audit-roles.js', 'visibility model, auditor independence, time-boxed access'],
  ['assets.js', 'browser DOM, responsibility cascade, restricted cards, CSS coverage'],
  ['identity-flow.js', 'identity-first start-up, password check, landing destinations'],
  ['operations.js', 'safety record execution, PV officer inbox, account provisioning'],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/**
 * A clean environment for each suite: strip the PV_* namespace inherited from
 * the shell so a local export cannot silently redirect a suite's scratch
 * database. `PV_EDGE` is kept deliberately - locating the browser is a
 * legitimate machine-level override.
 */
const KEEP = new Set(['PV_EDGE']);

function suiteEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PV_') && !KEEP.has(key)) delete env[key];
  }
  return env;
}

function main() {
  const chosen = only.length
    ? SUITES.filter(([file]) => only.some((o) => file.includes(o)))
    : SUITES;

  if (!chosen.length) {
    process.stdout.write(`\n  No suite matched: ${only.join(', ')}\n`);
    process.stdout.write(`  Available: ${SUITES.map(([f]) => f).join(', ')}\n\n`);
    process.exit(1);
  }

  process.stdout.write('\n  LeebertyPV -  full test run\n');
  process.stdout.write(`  ${chosen.length} suite(s), node ${process.version}\n`);

  const results = [];
  const started = Date.now();

  for (const [file, description] of chosen) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) {
      results.push({ file, description, status: 'missing', ms: 0 });
      process.stdout.write(`\n  ── ${file} - FILE NOT FOUND\n`);
      continue;
    }

    process.stdout.write(`\n  ── ${file}  (${description})\n`);
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [full], {
      cwd: ROOT,
      stdio: 'inherit',
      env: suiteEnv(),
    });
    const ms = Date.now() - t0;

    // A suite killed by a signal is a failure even though it produced no exit
    // code; treating it as anything else would let an interrupted run report
    // green.
    const status = res.error ? 'error'
      : (res.signal ? 'signal' : (res.status === 0 ? 'pass' : 'fail'));
    results.push({ file, description, status, ms, signal: res.signal, error: res.error });
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.length - passed;

  process.stdout.write(`\n${'='.repeat(66)}\n`);
  process.stdout.write('  suite results\n');
  process.stdout.write(`${'='.repeat(66)}\n`);
  for (const r of results) {
    const mark = r.status === 'pass' ? '\u2713' : '\u2717';
    const detail = r.status === 'pass' ? '' : `  ${r.status}${r.signal ? ` (${r.signal})` : ''}`;
    process.stdout.write(`  ${mark} ${r.file.padEnd(18)} ${String((r.ms / 1000).toFixed(1)).padStart(6)}s${detail}\n`);
  }
  process.stdout.write(`${'='.repeat(66)}\n`);
  process.stdout.write(`  ${passed}/${results.length} suites passed in ${seconds}s\n`);

  if (failed) {
    process.stdout.write('\n  Failing suites:\n');
    for (const r of results.filter((x) => x.status !== 'pass')) {
      process.stdout.write(`    ${r.file}  - ${r.error ? r.error.message : r.status}\n`);
    }
  }
  process.stdout.write('\n');

  process.exit(failed === 0 ? 0 : 1);
}

main();
