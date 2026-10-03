'use strict';

/**
 * Load the GxP configuration library (process types, checklist templates and
 * the GxP area register) into the database.
 *
 *   node scripts/seed.js
 *
 * This is safe to re-run: definitions are upserted by code, so editing a JSON
 * file in seed/ and re-running refreshes the definition without touching any
 * business records.
 */

const path = require('node:path');
const db = require('../src/core/db');
const audit = require('../src/core/audit');
const seed = require('../src/seed');

function main() {
  db.open();
  const startedAt = Date.now();

  let summary;
  try {
    // throwOnError: a broken definition file must fail the command, not pass silently.
    summary = seed.run({ silent: false, throwOnError: true });
  } catch (err) {
    process.stderr.write(`\n  Seed failed: ${err.message}\n\n`);
    process.exit(1);
  }

  const chain = audit.verifyChain();
  const ms = Date.now() - startedAt;

  process.stdout.write(`  Audit trail integrity: ${chain.ok ? 'OK' : 'FAILED'} (${chain.checked} entries)\n`);
  if (!chain.ok) {
    process.stdout.write(`    breakout at seq ${chain.brokenAt}: ${chain.reason}\n`);
  }
  process.stdout.write(`  Completed in ${ms} ms\n\n`);

  const processTypes = db.all('SELECT code, name, category, source_file FROM process_types WHERE active = 1 ORDER BY category, code');
  process.stdout.write('  Active process types:\n');
  for (const p of processTypes) {
    process.stdout.write(`    ${p.code.padEnd(16)} ${p.name.padEnd(24)} ${p.source_file || ''}\n`);
  }

  const templates = db.all(
    'SELECT t.code, t.title, COUNT(i.id) AS n FROM checklist_templates t ' +
    'LEFT JOIN checklist_items i ON i.template_id = t.id WHERE t.active = 1 GROUP BY t.id ORDER BY t.code'
  );
  process.stdout.write('\n  Active checklist templates:\n');
  for (const t of templates) {
    process.stdout.write(`    ${t.code.padEnd(24)} ${String(t.n).padStart(3)} items  ${t.title}\n`);
  }
  process.stdout.write('\n');

  db.close();
  process.exit(chain.ok ? 0 : 2);
}

if (require.main === module) main();
