'use strict';

/**
 * Document control.
 *
 * Regulatory basis
 * ----------------
 *  - 21 CFR Part 211.180(e)  periodic review of records/SOPs.
 *  - 21 CFR Part 211.160 / 211.186  master production and control records.
 *  - EU GMP Chapter 4  documentation: specifications, manufacturing formulae,
 *    processing instructions, testing procedures; documents must be approved,
 *    signed and dated by authorised persons; no document may be changed without
 *    authorisation; superseded documents must be retained.
 *  - EU GMP Annex 11 §4.2  version control and change history for documents.
 *  - GLP 21 CFR Part 58.81 / 58.195  SOPs and retention for the study period.
 *  - ICH E6(R2) §8  essential documents for trial master file.
 *
 * Lifecycle modelled here:
 *   draft -> in_review -> approved -> effective -> (superseded | obsolete | retired)
 * with periodic review driven by `review_period_months`, and training
 * assignments raised automatically when a new version goes effective.
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

const STATUSES = ['draft', 'in_review', 'approved', 'effective', 'superseded', 'obsolete', 'retired'];

/** Regulated document types across all GxP areas. */
const DOC_TYPES = {
  sop: { label: 'Standard Operating Procedure', labelZh: '标准操作规程', gxp: ['GMP', 'GLP', 'GCP', 'GDP'] },
  policy: { label: 'Policy', labelZh: '方针/政策', gxp: ['GMP', 'GLP', 'GCP'] },
  specification: { label: 'Specification', labelZh: '质量标准/规格', gxp: ['GMP', 'GLP'] },
  test_method: { label: 'Analytical Test Method', labelZh: '检验方法', gxp: ['GMP', 'GLP'] },
  batch_record: { label: 'Master Batch Record', labelZh: '主批记录', gxp: ['GMP'] },
  validation_protocol: { label: 'Validation Protocol (IQ/OQ/PQ)', labelZh: '验证方案', gxp: ['GMP', 'GCP'] },
  validation_report: { label: 'Validation Report', labelZh: '验证报告', gxp: ['GMP', 'GCP'] },
  csv_plan: { label: 'Computerised System Validation Plan', labelZh: '计算机化系统验证计划', gxp: ['GMP', 'GLP', 'GCP'] },
  study_plan: { label: 'Study Plan / Protocol', labelZh: '试验方案', gxp: ['GLP', 'GCP'] },
  protocol_amendment: { label: 'Protocol Amendment', labelZh: '方案修订', gxp: ['GLP', 'GCP'] },
  investigator_brochure: { label: 'Investigator Brochure', labelZh: '研究者手册', gxp: ['GCP'] },
  icf: { label: 'Informed Consent Form', labelZh: '知情同意书', gxp: ['GCP'] },
  crf: { label: 'Case Report Form', labelZh: '病例报告表', gxp: ['GCP'] },
  pv_plan: { label: 'Pharmacovigilance System Master File', labelZh: '药物警戒体系主文件', gxp: ['GVP'] },
  recall_plan: { label: 'Recall / Return Procedure', labelZh: '召回/退货程序', gxp: ['GDP', 'GMP'] },
  stability_protocol: { label: 'Stability Study Protocol', labelZh: '稳定性试验方案', gxp: ['GMP', 'GLP'] },
  training_manual: { label: 'Training Manual', labelZh: '培训手册', gxp: ['GMP', 'GLP', 'GCP'] },
  job_description: { label: 'Job Description / Qualification Record', labelZh: '岗位说明书/资质记录', gxp: ['GMP', 'GLP', 'GCP'] },
  form: { label: 'Controlled Form / Template', labelZh: '受控表单/模板', gxp: ['GMP', 'GLP', 'GCP'] },
  report: { label: 'Report', labelZh: '报告', gxp: ['GMP', 'GLP', 'GCP'] },
};

const REVIEW_PERIOD_OPTIONS = [6, 12, 24, 36, 60];

