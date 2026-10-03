'use strict';

/**
 * Authentication, session control and electronic signatures.
 *
 * Regulatory basis
 * ----------------
 *  - 21 CFR Part 11.10(d)  limiting system access to authorised individuals.
 *  - 21 CFR Part 11.10(g)  authority checks.
 *  - 21 CFR Part 11.200(a)(1)(i) signatures shall employ at least two distinct
 *    components: an identification code (user id) and a password. When a
 *    *continuous* access session is not used, each signing session must use
 *    all components. We therefore require password **and** a second factor
 *    (TOTP, or a single-use server nonce for accounts without an authenticator).
 *  - 21 CFR Part 11.200(a)(2)/(3) signature must show printed name, date/time
 *    and meaning, and must be linked to the record so it cannot be excised.
 *  - EU GMP Annex 11 §12.1  unique logins, no shared accounts, periodic review.
 */

const config = require('../config');
const db = require('./db');
const auth = require('./crypto');
const audit = require('./audit');
const rbac = require('./rbac');

// ------------------------------------------------------------------ users ---

function nowIso() { return new Date().toISOString(); }

function addMs(ms) { return new Date(Date.now() + ms).toISOString(); }

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    fullNameEn: row.full_name_en,
    email: row.email,
    employeeNo: row.employee_no,
    department: row.department,
    jobTitle: row.job_title,
    role: row.role,
    roleLabel: (rbac.ROLES[row.role] || {}).label || row.role,
    status: row.status,
    locale: row.locale,
    gxpAreas: parseJson(row.gxp_areas, []),
    qualification: parseJson(row.qualification, {}),
    totpEnabled: Boolean(row.totp_enabled),
    mustChangePassword: Boolean(row.must_change_password),
    passwordChangedAt: row.password_changed_at,
    passwordExpired: isPasswordExpired(row),
    lastLoginAt: row.last_login_at,
    trainingStatus: row.training_status,
    permissions: rbac.permissionsFor(row.role),
    readOnly: rbac.isReadOnly(row),
  };
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function isPasswordExpired(row) {
  if (!row.password_changed_at) return false;
  const ageDays = (Date.now() - Date.parse(row.password_changed_at)) / 86400000;
  return ageDays > config.security.passwordMaxAgeDays;
}

function getUserById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
}

function getUserByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ?', [String(username || '').trim()]);
}

/**
 * Verify a password against a user id. Used by self-service flows where the
 * caller has a session but must re-prove knowledge of the credential.
 */
function verifyPasswordForUser(userId, password) {
  const row = getUserById(userId);
  if (!row) return false;
  return auth.verifyPassword(String(password || ''), row.password_hash);
}

// --------------------------------------------------------------- password ---

/**
 * Validate a candidate password against the site policy.
 * @returns {{ok: boolean, errors: string[]}}
 */
