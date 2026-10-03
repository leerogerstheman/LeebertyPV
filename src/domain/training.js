'use strict';

/**
 * Training and qualification matrix.
 *
 * Regulatory basis
 * ----------------
 *  - EU GMP Chapter 2.10-2.14  personnel must be trained in the GMP requirements
 *    relevant to their duties; training records must be kept; effectiveness of
 *    training must be assessed; GMP-relevant training is part of the quality
 *    system.
 *  - EU GMP Chapter 3.6  persons authorised to enter production/QC areas.
 *  - 21 CFR Part 211.25  personnel qualifications, training, and documented
 *    evidence of training.
 *  - 21 CFR Part 58.29 (GLP)  personnel must have education/training/experience,
 *    and records of training must be maintained.
 *  - ICH E6(R2) §4.1.2 / §4.2.4  investigator and staff qualifications, CVs and
 *    documented training.
 *  - 21 CFR Part 11.10(i)  persons who use electronic signature systems must be
 *    trained and their training documented.
 *
 * The "matrix" view answers the question that actually blocks release in an
 * audit: *can this specific person perform this specific GxP task today?*
 */

const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');

function nowIso() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const METHOD_LABELS = {
  classroom: 'Classroom training',
  self_study: 'Self study / read & understood',
  on_the_job: 'On-the-job training',
  external: 'External course / conference',
  e_learning: 'E-learning (with assessment)',
  qualification: 'Formal qualification / certification',
};

const TRAINING_STATUSES = ['assigned', 'in_progress', 'completed', 'failed', 'expired', 'waived'];

// -------------------------------------------------------------- curricula ---

function createCurriculum(input, actor, ctx) {
  const code = String(input.code || '').trim().toUpperCase();
  const title = String(input.title || '').trim();
  if (!code) throw httpError(400, 'CODE_REQUIRED');
  if (title.length < 3) throw httpError(400, 'TITLE_REQUIRED');
  if (db.get('SELECT id FROM training_curricula WHERE code = ?', [code])) {
    throw httpError(409, 'CURRICULUM_EXISTS', `Curriculum ${code} already exists`);
  }
  const at = nowIso();
  let id;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO training_curricula (code, title, title_en, gxp_areas, applies_to_roles, applies_to_departments, ' +
      'validity_months, is_gxp_critical, document_id, description, created_at, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [code, title, input.titleEn || null, JSON.stringify(input.gxpAreas || []),
        JSON.stringify(input.appliesToRoles || []), JSON.stringify(input.appliesToDepartments || []),
        input.validityMonths != null ? Number(input.validityMonths) : 24,
        input.isGxpCritical === false ? 0 : 1, input.documentId || null,
        input.description || null, at, 1]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
  });
  audit.append({
    action: 'create', entityType: 'training_curricula', entityId: id, actor,
    reason: 'Training curriculum created', ctx, gxpAreas: input.gxpAreas || [],
    newValue: { code, title, validity_months: input.validityMonths || 24 },
  });
  return getCurriculum(id);
}

function getCurriculum(idOrCode) {
  const row = /^\d+$/.test(String(idOrCode))
    ? db.get('SELECT * FROM training_curricula WHERE id = ?', [Number(idOrCode)])
    : db.get('SELECT * FROM training_curricula WHERE code = ?', [String(idOrCode)]);
  if (!row) return null;
  const records = db.all(
    `SELECT tr.*, u.full_name, u.username, u.department, u.role
     FROM training_records tr JOIN users u ON u.id = tr.user_id
     WHERE tr.curriculum_id = ? ORDER BY tr.updated_at DESC`,
    [row.id]
  );
  const doc = row.document_id ? db.get('SELECT doc_number, title FROM documents WHERE id = ?', [row.document_id]) : null;
  return {
    id: row.id, code: row.code, title: row.title, titleEn: row.title_en,
    gxpAreas: parseJson(row.gxp_areas, []),
    appliesToRoles: parseJson(row.applies_to_roles, []),
    appliesToDepartments: parseJson(row.applies_to_departments, []),
    validityMonths: row.validity_months, isGxpCritical: Boolean(row.is_gxp_critical),
    documentId: row.document_id, document: doc, description: row.description,
    active: Boolean(row.active), createdAt: row.created_at,
    stats: summariseRecords(records),
    records: records.map(mapRecord),
  };
}

