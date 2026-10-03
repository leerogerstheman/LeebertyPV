'use strict';

/**
 * Database bootstrap for LeebertyPV.
 *
 * Design notes
 * ------------
 * 1. The schema is deliberately written so that the *compliance kernel* is
 *    generic: deviations, change controls, CAPAs, OOS investigations, supplier
 *    findings, GCP protocol deviations and GLP study findings all live in the
 *    same `workflow_instance` / `workflow_step` tables. A "domain" is therefore
 *    data (seed/workflows/*.json), not code.
 * 2. Every mutable business table carries `record_key`/`record_version` or an
 *    explicit version column so records can be reconstructed as-of a point in
 *    time from the audit trail (ALCOA+ "Enduring" + "Available").
 * 3. Nothing in `audit_trail` is ever updated or deleted; each row is chained
 *    to its predecessor with a keyed digest.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 8000;

-- ---------------------------------------------------------------- meta -----
CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL
);

-- --------------------------------------------------- security principal ----
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  full_name_en        TEXT,
  email               TEXT,
  employee_no         TEXT,
  department          TEXT,
  job_title           TEXT,
  role                TEXT NOT NULL,
  -- account lifecycle: pending | active | locked | disabled | expired
  status              TEXT NOT NULL DEFAULT 'active',
  -- When access ends. Null means no end date, which is right for an employee and
  -- wrong for an external inspector: an agency inspection is bounded by the
  -- inspection, and an account that outlives it is a standing door into the
  -- quality system. Enforced at sign-in and on every session resolution.
  access_expires_at   TEXT,
  password_hash       TEXT,
  password_algo       TEXT DEFAULT 'scrypt',
  password_salt       TEXT,
  password_changed_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret         TEXT,
  totp_enabled        INTEGER NOT NULL DEFAULT 0,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  locale              TEXT NOT NULL DEFAULT 'zh-CN',
  signature_manifest  TEXT,
  training_status     TEXT,
  gxp_areas           TEXT,
  qualification       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_login_at       TEXT,
  created_by          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS password_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  password_hash TEXT NOT NULL,
  salt        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  revoked_at    TEXT,
  revoke_reason TEXT,
  -- elevation window for e-signatures (Part 11.200 continuous authentication)
  signature_unlocked_until TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT,
  success     INTEGER NOT NULL,
  reason      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_at ON login_attempts(at);

-- ------------------------------------------------------- compliance core ---
-- Append-only. UPDATE/DELETE are blocked by triggers. Each row carries a
-- keyed digest over its own payload plus the previous row's digest.
CREATE TABLE IF NOT EXISTS audit_trail (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  actor_id        INTEGER,
  actor_username  TEXT,
  actor_name      TEXT,
  actor_role      TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT,
  record_key      TEXT,
  record_version  INTEGER,
  reason          TEXT,
  old_value       TEXT,
  new_value       TEXT,
  meta            TEXT,
  session_id      TEXT,
  signature_id    INTEGER,
  ip              TEXT,
  user_agent      TEXT,
  prev_hash       TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  chain_hash      TEXT NOT NULL,
  gxp_areas       TEXT,
  severity        TEXT NOT NULL DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_trail(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_trail(record_key);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_trail(at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_trail(actor_id);

CREATE TRIGGER IF NOT EXISTS audit_trail_no_update
BEFORE UPDATE ON audit_trail
BEGIN SELECT RAISE(ABORT, 'audit_trail is append-only (ALCOA+ / 21 CFR Part 11.10(e))'); END;

CREATE TRIGGER IF NOT EXISTS audit_trail_no_delete
BEFORE DELETE ON audit_trail
BEGIN SELECT RAISE(ABORT, 'audit_trail is append-only (ALCOA+ / 21 CFR Part 11.10(e))'); END;

-- 21 CFR Part 11.200(a)(1)(i): signatures use at least two distinct
-- components. Component A = password, Component B = TOTP or a server-issued
-- per-signing nonce.
CREATE TABLE IF NOT EXISTS signatures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  username       TEXT NOT NULL,
  printed_name   TEXT NOT NULL,
  meaning        TEXT NOT NULL,
  meaning_code   TEXT,
  reason           TEXT,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  record_key     TEXT,
  record_version INTEGER,
  step_code      TEXT,
  method         TEXT NOT NULL,
  components     TEXT,
  credential_hash TEXT,
  signed_at      TEXT NOT NULL,
  ip             TEXT,
  session_id     TEXT,
  valid          INTEGER NOT NULL DEFAULT 1,
  invalidated_at TEXT,
  invalidated_by INTEGER,
  invalidate_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_signatures_entity ON signatures(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_signatures_user ON signatures(user_id);

CREATE TABLE IF NOT EXISTS signing_nonces (
  nonce      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  purpose    TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS security_policy (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  policy_json   TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  approved_by   INTEGER,
  approved_at   TEXT,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------- document control -----
CREATE TABLE IF NOT EXISTS documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number        TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  title_en          TEXT,
  doc_type          TEXT NOT NULL,
  gxp_areas         TEXT NOT NULL,
  site              TEXT,
  department        TEXT,
  process_area      TEXT,
  owner_id          INTEGER REFERENCES users(id),
  current_version   TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  classification    TEXT,
  regulation_refs   TEXT,
  review_period_months INTEGER NOT NULL DEFAULT 24,
  next_review_date  TEXT,
  effective_date    TEXT,
  superseded_by     INTEGER,
  retention_years   INTEGER,
  keywords          TEXT,
  summary           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  created_by        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(next_review_date);

CREATE TABLE IF NOT EXISTS document_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  version       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  change_summary TEXT,
  change_reason TEXT,
  content       TEXT,
  content_hash  TEXT,
  attachment_id INTEGER,
  effective_date TEXT,
  obsolete_date TEXT,
  review_due_date TEXT,
  trained_required INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    INTEGER,
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS documents_read (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  version_id  INTEGER REFERENCES document_versions(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  read_at     TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  signature_id INTEGER,
  UNIQUE (document_id, version_id, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  filename     TEXT NOT NULL,
  mime         TEXT,
  size_bytes   INTEGER,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  INTEGER,
  description  TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- ------------------------------------------- configuration-driven engine ---
CREATE TABLE IF NOT EXISTS process_types (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  name_en        TEXT,
  category       TEXT NOT NULL,
  gxp_areas      TEXT NOT NULL,
  regulation_refs TEXT,
  description    TEXT,
  description_en TEXT,
  sla_days       INTEGER,
  requires_root_cause INTEGER NOT NULL DEFAULT 0,
  requires_effectiveness_check INTEGER NOT NULL DEFAULT 0,
  requires_qa_approval INTEGER NOT NULL DEFAULT 1,
  criticality_levels TEXT,
  definitions_json TEXT NOT NULL,
  source_file    TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  loaded_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  record_key        TEXT NOT NULL UNIQUE,
  process_code      TEXT NOT NULL REFERENCES process_types(code),
  title             TEXT NOT NULL,
  summary            TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  current_step      TEXT,
  site              TEXT,
  department        TEXT,
  gxp_areas         TEXT NOT NULL,
  criticality       TEXT,
  -- linkage between records (deviation -> CAPA -> change control)
  parent_id         INTEGER REFERENCES workflow_instances(id),
  link_type         TEXT,
  source_entity_type TEXT,
  source_entity_id  TEXT,
  reported_by       INTEGER REFERENCES users(id),
  owner_id          INTEGER REFERENCES users(id),
  qa_owner_id       INTEGER REFERENCES users(id),
  occurred_at       TEXT,
  detected_at       TEXT,
  due_date          TEXT,
  -- Reporting clock (GVP 2021 第四十九条). due_date is derived from day0_date;
  -- clock_json keeps the resolved ladder, basis and citations so the reasoning
  -- behind a deadline stays reviewable years later, not just the date itself.
  day0_date         TEXT,
  clock_json        TEXT,
  closed_at         TEXT,
  batch_number      TEXT,
  product           TEXT,
  study_code        TEXT,
  protocol_number   TEXT,
  subject_id        TEXT,
  data_json         TEXT NOT NULL DEFAULT '{}',
  root_cause        TEXT,
  root_cause_method TEXT,
  impact_assessment TEXT,
  immediate_action  TEXT,
  effectiveness_check TEXT,
  effectiveness_result TEXT,
  record_version    INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  created_by        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wf_status ON workflow_instances(status, process_code);
CREATE INDEX IF NOT EXISTS idx_wf_due ON workflow_instances(due_date);
CREATE INDEX IF NOT EXISTS idx_wf_owner ON workflow_instances(owner_id);
CREATE INDEX IF NOT EXISTS idx_wf_parent ON workflow_instances(parent_id);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id   INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  step_code     TEXT NOT NULL,
  name          TEXT NOT NULL,
  name_en       TEXT,
  step_type     TEXT NOT NULL DEFAULT 'task',
  status        TEXT NOT NULL DEFAULT 'pending',
  assignee_role TEXT,
  assignee_id   INTEGER REFERENCES users(id),
  completed_at  TEXT,
  completed_by  INTEGER,
  due_date      TEXT,
  outcome       TEXT,
  comment       TEXT,
  form_data     TEXT,
  signature_meaning TEXT,
  signature_id  INTEGER,
  created_at    TEXT NOT NULL,
  UNIQUE (instance_id, step_code)
);
CREATE INDEX IF NOT EXISTS idx_wf_steps_instance ON workflow_steps(instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_wf_steps_assignee ON workflow_steps(assignee_id, status);

CREATE TABLE IF NOT EXISTS workflow_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor_id    INTEGER,
  actor_name  TEXT,
  from_status TEXT,
  to_status   TEXT,
  step_code   TEXT,
  action      TEXT NOT NULL,
  comment     TEXT,
  signature_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wf_history ON workflow_history(instance_id, at);

-- --------------------------------------------------------- GxP registers ---
CREATE TABLE IF NOT EXISTS equipment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no       TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  name_en        TEXT,
  model          TEXT,
  manufacturer   TEXT,
  serial_no      TEXT,
  location       TEXT,
  department     TEXT,
  gxp_areas      TEXT,
  qualification_status TEXT,
  iq_date        TEXT,
  oq_date        TEXT,
  pq_date        TEXT,
  calibration_required INTEGER NOT NULL DEFAULT 1,
  calibration_interval_days INTEGER,
  last_calibration_date TEXT,
  next_calibration_date TEXT,
  maintenance_interval_days INTEGER,
  last_maintenance_date TEXT,
  next_maintenance_date TEXT,
  status         TEXT NOT NULL DEFAULT 'in_service',
  criticality    TEXT,
  csv_status     TEXT,
  csv_ref        TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_cal ON equipment(next_calibration_date);

CREATE TABLE IF NOT EXISTS training_curricula (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  title_en     TEXT,
  gxp_areas    TEXT,
  applies_to_roles TEXT,
  applies_to_departments TEXT,
  validity_months INTEGER,
  is_gxp_critical INTEGER NOT NULL DEFAULT 1,
  document_id  INTEGER REFERENCES documents(id),
  description  TEXT,
  created_at   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS training_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  curriculum_id INTEGER NOT NULL REFERENCES training_curricula(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'assigned',
  assigned_at   TEXT NOT NULL,
  due_date      TEXT,
  completed_at  TEXT,
  trained_by    INTEGER REFERENCES users(id),
  trainer_name   TEXT,
  method        TEXT,
  score         REAL,
  pass_mark     REAL,
  result        TEXT,
  expires_at    TEXT,
  evidence      TEXT,
  assessment_notes TEXT,
  signature_id  INTEGER,
  updated_at    TEXT NOT NULL,
  UNIQUE (curriculum_id, user_id, assigned_at)
);
CREATE INDEX IF NOT EXISTS idx_training_user ON training_records(user_id, status);
CREATE INDEX IF NOT EXISTS idx_training_expiry ON training_records(expires_at);

CREATE TABLE IF NOT EXISTS gxp_areas (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  name_en      TEXT,
  full_name    TEXT,
  full_name_en TEXT,
  description  TEXT,
  colour       TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checklist_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  title_en      TEXT,
  scope         TEXT NOT NULL,
  gxp_areas     TEXT NOT NULL,
  category      TEXT,
  regulation    TEXT,
  authority     TEXT,
  version       TEXT,
  description   TEXT,
  description_en TEXT,
  source_file   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  loaded_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id   INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  clause_ref    TEXT,
  requirement   TEXT NOT NULL,
  requirement_en TEXT,
  guidance      TEXT,
  guidance_en   TEXT,
  risk_level    TEXT NOT NULL DEFAULT 'major',
  gxp_areas     TEXT,
  evidence_hint TEXT,
  is_critical   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checklist_items_tpl ON checklist_items(template_id, seq);

CREATE TABLE IF NOT EXISTS inspections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  inspection_type TEXT NOT NULL,
  authority      TEXT,
  gxp_areas      TEXT NOT NULL,
  template_id    INTEGER REFERENCES checklist_templates(id),
  site           TEXT,
  scope          TEXT,
  lead_auditor   TEXT,
  announced_at   TEXT,
  scheduled_date TEXT,
  completed_at   TEXT,
  status         TEXT NOT NULL DEFAULT 'planned',
  readiness_score REAL,
  summary        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  created_by     INTEGER
);

CREATE TABLE IF NOT EXISTS inspection_findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES checklist_items(id),
  template_id   INTEGER REFERENCES checklist_templates(id),
  finding_type  TEXT NOT NULL,
  -- explicit assessment outcome, kept separate from the workflow "status" so a
  -- closed finding can still be reported as partially compliant
  assessed_grade TEXT NOT NULL DEFAULT 'not_assessed',
  clause_ref    TEXT,
  requirement   TEXT,
  observation   TEXT,
  objective_evidence TEXT,
  risk_level    TEXT NOT NULL DEFAULT 'major',
  status        TEXT NOT NULL DEFAULT 'open',
  owner_id      INTEGER REFERENCES users(id),
  due_date      TEXT,
  workflow_id   INTEGER REFERENCES workflow_instances(id),
  response      TEXT,
  assessed_at   TEXT,
  assessed_by   INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_inspection ON inspection_findings(inspection_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  task_type    TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  assignee_id  INTEGER REFERENCES users(id),
  assignee_role TEXT,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  priority     TEXT NOT NULL DEFAULT 'normal',
  gxp_areas    TEXT,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);

-- Traceability matrix: requirement -> control -> evidence (GAMP 5 / Annex 11)
CREATE TABLE IF NOT EXISTS traceability (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_ref TEXT NOT NULL,
  source        TEXT,
  control_desc  TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  test_evidence TEXT,
  status        TEXT NOT NULL DEFAULT 'implemented',
  gxp_areas     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  role       TEXT,
  title      TEXT NOT NULL,
  body       TEXT,
  level      TEXT NOT NULL DEFAULT 'info',
  link       TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  dedupe_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  scope      TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);
`;

/** Tables whose mutations must appear in the audit trail. */
const AUDITED_TABLES = [
  'users', 'documents', 'document_versions', 'workflow_instances', 'workflow_steps',
  'equipment', 'training_records', 'training_curricula', 'inspections',
  'inspection_findings', 'tasks', 'process_types', 'checklist_templates',
  'security_policy', 'app_settings', 'traceability',
];