function validatePassword(password, user) {
  const errors = [];
  const p = String(password || '');
  const pol = loadPolicy();
  if (p.length < pol.passwordMinLength) {
    errors.push(`PASSWORD_TOO_SHORT: minimum ${pol.passwordMinLength} characters`);
  }
  if (p.length > 200) errors.push('PASSWORD_TOO_LONG');
  const classes = [
    /[a-z]/.test(p), /[A-Z]/.test(p), /[0-9]/.test(p), /[^A-Za-z0-9]/.test(p),
  ].filter(Boolean).length;
  if (classes < pol.passwordRequireClasses) {
    errors.push(`PASSWORD_TOO_SIMPLE: need at least ${pol.passwordRequireClasses} of lowercase/uppercase/digit/symbol`);
  }
  if (/^(.)\1+$/.test(p)) errors.push('PASSWORD_REPEATED_CHARACTER');
  if (COMMON_PASSWORDS.has(p.toLowerCase())) errors.push('PASSWORD_COMMON');
  if (user && user.username && p.toLowerCase().includes(String(user.username).toLowerCase())) {
    errors.push('PASSWORD_CONTAINS_USERNAME');
  }
  if (p.toLowerCase().includes('password') || p.includes('123456')) {
    errors.push('PASSWORD_PREDICTABLE');
  }
  // 21 CFR Part 11.300(b): ensure passwords are periodically checked/recycled.
  if (user) {
    const history = db.all(
      'SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [user.id, loadPolicy().passwordHistoryDepth]
    );
    for (const h of history) {
      if (auth.verifyPassword(p, h.password_hash)) {
        errors.push(`PASSWORD_REUSED: cannot reuse any of the last ${loadPolicy().passwordHistoryDepth} passwords`);
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', 'welcome', 'welcome1', 'letmein',
  'admin', 'admin123', 'administrator', 'qwerty', 'qwerty123', 'abc123',
  'iloveyou', '111111', '123123', '1q2w3e4r', 'changeme', 'root',
]);

function loadPolicy() {
  const row = db.get('SELECT policy_json, effective_from FROM security_policy WHERE id = 1');
  const base = {
    passwordMinLength: config.security.passwordMinLength,
    passwordHistoryDepth: config.security.passwordHistoryDepth,
    passwordMaxAgeDays: config.security.passwordMaxAgeDays,
    passwordRequireClasses: config.security.passwordRequireClasses,
    maxFailedLogins: config.security.maxFailedLogins,
    lockoutMinutes: config.security.lockoutMinutes,
    idleTimeoutMinutes: config.security.idleTimeoutMinutes,
    sessionAbsoluteHours: config.security.sessionAbsoluteHours,
    signatureTtlMinutes: config.security.signatureTtlMinutes,
    signatureSecondFactor: config.features.signatureSecondFactor,
    uniqueAccountsPerUser: true,
  };
  if (!row) return base;
  return { ...base, ...parseJson(row.policy_json, {}) };
}

function savePolicy(patch, actor, ctx) {
  const current = loadPolicy();
  const next = { ...current, ...patch };
  const before = db.get('SELECT policy_json, effective_from FROM security_policy WHERE id = 1');
  db.run(
    'INSERT INTO security_policy (id, policy_json, effective_from, approved_by, approved_at, updated_at) ' +
    'VALUES (1, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET policy_json = excluded.policy_json, approved_by = excluded.approved_by, ' +
    'approved_at = excluded.approved_at, updated_at = excluded.updated_at',
    [JSON.stringify(next), before ? before.effective_from : nowIso(),
      actor ? actor.id : null, nowIso(), nowIso()]
  );
  audit.append({
    action: 'policy_change',
    entityType: 'security_policy',
    entityId: '1',
    actor,
    reason: 'Security policy updated',
    oldValue: parseJson(before && before.policy_json, {}),
    newValue: next,
    ctx,
    severity: 'critical',
  });
  return next;
}

function setPassword(userId, newPassword, actor, ctx, { mustChange = false, reason = 'Password set' } = {}) {
  const user = getUserById(userId);
  if (!user) throw httpError(404, 'USER_NOT_FOUND');
  const check = validatePassword(newPassword, user);
  if (!check.ok) throw httpError(400, 'PASSWORD_POLICY', check.errors.join('; '));

  const h = auth.hashPassword(newPassword);
  const before = { password_changed_at: user.password_changed_at, must_change_password: user.must_change_password };
  db.transaction(() => {
    db.run(
      'UPDATE users SET password_hash = ?, password_algo = ?, password_salt = ?, password_changed_at = ?, ' +
      'must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
      [h.hash, h.algo, h.salt, nowIso(), mustChange ? 1 : 0, nowIso(), userId]
    );
    db.run(
      'INSERT INTO password_history (user_id, password_hash, salt, created_at) VALUES (?,?,?,?)',
      [userId, h.hash, h.salt, nowIso()]
    );
    // 21 CFR Part 11.300(b): prevent reuse by trimming history to the policy depth.
    const depth = loadPolicy().passwordHistoryDepth;
    db.run(
      'DELETE FROM password_history WHERE user_id = ? AND id NOT IN ' +
      '(SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)',
      [userId, userId, depth]
    );
    // Reset the second factor so an administrator cannot know the user's secret.
    if (user.totp_enabled) {
      db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [userId]);
    }
    db.run('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      [nowIso(), 'password changed', userId]);
  });
  audit.recordChange({
    actor: actor || null,
    entityType: 'users',
    entityId: userId,
    recordKey: `users:${userId}`,
    before,
    after: { password_changed_at: nowIso(), must_change_password: mustChange, password_reset: true },
    reason: `Password change (${reason}); all other sessions revoked`,
    ctx,
    action: 'password_change',
    gxpAreas: [],
  });
  return true;
}

// ---------------------------------------------------------------- sessions --

function createSession(user, ctx) {
  const policy = loadPolicy();
  const id = auth.randomToken(32);
  const now = nowIso();
  const expires = addMs(policy.sessionAbsoluteHours * 3600 * 1000);
  db.run(
    'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)',
    [id, user.id, now, now, expires, ctx.ip || null, ctx.userAgent || null]
  );
  return { id, createdAt: now, expiresAt: expires };
}

function getSession(sessionId) {
  if (!sessionId) return null;
  return db.get('SELECT * FROM sessions WHERE id = ?', [String(sessionId)]);
}

/**
 * Resolve a session to a user, applying idle and absolute timeouts.
 * Returns `{ user, session, reason }`; `user` is null when invalid.
 */
function resolveSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return { user: null, session: null, reason: 'NO_SESSION' };
  if (session.revoked_at) return { user: null, session, reason: 'SESSION_REVOKED' };
  const now = Date.now();
  const policy = loadPolicy();
  if (Date.parse(session.expires_at) < now) {
    revokeSession(session.id, 'absolute timeout');
    return { user: null, session, reason: 'SESSION_EXPIRED' };
  }
  const idleMs = now - Date.parse(session.last_seen_at);
  if (idleMs > policy.idleTimeoutMinutes * 60000) {
    revokeSession(session.id, 'idle timeout');
    return { user: null, session, reason: 'IDLE_TIMEOUT' };
  }
  const user = getUserById(session.user_id);
  if (!user) return { user: null, session, reason: 'USER_NOT_FOUND' };
  if (user.status !== 'active') return { user: null, session, reason: `ACCOUNT_${String(user.status).toUpperCase()}` };

  // Time-boxed access, enforced on every request rather than only at sign-in.
  // An external inspection is bounded by the inspection; a session that outlives
  // its authority is the failure this exists to prevent, and a session can be
  // long-lived, so checking only at login would leave the door open.
  const expiry = accessExpiry(user);
  if (expiry && Date.parse(expiry.at) <= Date.now()) {
    revokeSession(session.id, 'access expired');
    markExpired(user);
    return { user: null, session, reason: 'ACCESS_EXPIRED', expiredAt: expiry.at };
  }

  db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), session.id]);
  session.last_seen_at = nowIso();
  return { user, session, reason: null };
}