// ------------------------------------------------------------------ create --

function createDocument(input, actor, ctx) {
  const docNumber = String(input.docNumber || '').trim();
  const title = String(input.title || '').trim();
  if (!docNumber) throw httpError(400, 'DOC_NUMBER_REQUIRED');
  if (title.length < 3) throw httpError(400, 'TITLE_REQUIRED');
  if (!DOC_TYPES[input.docType]) throw httpError(400, 'INVALID_DOC_TYPE', `Known types: ${Object.keys(DOC_TYPES).join(', ')}`);
  if (db.get('SELECT id FROM documents WHERE doc_number = ?', [docNumber])) {
    throw httpError(409, 'DOC_NUMBER_EXISTS', `Document number ${docNumber} already exists`);
  }
  const gxpAreas = Array.isArray(input.gxpAreas) && input.gxpAreas.length
    ? input.gxpAreas
    : DOC_TYPES[input.docType].gxp;
  const reviewMonths = REVIEW_PERIOD_OPTIONS.includes(Number(input.reviewPeriodMonths))
    ? Number(input.reviewPeriodMonths) : 24;

  const at = nowIso();
  let id;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO documents (doc_number, title, title_en, doc_type, gxp_areas, site, department, process_area, ' +
      'owner_id, current_version, status, classification, regulation_refs, review_period_months, retention_years, ' +
      'keywords, summary, created_at, updated_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        docNumber, title, input.titleEn || null, input.docType, JSON.stringify(gxpAreas),
        input.site || null, input.department || null, input.processArea || null,
        input.ownerId || (actor ? actor.id : null), input.version || '1.0', 'draft',
        input.classification || 'internal', JSON.stringify(input.regulationRefs || []),
        reviewMonths, input.retentionYears != null ? Number(input.retentionYears) : null,
        JSON.stringify(input.keywords || []), input.summary || null, at, at, actor ? actor.id : null,
      ]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
    db.run(
      'INSERT INTO document_versions (document_id, version, status, change_summary, change_reason, content, ' +
      'review_due_date, trained_required, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, input.version || '1.0', 'draft', input.changeSummary || 'Initial issue',
        input.changeReason || 'New document', input.content || null, null,
        input.trainingRequired === false ? 0 : 1, at, actor ? actor.id : null]
    );
  });

  audit.append({
    action: 'create', entityType: 'documents', entityId: id, recordKey: `doc:${docNumber}`, recordVersion: 1,
    actor, reason: input.changeReason || 'New controlled document created', ctx, gxpAreas,
    newValue: { doc_number: docNumber, title, doc_type: input.docType, version: input.version || '1.0', status: 'draft' },
  });
  return getDocument(id);
}

/** Record a new controlled version of an existing document. */
function createVersion(documentId, input, actor, ctx) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  const version = String(input.version || '').trim();
  if (!/^\d+(\.\d+)*$/.test(version)) throw httpError(400, 'INVALID_VERSION', 'Version must look like 1.0, 2.0 or 1.1');
  if (db.get('SELECT id FROM document_versions WHERE document_id = ? AND version = ?', [doc.id, version])) {
    throw httpError(409, 'VERSION_EXISTS', `Version ${version} already exists for ${doc.doc_number}`);
  }
  if (!input.changeReason || String(input.changeReason).trim().length < 5) {
    throw httpError(400, 'CHANGE_REASON_REQUIRED', 'A change reason is required for a new version (EU GMP Chapter 4)');
  }
  const at = nowIso();
  let versionId;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO document_versions (document_id, version, status, change_summary, change_reason, content, ' +
      'content_hash, review_due_date, trained_required, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [doc.id, version, 'draft', input.changeSummary || null, String(input.changeReason).trim(),
        input.content || null, input.content ? require('../core/crypto').sha256(String(input.content)) : null,
        null, input.trainingRequired === false ? 0 : 1, at, actor ? actor.id : null]
    );
    versionId = db.get('SELECT last_insert_rowid() AS id').id;
    db.run('UPDATE documents SET current_version = ?, status = ?, updated_at = ? WHERE id = ?',
      [version, 'draft', at, doc.id]);
  });
  audit.append({
    action: 'new_version', entityType: 'document_versions', entityId: versionId,
    recordKey: `doc:${doc.doc_number}`, recordVersion: Number(version.split('.')[0]) || null,
    actor, reason: String(input.changeReason).trim(), ctx, gxpAreas: parseJson(doc.gxp_areas, []),
    oldValue: { version: doc.current_version, status: doc.status },
    newValue: { version, status: 'draft', change_summary: input.changeSummary || null },
  });
  return getDocument(doc.id);
}