let db = null;

function open() {
  if (db) return db;
  const dir = path.dirname(config.dbFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec(SCHEMA_SQL);
  applyAdditiveMigrations();
  stampMeta();
  return db;
}

/**
 * Bring an existing database up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * column added to the schema never reaches an instance that has been running. The
 * instance this work was built on is exactly that case: it holds real audit
 * history, and refusing to start it because a column is missing would be the
 * worst possible outcome.
 *
 * Only additive, nullable columns belong here. A migration that drops or rewrites
 * needs to be a deliberate, logged operation rather than something that runs
 * silently at start-up.
 */
function applyAdditiveMigrations() {
  const additions = [
    // users.access_expires_at - time-boxed access for external inspectors.
    ['users', 'access_expires_at', 'TEXT'],
    // workflow_instances.day0_date / clock_json - the reporting clock. Existing
    // instances keep their original due_date; the columns record the basis for
    // any deadline recomputed after the GVP 2021 timeline engine was introduced.
    ['workflow_instances', 'day0_date', 'TEXT'],
    ['workflow_instances', 'clock_json', 'TEXT'],
  ];
  for (const [table, column, type] of additions) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (cols.includes(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (err) {
      // Report and continue: a schema fix-up must never be the reason an instance
      // will not open. The feature that needs the column degrades, nothing else.
      process.stderr.write(`  [schema] could not add ${table}.${column}: ${err.message}\n`);
    }
  }
}

function stampMeta() {
  const now = new Date().toISOString();
  const set = db.prepare(
    'INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  set.run('schema_version', String(config.app.schemaVersion), now);
  set.run('app_version', config.app.version, now);
  set.run('instance_id', getOrCreateInstanceId(), now);
  set.run('database_created_at', getMeta('database_created_at') || now, now);
}

function getOrCreateInstanceId() {
  const existing = getMeta('instance_id');
  if (existing) return existing;
  return require('node:crypto').randomUUID();
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getDb() {
  if (!db) open();
  return db;
}

function close() {
  if (db) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    db.close();
    db = null;
  }
}

/**
 * Run `fn` inside a transaction. Nested calls reuse the outer transaction.
 */
let txDepth = 0;
function transaction(fn) {
  const d = getDb();
  if (txDepth > 0) return fn(d);
  txDepth += 1;
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

module.exports = {
  open,
  getDb,
  close,
  transaction,
  all,
  get,
  run,
  getMeta,
  AUDITED_TABLES,
  SCHEMA_SQL,
};