/**
 * When does this account's access end, and why?
 *
 * Returns null when the account has no end date, which is the normal case for an
 * employee. The reason is carried so the interface can say why somebody was
 * turned away rather than showing a bare refusal.
 *
 * @param {object} user
 * @returns {{at: string, reason: string}|null}
 */
function accessExpiry(user) {
  if (!user || !user.access_expires_at) return null;
  return {
    at: user.access_expires_at,
    reason: user.role === 'auditor_external'
      ? '外部检查员的访问权限已到期（访问为限时授权）'
      : '该账号的访问权限已到期',
  };
}

/** Mark an account expired so the reason survives in the record. */
function markExpired(user) {
  try {
    if (user.status === 'expired') return;
    db.run("UPDATE users SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), user.id]);
    audit.append({
      action: 'account_expired',
      entityType: 'users',
      entityId: user.id,
      recordKey: `users:${user.id}`,
      actor: null,
      reason: `Access ended automatically at ${user.access_expires_at}`,
      ctx: { ip: null, userAgent: 'access-expiry-check', sessionId: null },
      severity: 'critical',
      meta: { username: user.username, role: user.role, expiresAt: user.access_expires_at },
    });
  } catch { /* the refusal stands even if the record cannot be updated */ }
}

function revokeSession(sessionId, reason) {
  db.run('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL',
    [nowIso(), reason || 'logout', sessionId]);
}

function revokeAllSessions(userId, exceptSessionId, reason) {
  db.run('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?',
    [nowIso(), reason || 'revoked', userId, exceptSessionId || '']);
}

// ------------------------------------------------------------------ login --

/**
 * Authenticate with username + password (+ optional TOTP).
 * @returns {{ok: boolean, code?: string, user?: object, session?: object}}
 */
function login({ username, password, totp, ctx = {} }) {
  const policy = loadPolicy();
  const user = getUserByUsername(username);
  const record = (success, reason, userId) => {
    db.run(
      'INSERT INTO login_attempts (username, success, reason, ip, user_agent, at) VALUES (?,?,?,?,?,?)',
      [String(username || ''), success ? 1 : 0, reason || null, ctx.ip || null, ctx.userAgent || null, nowIso()]
    );
    if (userId) {
      audit.append({
        action: success ? 'login_success' : 'login_failure',
        entityType: 'sessions',
        entityId: String(userId),
        recordKey: `users:${userId}`,
        actor: success ? user : null,
        reason: reason || null,
        ctx,
        severity: success ? 'info' : 'warning',
        meta: { username: String(username || '') },
      });
    }
  };

  if (!user) {
    // Constant-ish work to avoid trivially revealing which usernames exist.
    auth.verifyPassword(String(password || ''), 'scrypt$16384$8$1$00$00');
    record(false, 'unknown user', null);
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }

  if (user.status === 'disabled') { record(false, 'account disabled', user.id); return { ok: false, code: 'ACCOUNT_DISABLED' }; }

  // Time-boxed access, checked before the password so an expired inspector is told
  // that access ended rather than being left to guess whether the password was
  // wrong.
  const expiry = accessExpiry(user);
  if (expiry && Date.parse(expiry.at) <= Date.now()) {
    record(false, 'access expired', user.id);
    markExpired(user);
    return { ok: false, code: 'ACCESS_EXPIRED', expiredAt: expiry.at, reason: expiry.reason };
  }
  if (user.status === 'pending') { record(false, 'account pending activation', user.id); return { ok: false, code: 'ACCOUNT_PENDING' }; }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    record(false, 'account locked', user.id);
    return { ok: false, code: 'ACCOUNT_LOCKED', until: user.locked_until };
  }

  if (!auth.verifyPassword(String(password || ''), user.password_hash)) {
    const attempts = (user.failed_attempts || 0) + 1;
    const lock = attempts >= policy.maxFailedLogins;
    db.run(
      'UPDATE users SET failed_attempts = ?, locked_until = ?, status = ? , updated_at = ? WHERE id = ?',
      [attempts, lock ? addMs(policy.lockoutMinutes * 60000) : user.locked_until,
        lock && user.status === 'active' ? 'locked' : user.status, nowIso(), user.id]
    );
    record(false, `bad password (attempt ${attempts}/${policy.maxFailedLogins})`, user.id);
    return { ok: false, code: lock ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS', attemptsLeft: Math.max(0, policy.maxFailedLogins - attempts) };
  }

  // Second factor for accounts that enrolled an authenticator.
  if (user.totp_enabled && user.totp_secret) {
    if (!totp) { record(false, 'totp required', user.id); return { ok: false, code: 'TOTP_REQUIRED' }; }
    if (!auth.totpVerify(user.totp_secret, totp)) {
      record(false, 'bad totp', user.id);
      return { ok: false, code: 'TOTP_INVALID' };
    }
  }

  db.run(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, status = ?, last_login_at = ?, updated_at = ? WHERE id = ?',
    [user.status === 'locked' ? 'active' : user.status, nowIso(), nowIso(), user.id]
  );

  const session = createSession(user, ctx);
  record(true, 'ok', user.id);
  return { ok: true, user: publicUser(getUserById(user.id)), session };
}

// -------------------------------------------------------------- signatures --

/**
 * Issue a single-use signing nonce. Used as the second component for
 * signatures when the user has not enrolled a TOTP authenticator: possession of
 * the logged-in session alone is not sufficient, the user must re-enter their
 * password and obtain a fresh challenge.
 */
function issueSigningNonce(user, session, purpose) {
  const nonce = auth.randomToken(24);
  const ttl = config.security.signingNonceTtlSeconds;
  db.run(
    'INSERT INTO signing_nonces (nonce, user_id, purpose, created_at, expires_at, session_id) VALUES (?,?,?,?,?,?)',
    [nonce, user.id, purpose || 'signature', nowIso(), addMs(ttl * 1000), session ? session.id : null]
  );
  // housekeeping: drop expired nonces
  db.run('DELETE FROM signing_nonces WHERE expires_at < ?', [nowIso()]);
  return { nonce, expiresAt: addMs(ttl * 1000), ttlSeconds: ttl };
}

function consumeNonce(userId, nonce) {
  const row = db.get('SELECT * FROM signing_nonces WHERE nonce = ?', [String(nonce || '')]);
  if (!row) return { ok: false, code: 'NONCE_INVALID' };
  if (row.user_id !== userId) return { ok: false, code: 'NONCE_WRONG_USER' };
  if (row.used_at) return { ok: false, code: 'NONCE_ALREADY_USED' };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, code: 'NONCE_EXPIRED' };
  db.run('UPDATE signing_nonces SET used_at = ? WHERE nonce = ?', [nowIso(), row.nonce]);
  return { ok: true };
}