function listCurricula(filters = {}) {
  let rows = db.all('SELECT * FROM training_curricula WHERE active = 1 ORDER BY code');
  if (filters.gxpArea) rows = rows.filter((r) => parseJson(r.gxp_areas, []).includes(filters.gxpArea));
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    rows = rows.filter((r) => r.code.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));
  }
  return rows.map((r) => {
    const records = db.all('SELECT * FROM training_records WHERE curriculum_id = ?', [r.id]);
    return {
      id: r.id, code: r.code, title: r.title, titleEn: r.title_en,
      gxpAreas: parseJson(r.gxp_areas, []),
      appliesToRoles: parseJson(r.applies_to_roles, []),
      appliesToDepartments: parseJson(r.applies_to_departments, []),
      validityMonths: r.validity_months, isGxpCritical: Boolean(r.is_gxp_critical),
      documentId: r.document_id, description: r.description,
      stats: summariseRecords(records),
    };
  });
}

function summariseRecords(records) {
  const byStatus = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const expired = records.filter((r) => r.status === 'completed' && r.expires_at && Date.parse(r.expires_at) < Date.now()).length;
  const compliance = records.length ? Math.round(((records.length - (byStatus.assigned || 0) - (byStatus.in_progress || 0) - (byStatus.failed || 0) - expired) / records.length) * 100) : null;
  return { total: records.length, byStatus, expired, compliancePercent: compliance };
}

// --------------------------------------------------------------- assignment --

/**
 * Assign a curriculum to a user (or bulk-assign by role/department).
 */
function assign(curriculumId, targets, actor, ctx) {
  const cur = db.get('SELECT * FROM training_curricula WHERE id = ?', [Number(curriculumId)]);
  if (!cur) throw httpError(404, 'CURRICULUM_NOT_FOUND');
  const at = nowIso();
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  let users = [];
  if (Array.isArray(targets.userIds) && targets.userIds.length) {
    users = db.all(
      `SELECT id FROM users WHERE id IN (${targets.userIds.map(() => '?').join(',')}) AND status = 'active'`,
      targets.userIds.map(Number)
    );
  } else {
    const where = ["status = 'active'"];
    const params = [];
    if (Array.isArray(targets.roles) && targets.roles.length) {
      where.push(`role IN (${targets.roles.map(() => '?').join(',')})`);
      params.push(...targets.roles);
    }
    if (Array.isArray(targets.departments) && targets.departments.length) {
      where.push(`department IN (${targets.departments.map(() => '?').join(',')})`);
      params.push(...targets.departments);
    }
    users = db.all(`SELECT id FROM users WHERE ${where.join(' AND ')}`, params);
  }
  if (!users.length) return { ok: true, assigned: 0 };

  let assigned = 0;
  db.transaction(() => {
    for (const u of users) {
      const existing = db.get(
        "SELECT id FROM training_records WHERE curriculum_id = ? AND user_id = ? AND status IN ('assigned','in_progress')",
        [cur.id, u.id]
      );
      if (existing) continue;
      db.run(
        'INSERT INTO training_records (curriculum_id, user_id, status, assigned_at, due_date, updated_at) VALUES (?,?,?,?,?,?)',
        [cur.id, u.id, 'assigned', at, targets.dueDate || dueDate, at]
      );
      assigned += 1;
    }
  });
  audit.append({
    action: 'training_assigned', entityType: 'training_curricula', entityId: cur.id, actor,
    reason: `Curriculum ${cur.code} assigned to ${assigned} user(s)`, ctx,
    meta: { curriculum: cur.code, assigned, dueDate: targets.dueDate || dueDate },
  });
  return { ok: true, assigned, curriculum: cur.code };
}

/**
 * Record the outcome of a training event. Completion requires a signature when
 * the curriculum is GxP-critical (the trainer or the trainee attests).
 */
