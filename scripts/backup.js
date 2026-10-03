'use strict';

/**
 * Backup the LeebertyPV workbench.
 *
 *   node scripts/backup.js
 *   node scripts/backup.js --label "pre-upgrade"
 *   node scripts/backup.js --verify-only <file>
 *
 * What is backed up and why:
 *   - the SQLite database, via VACUUM INTO so the copy is consistent even while
 *     the server is running (a plain file copy of a WAL database can be torn);
 *   - the audit chain key. Without it the chain cannot be verified, so a backup
 *     that omits it is not a restorable backup in the GxP sense;
 *   - a manifest with checksums so integrity can be confirmed after transfer.
 *
 * EU GMP Annex 11 §7.2 requires backups to be restorable; a restore rehearsal
 * must be documented in the validation file. `--verify-only` exists so that
 * rehearsal can be performed without touching the live database.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../src/core/db');
const audit = require('../src/core/audit');
const config = require('../src/config');

function parseArgs(argv) {
  const args = { label: null, verifyOnly: null, keep: 30 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i];
    else if (a === '--verify-only') args.verifyOnly = argv[++i];
    else if (a === '--keep') args.keep = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function backup(args) {
  const stamp = timestamp();
  const name = args.label
    ? `gxp-backup-${stamp}-${String(args.label).replace(/[^A-Za-z0-9._-]/g, '_')}`
    : `gxp-backup-${stamp}`;
  const dir = path.join(config.backupDir, name);
  fs.mkdirSync(dir, { recursive: true });

  process.stdout.write(`\n  Backing up to ${dir}\n\n`);

  // --- 1. consistent database copy ----------------------------------------
  const dbTarget = path.join(dir, 'gxp.db');
  db.open();
  const chainBefore = audit.verifyChain();

  // VACUUM INTO produces a transactionally consistent copy without blocking
  // readers, which a raw copy of a WAL database does not guarantee.
  db.getDb().exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
  const dbSize = fs.statSync(dbTarget).size;
  process.stdout.write(`  Database        ${(dbSize / 1024).toFixed(0)} KB\n`);

  // --- 2. audit chain key --------------------------------------------------
  const keySource = path.join(config.dataDir, 'audit-chain.key');
  const keyTarget = path.join(dir, 'audit-chain.key');
  let keyIncluded = false;
  if (fs.existsSync(keySource)) {
    fs.copyFileSync(keySource, keyTarget);
    fs.chmodSync(keyTarget, 0o600);
    keyIncluded = true;
    process.stdout.write(`  Audit key       included\n`);
  } else {
    process.stdout.write(`  Audit key       NOT FOUND - chain will not be verifiable from this backup\n`);
  }

  // --- 3. seed configuration (so the definition set is reproducible) -------
  const seedTarget = path.join(dir, 'seed');
  copyDir(config.seedDir, seedTarget);
  process.stdout.write(`  Configuration   copied\n`);

  // --- 4. manifest ---------------------------------------------------------
  const auditHead = db.get('SELECT seq FROM audit_trail ORDER BY seq DESC LIMIT 1');

  const manifest = {
    createdAt: new Date().toISOString(),
    label: args.label || null,
    app: { name: config.app.name, version: config.app.version, schemaVersion: config.app.schemaVersion },
    node: process.version,
    instanceId: db.getMeta('instance_id'),
    database: {
      file: 'gxp.db',
      sizeBytes: dbSize,
      sha256: sha256File(dbTarget),
    },
    auditChainKey: keyIncluded ? { file: 'audit-chain.key', sha256: sha256File(keyTarget) } : null,
    auditTrail: {
      entries: db.get('SELECT COUNT(*) AS n FROM audit_trail').n,
      verifiedAtBackup: chainBefore.ok,
      checkedEntries: chainBefore.checked,
      headHash: chainBefore.lastHash,
      // An instance that has never been used has no audit rows at all, so the
      // head sequence is legitimately absent rather than an error.
      headSequence: auditHead ? auditHead.seq : 0,
    },
    counts: Object.fromEntries(Object.entries({
      users: 'SELECT COUNT(*) AS n FROM users',
      documents: 'SELECT COUNT(*) AS n FROM documents',
      records: 'SELECT COUNT(*) AS n FROM workflow_instances',
      inspections: 'SELECT COUNT(*) AS n FROM inspections',
      findings: 'SELECT COUNT(*) AS n FROM inspection_findings',
      training: 'SELECT COUNT(*) AS n FROM training_records',
      equipment: 'SELECT COUNT(*) AS n FROM equipment',
      signatures: 'SELECT COUNT(*) AS n FROM signatures',
    }).map(([label, sql]) => [label, db.get(sql).n])),
    restoreInstructions: [
      '1. Stop the workbench (close the console window).',
      '2. Back up the current data/ directory elsewhere; never overwrite it in place.',
      '3. Copy gxp.db into <project>\\data\\gxp.db',
      '4. Copy audit-chain.key into <project>\\data\\audit-chain.key',
      '   The key MUST be the one from the same backup, otherwise the chain cannot verify.',
      '5. Start the workbench and run: node scripts/verify-audit.js',
      '6. Record the restore rehearsal in the system validation file (EU GMP Annex 11 §7.2).',
    ],
    verification: 'To confirm the backup is intact: node scripts/backup.js --verify-only <path to this manifest>',
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'RESTORE-使用说明.txt'), [
    'LeebertyPV - 备份恢复说明',
    'LeebertyPV - restore instructions',
    '',
    `备份时间 / Backed up at: ${manifest.createdAt}`,
    `审计追踪条目 / Audit entries: ${manifest.auditTrail.entries}`,
    `末尾哈希 / Head hash: ${manifest.auditTrail.headHash}`,
    '',
    ...manifest.restoreInstructions,
    '',
    '重要：audit-chain.key 必须与 gxp.db 来自同一次备份。',
    'IMPORTANT: audit-chain.key must come from the same backup as gxp.db.',
    '密钥不同则审计追踪无法校验，且无法通过任何方式修复。',
    'With a mismatched key the audit trail cannot be verified and cannot be repaired.',
    '',
  ].join('\r\n'), 'utf8');

  process.stdout.write(`  Manifest        written\n`);
  process.stdout.write(`\n  Audit trail verified at backup time: ${chainBefore.ok ? 'YES' : 'NO'}\n`);
  process.stdout.write(`  Entries: ${manifest.auditTrail.entries}  Head: ${manifest.auditTrail.headHash}\n`);
  process.stdout.write(`  SHA-256: ${manifest.database.sha256}\n`);

  db.close();
  prune(args.keep);
  process.stdout.write(`\n  Backup complete: ${dir}\n\n`);
  return dir;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Keep only the most recent N backups so the disk does not fill silently. */