/**
 * Apply an electronic signature to a record.
 *
 * @param {object} args
 * @param {object} args.user       authenticated user row
 * @param {object} args.session    active session row
 * @param {string} args.username   re-entered identification code
 * @param {string} args.password   component A
 * @param {string} [args.totp]     component B (authenticator)
 * @param {string} [args.nonce]    component B (server challenge)
 * @param {string} args.meaning    signature meaning code, must be a known value
 * @param {string} args.reason     why the signer is signing (free text)
 * @param {string} args.entityType target table
 * @param {string|number} args.entityId
 * @param {string} [args.recordKey]
 * @param {number} [args.recordVersion]
 * @param {string} [args.stepCode]
 * @param {object} args.ctx
 */
function sign(args) {
  const {
    user, session, username, password, totp, nonce,
    meaning, reason, entityType, entityId, recordKey, recordVersion, stepCode, ctx = {},
  } = args;

  const meaningDef = SIGNATURE_MEANINGS[meaning];
  if (!meaningDef) return { ok: false, code: 'UNKNOWN_SIGNATURE_MEANING', allowed: Object.keys(SIGNATURE_MEANINGS) };
  if (!reason || String(reason).trim().length < 3) return { ok: false, code: 'REASON_REQUIRED' };

  // ---- component A: identification code + password ------------------------
  if (String(username || '').trim().toLowerCase() !== String(user.username).toLowerCase()) {
    return { ok: false, code: 'SIGNATURE_IDENTITY_MISMATCH' };
  }
  const fresh = getUserById(user.id);
  if (!auth.verifyPassword(String(password || ''), fresh.password_hash)) {
    audit.append({
      action: 'signature_failed', entityType, entityId: entityId != null ? String(entityId) : null,
      recordKey, actor: user, reason: 'password component rejected', ctx, severity: 'warning',
      meta: { meaning, stepCode },
    });
    return { ok: false, code: 'SIGNATURE_AUTH_FAILED' };
  }
  if (isPasswordExpired(fresh)) return { ok: false, code: 'PASSWORD_EXPIRED_CHANGE_FIRST' };

  // ---- component B: second factor ----------------------------------------
  const policy = loadPolicy();
  let componentMethod = 'password-only';
  if (policy.signatureSecondFactor) {
    if (totp) {
      if (!fresh.totp_enabled || !fresh.totp_secret) return { ok: false, code: 'TOTP_NOT_ENROLLED' };
      if (!auth.totpVerify(fresh.totp_secret, totp)) return { ok: false, code: 'TOTP_INVALID' };
      componentMethod = 'password+totp';
    } else if (nonce) {
      const consumed = consumeNonce(user.id, nonce);
      if (!consumed.ok) return { ok: false, code: consumed.code };
      componentMethod = 'password+challenge';
    } else {
      return { ok: false, code: 'SECOND_FACTOR_REQUIRED' };
    }
  } else {
    componentMethod = 'password-only(policy)';
  }

  const components = {
    identification: fresh.username,
    credential: 'password',
    second: componentMethod === 'password+totp' ? 'totp' : (componentMethod === 'password+challenge' ? 'challenge-nonce' : 'none'),
    sessionId: session ? session.id : null,
  };

  const signedAt = nowIso();
  const credentialHash = auth.signatureCredentialHash(fresh, 'electronic', components);

  let signatureId;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO signatures (user_id, username, printed_name, meaning, meaning_code, reason, entity_type, ' +
      'entity_id, record_key, record_version, step_code, method, components, credential_hash, signed_at, ip, session_id) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [fresh.id, fresh.username, fresh.full_name || fresh.full_name_en || fresh.username,
        meaningDef.label, meaning, String(reason).trim(), entityType,
        entityId != null ? String(entityId) : null, recordKey || null,
        recordVersion != null ? Number(recordVersion) : null, stepCode || null,
        'electronic', JSON.stringify(components), credentialHash, signedAt,
        ctx.ip || null, session ? session.id : null]
    );
    signatureId = db.get('SELECT last_insert_rowid() AS id').id;
  });

  const trail = audit.append({
    action: 'sign',
    entityType,
    entityId: entityId != null ? String(entityId) : null,
    recordKey,
    recordVersion,
    actor: fresh,
    reason: `${meaningDef.label}: ${String(reason).trim()}`,
    ctx,
    signatureId,
    severity: 'critical',
    meta: { meaning, meaningLabel: meaningDef.label, stepCode, components: componentMethod },
  });

  return {
    ok: true,
    signature: {
      id: signatureId,
      printedName: fresh.full_name || fresh.username,
      username: fresh.username,
      meaning,
      meaningLabel: meaningDef.label,
      reason: String(reason).trim(),
      signedAt,
      method: 'electronic',
      secondFactor: components.second,
      auditSeq: trail.seq,
      manifest: `${meaningDef.label} / ${fresh.full_name || fresh.username} / ${signedAt}`,
    },
  };
}