/**
 * Move a version through the controlled lifecycle.
 * Approval/effective transitions require a signature reference.
 */
function transitionVersion(documentId, version, targetStatus, args, actor, ctx) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  const ver = db.get('SELECT * FROM document_versions WHERE document_id = ? AND version = ?', [doc.id, String(version)]);
  if (!ver) throw httpError(404, 'VERSION_NOT_FOUND');
  if (!STATUSES.includes(targetStatus)) throw httpError(400, 'INVALID_STATUS');

  const allowed = {
    draft: ['in_review'],
    in_review: ['approved', 'draft'],
    approved: ['effective', 'draft'],
    effective: ['superseded', 'obsolete'],
    superseded: [],
    obsolete: [],
    retired: [],
  };
  if (!(allowed[ver.status] || []).includes(targetStatus)) {
    throw httpError(409, 'INVALID_TRANSITION', `Cannot move ${doc.doc_number} v${version} from "${ver.status}" to "${targetStatus}"`);
  }

  // Approving or making effective a controlled document is a GxP signature event.
  const signatureRequired = ['approved', 'effective'].includes(targetStatus);
  if (signatureRequired && !args.signatureId) {
    throw httpError(428, 'SIGNATURE_REQUIRED',
      `Moving to "${targetStatus}" requires an electronic signature (${targetStatus === 'approved' ? 'approved' : 'released'})`);
  }
  if (signatureRequired) {
    const sig = db.get('SELECT * FROM signatures WHERE id = ?', [Number(args.signatureId)]);
    if (!sig || !sig.valid) throw httpError(400, 'SIGNATURE_INVALID');
    if (sig.user_id !== actor.id) throw httpError(403, 'SIGNATURE_NOT_YOURS');
    if (sig.entity_type === 'documents' && sig.entity_id && sig.entity_id !== String(doc.id)) {
      throw httpError(409, 'SIGNATURE_RECORD_MISMATCH');
    }
  }

  const at = nowIso();
  const before = { version_status: ver.status, document_status: doc.status, current_version: doc.current_version };
  const patch = { status: targetStatus };

  db.transaction(() => {
    if (targetStatus === 'effective') {
      // Retire the previously effective version: superseded documents must be
      // retained but must no longer be in use (EU GMP Chapter 4.16).
      const others = db.all(
        "SELECT id, version FROM document_versions WHERE document_id = ? AND version != ? AND status = 'effective'",
        [doc.id, ver.version]
      );
      for (const other of others) {
        db.run("UPDATE document_versions SET status = 'superseded', obsolete_date = ? WHERE id = ?", [at, other.id]);
        audit.append({
          action: 'supersede', entityType: 'document_versions', entityId: other.id,
          recordKey: `doc:${doc.doc_number}`, actor,
          reason: `Superseded by version ${ver.version}`, ctx,
          oldValue: { version: other.version, status: 'effective' },
          newValue: { version: other.version, status: 'superseded' },
        });
      }
      const reviewDue = new Date(Date.now() + (doc.review_period_months || 24) * 30.44 * 86400000)
        .toISOString().slice(0, 10);
      db.run('UPDATE document_versions SET status = ?, effective_date = ?, review_due_date = ? WHERE id = ?',
        ['effective', args.effectiveDate || today(), reviewDue, ver.id]);
      db.run('UPDATE documents SET status = ?, current_version = ?, effective_date = ?, next_review_date = ?, updated_at = ? WHERE id = ?',
        ['effective', ver.version, args.effectiveDate || today(), reviewDue, at, doc.id]);
      if (ver.trained_required) assignTrainingForDocument(doc.id, ver.id, actor, ctx);
    } else {
      db.run('UPDATE document_versions SET status = ? WHERE id = ?', [targetStatus, ver.id]);
      db.run('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', [targetStatus, at, doc.id]);
    }
  });

  audit.append({
    action: targetStatus === 'effective' ? 'release' : `status_${targetStatus}`,
    entityType: 'documents', entityId: doc.id, recordKey: `doc:${doc.doc_number}`,
    actor, reason: args.reason || `Document version ${ver.version} set to ${targetStatus}`,
    ctx, signatureId: args.signatureId || null,
    oldValue: before,
    newValue: { ...patch, version: ver.version, effective_date: targetStatus === 'effective' ? (args.effectiveDate || today()) : ver.effective_date },
    gxpAreas: parseJson(doc.gxp_areas, []),
    severity: signatureRequired ? 'critical' : 'info',
  });

  return getDocument(doc.id);
}

