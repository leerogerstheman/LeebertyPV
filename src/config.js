'use strict';

/**
 * Central runtime configuration for LeebertyPV.
 *
 * Everything is overridable through environment variables so the same build can
 * run on a workstation, a hospital ADR monitoring office or a MAH safety
 * department terminal without code changes.
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = process.env.PV_DATA_DIR
  ? path.resolve(process.env.PV_DATA_DIR)
  : path.join(ROOT, 'data');

for (const dir of [dataDir, path.join(ROOT, 'exports'), path.join(ROOT, 'backups')]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const config = {
  app: {
    name: 'LeebertyPV',
    nameZh: 'LeebertyPV',
    version: require('../package.json').version,
    /** Schema version, stamped into every database for upgrade bookkeeping. */
    schemaVersion: 1,
  },

  root: ROOT,
  dataDir,
  exportDir: path.join(ROOT, 'exports'),
  backupDir: path.join(ROOT, 'backups'),
  webDir: path.join(ROOT, 'web'),
  seedDir: path.join(ROOT, 'seed'),
  dbFile: process.env.PV_DB_FILE
    ? path.resolve(process.env.PV_DB_FILE)
    : path.join(dataDir, 'pv.db'),

  http: {
    host: process.env.PV_HOST || '127.0.0.1',
    port: envInt('PV_PORT', 8793),
    /** Set PV_TRUST_PROXY=1 when published behind a reverse proxy. */
    trustProxy: process.env.PV_TRUST_PROXY === '1',
    maxBodyBytes: envInt('PV_MAX_BODY', 8 * 1024 * 1024),
  },

  security: {
    // --- 21 CFR Part 11.300(b): periodic password checks -------------------
    passwordMinLength: envInt('PV_PASSWORD_MIN', 10),
    passwordHistoryDepth: envInt('PV_PASSWORD_HISTORY', 5),
    passwordMaxAgeDays: envInt('PV_PASSWORD_MAX_AGE', 90),
    passwordRequireClasses: envInt('PV_PASSWORD_CLASSES', 3),
    // --- 21 CFR Part 11.10(d): limiting system access ----------------------
    maxFailedLogins: envInt('PV_MAX_FAILED_LOGINS', 5),
    lockoutMinutes: envInt('PV_LOCKOUT_MINUTES', 15),
    // --- 21 CFR Part 11.10(d) / GVP Module I quality system -----------------
    idleTimeoutMinutes: envInt('PV_IDLE_TIMEOUT', 30),
    sessionAbsoluteHours: envInt('PV_SESSION_ABSOLUTE_HOURS', 12),
    // --- 21 CFR Part 11.200(a)(1)(i): two distinct identification components
    signatureTtlMinutes: envInt('PV_SIGNATURE_TTL', 5),
    signingNonceTtlSeconds: envInt('PV_NONCE_TTL', 120),
    totpIssuer: 'LeebertyPV',
  },

  /** Days ahead that "expiring soon" warnings cover. */
  reminder: {
    documentReviewWarningDays: envInt('PV_DOC_REVIEW_WARN_DAYS', 30),
    trainingExpiryWarningDays: envInt('PV_TRAINING_WARN_DAYS', 30),
    reportDeadlineWarningDays: envInt('PV_REPORT_WARN_DAYS', 5),
    capaDueWarningDays: envInt('PV_CAPA_WARN_DAYS', 7),
    /** Equipment calibration window; referenced by equipment.js and the monitor. */
    calibrationWarningDays: envInt('PV_CALIBRATION_WARN_DAYS', 30),
  },

  /** Chain verification uses a keyed digest so audit rows cannot be recomputed
   *  by someone who merely copies the database file. */
  audit: {
    get hmacKey() {
      const f = path.join(dataDir, 'audit-chain.key');
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, require('node:crypto').randomBytes(48).toString('hex'), { mode: 0o600 });
      }
      return fs.readFileSync(f, 'utf8').trim();
    },
  },

  /** Runtime feature switches, also editable from the UI settings page. */
  features: {
    /** Require a TOTP code (second factor) for PV e-signatures. */
    signatureSecondFactor: process.env.PV_SIG_2FA !== '0',
    /** Block completion of records whose linked steps are incomplete. */
    strictWorkflowGating: process.env.PV_STRICT_GATING !== '0',
    /** Refuse mutations when the audit chain is broken. */
    freezeOnChainBreak: process.env.PV_FREEZE_ON_CHAIN_BREAK !== '0',
    /**
     * Provision the built-in demonstration personas at start-up and show them on
     * the login screen. OFF by default: an instance that will hold real safety
     * records must never ship with known credentials. Enable with
     * PV_BUILTIN_ACCOUNTS=1 for a click-and-use instance.
     */
    builtinAccounts: process.env.PV_BUILTIN_ACCOUNTS === '1',
    /**
     * Generate the demonstration dataset at start-up when the instance holds no
     * safety records yet, so one double-click gives a populated workbench.
     * Gated on built-in accounts: the dataset is fictional cases, signals and
     * signatures written into the real audit trail.
     */
    autoSeedDemo: process.env.PV_AUTO_SEED_DEMO !== '0'
      && process.env.PV_BUILTIN_ACCOUNTS === '1',
    /** Run the background workflow monitor as a child of the server process. */
    backgroundMonitor: process.env.PV_MONITOR !== '0',
  },
};

module.exports = config;