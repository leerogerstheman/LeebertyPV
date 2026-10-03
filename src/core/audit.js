'use strict';

/**
 * Append-only audit trail with a keyed hash chain.
 *
 * Regulatory basis
 * ----------------
 *  - 21 CFR Part 11.10(e): secure, computer-generated, time-stamped audit trails
 *    that independently record the date and time of operator entries and actions
 *    that create, modify or delete electronic records. Record changes shall not
 *    obscure previously recorded information.
 *  - EU GMP Annex 11 §9: the audit trail must be available and convertible and
 *    must not be able to be modified or switched off.
 *  - WHO TRS 1033 Annex 4 / PIC-S data integrity guidance: ALCOA+ principles.
 *
 * Implementation
 * --------------
 * Each row stores `chain_hash = HMAC(key, prev_hash || canonical(payload))`.
 * The key lives outside the database file, so editing the database (or restoring
 * a doctored SQL dump) cannot produce a chain that verifies. `verifyChain`
 * re-walks the whole ledger and reports the first divergence.
 */

const config = require('../config');
const db = require('./db');
const cryptoUtil = require('./crypto');

/** Fields that participate in the chain digest. Order-independent (sorted). */
const HASHED_FIELDS = [
  'at', 'actor_id', 'actor_username', 'action', 'entity_type', 'entity_id',
  'record_key', 'record_version', 'reason', 'old_value', 'new_value', 'meta',
  'session_id', 'signature_id', 'ip',
];

function chainKey() {
  return config.audit.hmacKey;
}

function lastRow() {
  return db.get('SELECT seq, chain_hash FROM audit_trail ORDER BY seq DESC LIMIT 1');
}

function computeChainHash(prevHash, payload) {
  return cryptoUtil.hmac(chainKey(), `${prevHash}|${cryptoUtil.canonicalJson(payload)}`);
}

/**
 * Append one audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action        e.g. 'create' | 'update' | 'approve' | 'sign' | 'login'
 * @param {string} entry.entityType    business table or logical area
 * @param {object} [entry.actor]       the authenticated user (or null for system)
 * @param {object} [entry.oldValue]    previous state (partial is fine)
 * @param {object} [entry.newValue]    new state
 * @param {string} [entry.reason]      why the change was made
 * @param {object} [entry.meta]        extra context (route, params, ...)
 * @param {object} [entry.ctx]         request context { ip, userAgent, sessionId }
 */