/**
 * Auto-raise training assignments when a controlled document becomes effective.
 * Only curricula that point at this document (or whose role list matches the
 * document's department) are assigned.
 */
function assignTrainingForDocument(documentId, versionId, actor, ctx) {
  const curricula = db.all('SELECT * FROM training_curricula WHERE document_id = ? AND active = 1', [documentId]);
  if (!curricula.length) return 0;
  const at = nowIso();
  let created = 0;
  for (const cur of curricula) {
    const roles = parseJson(cur.applies_to_roles, []);
    const depts = parseJson(cur.applies_to_departments, []);
    let users = [];
    if (roles.length || depts.length) {
      const where = [];
      const params = [];
      if (roles.length) { where.push(`role IN (${roles.map(() => '?').join(',')})`); params.push(...roles); }
      if (depts.length) { where.push(`department IN (${depts.map(() => '?').join(',')})`); params.push(...depts); }
      users = db.all(`SELECT id FROM users WHERE status = 'active' AND (${where.join(' OR ')})`, params);
    }
    for (const u of users) {
      if (db.get('SELECT id FROM training_records WHERE curriculum_id = ? AND user_id = ? AND status IN (?,?)',
        [cur.id, u.id, 'assigned', 'in_progress'])) continue;
      db.run(
        'INSERT INTO training_records (curriculum_id, user_id, status, assigned_at, due_date, updated_at) VALUES (?,?,?,?,?,?)',
        [cur.id, u.id, 'assigned', at, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), at]
      );
      created += 1;
    }
  }
  if (created) {
    audit.append({
      action: 'training_assigned', entityType: 'documents', entityId: documentId,
      actor, reason: `${created} training assignment(s) raised automatically on document release`,
      ctx, meta: { curricula: curricula.map((c) => c.code), assignments: created }, severity: 'info',
    });
  }
  return created;
}

// ------------------------------------------------------------------- read ---

