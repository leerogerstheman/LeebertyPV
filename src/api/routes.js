'use strict';

/**
 * REST API routing.
 *
 * Every route is declared with the permission it requires, so authorisation is
 * reviewable in one place rather than scattered through handlers. Routes are
 * matched in declaration order; the first match wins.
 *
 * Route table entries:
 *   { method, pattern, permission?, auth?, handler }
 * `permission` is checked against the RBAC matrix; `auth: false` marks the few
 * endpoints reachable without a session (login, health, bootstrap status).
 */

const os = require('node:os');
const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');
const authCore = require('../core/auth');
const rbac = require('../core/rbac');
const { PERMISSIONS: P } = rbac;
const { SESSION_COOKIE } = require('./cookie');

const documents = require('../domain/documents');
const workflow = require('../domain/workflow');
const inspections = require('../domain/inspections');
const training = require('../domain/training');
const equipment = require('../domain/equipment');
const dashboard = require('../domain/dashboard');
const inbox = require('../domain/inbox');
const accounts = require('../domain/accounts');
const explorer = require('../domain/explorer');
const coding = require('../domain/coding');
const signal = require('../domain/signal');
const constraints = require('../domain/constraints');

// ------------------------------------------------------------- utilities ----

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function bad(code, message, details) { return new HttpError(400, code, message, details); }
function notFound(message) { return new HttpError(404, 'NOT_FOUND', message); }
function forbidden(code, message) { return new HttpError(403, code, message); }

function requireString(body, field, { min = 1, max = 5000 } = {}) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length < min) {
    throw bad('FIELD_REQUIRED', `Field "${field}" is required (minimum ${min} characters)`);
  }
  if (value.length > max) throw bad('FIELD_TOO_LONG', `Field "${field}" exceeds ${max} characters`);
  return value.trim();
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  return value === undefined || value === null ? null : String(value).trim() || null;
}

/** Reject GxP-relevant mutations without a stated reason (Part 11.10(e)). */
function requireReason(body, minLength = 3) {
  const reason = str(body.reason || body.changeReason || body.justification);
  if (!reason || reason.length < minLength) {
    throw bad('REASON_REQUIRED',
      `A reason of at least ${minLength} characters is required for this change (21 CFR Part 11.10(e))`);
  }
  return reason;
}

/**
 * Log that a read occurred. Reading GxP records is itself an auditable event
 * when the reader is an external auditor or the record is inspection-relevant.
 */
function auditView(user, ctx, entityType, entityId, recordKey) {
  if (!user) return;
  if (user.role !== 'auditor_external') return;
  audit.append({
    action: 'view', entityType, entityId: entityId != null ? String(entityId) : null, recordKey,
    actor: user, reason: 'External auditor viewed record', ctx, severity: 'info',
  });
}

// --------------------------------------------------------------- handlers ---

async function bootstrap({ }) {
  const setupComplete = db.get('SELECT COUNT(*) AS n FROM users').n > 0;
  const areas = db.all('SELECT * FROM gxp_areas ORDER BY sort_order, code').map((a) => ({
    code: a.code, name: a.name, nameEn: a.name_en, fullName: a.full_name,
    fullNameEn: a.full_name_en, colour: a.colour,
  }));
  const processTypes = workflow.listProcessTypes().map((p) => ({
    code: p.code, name: p.name, nameEn: p.nameEn, category: p.category,
    gxpAreas: p.gxpAreas, slaDays: p.slaDays, stepCount: p.stepCount,
    regulationRefs: p.regulationRefs, fields: p.fields,
    requiresRootCause: p.requiresRootCause,
    requiresEffectivenessCheck: p.requiresEffectivenessCheck,
    criticalityLevels: p.criticalityLevels,
  }));
  const roleList = rbac.listRoles();
  const policy = authCore.loadPolicy();
  const chain = audit.verifyChain();

  return {
    status: 200,
    body: {
      app: {
        name: config.app.name, nameZh: config.app.nameZh, version: config.app.version,
        schemaVersion: config.app.schemaVersion,
      },
      setupComplete,
      instanceId: db.getMeta('instance_id'),
      database: { file: config.dbFile, createdAt: db.getMeta('database_created_at') },
      features: config.features,
      policy: {
        passwordMinLength: policy.passwordMinLength,
        passwordMaxAgeDays: policy.passwordMaxAgeDays,
        idleTimeoutMinutes: policy.idleTimeoutMinutes,
        sessionAbsoluteHours: policy.sessionAbsoluteHours,
        signatureSecondFactor: policy.signatureSecondFactor,
        maxFailedLogins: policy.maxFailedLogins,
        lockoutMinutes: policy.lockoutMinutes,
      },
      gxpAreas: areas,
      processTypes,
      roles: roleList.map((r) => ({ code: r.code, label: r.label, labelZh: r.labelZh, readOnly: r.readOnly, description: r.description })),
      permissions: P,
      documentTypes: Object.entries(documents.DOC_TYPES).map(([code, def]) => ({
        code, label: def.label, labelZh: def.labelZh, gxp: def.gxp,
      })),
      trainingMethods: Object.entries(training.METHOD_LABELS).map(([code, label]) => ({ code, label })),
      signatureMeanings: Object.entries(authCore.SIGNATURE_MEANINGS).map(([code, def]) => ({
        code, label: def.label, labelZh: def.labelZh,
      })),
      inspectionGrades: Object.entries(inspections.GRADES).map(([code, def]) => ({
        code, label: def.label, labelZh: def.labelZh,
      })),
      findingTypes: Object.entries(inspections.FINDING_TYPES).map(([code, def]) => ({
        code, label: def.label, labelZh: def.labelZh, description: def.description,
      })),
      checklistTemplates: inspections.listTemplates().map((t) => ({
        code: t.code, title: t.title, titleEn: t.titleEn, scope: t.scope,
        gxpAreas: t.gxpAreas, regulation: t.regulation, itemCount: t.itemCount, riskCounts: t.riskCounts,
      })),
      auditChain: { ok: chain.ok, entries: chain.checked },
      // Only a demo-configured instance advertises its built-in cast; a real
      // instance shows a plain login form and an empty list.
      builtinAccounts: {
        enabled: accounts.builtinAccountsEnabled(),
        personas: accounts.loginChoices().map((p) => ({
          username: p.username, fullName: p.fullName, fullNameEn: p.fullNameEn,
          role: p.role, roleLabel: p.roleLabel, roleLabelZh: p.roleLabelZh,
          department: p.department, jobTitle: p.jobTitle,
          blurb: p.blurb, blurbEn: p.blurbEn, highlight: p.highlight,
          pendingItems: p.pendingItems,
          // The start-up screen asks for a domain BEFORE an identity, so the step
          // that offers identities filters this list by area. Omitting gxpAreas
          // here made that filter match nothing and the identity step came up
          // empty - the payload was the problem, not the filter.
          gxpAreas: p.gxpAreas || [],
          // How many steps this role owns per area, so the identity step can lead
          // with the people who actually do the domain's work rather than an
          // alphabetical list.
          areaSteps: p.areaSteps || {},
          curated: Boolean(p.curated),
        })),
        domains: accounts.loginDomains(),
        password: accounts.passwordHint(),
        passwordCandidates: accounts.passwordCandidates(),
      },
      serverTime: new Date().toISOString(),
    },
  };
}

async function login({ body, ctx }) {
  const username = requireString(body, 'username', { min: 1, max: 100 });
  const password = requireString(body, 'password', { min: 1, max: 200 });
  const result = authCore.login({ username, password, totp: str(body.totp), ctx });
  if (!result.ok) {
    const messages = {
      INVALID_CREDENTIALS: 'Invalid username or password.',
      ACCOUNT_LOCKED: 'Account locked after too many failed attempts. Try again later or contact the administrator.',
      ACCOUNT_DISABLED: 'This account is disabled.',
      ACCOUNT_PENDING: 'This account has not been activated yet.',
      TOTP_REQUIRED: 'This account requires an authenticator code. Enter the 6-digit code.',
      TOTP_INVALID: 'The authenticator code is not valid.',
    };
    return {
      status: result.code === 'ACCOUNT_LOCKED' ? 423 : 401,
      body: { error: result.code, message: messages[result.code] || 'Sign in failed.', attemptsLeft: result.attemptsLeft, until: result.until },
    };
  }
  return {
    status: 200,
    body: { ok: true, user: result.user, session: { id: result.session.id, expiresAt: result.session.expiresAt } },
    setCookie: `${SESSION_COOKIE}=${encodeURIComponent(result.session.id)}; Path=/; HttpOnly; SameSite=Strict`,
  };
}