function recordCompletion(recordId, input, actor, ctx) {
  const rec = db.get('SELECT * FROM training_records WHERE id = ?', [Number(recordId)]);
  if (!rec) throw httpError(404, 'TRAINING_RECORD_NOT_FOUND');
  const cur = db.get('SELECT * FROM training_curricula WHERE id = ?', [rec.curriculum_id]);
  const status = String(input.status || 'completed');
  if (!TRAINING_STATUSES.includes(status)) throw httpError(400, 'INVALID_STATUS');

  if (status === 'completed') {
    if (!input.method || !METHOD_LABELS[input.method]) {
      throw httpError(400, 'METHOD_REQUIRED', `Training method is required. Known: ${Object.keys(METHOD_LABELS).join(', ')}`);
    }
    if (input.score != null && input.passMark != null && Number(input.score) < Number(input.passMark)) {
      throw httpError(409, 'SCORE_BELOW_PASS_MARK', `Score ${input.score} is below the pass mark ${input.passMark}; record as "failed"`);
    }
    if (cur && cur.is_gxp_critical && !input.signatureId) {
      throw httpError(428, 'SIGNATURE_REQUIRED',
        'Completing GxP-critical training requires a signed record (EU GMP Chapter 2.12 / 21 CFR Part 211.25)');
    }
    if (input.signatureId) {
      const sig = db.get('SELECT * FROM signatures WHERE id = ?', [Number(input.signatureId)]);
      if (!sig || !sig.valid) throw httpError(400, 'SIGNATURE_INVALID');
      if (sig.user_id !== actor.id) throw httpError(403, 'SIGNATURE_NOT_YOURS');
    }
  }

  const at = nowIso();
  const completedAt = status === 'completed' ? (input.completedAt || at) : null;
  const validityMonths = input.validityMonths != null ? Number(input.validityMonths) : (cur ? cur.validity_months : 24);
  const expiresAt = (status === 'completed' && validityMonths)
    ? new Date(Date.parse(completedAt) + validityMonths * 30.44 * 86400000).toISOString().slice(0, 10)
    : null;

  const before = { status: rec.status, result: rec.result, expires_at: rec.expires_at };
  db.run(
    'UPDATE training_records SET status = ?, completed_at = ?, trained_by = ?, trainer_name = ?, method = ?, ' +
    'score = ?, pass_mark = ?, result = ?, expires_at = ?, evidence = ?, assessment_notes = ?, signature_id = ?, updated_at = ? WHERE id = ?',
    [status, completedAt, input.trainedBy || (actor ? actor.id : null), input.trainerName || (actor ? actor.full_name : null),
      input.method || rec.method, input.score != null ? Number(input.score) : rec.score,
      input.passMark != null ? Number(input.passMark) : rec.pass_mark,
      input.result || (status === 'completed' ? 'pass' : status), expiresAt,
      input.evidence || rec.evidence, input.assessmentNotes || null,
      input.signatureId || rec.signature_id, at, rec.id]
  );

  audit.recordChange({
    actor, entityType: 'training_records', entityId: rec.id,
    recordKey: `training:${rec.id}`, before,
    after: { status, result: input.result || 'pass', score: input.score, expires_at: expiresAt, method: input.method },
    reason: input.notes || `Training ${status} for curriculum ${cur ? cur.code : rec.curriculum_id}`,
    ctx, action: 'training_completion', signatureId: input.signatureId || null,
    gxpAreas: cur ? parseJson(cur.gxp_areas, []) : [],
  });

  refreshUserTrainingStatus(rec.user_id);
  return getTrainingRecord(rec.id);
}

function getTrainingRecord(id) {
  const r = db.get(
    `SELECT tr.*, c.code AS curriculum_code, c.title AS curriculum_title, c.is_gxp_critical, c.gxp_areas,
            u.full_name, u.username
     FROM training_records tr
     JOIN training_curricula c ON c.id = tr.curriculum_id
     JOIN users u ON u.id = tr.user_id WHERE tr.id = ?`,
    [Number(id)]
  );
  return r ? mapRecord(r) : null;
}

function mapRecord(r) {
  const expired = r.status === 'completed' && r.expires_at && Date.parse(r.expires_at) < Date.now();
  const effStatus = expired ? 'expired' : r.status;
  return {
    id: r.id,
    curriculumId: r.curriculum_id,
    curriculumCode: r.curriculum_code,
    curriculumTitle: r.curriculum_title,
    userId: r.user_id,
    userName: r.full_name,
    username: r.username,
    department: r.department,
    role: r.role,
    status: effStatus,
    storedStatus: r.status,
    assignedAt: r.assigned_at,
    dueDate: r.due_date,
    completedAt: r.completed_at,
    trainerName: r.trainer_name,
    method: r.method,
    methodLabel: METHOD_LABELS[r.method] || r.method,
    score: r.score,
    passMark: r.pass_mark,
    result: r.result,
    expiresAt: r.expires_at,
    daysToExpiry: r.expires_at ? Math.ceil((Date.parse(r.expires_at) - Date.now()) / 86400000) : null,
    evidence: r.evidence,
    assessmentNotes: r.assessment_notes,
    signatureId: r.signature_id,
    isGxpCritical: r.is_gxp_critical != null ? Boolean(r.is_gxp_critical) : undefined,
    overdue: r.status !== 'completed' && r.due_date ? Date.parse(r.due_date) < Date.now() : false,
  };
}