/**
 * Signature meanings. Keeping this closed-set prevents free-text meanings from
 * being used to obscure what the signer actually attested to.
 */
const SIGNATURE_MEANINGS = {
  authored: { label: 'Authored', labelZh: '起草' },
  reviewed: { label: 'Reviewed', labelZh: '审核' },
  approved: { label: 'Approved', labelZh: '批准' },
  rejected: { label: 'Rejected', labelZh: '拒绝' },
  verified: { label: 'Verified', labelZh: '核实' },
  performed: { label: 'Performed / Executed', labelZh: '执行' },
  witnessed: { label: 'Witnessed', labelZh: '见证' },
  released: { label: 'Released', labelZh: '放行' },
  closed: { label: 'Closed', labelZh: '关闭' },
  acknowledged: { label: 'Acknowledged (read and understood)', labelZh: '已阅知' },
  effectiveness_confirmed: { label: 'Effectiveness confirmed', labelZh: '有效性已确认' },
  disposition: { label: 'Disposition decided', labelZh: '作出处置决定' },
  completed: { label: 'Completed', labelZh: '完成' },
};

function listSignatures(entityType, entityId) {
  return db.all(
    'SELECT * FROM signatures WHERE entity_type = ? AND entity_id = ? ORDER BY signed_at ASC',
    [String(entityType), String(entityId)]
  ).map((s) => ({
    id: s.id,
    printedName: s.printed_name,
    username: s.username,
    meaning: s.meaning,
    meaningLabel: s.meaning_code,
    reason: s.reason,
    signedAt: s.signed_at,
    method: s.method,
    components: parseJson(s.components, {}),
    stepCode: s.step_code,
    valid: Boolean(s.valid),
    manifest: `${s.meaning} / ${s.printed_name} / ${s.signed_at}`,
  }));
}