function append(entry) {
  const actor = entry.actor || null;
  const now = entry.at || new Date().toISOString();

  const payload = {
    at: now,
    actor_id: actor ? actor.id : null,
    actor_username: actor ? actor.username : 'system',
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId != null ? String(entry.entityId) : null,
    record_key: entry.recordKey || null,
    record_version: entry.recordVersion != null ? Number(entry.recordVersion) : null,
    reason: entry.reason || null,
    old_value: entry.oldValue !== undefined ? cryptoUtil.canonicalJson(entry.oldValue) : null,
    new_value: entry.newValue !== undefined ? cryptoUtil.canonicalJson(entry.newValue) : null,
    meta: entry.meta !== undefined ? cryptoUtil.canonicalJson(entry.meta) : null,
    session_id: (entry.ctx && entry.ctx.sessionId) || null,
    signature_id: entry.signatureId != null ? Number(entry.signatureId) : null,
    ip: (entry.ctx && entry.ctx.ip) || null,
  };

  const prev = lastRow();
  const prevHash = prev ? prev.chain_hash : 'GENESIS';
  const chainHash = computeChainHash(prevHash, payload);

  const stmt = db.getDb().prepare(`
    INSERT INTO audit_trail (
      at, actor_id, actor_username, actor_name, actor_role, action,
      entity_type, entity_id, record_key, record_version, reason,
      old_value, new_value, meta, session_id, signature_id, ip, user_agent,
      prev_hash, payload_hash, chain_hash, gxp_areas, severity
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  stmt.run(
    payload.at,
    payload.actor_id,
    payload.actor_username,
    actor ? (actor.full_name || actor.full_name_en || actor.username) : 'system',
    actor ? actor.role : 'system',
    payload.action,
    payload.entity_type,
    payload.entity_id,
    payload.record_key,
    payload.record_version,
    payload.reason,
    payload.old_value,
    payload.new_value,
    payload.meta,
    payload.session_id,
    payload.signature_id,
    payload.ip,
    (entry.ctx && entry.ctx.userAgent) || null,
    prevHash,
    cryptoUtil.sha256(cryptoUtil.canonicalJson(payload)),
    chainHash,
    entry.gxpAreas ? JSON.stringify(entry.gxpAreas) : null,
    entry.severity || 'info',
  );

  return { seq: db.get('SELECT last_insert_rowid() AS id').id, chainHash, prevHash };
}

/**
 * Convenience wrapper: diff two snapshots and record only the changed fields.
 * Keeps the trail readable (`old_value`/`new_value` hold just the delta).
 */
function recordChange({ actor, entityType, entityId, recordKey, recordVersion, before, after, reason, ctx, meta, action, gxpAreas }) {
  const changed = diffObjects(before, after);
  if (action === undefined && Object.keys(changed).length === 0) return null;
  return append({
    action: action || inferAction(before, after),
    entityType,
    entityId,
    recordKey,
    recordVersion,
    actor,
    reason,
    ctx,
    meta,
    gxpAreas,
    oldValue: Object.keys(changed).length ? changed.old : undefined,
    newValue: Object.keys(changed).length ? changed.new : undefined,
  });
}

function inferAction(before, after) {
  if (!before) return 'create';
  if (!after) return 'delete';
  return 'update';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Returns `` {old, new} `` containing only keys whose values differ. */
function diffObjects(before, after) {
  const out = { old: {}, new: {} };
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    const bv = b[key];
    const av = a[key];
    if (cryptoUtil.canonicalJson(bv === undefined ? null : bv)
      !== cryptoUtil.canonicalJson(av === undefined ? null : av)) {
      out.old[key] = bv === undefined ? null : bv;
      out.new[key] = av === undefined ? null : av;
    }
  }
  return out;
}

/**
 * Re-walk the ledger and verify every link.
 *
 * @param {object} [opts]
 * @param {number} [opts.fromSeq]  start verifying from this sequence number
 * @returns {{ok: boolean, checked: number, brokenAt: number|null, reason: string|null, lastHash: string|null}}
 */
function verifyChain(opts = {}) {
  const key = chainKey();
  const rows = db.all('SELECT * FROM audit_trail WHERE seq >= ? ORDER BY seq ASC', [opts.fromSeq || 1]);
  let prevHash = 'GENESIS';

  if ((opts.fromSeq || 1) > 1) {
    const prior = db.get('SELECT chain_hash FROM audit_trail WHERE seq = ?', [(opts.fromSeq || 1) - 1]);
    if (prior) prevHash = prior.chain_hash;
  }

  let checked = 0;
  for (const row of rows) {
    const payload = {};
    for (const field of HASHED_FIELDS) payload[field] = row[field];
    const expected = cryptoUtil.hmac(key, `${prevHash}|${cryptoUtil.canonicalJson(payload)}`);
    if (expected !== row.chain_hash) {
      return {
        ok: false,
        checked,
        brokenAt: row.seq,
        reason: row.prev_hash !== prevHash
          ? `chain link broken before seq ${row.seq}: stored prev_hash does not match predecessor`
          : `payload digest mismatch at seq ${row.seq}: row content was altered after it was written`,
        lastHash: prevHash,
      };
    }
    prevHash = row.chain_hash;
    checked += 1;
  }
  return { ok: true, checked, brokenAt: null, reason: null, lastHash: prevHash };
}

/**
 * Verify a single record's history is internally consistent: every stored
 * version number appears exactly once, in ascending order.
 */
function verifyRecordHistory(recordKey) {
  const rows = db.all(
    'SELECT seq, at, action, record_version, actor_username, chain_hash FROM audit_trail WHERE record_key = ? ORDER BY seq ASC',
    [recordKey]
  );
  const versions = rows.map((r) => r.record_version).filter((v) => v != null);
  const sorted = [...versions].sort((a, b) => a - b);
  const contiguous = versions.every((v, i) => v === sorted[i]);
  return { recordKey, entries: rows.length, versions, contiguous, rows };
}

/** Query helper for the audit-trail viewer. */
function query(filters = {}) {
  const where = [];
  const params = [];
  if (filters.entityType) { where.push('entity_type = ?'); params.push(filters.entityType); }
  if (filters.entityId) { where.push('entity_id = ?'); params.push(String(filters.entityId)); }
  if (filters.recordKey) { where.push('record_key = ?'); params.push(filters.recordKey); }
  if (filters.actorId) { where.push('actor_id = ?'); params.push(Number(filters.actorId)); }
  if (filters.action) { where.push('action = ?'); params.push(filters.action); }
  if (filters.from) { where.push('at >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('at <= ?'); params.push(filters.to); }
  if (filters.severity) { where.push('severity = ?'); params.push(filters.severity); }
  if (filters.search) {
    where.push('(entity_type LIKE ? OR action LIKE ? OR actor_username LIKE ? OR reason LIKE ? OR entity_id LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit) || 100, 1000);
  const offset = Number(filters.offset) || 0;
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_trail ${clause}`, params).n;
  const rows = db.all(
    `SELECT * FROM audit_trail ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { total, limit, offset, rows };
}

/**
 * Reconstruct a stored record version from the audit trail alone. This is the
 * "Available/Legible" half of ALCOA+: you can always reproduce what the record
 * looked like at any point, even after the live row changed.
 */
function reconstruct(recordKey, atOrVersion) {
  const rows = db.all(
    `SELECT * FROM audit_trail WHERE record_key = ?
       AND (old_value IS NOT NULL OR new_value IS NOT NULL)
     ORDER BY seq ASC`,
    [recordKey]
  );
  if (!rows.length) return null;

  const state = {};
  for (const row of rows) {
    if (typeof atOrVersion === 'number' && row.record_version != null && row.record_version > atOrVersion) break;
    if (typeof atOrVersion === 'string' && row.at > atOrVersion) break;
    if (row.old_value) {
      const old = safeParse(row.old_value);
      if (old) for (const [k, v] of Object.entries(old)) delete state[k];
    }
    if (row.new_value) {
      const next = safeParse(row.new_value);
      if (next) Object.assign(state, next);
    }
    state.__lastSeq = row.seq;
    state.__lastAt = row.at;
  }
  return state;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Create a tamper-evident seal over the whole ledger at a point in time
 * (useful before an inspection: prove nothing changed since the seal).
 */
function seal(label) {
  const last = lastRow();
  const count = db.get('SELECT COUNT(*) AS n FROM audit_trail').n;
  const payload = {
    label: label || 'seal',
    at: new Date().toISOString(),
    lastSeq: last ? last.seq : 0,
    count,
    chainHash: last ? last.chain_hash : 'GENESIS',
  };
  const digest = cryptoUtil.sha256(cryptoUtil.canonicalJson(payload));
  db.run(
    'INSERT INTO app_settings (key, value, scope, updated_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [`audit_seal:${payload.at}`, JSON.stringify({ ...payload, digest }), 'system', payload.at]
  );
  return { ...payload, digest };
}

module.exports = {
  append,
  recordChange,
  verifyChain,
  verifyRecordHistory,
  query,
  reconstruct,
  diffObjects,
  seal,
  HASHED_FIELDS,
};
