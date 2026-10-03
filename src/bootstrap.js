'use strict';

/**
 * First-run provisioning.
 *
 * WHY THIS EXISTS
 * ---------------
 * The application used to need two double-clicks before it was worth looking at:
 * run the demo-data script, then run the application. That is a poor first
 * impression for something whose whole point is to be opened and understood, and
 * it is invisible to anyone who only reads the desktop shortcut.
 *
 * So the server provisions itself. On start it loads the configuration library,
 * creates the demonstration accounts, and - when the database holds no GxP
 * records at all - generates the demonstration dataset. The second launch finds
 * everything already in place and does nothing beyond the configuration reload.
 *
 * WHAT IS DELIBERATELY NOT AUTOMATIC
 * ----------------------------------
 * The demonstration dataset only appears when built-in accounts are enabled
 * (`PV_BUILTIN_ACCOUNTS=1`), because it is demonstration material: fictional
 * cases, signals and signatures written into the real audit trail. A
 * production instance must never find invented records waiting in it. The same
 * flag already governs the fictional cast, so the two cannot drift apart.
 *
 * The seeder runs in a child process rather than being required in-process. It is
 * a long script that closes the database and calls process.exit on some paths,
 * and loading it here would make the server's behaviour depend on those details.
 * A child process gives a hard guarantee: either it exits zero and the data is
 * there, or the server reports it and carries on with an empty database.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const db = require('./core/db');
const config = require('./config');

const SEEDER = path.join(__dirname, '..', 'scripts', 'seed-demo.js');

/** Has this instance ever held GxP work? */
function hasQualityRecords() {
  try {
    return db.get('SELECT COUNT(*) AS n FROM workflow_instances').n > 0;
  } catch {
    return false;
  }
}

/**
 * Load the demonstration dataset if this instance has none.
 *
 * @param {{force?: boolean, timeoutMs?: number}} opts
 * @returns {Promise<{ran:boolean, reason:string, seconds?:number, code?:number}>}
 */
function ensureDemoData(opts = {}) {
  const enabled = config.features.builtinAccounts;
  if (!enabled) {
    return Promise.resolve({ ran: false, reason: 'built-in accounts are disabled' });
  }
  if (!opts.force && hasQualityRecords()) {
    return Promise.resolve({ ran: false, reason: 'records already present' });
  }

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEEDER], {
      cwd: path.join(__dirname, '..'),
      // The seeder inherits the database and demo-account settings the server was
      // started with, so it writes to the same file the server is serving.
      env: {
        ...process.env,
        PV_DB_FILE: config.dbFile,
        PV_BUILTIN_ACCOUNTS: enabled ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({
        ran: false,
        reason: `the seeder did not finish within ${Math.round((opts.timeoutMs || 180000) / 1000)}s`,
        code: null,
      });
    }, opts.timeoutMs || 180000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ran: false, reason: `could not start the seeder: ${err.message}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      if (code !== 0) {
        // The tail of the seeder's output names the cause, and the server keeps
        // running with an empty database rather than refusing to start: an
        // operator can still sign in and look at the configuration.
        const tail = output.trim().split('\n').slice(-6).join('\n    ');
        resolve({ ran: false, reason: `the seeder exited ${code}`, code, detail: tail });
        return;
      }
      resolve({
        ran: true,
        reason: 'generated on first run',
        seconds,
        records: (() => {
          try { return db.get('SELECT COUNT(*) AS n FROM workflow_instances').n; } catch { return 0; }
        })(),
        entries: (() => {
          try { return db.get('SELECT COUNT(*) AS n FROM audit_trail').n; } catch { return 0; }
        })(),
      });
    });
  });
}

module.exports = { ensureDemoData, hasQualityRecords, SEEDER };