/** Invalidate a signature (e.g. after a record correction) with full audit. */
function invalidateSignature(signatureId, actor, reason, ctx) {
  const sig = db.get('SELECT * FROM signatures WHERE id = ?', [signatureId]);
  if (!sig) throw httpError(404, 'SIGNATURE_NOT_FOUND');
  if (!sig.valid) return sig;
  db.run(
    'UPDATE signatures SET valid = 0, invalidated_at = ?, invalidated_by = ?, invalidate_reason = ? WHERE id = ?',
    [nowIso(), actor ? actor.id : null, reason || null, signatureId]
  );
  audit.append({
    action: 'signature_invalidated',
    entityType: sig.entity_type,
    entityId: sig.entity_id,
    recordKey: sig.record_key,
    actor,
    reason,
    ctx,
    severity: 'critical',
    oldValue: { valid: 1 },
    newValue: { valid: 0 },
    meta: { signatureId, originalSigner: sig.username, originalMeaning: sig.meaning },
  });
  return db.get('SELECT * FROM signatures WHERE id = ?', [signatureId]);
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  publicUser,
  getUserById,
  getUserByUsername,
  verifyPasswordForUser,
  validatePassword,
  setPassword,
  loadPolicy,
  savePolicy,
  createSession,
  getSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  login,
  sign,
  issueSigningNonce,
  consumeNonce,
  listSignatures,
  invalidateSignature,
  SIGNATURE_MEANINGS,
  isPasswordExpired,
  httpError,
};