function prune(keep) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const dirs = fs.readdirSync(config.backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('gxp-backup-'))
    .map((e) => ({ name: e.name, path: path.join(config.backupDir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const excess = dirs.length - keep;
  if (excess <= 0) return;
  process.stdout.write(`\n  Pruning ${excess} old backup(s), keeping the newest ${keep}.\n`);
  for (let i = 0; i < excess; i += 1) {
    fs.rmSync(dirs[i].path, { recursive: true, force: true });
    process.stdout.write(`    removed ${dirs[i].name}\n`);
  }
}

/**
 * Verify a backup against its manifest without touching the live database.
 *
 * Ordering matters here. SQLite rewrites the database header (and creates or
 * checkpoints a WAL) merely on open, so hashing the file *after* opening it for
 * the chain check would always mismatch. The byte-level integrity check is
 * therefore done first, on the untouched file, and only then is the copy opened
 * to verify the audit chain. The two checks answer different questions:
 *   - the SHA-256 confirms the file survived transfer intact;
 *   - the keyed chain confirms the contents were never altered.
 */
function verifyOnly(manifestPath) {
  const dir = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  process.stdout.write(`\n  Verifying backup: ${dir}\n\n`);

  let ok = true;
  const check = (label, expected, actual) => {
    const pass = expected === actual;
    if (!pass) ok = false;
    process.stdout.write(`  ${pass ? 'OK  ' : 'FAIL'}  ${label}\n`);
    if (!pass) {
      process.stdout.write(`        expected ${expected}\n        actual   ${actual}\n`);
    }
  };

  const dbFile = path.join(dir, manifest.database.file);
  if (!fs.existsSync(dbFile)) {
    process.stdout.write(`  FAIL  database file missing: ${dbFile}\n`);
    process.exit(1);
  }

  // --- phase 1: transfer integrity, before anything opens the file ---------
  process.stdout.write('  Transfer integrity (hashed before the file is opened):\n');
  check('database sha256', manifest.database.sha256, sha256File(dbFile));
  check('database size', manifest.database.sizeBytes, fs.statSync(dbFile).size);

  if (manifest.auditChainKey) {
    const keyFile = path.join(dir, manifest.auditChainKey.file);
    if (!fs.existsSync(keyFile)) {
      process.stdout.write('  FAIL  audit chain key missing - the chain cannot be verified from this backup\n');
      ok = false;
    } else {
      check('audit key sha256', manifest.auditChainKey.sha256, sha256File(keyFile));
    }
  }

  if (!ok) {
    process.stdout.write('\n  Stopping: the backup is not byte-identical to what was written.\n');
    process.stdout.write('  Re-transfer the backup before relying on it.\n\n');
    process.exit(2);
  }

  // --- phase 2: audit chain integrity, inside the backup copy --------------
  process.stdout.write('\n  Verifying the audit chain inside the backup copy...\n');
  const previousDir = process.env.PV_DATA_DIR;
  const previousFile = process.env.PV_DB_FILE;
  process.env.PV_DATA_DIR = dir;
  process.env.PV_DB_FILE = dbFile;

  // Re-require the modules so they pick up the redirected paths.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`) && !key.includes(`${path.sep}scripts${path.sep}`)) {
      delete require.cache[key];
    }
  }
  try {
    const backupDb = require('../src/core/db');
    const backupAudit = require('../src/core/audit');
    backupDb.open();
    const result = backupAudit.verifyChain();
    const entries = backupDb.get('SELECT COUNT(*) AS n FROM audit_trail').n;
    check('audit entries', manifest.auditTrail.entries, entries);
    check('audit chain verifies', true, result.ok);
    if (!result.ok) {
      process.stdout.write(`        broken at seq ${result.brokenAt}: ${result.reason}\n`);
    }
    const head = backupDb.get('SELECT chain_hash FROM audit_trail ORDER BY seq DESC LIMIT 1');
    // An unused instance has no head hash; both sides normalise to GENESIS.
    check('head hash', manifest.auditTrail.headHash, head ? head.chain_hash : 'GENESIS');
    backupDb.close();
  } catch (err) {
    process.stdout.write(`  FAIL  could not verify the backup: ${err.message}\n`);
    ok = false;
  } finally {
    if (previousDir === undefined) delete process.env.PV_DATA_DIR; else process.env.PV_DATA_DIR = previousDir;
    if (previousFile === undefined) delete process.env.PV_DB_FILE; else process.env.PV_DB_FILE = previousFile;
  }

  process.stdout.write(`\n  ${ok ? 'BACKUP VERIFIED - safe to rely on for restore' : 'BACKUP VERIFICATION FAILED'}\n`);
  process.stdout.write('  Record this rehearsal in the system validation file (EU GMP Annex 11 §7.2).\n');
  process.stdout.write('  NOTE: opening the copy rewrites its SQLite header, so re-hashing gxp.db now will\n');
  process.stdout.write('        differ from the manifest. The manifest hash validates the archive as written.\n\n');
  process.exit(ok ? 0 : 2);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write([
      '',
      '  Backup the LeebertyPV database, audit chain key and configuration.',
      '',
      '  Usage:',
      '    node scripts/backup.js                         create a timestamped backup',
      '    node scripts/backup.js --label pre-upgrade     add a label to the folder name',
      '    node scripts/backup.js --keep 10               retain only the newest 10',
      '    node scripts/backup.js --verify-only <manifest.json>',
      '                                                   verify a backup and rehearse the restore',
      '',
    ].join('\n'));
    process.exit(0);
  }
  if (args.verifyOnly) {
    verifyOnly(args.verifyOnly);
    return;
  }
  backup(args);
}

main();