function getDocument(idOrNumber) {
  const row = /^\d+$/.test(String(idOrNumber))
    ? db.get('SELECT * FROM documents WHERE id = ?', [Number(idOrNumber)])
    : db.get('SELECT * FROM documents WHERE doc_number = ?', [String(idOrNumber)]);
  if (!row) return null;

  const versions = db.all('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at DESC', [row.id]);
  const owner = row.owner_id ? db.get('SELECT id, username, full_name, role FROM users WHERE id = ?', [row.owner_id]) : null;
  const signatures = db.all(
    'SELECT * FROM signatures WHERE entity_type = ? AND entity_id = ? ORDER BY signed_at ASC',
    ['documents', String(row.id)]
  );
  const reads = db.all(
    `SELECT dr.read_at, dr.acknowledged, u.full_name, u.username, u.department
     FROM documents_read dr JOIN users u ON u.id = dr.user_id WHERE dr.document_id = ? ORDER BY dr.read_at DESC LIMIT 200`,
    [row.id]
  );

  return {
    id: row.id,
    docNumber: row.doc_number,
    title: row.title,
    titleEn: row.title_en,
    docType: row.doc_type,
    docTypeLabel: (DOC_TYPES[row.doc_type] || {}).label || row.doc_type,
    docTypeLabelZh: (DOC_TYPES[row.doc_type] || {}).labelZh || row.doc_type,
    gxpAreas: parseJson(row.gxp_areas, []),
    site: row.site,
    department: row.department,
    processArea: row.process_area,
    owner,
    currentVersion: row.current_version,
    status: row.status,
    classification: row.classification,
    regulationRefs: parseJson(row.regulation_refs, []),
    reviewPeriodMonths: row.review_period_months,
    nextReviewDate: row.next_review_date,
    effectiveDate: row.effective_date,
    retentionYears: row.retention_years,
    keywords: parseJson(row.keywords, []),
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    reviewStatus: reviewStatus(row.next_review_date),
    daysToReview: row.next_review_date ? Math.ceil((Date.parse(row.next_review_date) - Date.now()) / 86400000) : null,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, status: v.status, changeSummary: v.change_summary,
      changeReason: v.change_reason, effectiveDate: v.effective_date, obsoleteDate: v.obsolete_date,
      reviewDueDate: v.review_due_date, trainingRequired: Boolean(v.trained_required),
      contentHash: v.content_hash, createdAt: v.created_at, createdBy: v.created_by,
    })),
    signatures: signatures.map((s) => ({
      id: s.id, printedName: s.printed_name, username: s.username, meaning: s.meaning,
      meaningCode: s.meaning_code, reason: s.reason, signedAt: s.signed_at, valid: Boolean(s.valid),
      manifest: `${s.meaning} / ${s.printed_name} / ${s.signed_at}`,
    })),
    readAcknowledgements: reads.map((r) => ({
      fullName: r.full_name, username: r.username, department: r.department,
      readAt: r.read_at, acknowledged: Boolean(r.acknowledged),
    })),
  };
}

function reviewStatus(nextReviewDate) {
  if (!nextReviewDate) return 'not_scheduled';
  const days = Math.ceil((Date.parse(nextReviewDate) - Date.now()) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= config.reminder.documentReviewWarningDays) return 'due_soon';
  return 'current';
}