async function logout({ session, user, ctx }) {
  if (session) authCore.revokeSession(session.id, 'user logout');
  if (user) {
    audit.append({ action: 'logout', entityType: 'sessions', entityId: session ? session.id : null, actor: user, ctx });
  }
  return {
    status: 200,
    body: { ok: true },
    setCookie: `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
  };
}

async function me({ user, session }) {
  const policy = authCore.loadPolicy();
  return {
    status: 200,
    body: {
      user: authCore.publicUser(user),
      session: {
        id: session.id,
        expiresAt: session.expires_at,
        createdAt: session.created_at,
        idleTimeoutMinutes: policy.idleTimeoutMinutes,
        signatureTtlMinutes: policy.signatureTtlMinutes,
      },
    },
  };
}

/** Self-service password change; requires the current password. */
async function changeOwnPassword({ user, body, ctx, session }) {
  const current = requireString(body, 'currentPassword', { min: 1 });
  const next = requireString(body, 'newPassword', { min: 8 });
  if (!authCore.verifyPasswordForUser(user.id, current)) {
    audit.append({
      action: 'password_change_failed', entityType: 'users', entityId: user.id,
      actor: user, reason: 'Current password incorrect', ctx, severity: 'warning',
    });
    throw forbidden('CURRENT_PASSWORD_INCORRECT', 'The current password is not correct.');
  }
  authCore.setPassword(user.id, next, user, ctx, { mustChange: false, reason: 'User self-service change' });
  authCore.revokeAllSessions(user.id, session ? session.id : null, 'password changed');
  return { status: 200, body: { ok: true, message: 'Password changed. Other sessions have been signed out.' } };
}

/** Step 1 of authenticator enrolment: issue a secret. */
async function totpEnrol({ user, ctx }) {
  const secret = require('../core/crypto').generateTotpSecret();
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?',
    [secret, new Date().toISOString(), user.id]);
  const uri = require('../core/crypto').totpUri(secret, user.username, config.security.totpIssuer);
  audit.append({
    action: 'totp_enrol_started', entityType: 'users', entityId: user.id, actor: user,
    reason: 'Second authentication factor enrolment started', ctx,
  });
  return { status: 200, body: { secret, uri, issuer: config.security.totpIssuer, account: user.username } };
}

/** Step 2: confirm the authenticator works before enabling it. */
async function totpConfirm({ user, body, ctx }) {
  const code = requireString(body, 'code', { min: 6, max: 6 });
  const row = authCore.getUserById(user.id);
  if (!row.totp_secret) throw bad('NO_ENROLMENT_IN_PROGRESS', 'Start enrolment first.');
  const cryptoUtil = require('../core/crypto');
  if (!cryptoUtil.totpVerify(row.totp_secret, code)) {
    throw bad('TOTP_INVALID', 'The code did not match. Check the device clock and try again.');
  }
  db.run('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  audit.append({
    action: 'totp_enabled', entityType: 'users', entityId: user.id, actor: user,
    reason: 'Second authentication factor enabled for e-signatures', ctx, severity: 'critical',
  });
  return { status: 200, body: { ok: true } };
}

/**
 * Issue a signing challenge for users without an authenticator. This is the
 * second identification component for 21 CFR Part 11.200(a)(1)(i).
 */
async function signatureChallenge({ user, session, body, ctx }) {
  const meaning = str(body.meaning) || 'signature';
  const nonce = authCore.issueSigningNonce(user, session, meaning);
  return { status: 200, body: { ...nonce, policy: { secondFactorRequired: authCore.loadPolicy().signatureSecondFactor } } };
}

/**
 * The single entry point for applying an electronic signature. Every signed
 * action in the system funnels through here so the audit record is uniform.
 */
async function applySignature({ user, session, body, ctx }) {
  const result = authCore.sign({
    user,
    session,
    username: requireString(body, 'username', { min: 1 }),
    password: requireString(body, 'password', { min: 1 }),
    totp: str(body.totp),
    nonce: str(body.nonce),
    meaning: requireString(body, 'meaning', { min: 1 }),
    reason: requireString(body, 'reason', { min: 3 }),
    entityType: requireString(body, 'entityType', { min: 1 }),
    entityId: body.entityId != null ? body.entityId : null,
    recordKey: str(body.recordKey),
    recordVersion: num(body.recordVersion),
    stepCode: str(body.stepCode),
    ctx,
  });
  if (!result.ok) {
    const messages = {
      UNKNOWN_SIGNATURE_MEANING: `Unknown signature meaning. Allowed: ${Object.keys(authCore.SIGNATURE_MEANINGS).join(', ')}`,
      SIGNATURE_AUTH_FAILED: 'Password verification failed. The signature was not applied.',
      SIGNATURE_IDENTITY_MISMATCH: 'The username does not match the signed-in user. A signature must be your own.',
      TOTP_INVALID: 'The authenticator code is not valid.',
      TOTP_NOT_ENROLLED: 'This account has no authenticator enrolled; request a signing challenge instead.',
      SECOND_FACTOR_REQUIRED: 'A second identification component is required (21 CFR Part 11.200(a)(1)(i)).',
      NONCE_INVALID: 'The signing challenge is not valid. Request a new one.',
      NONCE_EXPIRED: 'The signing challenge has expired. Request a new one.',
      NONCE_ALREADY_USED: 'This signing challenge was already used. Signatures require a fresh challenge.',
      PASSWORD_EXPIRED_CHANGE_FIRST: 'Your password has expired. Change it before signing.',
      REASON_REQUIRED: 'A reason for signing is required.',
    };
    throw new HttpError(result.code === 'SIGNATURE_AUTH_FAILED' ? 401 : 400, result.code,
      messages[result.code] || 'The signature could not be applied.', result.allowed ? { allowed: result.allowed } : undefined);
  }
  return { status: 201, body: result.signature };
}

// ------------------------------------------------------------------ users ---

async function listUsers({ query }) {
  const where = [];
  const params = [];
  if (query.role) { where.push('role = ?'); params.push(query.role); }
  if (query.status) { where.push('status = ?'); params.push(query.status); }
  if (query.department) { where.push('department = ?'); params.push(query.department); }
  if (query.search) {
    where.push('(username LIKE ? OR full_name LIKE ? OR full_name_en LIKE ? OR email LIKE ? OR employee_no LIKE ?)');
    const like = `%${query.search}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(`SELECT * FROM users ${clause} ORDER BY department, full_name`, params);
  const departments = db.all("SELECT DISTINCT department FROM users WHERE department IS NOT NULL ORDER BY department").map((r) => r.department);
  return {
    status: 200,
    body: { total: rows.length, departments, rows: rows.map(authCore.publicUser) },
  };
}

async function createUser({ body, user, ctx }) {
  const username = requireString(body, 'username', { min: 3, max: 60 });
  const fullName = requireString(body, 'fullName', { min: 2, max: 120 });
  const role = requireString(body, 'role', { min: 2 });
  if (!rbac.ROLES[role]) throw bad('UNKNOWN_ROLE', `Unknown role "${role}". Known: ${Object.keys(rbac.ROLES).join(', ')}`);
  if (db.get('SELECT id FROM users WHERE username = ?', [username])) {
    throw new HttpError(409, 'USERNAME_EXISTS', `Username "${username}" is already taken. Accounts must be unique per person (Annex 11 §12.1).`);
  }
  const at = new Date().toISOString();
  let id;
  db.transaction(() => {
    db.run(
      'INSERT INTO users (username, full_name, full_name_en, email, employee_no, department, job_title, role, ' +
      'status, locale, gxp_areas, qualification, must_change_password, created_at, updated_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [username, fullName, str(body.fullNameEn), str(body.email), str(body.employeeNo),
        str(body.department), str(body.jobTitle), role,
        str(body.status) || 'active', str(body.locale) || 'zh-CN',
        JSON.stringify(body.gxpAreas || []), JSON.stringify(body.qualification || {}),
        1, at, at, user ? user.id : null]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
  });

  // If a password was supplied up front, set it under the same policy checks.
  let passwordSet = false;
  if (body.password) {
    authCore.setPassword(id, body.password, user, ctx, { mustChange: body.mustChangePassword !== false, reason: 'Initial password by administrator' });
    passwordSet = true;
  } else {
    db.run('UPDATE users SET password_hash = NULL, must_change_password = 1 WHERE id = ?', [id]);
  }

  audit.append({
    action: 'create', entityType: 'users', entityId: id, actor: user,
    reason: `User account created for ${fullName} (${role})`, ctx,
    newValue: { username, full_name: fullName, role, status: str(body.status) || 'active', passwordSet },
    severity: 'critical',
  });
  return { status: 201, body: { user: authCore.publicUser(authCore.getUserById(id)), passwordSet } };
}

async function updateUser({ user, params, body, ctx }) {
  const target = authCore.getUserById(params.id);
  if (!target) throw notFound('User not found');
  const reason = requireReason(body);
  const ALLOWED = ['full_name', 'full_name_en', 'email', 'employee_no', 'department', 'job_title',
    'role', 'status', 'locale', 'gxp_areas', 'qualification'];
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    const col = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    if (ALLOWED.includes(col)) {
      patch[col] = Array.isArray(value) || (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value;
    }
  }
  if (patch.role && !rbac.ROLES[patch.role]) throw bad('UNKNOWN_ROLE', `Unknown role "${patch.role}"`);
  if (patch.status && !['active', 'pending', 'locked', 'disabled'].includes(patch.status)) {
    throw bad('INVALID_STATUS', 'Status must be active, pending, locked or disabled');
  }
  // Guard against removing the last administrator.
  if ((patch.role && patch.role !== 'system_admin') || patch.status === 'disabled') {
    const admins = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'system_admin' AND status = 'active'").n;
    if (target.role === 'system_admin' && target.status === 'active' && admins <= 1) {
      throw new HttpError(409, 'LAST_ADMIN', 'Cannot change the last active administrator account.');
    }
  }
  if (patch.role && patch.role !== target.role) {
    authCore.revokeAllSessions(target.id, null, 'role changed');
  }
  if (patch.status === 'disabled') authCore.revokeAllSessions(target.id, null, 'account disabled');
  if (patch.status === 'active' && target.status === 'locked') {
    patch.locked_until = null;
    patch.failed_attempts = 0;
  }
  if (!Object.keys(patch).length) throw bad('NOTHING_TO_UPDATE');
  patch.updated_at = new Date().toISOString();

  const before = {};
  const after = {};
  for (const col of Object.keys(patch)) { before[col] = target[col]; after[col] = patch[col]; }
  db.run(`UPDATE users SET ${Object.keys(patch).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...Object.values(patch), target.id]);

  audit.recordChange({
    actor: user, entityType: 'users', entityId: target.id, recordKey: `users:${target.id}`,
    before, after, reason, ctx, action: 'update', severity: 'critical',
  });
  return { status: 200, body: { user: authCore.publicUser(authCore.getUserById(target.id)) } };
}

async function resetUserPassword({ user, params, body, ctx }) {
  const target = authCore.getUserById(params.id);
  if (!target) throw notFound('User not found');
  const reason = requireReason(body, 5);
  const newPassword = body.newPassword ? String(body.newPassword) : generateTempPassword();
  authCore.setPassword(target.id, newPassword, user, ctx, {
    mustChange: true, reason: `Administrator reset: ${reason}`,
  });
  return { status: 200, body: { ok: true, temporaryPassword: newPassword, mustChangePassword: true } };
}

function generateTempPassword() {
  const cryptoUtil = require('../core/crypto');
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const pick = (set, n) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
  const parts = [pick(upper, 2), pick(lower, 5), pick(digits, 3), pick(symbols, 2)];
  const all = parts.join('').split('');
  // Fisher-Yates with a cryptographic source so the temp password is unguessable.
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = cryptoUtil.randomToken(2).charCodeAt(0) % (i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.join('');
}

// ------------------------------------------------------- workflow explorer --

/**
 * The domain explorer: the process flow, who is involved, what each is
 * responsible for, and a three-state permission matrix per participant.
 */
async function getWorkflowExplorer({ params, query, user }) {
  return {
    status: 200,
    body: explorer.explorerPayload(params.code, {
      includeAllRoles: query.includeAllRoles !== '0',
      // No session: the caller gets the reference model without this
      // instance's record counts, cast or demonstration credential.
      anonymous: !user,
    }),
  };
}

async function getParticipants({ params }) {
  return { status: 200, body: explorer.listParticipants(params.code) };
}

/** Add a role to the cast. Roles come from the RBAC catalogue, never invented. */
async function addParticipant({ params, body, user, ctx }) {
  const role = requireString(body, 'role', { min: 2 });
  return {
    status: 201,
    body: explorer.addParticipant(params.code, role, user, ctx, str(body.reason)),
  };
}

async function removeParticipant({ params, body, user, ctx }) {
  return {
    status: 200,
    body: explorer.removeParticipant(params.code, params.role, user, ctx, str(body.reason)),
  };
}

/** The domains picker: each GxP area with enough detail to make a real choice. */
async function listDomains({ user }) {
  return { status: 200, body: explorer.listDomains({ anonymous: !user }) };
}

/** A domain as a destination: its processes, its people, its permission matrix. */
async function getDomain({ params, user }) {
  const data = explorer.exploreDomain(params.code, { anonymous: !user, viewer: user || null });
  if (!data.processes.length) {
    throw notFound(`No active process is registered for the PV area "${params.code}"`);
  }
  return { status: 200, body: data };
}

/** The design-philosophy page: why this workbench works the way it does. */
async function getPhilosophy() {
  const areas = db.all(
    'SELECT code, name, name_en, description FROM gxp_areas ORDER BY sort_order, code'
  );
  return {
    status: 200,
    body: {
      oneLiner: {
        zh: '个例报告是原料，时限是底线，信号是线索，获益-风险评估才是结论。',
        en: 'Case reports are the raw material, timelines are the floor, signals are the clues - benefit-risk assessment is the conclusion.',
      },
      philosophy: explorer.PHILOSOPHY,
      philosophyEn: explorer.PHILOSOPHY_EN,
      areas: areas.map((a) => ({
        code: a.code, name: a.name, nameEn: a.name_en,
        description: a.description,
        descriptionEn: a.description,
      })),
    },
  };
}

/** The roles a user may pick from, with their duties, for the add dialog. */
async function listAssignableRoles() {
  const roles = rbac.listRoles().map((r) => ({
    code: r.code,
    label: r.label,
    labelZh: r.labelZh,
    description: r.description,
    readOnly: r.readOnly,
    isGxPRecordParty: r.isSafetyRecordParty,
    permissionCount: r.permissionCount,
    duty: explorer.ROLE_DUTY[r.code] ? explorer.ROLE_DUTY[r.code].zh : r.description,
    dutyEn: explorer.ROLE_DUTY[r.code] ? explorer.ROLE_DUTY[r.code].en : r.description,
    accountCount: db.get(
      "SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = 'active'", [r.code]
    ).n,
  }));
  return {
    status: 200,
    body: {
      roles,
      note: 'Roles and their permissions are defined in the application, not created in the interface. '
        + 'A participant can be added from this list, but no new capability can be invented.',
      noteZh: '角色及其权限由应用程序定义，不能在界面中创建。可以从该列表添加参与者，但无法凭空创造权限。',
    },
  };
}

/** The catalogue of code-enforced constraints, for the matrix legend. */
async function listConstraints() {
  return {
    status: 200,
    body: {
      constraints: constraints.CONSTRAINTS,
      count: constraints.CONSTRAINTS.length,
      byCategory: constraints.byCategory(),
      note: 'These are enforced in code, independently of the role configuration. '
        + 'They are shown as the third state in the permission matrix so the interface never '
        + 'claims a capability the server would then refuse.',
      noteZh: '这些约束由代码强制，与角色配置无关。它们在权限矩阵中显示为第三种状态，'
        + '以避免界面声称一项服务端随后会拒绝的能力。',
    },
  };
}

/** One role's detail card: duties, steps, permissions and constraints. */
async function getRoleDetail({ params }) {
  const roleDef = rbac.ROLES[params.role];
  if (!roleDef) throw notFound(`Unknown role "${params.role}"`);
  const permissions = rbac.permissionsFor(params.role);
  const wildcard = permissions.includes('*');
  const allPermissions = Object.values(P);
  const rows = allPermissions.map((permission) => {
    const holds = wildcard || permissions.includes(permission);
    const applicable = constraints.forRole(params.role)
      .filter((c) => (c.appliesTo || []).includes(permission));
    return {
      permission,
      state: !holds ? 'denied' : (applicable.length ? 'conditional' : 'allowed'),
      constraints: applicable.map((c) => ({
        id: c.id, kind: c.kind, label: c.label, labelEn: c.labelEn,
        reason: c.reason, reasonEn: c.reasonEn, basis: c.basis,
      })),
    };
  });
  return {
    status: 200,
    body: {
      role: params.role,
      label: roleDef.label,
      labelZh: roleDef.labelZh,
      description: roleDef.description,
      readOnly: Boolean(roleDef.readOnly),
      isGxPRecordParty: roleDef.isSafetyRecordParty,
      duty: explorer.ROLE_DUTY[params.role] ? explorer.ROLE_DUTY[params.role].zh : roleDef.description,
      dutyEn: explorer.ROLE_DUTY[params.role] ? explorer.ROLE_DUTY[params.role].en : roleDef.description,
      permissionCount: wildcard ? allPermissions.length : permissions.length,
      rows,
      summary: {
        allowed: rows.filter((r) => r.state === 'allowed').length,
        conditional: rows.filter((r) => r.state === 'conditional').length,
        denied: rows.filter((r) => r.state === 'denied').length,
      },
    },
  };
}

// -------------------------------------------------------------- dashboards --

async function getDashboard({ user, query }) {
  return { status: 200, body: dashboard.dashboard(user, { gxpArea: query.gxpArea || null }) };
}

/**
 * The inbox: what this specific user must submit, approve, verify or perform.
 * Kept separate from the dashboard because it answers a different question and
 * is ranked by consequence rather than by date.
 */
async function getInbox({ user, query }) {
  return {
    status: 200,
    body: inbox.build(user, {
      action: query.action,
      kind: query.kind,
      overdueOnly: query.overdue === '1' || query.overdue === 'true',
      gxpArea: query.gxpArea,
      limit: num(query.limit),
    }),
  };
}

async function markNotificationRead({ params, user, ctx }) {
  return { status: 200, body: inbox.markRead(params.id, user, ctx) };
}

async function markAllNotificationsRead({ user, ctx }) {
  return { status: 200, body: inbox.markAllRead(user, ctx) };
}

async function listTasks({ user, query }) {
  const where = [];
  const params = [];
  if (query.status) { where.push('status = ?'); params.push(query.status); }
  if (query.taskType) { where.push('task_type = ?'); params.push(query.taskType); }
  if (query.assigneeId) { where.push('assignee_id = ?'); params.push(Number(query.assigneeId)); }
  if (query.mine === '1') { where.push('(assignee_id = ? OR assignee_role = ?)'); params.push(user.id, user.role); }
  if (query.priority) { where.push('priority = ?'); params.push(query.priority); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT t.*, u.full_name AS assignee_name FROM tasks t
     LEFT JOIN users u ON u.id = t.assignee_id
     ${clause}
     ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
              t.due_date IS NULL, t.due_date ASC LIMIT 300`,
    params
  );
  return {
    status: 200,
    body: {
      total: rows.length,
      rows: rows.map((t) => ({
        id: t.id, title: t.title, description: t.description, taskType: t.task_type,
        entityType: t.entity_type, entityId: t.entity_id,
        assigneeId: t.assignee_id, assigneeName: t.assignee_name, assigneeRole: t.assignee_role,
        dueDate: t.due_date, status: t.status, priority: t.priority,
        gxpAreas: JSON.parse(t.gxp_areas || '[]'),
        createdAt: t.created_at, completedAt: t.completed_at,
        overdue: t.status === 'open' && t.due_date ? Date.parse(t.due_date) < Date.now() : false,
      })),
    },
  };
}

/** Built-in demonstration personas for the login screen. */
async function getLoginChoices({ user }) {
  const enabled = accounts.builtinAccountsEnabled();
  // The domain screen offers identities and the domain picker lists areas, so
  // both are published here. They are public by design on a demonstration
  // instance; a production instance gets neither list.
  let domains = [];
  try { domains = accounts.loginDomains(); } catch { domains = []; }
  return {
    status: 200,
    body: {
      enabled,
      password: accounts.passwordHint(),
      // Every credential a demonstration account might hold. The shared password
      // was once written as two literals in two files - the same words in a
      // different order - so an instance seeded before that was unified holds the
      // old value for half its accounts. The screen tries each in turn rather
      // than offering an identity that cannot be entered.
      passwordCandidates: accounts.passwordCandidates(),
      personas: accounts.loginChoices(),
      domains,
      // Whether the caller already holds a session, so the screen can say who
      // they are instead of offering to sign them in again.
      signedIn: Boolean(user),
    },
  };
}

async function getReadiness({ query }) {
  return { status: 200, body: inspections.readinessDashboard({ gxpArea: query.gxpArea || null }) };
}

async function getCompliancePosture() {
  return { status: 200, body: dashboard.compliancePosture() };
}

async function getCoverage() {
  return { status: 200, body: { areas: dashboard.coverage() } };
}

// --------------------------------------------------------------- documents --

async function listDocuments({ query }) {
  return {
    status: 200,
    body: documents.listDocuments({
      status: query.status, docType: query.docType, department: query.department,
      gxpArea: query.gxpArea, ownerId: num(query.ownerId), search: query.search,
      reviewOverdue: query.reviewOverdue === '1' || query.reviewOverdue === 'true',
      limit: num(query.limit), offset: num(query.offset),
    }),
  };
}

async function getDocument({ params, user, ctx }) {
  const doc = documents.getDocument(params.id);
  if (!doc) throw notFound('Document not found');
  auditView(user, ctx, 'documents', doc.id, `doc:${doc.docNumber}`);
  return { status: 200, body: doc };
}

async function createDocument({ body, user, ctx }) {
  return { status: 201, body: documents.createDocument({
    docNumber: requireString(body, 'docNumber', { min: 2, max: 60 }),
    title: requireString(body, 'title', { min: 3, max: 300 }),
    titleEn: str(body.titleEn),
    docType: requireString(body, 'docType', { min: 2 }),
    gxpAreas: body.gxpAreas,
    site: str(body.site), department: str(body.department), processArea: str(body.processArea),
    ownerId: num(body.ownerId), version: str(body.version) || '1.0',
    classification: str(body.classification), regulationRefs: body.regulationRefs,
    reviewPeriodMonths: num(body.reviewPeriodMonths), retentionYears: num(body.retentionYears),
    keywords: body.keywords, summary: str(body.summary), content: body.content,
    changeSummary: str(body.changeSummary), changeReason: str(body.changeReason),
    trainingRequired: body.trainingRequired,
  }, user, ctx) };
}

async function updateDocument({ params, body, user, ctx }) {
  const reason = requireReason(body);
  const patch = {};
  for (const key of ['title', 'titleEn', 'department', 'site', 'processArea', 'ownerId',
    'reviewPeriodMonths', 'retentionYears', 'classification', 'gxpAreas', 'regulationRefs', 'keywords', 'summary']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  return { status: 200, body: documents.updateDocument(params.id, patch, user, ctx, reason) };
}

async function createDocumentVersion({ params, body, user, ctx }) {
  return { status: 201, body: documents.createVersion(params.id, {
    version: requireString(body, 'version', { min: 1, max: 20 }),
    changeReason: requireString(body, 'changeReason', { min: 5 }),
    changeSummary: str(body.changeSummary),
    content: body.content,
    trainingRequired: body.trainingRequired,
  }, user, ctx) };
}

async function transitionDocument({ params, body, user, ctx }) {
  return { status: 200, body: documents.transitionVersion(params.id, params.version,
    requireString(body, 'targetStatus', { min: 2 }), {
      signatureId: num(body.signatureId),
      reason: str(body.reason),
      effectiveDate: str(body.effectiveDate),
    }, user, ctx) };
}

async function acknowledgeDocument({ params, body, user, ctx }) {
  const targetUserId = num(body.userId) || user.id;
  if (targetUserId !== user.id && !rbac.hasPermission(user, P.TRAINING_MANAGE)) {
    throw forbidden('CANNOT_ACKNOWLEDGE_FOR_OTHERS', 'You can only record your own read acknowledgement.');
  }
  return { status: 200, body: documents.recordRead(params.id, targetUserId, {
    acknowledged: body.acknowledged !== false, signatureId: num(body.signatureId),
  }, user, ctx) };
}

async function documentReviewReport({ query }) {
  return { status: 200, body: documents.reviewDueReport(num(query.daysAhead)) };
}

// --------------------------------------------------------------- workflows --

async function listProcessTypes({ query }) {
  return { status: 200, body: { rows: workflow.listProcessTypes({ gxpArea: query.gxpArea }) } };
}

async function getProcessType({ params }) {
  const def = workflow.getDefinition(params.code);
  if (!def) throw notFound(`Unknown process type "${params.code}"`);
  return { status: 200, body: def };
}

// ---- MedDRA coding --------------------------------------------------------

async function getDictionary() {
  const dict = coding.load();
  return {
    status: 200,
    body: {
      version: dict.version,
      versionLabel: dict.versionLabel,
      versionLabelEn: dict.versionLabelEn,
      notice: dict.notice,
      noticeEn: dict.noticeEn,
      structure: dict.structure,
      socCount: (dict.socs || []).length,
      ptCount: coding.listPts({ limit: 1000 }).length,
      smqCount: (dict.smqs || []).length,
    },
  };
}

async function listCodingTerms({ query }) {
  return {
    status: 200,
    body: {
      rows: coding.listPts({
        search: query.search, soc: query.soc, smq: query.smq,
        locale: query.locale, limit: num(query.limit),
      }),
    },
  };
}

async function listCodingSocs() {
  return { status: 200, body: { rows: coding.listSocs(), smqs: coding.listSmqs() } };
}

/**
 * Code one term. The response always says whether the term resolved, because a
 * silently-accepted uncoded term is the failure mode this endpoint exists to
 * prevent: it would enter the case count as data that no aggregate can count.
 */
async function codeTerm({ body }) {
  const term = body && body.term;
  if (term === undefined || term === null || String(term).trim() === '') {
    throw bad('VALIDATION_FAILED', 'A term is required');
  }
  const result = coding.code(term);
  return {
    status: 200,
    body: {
      status: result.status,
      input: result.input,
      pt: result.entry ? result.entry.pt : null,
      ptName: result.entry ? result.entry.ptName : null,
      ptNameEn: result.entry ? result.entry.ptNameEn : null,
      soc: result.entry ? result.entry.soc : null,
      socName: result.entry ? result.entry.socName : null,
      smqs: (result.smqs || []).map((s) => ({ code: s.code, name: s.name, scope: s.scope })),
      message: result.message || null,
      messageEn: result.messageEn || null,
    },
  };
}

// ---- signal detection -----------------------------------------------------

async function getSignalAnalysis({ query }) {
  return {
    status: 200,
    body: signal.analyse({
      product: query.product || null,
      since: query.since || null,
      minCount: num(query.minCount),
      minPrr: num(query.minPrr),
      minChiSq: num(query.minChiSq),
    }),
  };
}

async function getLineListing({ query }) {
  return {
    status: 200,
    body: signal.lineListing({ product: query.product || null, since: query.since || null }),
  };
}

async function listRecords({ query }) {
  return {
    status: 200,
    body: workflow.listInstances({
      processCode: query.processCode, status: query.status, criticality: query.criticality,
      ownerId: num(query.ownerId), search: query.search, gxpArea: query.gxpArea,
      open: query.open === '1' || query.open === 'true',
      overdue: query.overdue === '1' || query.overdue === 'true',
      limit: num(query.limit), offset: num(query.offset),
    }),
  };
}

async function getRecord({ params, user, ctx }) {
  const record = workflow.getInstance(params.id);
  if (!record) throw notFound('Record not found');
  auditView(user, ctx, 'workflow_instances', record.id, record.recordKey);
  return { status: 200, body: record };
}

async function createRecord({ body, user, ctx }) {
  return { status: 201, body: workflow.createInstance({
    processCode: requireString(body, 'processCode', { min: 2 }),
    title: requireString(body, 'title', { min: 3, max: 300 }),
    summary: str(body.summary),
    site: str(body.site), department: str(body.department),
    gxpAreas: body.gxpAreas, criticality: str(body.criticality),
    ownerId: num(body.ownerId), qaOwnerId: num(body.qaOwnerId),
    parentId: num(body.parentId), linkType: str(body.linkType),
    sourceEntityType: str(body.sourceEntityType), sourceEntityId: str(body.sourceEntityId),
    occurredAt: str(body.occurredAt), detectedAt: str(body.detectedAt), dueDate: str(body.dueDate),
    batchNumber: str(body.batchNumber), product: str(body.product),
    studyCode: str(body.studyCode), protocolNumber: str(body.protocolNumber), subjectId: str(body.subjectId),
    data: body.data || {},
  }, user, ctx) };
}

async function updateRecord({ params, body, user, ctx }) {
  const reason = requireReason(body);
  const patch = {};
  for (const key of ['title', 'summary', 'criticality', 'ownerId', 'qaOwnerId', 'dueDate', 'site', 'department',
    'batchNumber', 'product', 'studyCode', 'protocolNumber', 'subjectId', 'occurredAt',
    'rootCause', 'rootCauseMethod', 'impactAssessment', 'immediateAction',
    'effectivenessCheck', 'effectivenessResult', 'gxpAreas', 'data', 'status']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  return { status: 200, body: workflow.updateInstance(params.id, patch, user, ctx, reason) };
}

async function completeRecordStep({ params, body, user, ctx }) {
  return {
    status: 200,
    body: workflow.completeStep({
      instanceId: params.id,
      stepCode: str(body.stepCode),
      actor: user,
      ctx,
      outcome: str(body.outcome),
      comment: str(body.comment),
      formData: body.formData || {},
      signatureId: num(body.signatureId),
      force: body.force === true,
    }),
  };
}

async function linkRecord({ params, body, user, ctx }) {
  return {
    status: 200,
    body: workflow.linkRecords(params.id, num(body.childId), str(body.linkType), user, ctx),
  };
}

async function cancelRecord({ params, body, user, ctx }) {
  return { status: 200, body: workflow.cancelInstance(params.id, requireReason(body, 10), user, ctx) };
}

// -------------------------------------------------------------- inspections --

async function listChecklistTemplates({ query }) {
  return { status: 200, body: { rows: inspections.listTemplates({ gxpArea: query.gxpArea, scope: query.scope, category: query.category }) } };
}

async function getChecklistTemplate({ params }) {
  const tpl = inspections.getTemplate(params.code);
  if (!tpl) throw notFound('Checklist template not found');
  return { status: 200, body: tpl };
}

async function listInspections({ query }) {
  return {
    status: 200,
    body: inspections.listInspections({
      status: query.status, inspectionType: query.inspectionType, gxpArea: query.gxpArea,
      search: query.search, limit: num(query.limit), offset: num(query.offset),
    }),
  };
}

async function getInspection({ params, user, ctx }) {
  const row = inspections.getInspection(params.id);
  if (!row) throw notFound('Inspection not found');
  auditView(user, ctx, 'inspections', row.id, `inspection:${row.code}`);
  return { status: 200, body: row };
}

async function createInspection({ body, user, ctx }) {
  return { status: 201, body: inspections.createInspection({
    code: str(body.code), title: str(body.title), inspectionType: str(body.inspectionType),
    authority: str(body.authority), gxpAreas: body.gxpAreas,
    templateId: num(body.templateId), templateCode: str(body.templateCode),
    site: str(body.site), scope: str(body.scope), leadAuditor: str(body.leadAuditor),
    scheduledDate: str(body.scheduledDate),
  }, user, ctx) };
}

async function assessFinding({ params, body, user, ctx }) {
  return { status: 200, body: inspections.assessItem(params.id, {
    grade: requireString(body, 'grade', { min: 3 }),
    observation: str(body.observation),
    objectiveEvidence: str(body.objectiveEvidence),
    riskLevel: str(body.riskLevel),
    findingType: str(body.findingType),
    ownerId: num(body.ownerId),
    dueDate: str(body.dueDate),
    notes: str(body.notes),
  }, user, ctx) };
}

async function escalateFinding({ params, body, user, ctx }) {
  return { status: 201, body: inspections.escalateToCapa(params.id, {
    processCode: str(body.processCode), title: str(body.title), summary: str(body.summary),
    ownerId: num(body.ownerId), dueDate: str(body.dueDate), data: body.data || {},
  }, user, ctx) };
}

async function closeInspection({ params, body, user, ctx }) {
  return { status: 200, body: inspections.closeInspection(params.id, {
    summary: str(body.summary), force: body.force === true,
  }, user, ctx) };
}

// ----------------------------------------------------------------- training --

async function listCurricula({ query }) {
  return { status: 200, body: { rows: training.listCurricula({ gxpArea: query.gxpArea, search: query.search }) } };
}

async function getCurriculum({ params }) {
  const row = training.getCurriculum(params.id);
  if (!row) throw notFound('Curriculum not found');
  return { status: 200, body: row };
}

async function createCurriculum({ body, user, ctx }) {
  return { status: 201, body: training.createCurriculum({
    code: requireString(body, 'code', { min: 2, max: 40 }),
    title: requireString(body, 'title', { min: 3, max: 200 }),
    titleEn: str(body.titleEn), gxpAreas: body.gxpAreas,
    appliesToRoles: body.appliesToRoles, appliesToDepartments: body.appliesToDepartments,
    validityMonths: num(body.validityMonths), isGxpCritical: body.isGxpCritical,
    documentId: num(body.documentId), description: str(body.description),
  }, user, ctx) };
}

async function assignTraining({ params, body, user, ctx }) {
  return { status: 200, body: training.assign(params.id, {
    userIds: body.userIds, roles: body.roles, departments: body.departments, dueDate: str(body.dueDate),
  }, user, ctx) };
}

async function completeTraining({ params, body, user, ctx }) {
  return { status: 200, body: training.recordCompletion(params.id, {
    status: str(body.status) || 'completed',
    method: str(body.method), score: num(body.score), passMark: num(body.passMark),
    result: str(body.result), trainerName: str(body.trainerName), trainedBy: num(body.trainedBy),
    completedAt: str(body.completedAt), validityMonths: num(body.validityMonths),
    evidence: str(body.evidence), assessmentNotes: str(body.assessmentNotes),
    signatureId: num(body.signatureId), notes: str(body.notes),
  }, user, ctx) };
}

async function trainingMatrix({ query }) {
  return { status: 200, body: training.matrix({ department: query.department, role: query.role, gxpArea: query.gxpArea }) };
}

async function userTrainingMatrix({ params }) {
  const row = training.userMatrix(num(params.id));
  if (!row) throw notFound('User not found');
  return { status: 200, body: row };
}

async function trainingCompliance({ query }) {
  return { status: 200, body: training.complianceReport(num(query.daysAhead)) };
}

async function trainingEligibility({ params, query }) {
  return { status: 200, body: training.canPerformGxPTask(num(params.id), { gxpAreas: query.gxpAreas ? String(query.gxpAreas).split(',') : null }) };
}

// ---------------------------------------------------------------- equipment --

async function listEquipment({ query }) {
  return {
    status: 200,
    body: equipment.listEquipment({
      search: query.search, status: query.status, department: query.department,
      location: query.location, gxpArea: query.gxpArea, criticality: query.criticality,
      calibrationStatus: query.calibrationStatus, qualificationStatus: query.qualificationStatus,
      limit: num(query.limit), offset: num(query.offset),
    }),
  };
}

async function getEquipment({ params }) {
  const row = equipment.getEquipment(params.id);
  if (!row) throw notFound('Equipment not found');
  return { status: 200, body: row };
}

async function createEquipment({ body, user, ctx }) {
  return { status: 201, body: equipment.createEquipment({
    assetNo: requireString(body, 'assetNo', { min: 2, max: 60 }),
    name: requireString(body, 'name', { min: 2, max: 200 }),
    nameEn: str(body.nameEn), model: str(body.model), manufacturer: str(body.manufacturer),
    serialNo: str(body.serialNo), location: str(body.location), department: str(body.department),
    gxpAreas: body.gxpAreas, qualificationStatus: str(body.qualificationStatus),
    iqDate: str(body.iqDate), oqDate: str(body.oqDate), pqDate: str(body.pqDate),
    calibrationRequired: body.calibrationRequired, calibrationIntervalDays: num(body.calibrationIntervalDays),
    lastCalibrationDate: str(body.lastCalibrationDate), nextCalibrationDate: str(body.nextCalibrationDate),
    maintenanceIntervalDays: num(body.maintenanceIntervalDays), lastMaintenanceDate: str(body.lastMaintenanceDate),
    nextMaintenanceDate: str(body.nextMaintenanceDate), status: str(body.status),
    criticality: str(body.criticality), csvStatus: str(body.csvStatus), csvRef: str(body.csvRef),
    notes: str(body.notes),
  }, user, ctx) };
}

async function updateEquipment({ params, body, user, ctx }) {
  const reason = requireReason(body);
  const patch = { ...body };
  delete patch.reason;
  return { status: 200, body: equipment.updateEquipment(params.id, patch, user, ctx, reason) };
}

async function calibrateEquipment({ params, body, user, ctx }) {
  return { status: 200, body: equipment.recordCalibration(params.id, {
    performedAt: str(body.performedAt), performedBy: str(body.performedBy),
    result: str(body.result), certificateNo: str(body.certificateNo),
    notes: str(body.notes), nextDueDate: str(body.nextDueDate),
    intervalDays: num(body.intervalDays), signatureId: num(body.signatureId),
  }, user, ctx) };
}

async function maintainEquipment({ params, body, user, ctx }) {
  return { status: 200, body: equipment.recordMaintenance(params.id, {
    performedAt: str(body.performedAt), performedBy: str(body.performedBy),
    maintenanceType: str(body.maintenanceType), result: str(body.result),
    workOrderNo: str(body.workOrderNo), notes: str(body.notes),
    nextDueDate: str(body.nextDueDate), intervalDays: num(body.intervalDays),
    signatureId: num(body.signatureId),
  }, user, ctx) };
}

async function qualifyEquipment({ params, body, user, ctx }) {
  return { status: 200, body: equipment.setQualification(params.id, {
    iq: str(body.iq), oq: str(body.oq), pq: str(body.pq), status: str(body.status),
  }, user, ctx, requireReason(body)) };
}

async function equipmentCalibrationReport({ query }) {
  return { status: 200, body: equipment.calibrationDueReport(num(query.daysAhead)) };
}

async function equipmentRaiseWorkflow({ params, body, user, ctx }) {
  return { status: 201, body: equipment.raiseWorkflowForEquipment(params.id,
    requireString(body, 'processCode', { min: 2 }),
    requireString(body, 'title', { min: 3 }),
    user, ctx) };
}

// --------------------------------------------------------------- audit trail --

async function queryAudit({ query, user }) {
  const result = audit.query({
    entityType: query.entityType, entityId: query.entityId, recordKey: query.recordKey,
    actorId: num(query.actorId), action: query.action, from: query.from, to: query.to,
    severity: query.severity, search: query.search, limit: num(query.limit), offset: num(query.offset),
  });
  if (user && user.role === 'auditor_external') {
    audit.append({
      action: 'audit_query', entityType: 'audit_trail', actor: user,
      reason: `External auditor queried the audit trail (${result.total} matching entries)`,
      ctx: { ip: null }, severity: 'warning',
    });
  }
  return { status: 200, body: result };
}

async function verifyAuditChain() {
  const result = audit.verifyChain();
  const lastRow = db.get('SELECT seq, chain_hash, at FROM audit_trail ORDER BY seq DESC LIMIT 1');
  return {
    status: result.ok ? 200 : 409,
    body: { ...result, entries: db.get('SELECT COUNT(*) AS n FROM audit_trail').n, lastEntry: lastRow || null },
  };
}

async function recordHistory({ params }) {
  const result = audit.verifyRecordHistory(params.key);
  const reconstructed = audit.reconstruct(params.key);
  return { status: 200, body: { ...result, reconstructed } };
}

async function reconstructRecord({ params, query }) {
  const state = audit.reconstruct(params.key, query.version ? num(query.version) : (query.at || undefined));
  if (!state) throw notFound('No audit history for that record key');
  return { status: 200, body: { recordKey: params.key, state } };
}

async function sealAudit({ body, user, ctx }) {
  return { status: 201, body: audit.seal(str(body.label) || `seal by ${user.username}`) };
}

/** Export the audit trail for an inspection (CSV or JSON). */
async function exportAudit({ query, user, ctx }) {
  const result = audit.query({ ...query, limit: 100000, offset: 0 });

  // An export is not a view. Reading one screen is bounded by the session; taking
  // a copy of the audit trail out of the system is not, and the copy cannot be
  // recalled. So every export is recorded, naming who took it, how many entries
  // left, and what the export was filtered to - the only way to answer "how much
  // of our data is outside the system, and whose?".
  //
  // Written BEFORE the payload is built, so an export generated but interrupted in
  // transit is still on the record as having left.
  try {
    audit.append({
      action: 'export',
      entityType: 'audit_trail',
      entityId: null,
      recordKey: 'audit_trail:export',
      actor: user || null,
      reason: `Audit trail exported (${result.rows.length} entries, format ${query.format || 'csv'})`
        + (user ? ` by ${user.username} (${user.role})` : ' by an unauthenticated caller'),
      ctx: ctx || {},
      severity: 'critical',
      meta: {
        entries: result.rows.length,
        format: query.format || 'csv',
        filter: {
          from: query.from || null, to: query.to || null,
          entityType: query.entityType || null, action: query.action || null,
          actor: query.actor || null, recordKey: query.recordKey || null,
        },
      },
    });
  } catch { /* the export proceeds even if the record cannot be written */ }

  const format = query.format || 'csv';
  if (format === 'json') {
    return { status: 200, body: { generatedAt: new Date().toISOString(), count: result.rows.length, rows: result.rows } };
  }
  const columns = ['seq', 'at', 'actor_username', 'actor_name', 'actor_role', 'action', 'entity_type',
    'entity_id', 'record_key', 'record_version', 'reason', 'old_value', 'new_value', 'ip',
    'signature_id', 'prev_hash', 'chain_hash'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
    return /[",]/.test(s) ? `"${s}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of result.rows) lines.push(columns.map((c) => escape(row[c])).join(','));
  // BOM so Excel opens UTF-8 Chinese text correctly.
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
    body: `\uFEFF${lines.join('\r\n')}`,
  };
}

// ------------------------------------------------------------------ system --

async function health() {
  const chain = audit.verifyChain();
  return {
    status: chain.ok ? 200 : 503,
    body: {
      ok: chain.ok,
      version: config.app.version,
      uptimeSeconds: Math.round(process.uptime()),
      auditChain: chain,
      database: config.dbFile,
    },
  };
}

async function systemInfo() {
  const files = {
    database: config.dbFile,
    sizeBytes: (() => { try { return require('node:fs').statSync(config.dbFile).size; } catch { return null; } })(),
  };
  const counts = {};
  for (const [label, sql] of Object.entries({
    auditEntries: 'SELECT COUNT(*) AS n FROM audit_trail',
    signatures: 'SELECT COUNT(*) AS n FROM signatures',
    users: 'SELECT COUNT(*) AS n FROM users',
    documents: 'SELECT COUNT(*) AS n FROM documents',
    records: 'SELECT COUNT(*) AS n FROM workflow_instances',
    inspections: 'SELECT COUNT(*) AS n FROM inspections',
    findings: 'SELECT COUNT(*) AS n FROM inspection_findings',
    trainingRecords: 'SELECT COUNT(*) AS n FROM training_records',
    equipment: 'SELECT COUNT(*) AS n FROM equipment',
  })) {
    counts[label] = db.get(sql).n;
  }
  return {
    status: 200,
    body: {
      app: { name: config.app.name, version: config.app.version, schemaVersion: config.app.schemaVersion },
      node: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      database: files,
      counts,
      features: config.features,
      dataDir: config.dataDir,
      tokens: { auditKeyFile: require('node:path').join(config.dataDir, 'audit-chain.key') },
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
  };
}

async function getSettings() {
  const rows = db.all('SELECT key, value, scope, updated_at FROM app_settings ORDER BY key');
  return { status: 200, body: { rows, policy: authCore.loadPolicy(), features: config.features } };
}

async function putSetting({ body, user, ctx }) {
  const key = requireString(body, 'key', { min: 1, max: 120 });
  const value = body.value === undefined ? null : JSON.stringify(body.value);
  const before = db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
  db.run(
    'INSERT INTO app_settings (key, value, scope, updated_at, updated_by) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    [key, value, str(body.scope) || 'system', new Date().toISOString(), user.id]
  );
  audit.append({
    action: 'setting_change', entityType: 'app_settings', entityId: key, actor: user,
    reason: requireReason(body, 3),
    ctx, oldValue: before ? { value: before.value } : null, newValue: { value },
    severity: 'warning',
  });
  return { status: 200, body: { ok: true } };
}

async function putPolicy({ body, user, ctx }) {
  const patch = {};
  for (const key of ['passwordMinLength', 'passwordHistoryDepth', 'passwordMaxAgeDays', 'passwordRequireClasses',
    'maxFailedLogins', 'lockoutMinutes', 'idleTimeoutMinutes', 'sessionAbsoluteHours',
    'signatureTtlMinutes', 'signatureSecondFactor', 'uniqueAccountsPerUser']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (!Object.keys(patch).length) throw bad('NOTHING_TO_UPDATE');
  return { status: 200, body: authCore.savePolicy(patch, user, ctx) };
}

async function listRoles() {
  return { status: 200, body: { rows: rbac.listRoles(), permissions: P } };
}

async function myPermissions({ user }) {
  return {
    status: 200,
    body: {
      role: user.role,
      permissions: rbac.permissionsFor(user.role),
      readOnly: rbac.isReadOnly(user),
      roleDefinition: rbac.ROLES[user.role] || null,
    },
  };
}

/** First-run setup: create the initial administrator account. */
async function setup({ body, ctx }) {
  if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) {
    throw new HttpError(409, 'ALREADY_SETUP', 'This instance already has accounts. Use the user administration screen instead.');
  }
  const username = requireString(body, 'username', { min: 3, max: 60 });
  const fullName = requireString(body, 'fullName', { min: 2, max: 120 });
  const password = requireString(body, 'password', { min: 8, max: 200 });
  const siteName = str(body.siteName) || os.hostname();

  const at = new Date().toISOString();
  let id;
  db.transaction(() => {
    db.run(
      'INSERT INTO users (username, full_name, full_name_en, email, department, job_title, role, status, locale, ' +
      'must_change_password, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [username, fullName, str(body.fullNameEn), str(body.email), str(body.department) || 'Quality Assurance',
        str(body.jobTitle) || 'System Administrator', 'system_admin', 'active', str(body.locale) || 'zh-CN', 0, at, at]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
  });
  authCore.setPassword(id, password, { id, username, role: 'system_admin' }, ctx, {
    mustChange: false, reason: 'Initial administrator account created during first-run setup',
  });
  db.run(
    'INSERT INTO app_settings (key, value, scope, updated_at, updated_by) VALUES (?,?,?,?,?)',
    ['site.name', JSON.stringify(siteName), 'system', at, id]
  );
  audit.append({
    action: 'instance_setup', entityType: 'users', entityId: id,
    actor: authCore.getUserById(id), reason: `Instance initialised; site "${siteName}"`, ctx, severity: 'critical',
    newValue: { username, full_name: fullName, role: 'system_admin', site: siteName },
  });
  const loginResult = authCore.login({ username, password, ctx });
  return {
    status: 201,
    body: { ok: true, user: loginResult.user },
    setCookie: loginResult.ok ? `${SESSION_COOKIE}=${encodeURIComponent(loginResult.session.id)}; Path=/; HttpOnly; SameSite=Strict` : undefined,
  };
}

// ----------------------------------------------------------------- routes ---

const routes = [
  // ---- unauthenticated -----------------------------------------------------
  { method: 'GET', pattern: '/api/health', auth: false, handler: health },
  { method: 'GET', pattern: '/api/bootstrap', auth: false, handler: bootstrap },
  { method: 'POST', pattern: '/api/setup', auth: false, handler: setup },
  { method: 'POST', pattern: '/api/auth/login', auth: false, handler: login },

  // ---- session -------------------------------------------------------------
  { method: 'POST', pattern: '/api/auth/logout', handler: logout },
  { method: 'GET', pattern: '/api/auth/me', handler: me },
  { method: 'POST', pattern: '/api/auth/password', handler: changeOwnPassword },
  { method: 'POST', pattern: '/api/auth/totp/enrol', handler: totpEnrol },
  { method: 'POST', pattern: '/api/auth/totp/confirm', handler: totpConfirm },
  { method: 'GET', pattern: '/api/auth/permissions', handler: myPermissions },

  // ---- electronic signature ------------------------------------------------
  { method: 'POST', pattern: '/api/signatures/challenge', handler: signatureChallenge },
  { method: 'POST', pattern: '/api/signatures', handler: applySignature },
  { method: 'GET', pattern: '/api/signatures', permission: P.AUDIT_VIEW, handler: async ({ query }) => ({
    status: 200,
    body: { rows: authCore.listSignatures(query.entityType, query.entityId) },
  }) },
  { method: 'POST', pattern: '/api/signatures/:id/invalidate', permission: P.AUDIT_VERIFY, handler: async ({ params, body, user, ctx }) => ({
    status: 200,
    body: authCore.invalidateSignature(num(params.id), user, requireReason(body, 10), ctx),
  }) },

  // ---- workflow explorer ---------------------------------------------------
  //
  // These five reads are deliberately PUBLIC, and that is a considered decision
  // rather than an oversight.
  //
  // The application opens on the domain picker, and the domain screen must be
  // able to show its own workflow before anybody has said who they are. What
  // these endpoints return is the regulatory reference material the application
  // ships with - process definitions, role duties, the permission matrix and the
  // code-enforced constraints. None of it is a GxP record, none of it is
  // per-user, and all of it is derivable from the configuration files that are
  // readable on disk anyway.
  //
  // The live counts that ARE instance data - how many records exist, whether a
  // role has an account - are withheld from an anonymous caller by the handlers,
  // so an unauthenticated visitor sees the reference model and not the state of
  // the organisation. Everything that creates, changes or closes anything stays
  // behind its own permission.
  { method: 'GET', pattern: '/api/domains', auth: false, handler: listDomains },
  { method: 'GET', pattern: '/api/philosophy', auth: false, handler: getPhilosophy },
  { method: 'GET', pattern: '/api/domain/:code', auth: false, handler: getDomain },
  { method: 'GET', pattern: '/api/explorer/:code', auth: false, handler: getWorkflowExplorer },
  { method: 'GET', pattern: '/api/assignable-roles', auth: false, handler: listAssignableRoles },
  { method: 'GET', pattern: '/api/constraints', auth: false, handler: listConstraints },
  { method: 'GET', pattern: '/api/roles/:role', auth: false, handler: getRoleDetail },

  // Managing the cast of a workflow view changes configuration, so it keeps its
  // permission and its session.
  { method: 'GET', pattern: '/api/explorer/:code/participants', handler: getParticipants },
  { method: 'POST', pattern: '/api/explorer/:code/participants', permission: P.EXPLORER_MANAGE, handler: addParticipant },
  { method: 'DELETE', pattern: '/api/explorer/:code/participants/:role', permission: P.EXPLORER_MANAGE, handler: removeParticipant },

  // ---- dashboards ----------------------------------------------------------
  { method: 'GET', pattern: '/api/dashboard', handler: getDashboard },
  { method: 'GET', pattern: '/api/inbox', handler: getInbox },
  { method: 'GET', pattern: '/api/tasks', handler: listTasks },
  { method: 'POST', pattern: '/api/notifications/:id/read', handler: markNotificationRead },
  { method: 'POST', pattern: '/api/notifications/read-all', handler: markAllNotificationsRead },
  { method: 'GET', pattern: '/api/login-choices', auth: false, handler: getLoginChoices },
  { method: 'GET', pattern: '/api/readiness', permission: P.COMPLIANCE_VIEW, handler: getReadiness },
  { method: 'GET', pattern: '/api/compliance/posture', permission: P.COMPLIANCE_VIEW, handler: getCompliancePosture },
  { method: 'GET', pattern: '/api/compliance/coverage', permission: P.COMPLIANCE_VIEW, handler: getCoverage },

  // ---- users ---------------------------------------------------------------
  { method: 'GET', pattern: '/api/users', permission: P.USER_VIEW, handler: listUsers },
  { method: 'POST', pattern: '/api/users', permission: P.USER_MANAGE, handler: createUser },
  { method: 'PATCH', pattern: '/api/users/:id', permission: P.USER_MANAGE, handler: updateUser },
  { method: 'POST', pattern: '/api/users/:id/password', permission: P.USER_MANAGE, handler: resetUserPassword },
  { method: 'GET', pattern: '/api/roles', handler: listRoles },

  // ---- documents -----------------------------------------------------------
  { method: 'GET', pattern: '/api/documents', permission: P.DOC_VIEW, handler: listDocuments },
  { method: 'POST', pattern: '/api/documents', permission: P.DOC_CREATE, handler: createDocument },
  { method: 'GET', pattern: '/api/documents/:id', permission: P.DOC_VIEW, handler: getDocument },
  { method: 'PATCH', pattern: '/api/documents/:id', permission: P.DOC_EDIT, handler: updateDocument },
  { method: 'POST', pattern: '/api/documents/:id/versions', permission: P.DOC_EDIT, handler: createDocumentVersion },
  { method: 'POST', pattern: '/api/documents/:id/versions/:version/transition', permission: P.DOC_REVIEW, handler: transitionDocument },
  { method: 'POST', pattern: '/api/documents/:id/acknowledge', permission: P.DOC_VIEW, handler: acknowledgeDocument },
  { method: 'GET', pattern: '/api/reports/document-review', permission: P.DOC_VIEW, handler: documentReviewReport },

  // ---- GxP process records -------------------------------------------------
  { method: 'GET', pattern: '/api/process-types', handler: listProcessTypes },
  { method: 'GET', pattern: '/api/process-types/:code', handler: getProcessType },

  // ---- MedDRA coding --------------------------------------------------------
  // Reading the dictionary is part of reading a case, so it is gated at the same
  // level as the case list. Validating a term is a write-shaped action on a
  // safety record, so it additionally requires signal management rights - the
  // role that owns coding quality.
  { method: 'GET', pattern: '/api/coding/dictionary', permission: P.RECORD_VIEW, handler: getDictionary },
  { method: 'GET', pattern: '/api/coding/terms', permission: P.RECORD_VIEW, handler: listCodingTerms },
  { method: 'GET', pattern: '/api/coding/socs', permission: P.RECORD_VIEW, handler: listCodingSocs },
  { method: 'POST', pattern: '/api/coding/code', permission: P.SIGNAL_MANAGE, handler: codeTerm },

  // ---- signal detection ----------------------------------------------------
  { method: 'GET', pattern: '/api/signal/analysis', permission: P.SIGNAL_MANAGE, handler: getSignalAnalysis },
  { method: 'GET', pattern: '/api/signal/line-listing', permission: P.SIGNAL_MANAGE, handler: getLineListing },
  { method: 'GET', pattern: '/api/records', permission: P.RECORD_VIEW, handler: listRecords },
  { method: 'POST', pattern: '/api/records', permission: P.RECORD_CREATE, handler: createRecord },
  { method: 'GET', pattern: '/api/records/:id', permission: P.RECORD_VIEW, handler: getRecord },
  { method: 'PATCH', pattern: '/api/records/:id', permission: P.RECORD_EDIT, handler: updateRecord },
  { method: 'POST', pattern: '/api/records/:id/steps/complete', permission: P.RECORD_EDIT, handler: completeRecordStep },
  { method: 'POST', pattern: '/api/records/:id/link', permission: P.RECORD_EDIT, handler: linkRecord },
  { method: 'POST', pattern: '/api/records/:id/cancel', permission: P.RECORD_CLOSE, handler: cancelRecord },

  // ---- inspections ---------------------------------------------------------
  { method: 'GET', pattern: '/api/checklists', permission: P.INSPECTION_VIEW, handler: listChecklistTemplates },
  { method: 'GET', pattern: '/api/checklists/:code', permission: P.INSPECTION_VIEW, handler: getChecklistTemplate },
  { method: 'GET', pattern: '/api/inspections', permission: P.INSPECTION_VIEW, handler: listInspections },
  { method: 'POST', pattern: '/api/inspections', permission: P.INSPECTION_MANAGE, handler: createInspection },
  { method: 'GET', pattern: '/api/inspections/:id', permission: P.INSPECTION_VIEW, handler: getInspection },
  { method: 'POST', pattern: '/api/inspections/:id/close', permission: P.INSPECTION_MANAGE, handler: closeInspection },
  { method: 'POST', pattern: '/api/findings/:id/assess', permission: P.INSPECTION_MANAGE, handler: assessFinding },
  { method: 'POST', pattern: '/api/findings/:id/escalate', permission: P.INSPECTION_MANAGE, handler: escalateFinding },

  // ---- training ------------------------------------------------------------
  { method: 'GET', pattern: '/api/curricula', permission: P.TRAINING_VIEW, handler: listCurricula },
  { method: 'POST', pattern: '/api/curricula', permission: P.TRAINING_MANAGE, handler: createCurriculum },
  { method: 'GET', pattern: '/api/curricula/:id', permission: P.TRAINING_VIEW, handler: getCurriculum },
  { method: 'POST', pattern: '/api/curricula/:id/assign', permission: P.TRAINING_MANAGE, handler: assignTraining },
  { method: 'POST', pattern: '/api/training-records/:id/complete', permission: P.TRAINING_ASSESS, handler: completeTraining },
  { method: 'GET', pattern: '/api/training/matrix', permission: P.TRAINING_VIEW, handler: trainingMatrix },
  { method: 'GET', pattern: '/api/training/matrix/:id', permission: P.TRAINING_VIEW, handler: userTrainingMatrix },
  { method: 'GET', pattern: '/api/training/compliance', permission: P.TRAINING_VIEW, handler: trainingCompliance },
  { method: 'GET', pattern: '/api/training/eligibility/:id', permission: P.TRAINING_VIEW, handler: trainingEligibility },

  // ---- equipment -----------------------------------------------------------
  { method: 'GET', pattern: '/api/equipment', permission: P.EQUIPMENT_VIEW, handler: listEquipment },
  { method: 'POST', pattern: '/api/equipment', permission: P.EQUIPMENT_MANAGE, handler: createEquipment },
  { method: 'GET', pattern: '/api/equipment/:id', permission: P.EQUIPMENT_VIEW, handler: getEquipment },
  { method: 'PATCH', pattern: '/api/equipment/:id', permission: P.EQUIPMENT_MANAGE, handler: updateEquipment },
  { method: 'POST', pattern: '/api/equipment/:id/calibration', permission: P.EQUIPMENT_MANAGE, handler: calibrateEquipment },
  { method: 'POST', pattern: '/api/equipment/:id/maintenance', permission: P.EQUIPMENT_MANAGE, handler: maintainEquipment },
  { method: 'POST', pattern: '/api/equipment/:id/qualification', permission: P.EQUIPMENT_MANAGE, handler: qualifyEquipment },
  { method: 'POST', pattern: '/api/equipment/:id/raise-record', permission: P.DEVIATION_MANAGE, handler: equipmentRaiseWorkflow },
  { method: 'GET', pattern: '/api/reports/calibration', permission: P.EQUIPMENT_VIEW, handler: equipmentCalibrationReport },

  // ---- audit trail ---------------------------------------------------------
  { method: 'GET', pattern: '/api/audit', permission: P.AUDIT_VIEW, handler: queryAudit },
  { method: 'GET', pattern: '/api/audit/verify', permission: P.AUDIT_VERIFY, handler: verifyAuditChain },
  { method: 'GET', pattern: '/api/audit/export', permission: P.AUDIT_EXPORT, handler: exportAudit },
  { method: 'POST', pattern: '/api/audit/seal', permission: P.AUDIT_VERIFY, handler: sealAudit },
  { method: 'GET', pattern: '/api/audit/history/:key', permission: P.AUDIT_VIEW, handler: recordHistory },
  { method: 'GET', pattern: '/api/audit/reconstruct/:key', permission: P.AUDIT_VIEW, handler: reconstructRecord },

  // ---- system --------------------------------------------------------------
  { method: 'GET', pattern: '/api/system/info', permission: P.SETTINGS_MANAGE, handler: systemInfo },
  { method: 'GET', pattern: '/api/system/settings', permission: P.SETTINGS_MANAGE, handler: getSettings },
  { method: 'PUT', pattern: '/api/system/settings', permission: P.SETTINGS_MANAGE, handler: putSetting },
  { method: 'PUT', pattern: '/api/system/policy', permission: P.POLICY_MANAGE, handler: putPolicy },
];

// Match a concrete path against a pattern with `:param` segments.
function matchRoute(method, path, route) {
  if (route.method !== method) return null;
  const routeParts = route.pattern.split('/');
  const pathParts = path.split('/');
  if (routeParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < routeParts.length; i += 1) {
    const rp = routeParts[i];
    if (rp.startsWith(':')) {
      params[rp.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (rp !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

async function handle({ method, path, query, body, user, session, ctx }) {
  let matched = null;
  for (const route of routes) {
    const params = matchRoute(method, path, route);
    if (params) { matched = { route, params }; break; }
  }
  if (!matched) {
    return { status: 404, body: { error: 'NO_SUCH_ENDPOINT', message: `No API endpoint for ${method} ${path}` } };
  }

  const { route, params } = matched;

  if (route.auth === false) {
    return route.handler({ method, path, query, body, user, session, ctx, params });
  }

  if (!user) {
    return {
      status: 401,
      body: { error: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue. GxP records are only available to authenticated users.' },
    };
  }

  // 21 CFR Part 11.10(d)/(g): enforce authority before doing any work.
  if (route.permission && !rbac.hasPermission(user, route.permission)) {
    audit.append({
      action: 'access_denied', entityType: 'api', entityId: path, actor: user,
      reason: `Missing permission "${route.permission}" for ${method} ${path}`,
      ctx, severity: 'warning',
    });
    return {
      status: 403,
      body: {
        error: 'PERMISSION_DENIED',
        message: `Your role (${user.role}) does not include the "${route.permission}" permission.`,
        requiredPermission: route.permission,
      },
    };
  }

  // Users with a temporary password must change it before touching GxP data.
  if (user.must_change_password && !['/api/auth/password', '/api/auth/me', '/api/auth/logout'].includes(path)) {
    return {
      status: 403,
      body: {
        error: 'PASSWORD_CHANGE_REQUIRED',
        message: 'You must set a new password before working with GxP records (21 CFR Part 11.300(b)).',
      },
    };
  }

  return route.handler({ method, path, query, body, user, session, ctx, params });
}

module.exports = { routes, handle, HttpError, matchRoute };
