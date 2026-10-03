'use strict';

/**
 * Verify the integrity of the audit trail hash chain.
 *
 *   node scripts/verify-audit.js
 *   node scripts/verify-audit.js --record DEV-2026-0001
 *   node scripts/verify-audit.js --seal "pre-inspection seal"
 *
 * Exit codes:
 *   0  chain verified
 *   2  chain broken  (treat as a data integrity incident)
 *   1  usage or database error
 *
 * This script is the command-line equivalent of the "Verify integrity" button in
 * the UI, and is intended to be run before an inspection and after any restore
 * of the database, with the output filed as evidence.
 */

const db = require('../src/core/db');
const audit = require('../src/core/audit');

function parseArgs(argv) {
  const args = { record: null, seal: null, json: false, from: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--record') args.record = argv[++i];
    else if (a === '--seal') args.seal = argv[++i] || 'manual seal';
    else if (a === '--from') args.from = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write([
      '',
      '  Verify the GxP Workbench audit trail hash chain.',
      '',
      '  Usage:',
      '    node scripts/verify-audit.js [options]',
      '',
      '  Options:',
      '    --record <key>   also dump the version history of one record',
      '    --from <seq>     verify only from this sequence number onwards',
      '    --seal <label>   create a tamper-evident seal when verification passes',
      '    --json           emit machine-readable output',
      '    --help           show this help',
      '',
    ].join('\n'));
    process.exit(0);
  }

  db.open();

  const startedAt = Date.now();
  const result = audit.verifyChain(args.from ? { fromSeq: args.from } : {});
  const elapsed = Date.now() - startedAt;

  const total = db.get('SELECT COUNT(*) AS n FROM audit_trail').n;
  const first = db.get('SELECT seq, at FROM audit_trail ORDER BY seq ASC LIMIT 1');
  const last = db.get('SELECT seq, at, chain_hash FROM audit_trail ORDER BY seq DESC LIMIT 1');

  let recordReport = null;
  if (args.record) {
    recordReport = audit.verifyRecordHistory(args.record);
  }

  let seal = null;
  if (result.ok && args.seal) {
    seal = audit.seal(args.seal);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok, checked: result.checked, brokenAt: result.brokenAt, reason: result.reason,
      entries: total, firstEntry: first, lastEntry: last, elapsedMs: elapsed,
      record: recordReport ? {
        recordKey: recordReport.recordKey, entries: recordReport.entries,
        versions: recordReport.versions, contiguous: recordReport.contiguous,
      } : null,
      seal,
    }, null, 2)}\n`);
  } else {
    process.stdout.write('\n  LeebertyPV - audit trail integrity verification\n');
    process.stdout.write(`  ${'='.repeat(58)}\n\n`);
    process.stdout.write(`  Database        ${require('../src/config').dbFile}\n`);
    process.stdout.write(`  Entries         ${total}\n`);
    if (first) process.stdout.write(`  First entry     seq ${first.seq} at ${first.at}\n`);
    if (last) process.stdout.write(`  Last entry      seq ${last.seq} at ${last.at}\n`);
    if (last) process.stdout.write(`  Head hash       ${last.chain_hash}\n`);
    process.stdout.write('\n');

    if (result.ok) {
      process.stdout.write(`  RESULT: VERIFIED - ${result.checked} entries checked in ${elapsed} ms\n`);
      process.stdout.write('  No tampering detected. Every link matches its predecessor.\n\n');
    } else {
      process.stdout.write('  RESULT: *** INTEGRITY FAILURE ***\n\n');
      process.stdout.write(`  Broken at sequence: ${result.brokenAt}\n`);
      process.stdout.write(`  Reason: ${result.reason}\n\n`);
      process.stdout.write('  This is a data integrity incident. Actions:\n');
      process.stdout.write('    1. Stop using the system; do not start it in write mode.\n');
      process.stdout.write('    2. Preserve the database file and the audit-chain.key file as-is.\n');
      process.stdout.write('    3. Do not attempt to repair or rebuild the chain.\n');
      process.stdout.write('    4. Notify the system owner and raise a data integrity incident record.\n\n');
    }

    if (recordReport) {
      process.stdout.write(`  Record history: ${recordReport.recordKey}\n`);
      process.stdout.write(`    audit entries   ${recordReport.entries}\n`);
      process.stdout.write(`    versions seen   ${recordReport.versions.join(', ') || '(none)'}\n`);
      process.stdout.write(`    contiguous      ${recordReport.contiguous ? 'yes' : 'NO - version gaps detected'}\n\n`);
    }

    if (seal) {
      process.stdout.write('  Integrity seal created:\n');
      process.stdout.write(`    label           ${seal.label}\n`);
      process.stdout.write(`    at              ${seal.at}\n`);
      process.stdout.write(`    entries         ${seal.count}\n`);
      process.stdout.write(`    head hash       ${seal.chainHash}\n`);
      process.stdout.write(`    seal digest     ${seal.digest}\n\n`);
    }
  }

  db.close();
  process.exit(result.ok ? 0 : 2);
}

main();