function listDocuments(filters = {}) {
  const where = [];
  const params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.docType) { where.push('doc_type = ?'); params.push(filters.docType); }
  if (filters.department) { where.push('department = ?'); params.push(filters.department); }
  if (filters.site) { where.push('site = ?'); params.push(filters.site); }
  if (filters.ownerId) { where.push('owner_id = ?'); params.push(Number(filters.ownerId)); }
  if (filters.gxpArea) { where.push('gxp_areas LIKE ?'); params.push(`%"${filters.gxpArea}"%`); }
  if (filters.reviewOverdue) { where.push("next_review_date IS NOT NULL AND next_review_date < date('now') AND status = 'effective'"); }
  if (filters.search) {
    where.push('(doc_number LIKE ? OR title LIKE ? OR title_en LIKE ? OR summary LIKE ? OR keywords LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit) || 100, 500);
  const offset = Number(filters.offset) || 0;
  const total = db.get(`SELECT COUNT(*) AS n FROM documents ${clause}`, params).n;
  const rows = db.all(
    `SELECT * FROM documents ${clause} ORDER BY doc_number ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    total, limit, offset,
    rows: rows.map((r) => ({
      id: r.id, docNumber: r.doc_number, title: r.title, titleEn: r.title_en,
      docType: r.doc_type, docTypeLabel: (DOC_TYPES[r.doc_type] || {}).label || r.doc_type,
      docTypeLabelZh: (DOC_TYPES[r.doc_type] || {}).labelZh || r.doc_type,
      gxpAreas: parseJson(r.gxp_areas, []), department: r.department, site: r.site,
      currentVersion: r.current_version, status: r.status, effectiveDate: r.effective_date,
      nextReviewDate: r.next_review_date, reviewStatus: reviewStatus(r.next_review_date),
      ownerId: r.owner_id, updatedAt: r.updated_at,
    })),
  };
}

/** Documents due (or overdue) for periodic review. */
function reviewDueReport(daysAhead) {
  const days = daysAhead != null ? Number(daysAhead) : config.reminder.documentReviewWarningDays;
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const overdue = db.all(
    "SELECT id, doc_number, title, doc_type, department, next_review_date, owner_id FROM documents " +
    "WHERE status = 'effective' AND next_review_date IS NOT NULL AND next_review_date < date('now') " +
    'ORDER BY next_review_date ASC'
  );
  const dueSoon = db.all(
    "SELECT id, doc_number, title, doc_type, department, next_review_date, owner_id FROM documents " +
    "WHERE status = 'effective' AND next_review_date IS NOT NULL AND next_review_date >= date('now') AND next_review_date <= ? " +
    'ORDER BY next_review_date ASC',
    [horizon]
  );
  const byType = db.all(
    "SELECT doc_type, COUNT(*) AS n FROM documents WHERE status = 'effective' GROUP BY doc_type ORDER BY n DESC"
  );
  const withoutOwner = db.get("SELECT COUNT(*) AS n FROM documents WHERE owner_id IS NULL AND status != 'retired'").n;
  const staleDrafts = db.get(
    "SELECT COUNT(*) AS n FROM documents WHERE status IN ('draft','in_review') AND julianday('now') - julianday(updated_at) > 90"
  ).n;
  return {
    daysAhead: days,
    overdue: overdue.map(mapBrief), dueSoon: dueSoon.map(mapBrief),
    byType, withoutOwner, staleDrafts,
    counts: { overdue: overdue.length, dueSoon: dueSoon.length, withoutOwner, staleDrafts },
  };
}

function mapBrief(r) {
  return {
    id: r.id, docNumber: r.doc_number, title: r.title, docType: r.doc_type,
    department: r.department, nextReviewDate: r.next_review_date, ownerId: r.owner_id,
    daysToReview: Math.ceil((Date.parse(r.next_review_date) - Date.now()) / 86400000),
  };
}

/** Record that a user has read and understood a controlled document. */
function recordRead(documentId, userId, { acknowledged = true, signatureId = null } = {}, actor, ctx) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(documentId)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  if (doc.status !== 'effective') throw httpError(409, 'DOCUMENT_NOT_EFFECTIVE', 'Only effective documents can be acknowledged');
  const ver = db.get('SELECT * FROM document_versions WHERE document_id = ? AND status = ?', [doc.id, 'effective']);
  const at = nowIso();
  db.run(
    'INSERT INTO documents_read (document_id, version_id, user_id, read_at, acknowledged, signature_id) ' +
    'VALUES (?,?,?,?,?,?) ON CONFLICT(document_id, version_id, user_id) DO UPDATE SET ' +
    'read_at = excluded.read_at, acknowledged = excluded.acknowledged, signature_id = excluded.signature_id',
    [doc.id, ver ? ver.id : null, Number(userId), at, acknowledged ? 1 : 0, signatureId]
  );
  audit.append({
    action: acknowledged ? 'acknowledge' : 'read',
    entityType: 'documents', entityId: doc.id, recordKey: `doc:${doc.doc_number}`,
    actor, reason: `Document v${doc.current_version} ${acknowledged ? 'acknowledged' : 'read'}`,
    ctx, signatureId, meta: { userId, version: doc.current_version },
  });
  return { ok: true, readAt: at };
}

/** Documents a given user still needs to acknowledge. */
function pendingAcknowledgements(userId) {
  return db.all(
    `SELECT d.id, d.doc_number, d.title, d.doc_type, d.current_version, d.effective_date
     FROM documents d
     WHERE d.status = 'effective'
       AND NOT EXISTS (
         SELECT 1 FROM documents_read r
         WHERE r.document_id = d.id AND r.user_id = ? AND r.acknowledged = 1
           AND r.version_id = (SELECT id FROM document_versions v WHERE v.document_id = d.id AND v.status = 'effective')
       )
     ORDER BY d.effective_date DESC LIMIT 100`,
    [Number(userId)]
  ).map((r) => ({
    id: r.id, docNumber: r.doc_number, title: r.title, docType: r.doc_type,
    version: r.current_version, effectiveDate: r.effective_date,
  }));
}

function updateDocument(id, patch, actor, ctx, reason) {
  const doc = db.get('SELECT * FROM documents WHERE id = ?', [Number(id)]);
  if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
  if (!reason || String(reason).trim().length < 3) throw httpError(400, 'REASON_REQUIRED');

  const ALLOWED = ['title', 'title_en', 'department', 'site', 'process_area', 'owner_id',
    'review_period_months', 'retention_years', 'classification', 'gxp_areas', 'regulation_refs', 'keywords', 'summary'];
  const dbPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    const col = toSnake(key);
    if (ALLOWED.includes(col)) dbPatch[col] = Array.isArray(value) ? JSON.stringify(value) : value;
  }
  if (!Object.keys(dbPatch).length) throw httpError(400, 'NOTHING_TO_UPDATE');

  const before = {};
  const after = {};
  for (const col of Object.keys(dbPatch)) { before[col] = doc[col]; after[col] = dbPatch[col]; }
  dbPatch.updated_at = nowIso();

  applyPatch('documents', doc.id, dbPatch);
  audit.recordChange({
    actor, entityType: 'documents', entityId: doc.id, recordKey: `doc:${doc.doc_number}`,
    before, after, reason, ctx, action: 'update', gxpAreas: parseJson(doc.gxp_areas, []),
  });
  return getDocument(doc.id);
}

function metrics() {
  const byStatus = db.all('SELECT status, COUNT(*) AS n FROM documents GROUP BY status');
  const byType = db.all("SELECT doc_type, COUNT(*) AS n FROM documents WHERE status = 'effective' GROUP BY doc_type ORDER BY n DESC");
  const report = reviewDueReport();
  const total = db.get('SELECT COUNT(*) AS n FROM documents').n;
  const effective = db.get("SELECT COUNT(*) AS n FROM documents WHERE status = 'effective'").n;
  const inReview = db.get("SELECT COUNT(*) AS n FROM documents WHERE status = 'in_review'").n;
  const noOwner = db.get("SELECT COUNT(*) AS n FROM documents WHERE owner_id IS NULL").n;
  return {
    total, effective, inReview, noOwner,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    byType,
    reviewOverdue: report.counts.overdue,
    reviewDueSoon: report.counts.dueSoon,
    staleDrafts: report.counts.staleDrafts,
  };
}

// ----------------------------------------------------------------- utils ----

function applyPatch(table, id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => patch[c]), id]);
}

function toSnake(s) {
  return String(s).replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  createDocument,
  createVersion,
  transitionVersion,
  getDocument,
  listDocuments,
  updateDocument,
  recordRead,
  pendingAcknowledgements,
  reviewDueReport,
  metrics,
  assignTrainingForDocument,
  DOC_TYPES,
  REVIEW_PERIOD_OPTIONS,
  STATUSES,
  httpError,
};