/**
 * Recompute the denormalised `users.training_status` flag used by the matrix
 * so task assignment can be blocked for untrained staff.
 */
function refreshUserTrainingStatus(userId) {
  const rows = db.all(
    `SELECT tr.status, tr.expires_at, c.is_gxp_critical
     FROM training_records tr JOIN training_curricula c ON c.id = tr.curriculum_id
     WHERE tr.user_id = ?`,
    [Number(userId)]
  );
  const critical = rows.filter((r) => r.is_gxp_critical);
  let status = 'not_required';
  if (critical.length) {
    const bad = critical.filter((r) => r.status !== 'completed' || (r.expires_at && Date.parse(r.expires_at) < Date.now()));
    if (!bad.length) status = 'current';
    else if (bad.some((r) => r.status === 'failed')) status = 'failed';
    else if (bad.every((r) => r.status === 'assigned')) status = 'pending';
    else status = 'expired_or_incomplete';
  }
  db.run('UPDATE users SET training_status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), Number(userId)]);
  return status;
}

/** Per-user view: everything assigned, plus what is missing. */
function userMatrix(userId) {
  const user = db.get('SELECT * FROM users WHERE id = ?', [Number(userId)]);
  if (!user) return null;
  const records = db.all(
    `SELECT tr.*, c.code AS curriculum_code, c.title AS curriculum_title, c.is_gxp_critical
     FROM training_records tr JOIN training_curricula c ON c.id = tr.curriculum_id
     WHERE tr.user_id = ? ORDER BY c.code`,
    [user.id]
  );

  // Which curricula *should* this person hold, based on role/department?
  const allCurricula = db.all('SELECT * FROM training_curricula WHERE active = 1');
  const required = allCurricula.filter((c) => {
    const roles = parseJson(c.applies_to_roles, []);
    const depts = parseJson(c.applies_to_departments, []);
    if (!roles.length && !depts.length) return false;
    return roles.includes(user.role) || (user.department && depts.includes(user.department));
  });
  const heldCodes = new Set(records.filter((r) => r.status === 'completed'
    && (!r.expires_at || Date.parse(r.expires_at) > Date.now())).map((r) => r.curriculum_code));
  const missing = required.filter((c) => !heldCodes.has(c.code)).map((c) => ({
    id: c.id, code: c.code, title: c.title, isGxpCritical: Boolean(c.is_gxp_critical),
  }));

  const expired = records.filter((r) => r.status === 'completed' && r.expires_at && Date.parse(r.expires_at) < Date.now());
  const dueSoon = records.filter((r) => r.expires_at && Date.parse(r.expires_at) >= Date.now()
    && Date.parse(r.expires_at) - Date.now() < config.reminder.trainingExpiryWarningDays * 86400000);

  return {
    user: {
      id: user.id, username: user.username, fullName: user.full_name, department: user.department,
      role: user.role, jobTitle: user.job_title, qualification: parseJson(user.qualification, {}),
      trainingStatus: user.training_status,
    },
    qualifiedForGxP: missing.filter((m) => m.isGxpCritical).length === 0 && expired.filter((r) => r.is_gxp_critical).length === 0,
    records: records.map(mapRecord),
    missingRequired: missing,
    expiringSoon: expired.concat(dueSoon).map(mapRecord),
    counts: {
      held: heldCodes.size, required: required.length, missing: missing.length,
      expired: expired.length, dueSoon: dueSoon.length,
    },
  };
}

/** The full matrix: rows = personnel, columns = curricula, cells = status. */
function matrix(filters = {}) {
  const userWhere = ["u.status = 'active'"];
  const userParams = [];
  if (filters.department) { userWhere.push('u.department = ?'); userParams.push(filters.department); }
  if (filters.role) { userWhere.push('u.role = ?'); userParams.push(filters.role); }
  const users = db.all(
    `SELECT u.id, u.username, u.full_name, u.department, u.role, u.job_title, u.training_status, u.qualification
     FROM users u WHERE ${userWhere.join(' AND ')} ORDER BY u.department, u.full_name`,
    userParams
  );
  let curricula = db.all('SELECT * FROM training_curricula WHERE active = 1 ORDER BY code');
  if (filters.gxpArea) curricula = curricula.filter((c) => parseJson(c.gxp_areas, []).includes(filters.gxpArea));

  const recordMap = new Map();
  for (const r of db.all('SELECT * FROM training_records')) {
    recordMap.set(`${r.user_id}:${r.curriculum_id}`, r);
  }

  const cells = {};
  for (const u of users) {
    for (const c of curricula) {
      const rec = recordMap.get(`${u.id}:${c.id}`);
      let state = 'not_assigned';
      if (rec) {
        if (rec.status === 'completed') {
          state = (rec.expires_at && Date.parse(rec.expires_at) < Date.now()) ? 'expired' : 'valid';
        } else if (rec.status === 'failed') state = 'failed';
        else if (rec.due_date && Date.parse(rec.due_date) < Date.now()) state = 'overdue';
        else state = rec.status;
      }
      cells[`${u.id}:${c.id}`] = {
        state,
        recordId: rec ? rec.id : null,
        expiresAt: rec ? rec.expires_at : null,
        score: rec ? rec.score : null,
      };
    }
  }

  const gxpCritical = curricula.filter((c) => c.is_gxp_critical);
  const gaps = [];
  for (const u of users) {
    for (const c of gxpCritical) {
      const cell = cells[`${u.id}:${c.id}`];
      const roles = parseJson(c.applies_to_roles, []);
      const depts = parseJson(c.applies_to_departments, []);
      const applies = roles.includes(u.role) || (u.department && depts.includes(u.department));
      if (applies && !['valid'].includes(cell.state)) {
        gaps.push({
          userId: u.id, userName: u.full_name, department: u.department, role: u.role,
          curriculumCode: c.code, curriculumTitle: c.title, state: cell.state, dueDate: null,
        });
      }
    }
  }

  return {
    generatedAt: nowIso(),
    users: users.map((u) => ({
      id: u.id, username: u.username, fullName: u.full_name, department: u.department,
      role: u.role, jobTitle: u.job_title, trainingStatus: u.training_status,
      qualification: parseJson(u.qualification, {}),
    })),
    curricula: curricula.map((c) => ({
      id: c.id, code: c.code, title: c.title, isGxpCritical: Boolean(c.is_gxp_critical),
      gxpAreas: parseJson(c.gxp_areas, []), validityMonths: c.validity_months,
    })),
    cells,
    gaps,
    summary: {
      users: users.length,
      curricula: curricula.length,
      gxpCriticalCurricula: gxpCritical.length,
      gaps: gaps.length,
      personnelFullyQualified: users.length - new Set(gaps.map((g) => g.userId)).size,
    },
  };
}

/** Everything expiring or overdue, for the dashboard and reminder engine. */
function complianceReport(daysAhead) {
  const days = daysAhead != null ? Number(daysAhead) : config.reminder.trainingExpiryWarningDays;
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  const overdue = db.all(
    `SELECT tr.id, u.full_name, u.department, c.code, c.title, tr.due_date
     FROM training_records tr JOIN users u ON u.id = tr.user_id JOIN training_curricula c ON c.id = tr.curriculum_id
     WHERE tr.status IN ('assigned','in_progress') AND tr.due_date IS NOT NULL AND tr.due_date < date('now')
       AND u.status = 'active' ORDER BY tr.due_date ASC`
  );
  const expiring = db.all(
    `SELECT tr.id, u.full_name, u.department, c.code, c.title, tr.expires_at
     FROM training_records tr JOIN users u ON u.id = tr.user_id JOIN training_curricula c ON c.id = tr.curriculum_id
     WHERE tr.status = 'completed' AND tr.expires_at IS NOT NULL AND tr.expires_at <= ? AND tr.expires_at >= date('now')
       AND u.status = 'active' ORDER BY tr.expires_at ASC`,
    [horizon]
  );
  const expired = db.all(
    `SELECT tr.id, u.full_name, u.department, c.code, c.title, tr.expires_at, c.is_gxp_critical
     FROM training_records tr JOIN users u ON u.id = tr.user_id JOIN training_curricula c ON c.id = tr.curriculum_id
     WHERE tr.status = 'completed' AND tr.expires_at IS NOT NULL AND tr.expires_at < date('now')
       AND u.status = 'active' ORDER BY tr.expires_at ASC`
  );
  const untrained = db.all(
    "SELECT id, username, full_name, department, role FROM users WHERE status = 'active' AND (training_status IS NULL OR training_status NOT IN ('current','not_required'))"
  );
  return {
    daysAhead: days,
    overdue: overdue.map((r) => ({ recordId: r.id, userName: r.full_name, department: r.department, curriculumCode: r.code, curriculumTitle: r.title, dueDate: r.due_date })),
    expiring: expiring.map((r) => ({ recordId: r.id, userName: r.full_name, department: r.department, curriculumCode: r.code, curriculumTitle: r.title, expiresAt: r.expires_at })),
    expired: expired.map((r) => ({ recordId: r.id, userName: r.full_name, department: r.department, curriculumCode: r.code, curriculumTitle: r.title, expiresAt: r.expires_at, gxpCritical: Boolean(r.is_gxp_critical) })),
    untrainedUsers: untrained.map((r) => ({ id: r.id, username: r.username, fullName: r.full_name, department: r.department, role: r.role })),
    counts: { overdue: overdue.length, expiring: expiring.length, expired: expired.length, untrained: untrained.length },
  };
}

/**
 * Gate for the shop floor: may this user execute a GxP task right now?
 * Returns the blocking reasons rather than a bare boolean so the UI can explain.
 */
function canPerformGxPTask(userId, opts = {}) {
  const reasons = [];
  const user = db.get('SELECT * FROM users WHERE id = ?', [Number(userId)]);
  if (!user) return { allowed: false, reasons: ['USER_NOT_FOUND'] };
  if (user.status !== 'active') reasons.push(`ACCOUNT_${String(user.status).toUpperCase()}`);
  if (user.must_change_password) reasons.push('PASSWORD_CHANGE_REQUIRED');

  const matrixData = userMatrix(userId);
  if (matrixData) {
    const criticalMissing = matrixData.missingRequired.filter((m) => m.isGxpCritical);
    if (criticalMissing.length && opts.requireTraining !== false) {
      reasons.push(`MISSING_REQUIRED_TRAINING: ${criticalMissing.map((m) => m.code).join(', ')}`);
    }
    const criticalExpired = matrixData.expiringSoon.filter((r) => r.status === 'expired' && r.isGxpCritical);
    if (criticalExpired.length) {
      reasons.push(`TRAINING_EXPIRED: ${criticalExpired.map((r) => r.curriculumCode).join(', ')}`);
    }
  }
  if (opts.gxpAreas && opts.gxpAreas.length) {
    const qualified = parseJson(user.qualification, {});
    for (const area of opts.gxpAreas) {
      if (qualified[area] === false) reasons.push(`NOT_QUALIFIED_FOR_${area}`);
    }
  }
  return { allowed: reasons.length === 0, reasons, user: { id: user.id, username: user.username, trainingStatus: user.training_status } };
}

function metrics() {
  const totalRecords = db.get('SELECT COUNT(*) AS n FROM training_records').n;
  const byStatus = db.all('SELECT status, COUNT(*) AS n FROM training_records GROUP BY status');
  const report = complianceReport();
  const gxpCriticalCurricula = db.get('SELECT COUNT(*) AS n FROM training_curricula WHERE is_gxp_critical = 1 AND active = 1').n;
  const completionRate = totalRecords
    ? Math.round(((db.get("SELECT COUNT(*) AS n FROM training_records WHERE status = 'completed'").n) / totalRecords) * 100)
    : null;
  return {
    totalRecords, byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    gxpCriticalCurricula, completionRate,
    overdue: report.counts.overdue, expiringSoon: report.counts.expiring,
    expired: report.counts.expired, untrainedUsers: report.counts.untrained,
  };
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  createCurriculum,
  getCurriculum,
  listCurricula,
  assign,
  recordCompletion,
  getTrainingRecord,
  userMatrix,
  matrix,
  complianceReport,
  canPerformGxPTask,
  refreshUserTrainingStatus,
  metrics,
  METHOD_LABELS,
  TRAINING_STATUSES,
  httpError,
};
