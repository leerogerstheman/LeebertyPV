'use strict';

/**
 * Inspection readiness and self-inspection engine.
 *
 * Why this module exists
 * ----------------------
 * The most expensive day in a GxP site is the day an inspector arrives and the
 * site discovers its own gaps in front of them. This module turns the
 * regulatory text into a reusable checklist library, lets QA run a
 * self-inspection, and converts every gap into a tracked finding that can be
 * escalated into a CAPA with one click.
 *
 * Scope note: the file header and some inline comments still cite EU GMP
 * Chapter 9 and PIC/S, inherited from the GxP product this came from. The
 * engine itself is jurisdiction-neutral - it evaluates whatever checklist
 * definitions it is given - and the shipped PV checklist library in
 * `seed/checklists/` is what makes it a pharmacovigilance tool:
 * `gvp-cn-2021.json`, `ich-e2b.json`, `ich-e2c.json`, `ich-e2d.json`,
 * `part11.json` and `alcoa-di.json`. A PV self-inspection is run against those,
 * not against a GMP checklist. Where this comment and a checklist disagree, the
 * checklist is authoritative.
 *
 * Original regulatory basis (applies to the GxP product this came from)
 * ---------------------------------------------------------------------
 *  - EU GMP Chapter 9  self inspection: "the purpose of self inspection is to
 *    monitor compliance with GMP and to propose necessary corrective measures";
 *    self inspections should be performed at regular intervals, and the
 *    programme should cover all aspects of GMP.
 *  - EU GMP Chapter 8.5  complaint, recall and return procedures.
 *  - PIC/S PI 002  inspection report / findings classification (critical, major,
 *    other).
 *  - 21 CFR Part 58.35 (GLP)  QA unit responsibilities, including auditing
 *    studies and facilities.
 *  - ICH E6(R2) §5.19  audit programme for clinical trials.
 *
 * Scoring model
 * -------------
 * `readiness_score` is the percentage of applicable requirements that are
 * demonstrated compliant, weighted by risk level so that a critical gap hurts
 * far more than an "other" observation. The score is explicitly NOT a
 * substitute for judgement - it exists to rank where to spend effort.
 */

const db = require('../core/db');
const audit = require('../core/audit');

function nowIso() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

/**
 * Target completion date for an escalated finding: the process SLA for the risk
 * level, with critical findings pulled forward to 30 days. Exists because the
 * CAPA definition marks the due date as mandatory and an escalation performed
 * from the inspection screen has no opportunity to ask for one.
 */
function defaultEscalationDueDate(workflow, processCode, riskLevel) {
  let days = 90;
  try {
    const def = workflow.getDefinition(processCode);
    if (def && def.slaDays) days = Number(def.slaDays);
  } catch { /* fall back to the default window */ }
  if (riskLevel === 'critical') days = Math.min(days, 30);
  else if (riskLevel === 'minor') days = Math.max(days, 90);
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Risk weighting used by the readiness score. */
const RISK_WEIGHTS = { critical: 10, major: 4, minor: 1 };
const RISK_LEVELS = ['critical', 'major', 'minor'];

/** How an individual requirement is graded during a self-inspection. */
const GRADES = {
  compliant: { label: 'Compliant', labelZh: '符合', weight: 1 },
  partial: { label: 'Partially compliant', labelZh: '部分符合', weight: 0.5 },
  gap: { label: 'Gap identified', labelZh: '存在缺陷', weight: 0 },
  not_applicable: { label: 'Not applicable', labelZh: '不适用', weight: null },
  not_assessed: { label: 'Not yet assessed', labelZh: '未评估', weight: null },
};

/** Finding classification aligned with PIC/S / agency inspection practice. */
const FINDING_TYPES = {
  critical: { label: 'Critical', labelZh: '严重缺陷', description: 'Produces a product/subject-safety or data-integrity risk; direct impact.' },
  major: { label: 'Major', labelZh: '主要缺陷', description: 'Non-compliance that could affect product quality or data reliability.' },
  minor: { label: 'Other / Minor', labelZh: '次要缺陷', description: 'Departure from good practice without immediate quality impact.' },
  observation: { label: 'Observation / OFI', labelZh: '观察项 / 改进机会', description: 'Opportunity for improvement, no non-compliance.' },
};

// ------------------------------------------------------- template loading ---

/**
 * Register a checklist template together with its items.
 * @param {object} template  { code, title, scope, gxpAreas, regulation, authority, items: [...] }
 */
function registerTemplate(template, sourceFile) {
  if (!template.code) throw new Error('checklist template requires a code');
  if (!Array.isArray(template.items) || !template.items.length) {
    throw new Error(`checklist ${template.code} has no items`);
  }
  const seen = new Set();
  template.items.forEach((item, idx) => {
    if (!item.requirement) throw new Error(`${template.code}: item ${idx + 1} has no requirement text`);
    if (item.riskLevel && !RISK_LEVELS.includes(item.riskLevel)) {
      throw new Error(`${template.code}: item ${idx + 1} has unknown riskLevel "${item.riskLevel}"`);
    }
  });

  let templateId = null;
  let itemsChanged = 0;
  db.transaction(() => {
    const existing = db.get('SELECT id FROM checklist_templates WHERE code = ?', [template.code]);
    if (existing) {
      templateId = existing.id;
      db.run(
        'UPDATE checklist_templates SET title = ?, title_en = ?, scope = ?, gxp_areas = ?, category = ?, ' +
        'regulation = ?, authority = ?, version = ?, description = ?, description_en = ?, source_file = ?, ' +
        'active = 1, loaded_at = ? WHERE id = ?',
        [template.title, template.titleEn || null, template.scope || 'self_inspection',
          JSON.stringify(template.gxpAreas || []), template.category || null,
          template.regulation || null, template.authority || null, template.version || null,
          template.description || null, template.descriptionEn || null, sourceFile || null, nowIso(), templateId]
      );
      // Items are reconciled in place below; deleting them here would break the
      // inspection_findings.item_id reference.
    } else {
      const res = db.run(
        'INSERT INTO checklist_templates (code, title, title_en, scope, gxp_areas, category, regulation, authority, ' +
        'version, description, description_en, source_file, active, loaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)',
        [template.code, template.title, template.titleEn || null, template.scope || 'self_inspection',
          JSON.stringify(template.gxpAreas || []), template.category || null, template.regulation || null,
          template.authority || null, template.version || null, template.description || null,
          template.descriptionEn || null, sourceFile || null, nowIso()]
      );
      templateId = db.get('SELECT last_insert_rowid() AS id').id;
    }

    let seq = 0;
    // Existing items are UPDATED in place rather than deleted and re-inserted.
    //
    // This matters more than it looks. `inspection_findings.item_id` references
    // `checklist_items`, so deleting the rows would either fail the foreign key or
    // - if it were forced - sever the link between a historical finding and the
    // clause it was raised against. Since the configuration library is reloaded
    // on every server start, a delete-and-recreate would quietly destroy that
    // traceability each time the service restarted.
    const existingItems = db.all(
      'SELECT id, seq FROM checklist_items WHERE template_id = ? ORDER BY seq', [templateId]
    );

    for (const item of template.items) {
      seq += 1;
      const prior = existingItems[seq - 1];
      const values = [item.clauseRef || null, item.requirement, item.requirementEn || null,
        item.guidance || null, item.guidanceEn || null, item.riskLevel || 'major',
        JSON.stringify(item.gxpAreas || template.gxpAreas || []), item.evidenceHint || null,
        item.riskLevel === 'critical' || item.isCritical ? 1 : 0];

      if (prior) {
        db.run(
          'UPDATE checklist_items SET seq = ?, clause_ref = ?, requirement = ?, requirement_en = ?, guidance = ?, ' +
          'guidance_en = ?, risk_level = ?, gxp_areas = ?, evidence_hint = ?, is_critical = ? WHERE id = ?',
          [seq, ...values, prior.id]
        );
      } else {
        db.run(
          'INSERT INTO checklist_items (template_id, seq, clause_ref, requirement, requirement_en, guidance, ' +
          'guidance_en, risk_level, gxp_areas, evidence_hint, is_critical) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [templateId, seq, ...values]
        );
      }
      itemsChanged += 1;
    }

    // A shortened checklist leaves surplus rows. Remove them only when nothing
    // references them; otherwise deactivate by emptying the requirement text so
    // the historical link survives.
    const surplus = existingItems.slice(seq);
    for (const row of surplus) {
      const referenced = db.get('SELECT COUNT(*) AS n FROM inspection_findings WHERE item_id = ?', [row.id]).n;
      if (referenced) {
        db.run("UPDATE checklist_items SET requirement = ?, clause_ref = ?, is_critical = 0 WHERE id = ?",
          [`[已从检查表移除] ${db.get('SELECT requirement FROM checklist_items WHERE id = ?', [row.id]).requirement}`,
            null, row.id]);
      } else {
        db.run('DELETE FROM checklist_items WHERE id = ?', [row.id]);
      }
    }
  });
  return { code: template.code, templateId, items: itemsChanged };
}

function listTemplates(filters = {}) {
  let rows = db.all('SELECT * FROM checklist_templates WHERE active = 1 ORDER BY scope, code');
  if (filters.gxpArea) rows = rows.filter((r) => parseJson(r.gxp_areas, []).includes(filters.gxpArea));
  if (filters.scope) rows = rows.filter((r) => r.scope === filters.scope);
  if (filters.category) rows = rows.filter((r) => r.category === filters.category);
  return rows.map((r) => {
    const items = db.all('SELECT risk_level, COUNT(*) AS n FROM checklist_items WHERE template_id = ? GROUP BY risk_level', [r.id]);
    const riskCounts = { critical: 0, major: 0, minor: 0 };
    for (const i of items) riskCounts[i.risk_level] = i.n;
    return {
      id: r.id, code: r.code, title: r.title, titleEn: r.title_en, scope: r.scope,
      gxpAreas: parseJson(r.gxp_areas, []), category: r.category, regulation: r.regulation,
      authority: r.authority, version: r.version, description: r.description,
      descriptionEn: r.description_en, itemCount: items.reduce((a, b) => a + b.n, 0), riskCounts,
    };
  });
}

function getTemplate(idOrCode) {
  const row = /^\d+$/.test(String(idOrCode))
    ? db.get('SELECT * FROM checklist_templates WHERE id = ?', [Number(idOrCode)])
    : db.get('SELECT * FROM checklist_templates WHERE code = ?', [String(idOrCode)]);
  if (!row) return null;
  const items = db.all('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY seq', [row.id]);
  return {
    id: row.id, code: row.code, title: row.title, titleEn: row.title_en, scope: row.scope,
    gxpAreas: parseJson(row.gxp_areas, []), category: row.category, regulation: row.regulation,
    authority: row.authority, version: row.version, description: row.description,
    descriptionEn: row.description_en, sourceFile: row.source_file,
    items: items.map(mapItem),
  };
}

function mapItem(i) {
  return {
    id: i.id, seq: i.seq, clauseRef: i.clause_ref, requirement: i.requirement,
    requirementEn: i.requirement_en, guidance: i.guidance, guidanceEn: i.guidance_en,
    riskLevel: i.risk_level, gxpAreas: parseJson(i.gxp_areas, []),
    evidenceHint: i.evidence_hint, isCritical: Boolean(i.is_critical),
  };
}

// ---------------------------------------------------------- self inspection --

/**
 * Start a self-inspection from a template: creates the inspection header, then
 * seeds one finding row per requirement in the `not_assessed` state so the
 * assessor works down a list rather than remembering what to check.
 */
/**
 * Refuse to let an internal auditor inspect an area they work in.
 *
 * An audit of your own area is not an audit - it is a self-assessment wearing an
 * audit's clothes, and the value of the internal audit function is precisely that
 * it looks at the work with an outside eye. EU GMP Chapter 9 assumes that
 * independence, and an inspector who discovers a self-audit will treat every
 * finding it produced as unreliable.
 *
 * The rule is narrow on purpose. It applies to the internal auditor role only,
 * it applies only when the auditor's own areas intersect the inspection's scope,
 * and it names the remedy rather than simply denying the action. A QA manager
 * running an inspection in their own area is a different matter: that is
 * management review, and it is expected.
 *
 * @param {object} actor  the acting user row
 * @param {string[]} gxpAreas  the areas the inspection will cover
 * @param {object} ctx
 */
function assertAuditorIndependence(actor, gxpAreas, ctx) {
  if (!actor || actor.role !== 'qa_auditor') return;
  const areas = Array.isArray(gxpAreas) ? gxpAreas.filter(Boolean) : [];
  if (!areas.length) return;

  // Which areas does this auditor work in? Derived from the configuration, with
  // the account's own declaration as a fallback so the rule cannot be skipped
  // when the configuration has not been loaded.
  let home = [];
  try {
    home = Object.keys((require('./accounts').homeAreasByRole()[actor.role]) || {});
  } catch { home = []; }
  if (!home.length) {
    try { home = JSON.parse(actor.gxp_areas || '[]'); } catch { home = []; }
  }

  const overlap = areas.filter((a) => home.includes(a));
  if (!overlap.length) return;

  // Record the refusal. An attempted self-audit is itself a finding about the
  // quality system, so it belongs in the audit trail even though nothing changed.
  try {
    require('../core/audit').append({
      action: 'inspection_self_audit_refused',
      entityType: 'inspections',
      entityId: null,
      recordKey: `user:${actor.id}`,
      actor,
      reason: 'Refused: internal auditor attempted to lead an inspection covering '
        + `${overlap.join(', ')}, an area they carry operational responsibility in.`,
      ctx: ctx || {},
      severity: 'warning',
      meta: { role: actor.role, homeAreas: home, requestedAreas: areas, overlap },
    });
  } catch { /* the refusal stands even if the note cannot be written */ }

  const err = httpError(403, 'SELF_AUDIT_NOT_INDEPENDENT',
    `内审员不得审计自己承担职责的领域（${overlap.join('、')}）。`
    + '自己审自己等于没有审计——请由其他内审员主导，或改由质量保证负责人以管理评审的形式进行。 '
    + `An internal auditor may not lead an inspection covering their own area (${overlap.join(', ')}). `
    + 'Have another auditor lead it, or have the QA manager conduct it as a management review.');
  err.overlap = overlap;
  throw err;
}

function createInspection(input, actor, ctx) {
  const template = input.templateId || input.templateCode ? getTemplate(input.templateId || input.templateCode) : null;
  if (!template && !input.title) throw httpError(400, 'TEMPLATE_OR_TITLE_REQUIRED');

  // Who an inspection covers decides who may lead it. An internal auditor working
  // in the area being inspected is refused here rather than in the interface,
  // because the interface can be bypassed and the independence requirement cannot.
  const coveredAreas = (input.gxpAreas && input.gxpAreas.length)
    ? input.gxpAreas
    : (template ? template.gxpAreas : []);
  assertAuditorIndependence(actor, coveredAreas, ctx);

  const code = input.code || nextInspectionCode(input.inspectionType);
  if (db.get('SELECT id FROM inspections WHERE code = ?', [code])) {
    throw httpError(409, 'INSPECTION_CODE_EXISTS', `Inspection ${code} already exists`);
  }
  const at = nowIso();
  let id;
  db.transaction(() => {
    const res = db.run(
      'INSERT INTO inspections (code, title, inspection_type, authority, gxp_areas, template_id, site, scope, ' +
      'lead_auditor, announced_at, scheduled_date, status, created_at, updated_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [code, input.title || (template ? template.title : 'Self inspection'),
        input.inspectionType || 'self_inspection', input.authority || null,
        JSON.stringify(input.gxpAreas && input.gxpAreas.length ? input.gxpAreas : (template ? template.gxpAreas : [])),
        template ? template.id : null, input.site || null, input.scope || null,
        input.leadAuditor || (actor ? actor.full_name : null), at,
        input.scheduledDate || today(), 'planned', at, at, actor ? actor.id : null]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;

    if (template) {
      for (const item of template.items) {
        db.run(
          'INSERT INTO inspection_findings (inspection_id, item_id, template_id, finding_type, clause_ref, ' +
          'requirement, risk_level, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [id, item.id, template.id, 'observation', item.clauseRef, item.requirement,
            item.riskLevel, 'not_assessed', at, at]
        );
      }
    }
  });

  audit.append({
    action: 'create', entityType: 'inspections', entityId: id, actor,
    reason: input.scope || `Self inspection started from ${template ? template.code : 'blank template'}`,
    ctx, gxpAreas: parseJson(db.get('SELECT gxp_areas FROM inspections WHERE id = ?', [id]).gxp_areas, []),
    newValue: { code, title: input.title || (template ? template.title : null), template: template ? template.code : null },
  });
  return getInspection(id);
}

function nextInspectionCode(type) {
  const prefix = type === 'regulatory' ? 'REG' : (type === 'supplier' ? 'SUP' : (type === 'study_audit' ? 'AUD' : 'SI'));
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const rows = db.all('SELECT code FROM inspections WHERE code LIKE ?', [like]);
  const max = rows.reduce((acc, r) => {
    const n = Number.parseInt(r.code.split('-').pop(), 10);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return `${prefix}-${year}-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Grade one checklist requirement.
 * @param {number} findingId
 * @param {object} input  { grade, observation, objectiveEvidence, riskLevel, findingType, ownerId, dueDate }
 */
function assessItem(findingId, input, actor, ctx) {
  const finding = db.get('SELECT * FROM inspection_findings WHERE id = ?', [Number(findingId)]);
  if (!finding) throw httpError(404, 'FINDING_NOT_FOUND');
  const inspection = db.get('SELECT * FROM inspections WHERE id = ?', [finding.inspection_id]);
  if (inspection.status === 'closed') throw httpError(409, 'INSPECTION_CLOSED', 'Reopen the inspection before changing assessments');

  const grade = String(input.grade || 'compliant');
  if (!GRADES[grade]) throw httpError(400, 'INVALID_GRADE', `Known grades: ${Object.keys(GRADES).join(', ')}`);

  // An adverse grade must carry objective evidence: an observation without
  // evidence is not auditable (PIC/S PI 002 / GLP 58.35).
  if (['partial', 'gap'].includes(grade)
      && !(input.objectiveEvidence && String(input.objectiveEvidence).trim().length >= 10)) {
    throw httpError(400, 'EVIDENCE_REQUIRED',
      'A "partially compliant" or "gap" assessment requires objective evidence of at least 10 characters');
  }

  let findingType = input.findingType || finding.finding_type;
  let status = 'compliant';
  if (grade === 'compliant') { findingType = 'observation'; status = 'closed'; }
  else if (grade === 'partial') { findingType = findingType === 'observation' ? 'minor' : findingType; status = 'open'; }
  else if (grade === 'gap') { status = 'open'; }
  else if (grade === 'not_applicable') { findingType = 'observation'; status = 'not_applicable'; }
  else if (grade === 'not_assessed') { status = 'not_assessed'; }

  const at = nowIso();
  const before = {
    finding_type: finding.finding_type, status: finding.status,
    observation: finding.observation, risk_level: finding.risk_level,
    assessed_grade: finding.assessed_grade,
  };
  db.run(
    'UPDATE inspection_findings SET finding_type = ?, assessed_grade = ?, observation = ?, objective_evidence = ?, ' +
    'risk_level = ?, status = ?, owner_id = ?, due_date = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?',
    [findingType, grade, input.observation || finding.observation, input.objectiveEvidence || finding.objective_evidence,
      input.riskLevel || finding.risk_level, status, input.ownerId || finding.owner_id,
      input.dueDate || finding.due_date, at, actor ? actor.id : null, at, finding.id]
  );

  audit.recordChange({
    actor, entityType: 'inspection_findings', entityId: finding.id,
    recordKey: `inspection:${inspection.code}`, before,
    after: { grade, finding_type: findingType, status, observation: input.observation, risk_level: input.riskLevel || finding.risk_level },
    reason: input.notes || `Requirement assessed as "${GRADES[grade].label}"`,
    ctx, action: 'assess', gxpAreas: parseJson(inspection.gxp_areas, []),
    severity: ['gap', 'partial'].includes(grade) && (input.riskLevel || finding.risk_level) === 'critical' ? 'critical' : 'info',
  });

  recalculateScore(inspection.id);
  return getFinding(finding.id);
}

function getFinding(id) {
  const f = db.get(
    `SELECT f.*, i.code AS inspection_code, i.title AS inspection_title
     FROM inspection_findings f JOIN inspections i ON i.id = f.inspection_id WHERE f.id = ?`,
    [Number(id)]
  );
  if (!f) return null;
  const owner = f.owner_id ? db.get('SELECT id, username, full_name FROM users WHERE id = ?', [f.owner_id]) : null;
  const wf = f.workflow_id
    ? db.get('SELECT id, record_key, process_code, title, status FROM workflow_instances WHERE id = ?', [f.workflow_id])
    : null;
  return {
    id: f.id, inspectionId: f.inspection_id, inspectionCode: f.inspection_code,
    inspectionTitle: f.inspection_title, itemId: f.item_id, clauseRef: f.clause_ref,
    requirement: f.requirement, findingType: f.finding_type, riskLevel: f.risk_level,
    grade: gradeOf(f), status: f.status, observation: f.observation,
    objectiveEvidence: f.objective_evidence,
    owner, dueDate: f.due_date, workflow: wf, response: f.response,
    assessedAt: f.assessed_at, assessedBy: f.assessed_by, createdAt: f.created_at, updatedAt: f.updated_at,
    overdue: ['open', 'in_progress'].includes(f.status) && f.due_date ? Date.parse(f.due_date) < Date.now() : false,
  };
}

function getInspection(idOrCode) {
  const row = /^\d+$/.test(String(idOrCode))
    ? db.get('SELECT * FROM inspections WHERE id = ?', [Number(idOrCode)])
    : db.get('SELECT * FROM inspections WHERE code = ?', [String(idOrCode)]);
  if (!row) return null;
  const template = row.template_id ? db.get('SELECT code, title FROM checklist_templates WHERE id = ?', [row.template_id]) : null;
  const findings = db.all('SELECT * FROM inspection_findings WHERE inspection_id = ? ORDER BY id', [row.id]);
  const assessed = findings.filter((f) => f.status !== 'not_assessed');
  const gaps = findings.filter((f) => ['gap', 'partial'].includes(gradeOf(f)));

  return {
    id: row.id, code: row.code, title: row.title, inspectionType: row.inspection_type,
    authority: row.authority, gxpAreas: parseJson(row.gxp_areas, []), template,
    site: row.site, scope: row.scope, leadAuditor: row.lead_auditor,
    announcedAt: row.announced_at, scheduledDate: row.scheduled_date, completedAt: row.completed_at,
    status: row.status, readinessScore: row.readiness_score, summary: row.summary,
    createdAt: row.created_at, updatedAt: row.updated_at,
    progress: {
      total: findings.length, assessed: assessed.length,
      compliant: findings.filter((f) => gradeOf(f) === 'compliant').length,
      partial: findings.filter((f) => gradeOf(f) === 'partial').length,
      gap: findings.filter((f) => gradeOf(f) === 'gap').length,
      notApplicable: findings.filter((f) => f.status === 'not_applicable').length,
      openFindings: gaps.filter((f) => f.status !== 'closed').length,
      percentAssessed: findings.length ? Math.round((assessed.length / findings.length) * 100) : 0,
    },
    riskBreakdown: breakdown(gaps),
    findings: findings.map((f) => ({
      id: f.id, itemId: f.item_id, clauseRef: f.clause_ref, requirement: f.requirement,
      grade: gradeOf(f), findingType: f.finding_type, riskLevel: f.risk_level, status: f.status,
      observation: f.observation, objectiveEvidence: f.objective_evidence, ownerId: f.owner_id,
      dueDate: f.due_date, workflowId: f.workflow_id, assessedAt: f.assessed_at,
      assessedBy: f.assessed_by,
    })),
  };
}

/**
 * The assessment grade is stored explicitly rather than inferred from `status`,
 * because a closed finding can legitimately be "partial" (gap accepted with a
 * documented rationale) and that distinction drives the readiness score.
 */
function gradeOf(f) {
  if (f.assessed_grade && GRADES[f.assessed_grade]) return f.assessed_grade;
  if (f.status === 'not_assessed') return 'not_assessed';
  if (f.status === 'not_applicable') return 'not_applicable';
  return 'compliant';
}

function breakdown(findings) {
  const out = { critical: 0, major: 0, minor: 0, observation: 0 };
  for (const f of findings) out[f.finding_type] = (out[f.finding_type] || 0) + 1;
  return out;
}

/**
 * Recompute the readiness score.
 *
 * score = sum(weight(risk) * gradeWeight) / sum(weight(risk)) over all
 * applicable (i.e. not "not_applicable") requirements, as a percentage.
 */
function recalculateScore(inspectionId) {
  const findings = db.all('SELECT * FROM inspection_findings WHERE inspection_id = ?', [Number(inspectionId)]);
  let numerator = 0;
  let denominator = 0;
  for (const f of findings) {
    const grade = gradeOf(f);
    const gradeDef = GRADES[grade] || GRADES.not_assessed;
    if (gradeDef.weight === null) continue; // not applicable / not assessed
    const riskWeight = RISK_WEIGHTS[f.risk_level] || 1;
    numerator += riskWeight * gradeDef.weight;
    denominator += riskWeight;
  }
  const score = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
  db.run('UPDATE inspections SET readiness_score = ?, updated_at = ? WHERE id = ?', [score, nowIso(), Number(inspectionId)]);
  return score;
}

/**
 * The instance's real CAPA workflow: 'PV-CAPA' when present, otherwise the first
 * active process whose definition identifies a CAPA, otherwise 'PV-CAPA'.
 */
function defaultCapaProcessCode() {
  const names = db.all('SELECT code, definitions_json FROM process_types WHERE active = 1 ORDER BY code');
  for (const row of names) if (row.code === 'PV-CAPA') return 'PV-CAPA';
  const byDef = names.find((row) => {
    try {
      const d = JSON.parse(row.definitions_json || '{}');
      return /capa/i.test(d.code || '') || /capa/i.test(d.category || '')
        || /capa/i.test(d.nameEn || '') || /capa/i.test(d.name || '');
    } catch { return false; }
  });
  return byDef ? byDef.code : 'PV-CAPA';
}

/**
 * A sensible default for a definition-required field the escalation did not
 * receive, derived from the inspection context. Selects take their first option;
 * dates take the escalation due date; free text takes the finding summary.
 */
function defaultFieldValue(field, context) {
  if (field.key === 'sourceType') return '内审发现';
  if (field.key === 'occurredAt') return context.now;
  if (field.type === 'date') return String(context.dueDate || context.now).slice(0, 10);
  if (field.type === 'select' && Array.isArray(field.options) && field.options.length) {
    return field.options[0];
  }
  return context.summary ? String(context.summary).slice(0, 200) : 'Raised from self-inspection finding';
}

/**
 * Turn a finding into a tracked CAPA / deviation record.
 */
function escalateToCapa(findingId, input, actor, ctx) {
  const finding = db.get('SELECT * FROM inspection_findings WHERE id = ?', [Number(findingId)]);
  if (!finding) throw httpError(404, 'FINDING_NOT_FOUND');
  if (finding.workflow_id) throw httpError(409, 'ALREADY_ESCALATED', 'This finding already has a linked CAPA record');
  if (finding.status === 'compliant' || finding.status === 'not_applicable') {
    throw httpError(409, 'NOTHING_TO_ESCALATE', 'Only gaps or partial compliance can be escalated');
  }
  const inspection = db.get('SELECT * FROM inspections WHERE id = ?', [finding.inspection_id]);

  // Lazy require to avoid a circular dependency between domain modules.
  const workflow = require('./workflow');

  // The PV configuration no longer ships a bare "CAPA" process type, so the
  // default must resolve to the instance's actual CAPA workflow ('PV-CAPA' when
  // present, otherwise the first active process whose definition identifies a
  // CAPA).
  const processCode = input.processCode || defaultCapaProcessCode();

  // A target date is a mandatory field on the CAPA definition, so the escalation
  // must supply one: the finding's own due date if the assessor set it, otherwise
  // the process SLA. A critical finding gets a materially shorter window because
  // the whole point of triaging by risk is that critical gaps close first.
  const dueDate = input.dueDate
    || finding.due_date
    || defaultEscalationDueDate(workflow, processCode, finding.risk_level);

  // PV process definitions mark more fields than title/summary/dueDate as
  // required (sourceType on PV-CAPA, processArea/impactOnTimelines on PV-DEV,
  // product/reportSource on ICSR-*). The escalation screen does not collect
  // them, so the built-in pathway fills them from the inspection context; a
  // caller may still override any of them by passing `data` through the route,
  // and caller-supplied values always win over the defaults.
  const data = {
    sourceInspection: inspection.code,
    clauseRef: finding.clause_ref,
    requirement: finding.requirement,
    objectiveEvidence: finding.objective_evidence,
    ...(input.data || {}),
  };
  const definition = workflow.getDefinition(processCode) || { fields: [] };
  const now = nowIso();
  for (const field of definition.fields || []) {
    if (!field.required) continue;
    if (input[field.key] !== undefined || data[field.key] !== undefined) continue;
    const value = defaultFieldValue(field, {
      now,
      dueDate,
      summary: input.summary || finding.observation,
    });
    if (value !== undefined) data[field.key] = value;
  }

  const created = workflow.createInstance({
    processCode,
    title: input.title || `CAPA for ${inspection.code}: ${String(finding.requirement).slice(0, 120)}`,
    summary: input.summary || finding.observation || 'Raised from self-inspection finding',
    criticality: finding.risk_level === 'critical' ? 'critical' : (finding.risk_level === 'minor' ? 'minor' : 'major'),
    gxpAreas: parseJson(inspection.gxp_areas, []),
    sourceEntityType: 'inspection_findings',
    sourceEntityId: String(finding.id),
    ownerId: input.ownerId || finding.owner_id || null,
    dueDate,
    site: inspection.site,
    data,
  }, actor, ctx);

  db.run(
    'UPDATE inspection_findings SET workflow_id = ?, status = ?, updated_at = ? WHERE id = ?',
    [created.id, 'in_progress', nowIso(), finding.id]
  );

  audit.append({
    action: 'escalate', entityType: 'inspection_findings', entityId: finding.id,
    recordKey: `inspection:${inspection.code}`, actor,
    reason: `Finding escalated to ${created.recordKey} (${processCode})`, ctx,
    newValue: { workflow_id: created.id, workflow_key: created.recordKey },
    severity: finding.risk_level === 'critical' ? 'critical' : 'warning',
  });

  return { finding: getFinding(finding.id), workflow: created };
}

function listInspections(filters = {}) {
  const where = [];
  const params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.inspectionType) { where.push('inspection_type = ?'); params.push(filters.inspectionType); }
  if (filters.gxpArea) { where.push('gxp_areas LIKE ?'); params.push(`%"${filters.gxpArea}"%`); }
  if (filters.search) {
    where.push('(code LIKE ? OR title LIKE ? OR scope LIKE ? OR lead_auditor LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const offset = Number(filters.offset) || 0;
  const total = db.get(`SELECT COUNT(*) AS n FROM inspections ${clause}`, params).n;
  const rows = db.all(
    `SELECT * FROM inspections ${clause} ORDER BY scheduled_date DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    total, limit, offset,
    rows: rows.map((r) => {
      const counts = db.get(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN status NOT IN ('not_assessed','compliant','not_applicable') THEN 1 ELSE 0 END) AS open
         FROM inspection_findings WHERE inspection_id = ?`, [r.id]
      );
      const criticalOpen = db.get(
        "SELECT COUNT(*) AS n FROM inspection_findings WHERE inspection_id = ? AND risk_level = 'critical' AND status NOT IN ('compliant','closed','not_applicable')",
        [r.id]
      ).n;
      return {
        id: r.id, code: r.code, title: r.title, inspectionType: r.inspection_type,
        authority: r.authority, gxpAreas: parseJson(r.gxp_areas, []), site: r.site,
        scope: r.scope, leadAuditor: r.lead_auditor, scheduledDate: r.scheduled_date,
        completedAt: r.completed_at, status: r.status, readinessScore: r.readiness_score,
        itemsTotal: counts.total || 0, findingsOpen: counts.open || 0, criticalOpen,
      };
    }),
  };
}

/** Complete an inspection and freeze the result. */
function closeInspection(id, input, actor, ctx) {
  const inspection = db.get('SELECT * FROM inspections WHERE id = ?', [Number(id)]);
  if (!inspection) throw httpError(404, 'INSPECTION_NOT_FOUND');
  const remaining = db.get(
    "SELECT COUNT(*) AS n FROM inspection_findings WHERE inspection_id = ? AND status = 'not_assessed'",
    [inspection.id]
  ).n;
  if (remaining > 0 && !input.force) {
    throw httpError(409, 'ASSESSMENT_INCOMPLETE', `${remaining} requirement(s) have not been assessed yet`);
  }
  const openCritical = db.get(
    "SELECT COUNT(*) AS n FROM inspection_findings WHERE inspection_id = ? AND risk_level = 'critical' AND status = 'open'",
    [inspection.id]
  ).n;
  if (openCritical > 0 && !input.force) {
    throw httpError(409, 'CRITICAL_GAPS_OPEN',
      `${openCritical} critical finding(s) are still open. Escalate them to CAPA before closing the inspection.`);
  }

  const score = recalculateScore(inspection.id);
  const at = nowIso();
  db.run(
    "UPDATE inspections SET status = ?, completed_at = ?, summary = ?, readiness_score = ?, updated_at = ? WHERE id = ?",
    [input.force && remaining ? 'closed_with_open_items' : 'closed', at, input.summary || null, score, at, inspection.id]
  );
  audit.append({
    action: 'close', entityType: 'inspections', entityId: inspection.id, actor,
    reason: input.summary || 'Self inspection completed', ctx,
    oldValue: { status: inspection.status, readiness_score: inspection.readiness_score },
    newValue: { status: 'closed', readiness_score: score, open_items_forced: Boolean(input.force && remaining) },
    gxpAreas: parseJson(inspection.gxp_areas, []), severity: 'warning',
  });
  return getInspection(inspection.id);
}

/**
 * The headline metric: "if an inspector arrived tomorrow, what would they find?"
 * Combines open critical findings, document review debt, training gaps and
 * audit-trail integrity into a single readiness picture with named blockers.
 */
function readinessDashboard(filters = {}) {
  const gxpArea = filters.gxpArea || null;
  const blockers = [];
  // Bound as a parameter: the area code arrives straight from the query string.
  const areaFilter = gxpArea ? ' AND gxp_areas LIKE ?' : '';
  const areaParams = gxpArea ? [`%"${gxpArea}"%`] : [];

  // 1. open inspection findings
  const openFindings = db.all(
    `SELECT f.id, f.risk_level, f.finding_type, f.requirement, f.clause_ref, f.due_date,
            i.code AS inspection_code, i.title AS inspection_title
     FROM inspection_findings f JOIN inspections i ON i.id = f.inspection_id
     WHERE f.status IN ('open','in_progress')${gxpArea ? ' AND i.gxp_areas LIKE ?' : ''}
     ORDER BY CASE f.risk_level WHEN 'critical' THEN 1 WHEN 'major' THEN 2 ELSE 3 END, f.due_date IS NULL, f.due_date`,
    areaParams
  );
  const criticalFindings = openFindings.filter((f) => f.risk_level === 'critical');
  if (criticalFindings.length) {
    blockers.push({
      code: 'OPEN_CRITICAL_FINDINGS', severity: 'critical', count: criticalFindings.length,
      message: `${criticalFindings.length} open critical inspection finding(s)`,
      items: criticalFindings.slice(0, 5).map((f) => `${f.inspection_code}: ${String(f.requirement).slice(0, 90)}`),
    });
  }
  const majorFindings = openFindings.filter((f) => f.risk_level === 'major');
  if (majorFindings.length) {
    blockers.push({
      code: 'OPEN_MAJOR_FINDINGS', severity: 'major', count: majorFindings.length,
      message: `${majorFindings.length} open major finding(s)`,
      items: majorFindings.slice(0, 5).map((f) => `${f.inspection_code}: ${String(f.requirement).slice(0, 90)}`),
    });
  }

  // 2. document review debt
  const reviewOverdue = db.all(
    `SELECT doc_number, title, next_review_date FROM documents
     WHERE status = 'effective' AND next_review_date IS NOT NULL AND next_review_date < date('now')${areaFilter}
     ORDER BY next_review_date LIMIT 50`,
    areaParams
  );
  if (reviewOverdue.length) {
    blockers.push({
      code: 'DOCUMENTS_PAST_REVIEW', severity: 'major', count: reviewOverdue.length,
      message: `${reviewOverdue.length} effective document(s) past their periodic review date (EU GMP Ch.4)`,
      items: reviewOverdue.slice(0, 5).map((d) => `${d.doc_number} (due ${d.next_review_date})`),
    });
  }

  // 3. training gaps
  const trainingReport = require('./training').complianceReport();
  if (trainingReport.counts.expired) {
    blockers.push({
      code: 'TRAINING_EXPIRED', severity: 'major', count: trainingReport.counts.expired,
      message: `${trainingReport.counts.expired} expired GxP training record(s)`,
      items: trainingReport.expired.slice(0, 5).map((t) => `${t.userName}: ${t.curriculumCode} (expired ${t.expiresAt})`),
    });
  }
  if (trainingReport.counts.overdue) {
    blockers.push({
      code: 'TRAINING_OVERDUE', severity: 'minor', count: trainingReport.counts.overdue,
      message: `${trainingReport.counts.overdue} overdue training assignment(s)`,
      items: trainingReport.overdue.slice(0, 5).map((t) => `${t.userName}: ${t.curriculumCode} (due ${t.dueDate})`),
    });
  }

  // 4. equipment calibration
  let equipReport = null;
  try {
    equipReport = require('./equipment').calibrationDueReport();
  } catch {
    equipReport = null;
  }
  if (equipReport && equipReport.overdue.length) {
    blockers.push({
      code: 'CALIBRATION_OVERDUE', severity: 'major', count: equipReport.overdue.length,
      message: `${equipReport.overdue.length} instrument(s) past calibration due date (21 CFR 211.160(b)(4))`,
      items: equipReport.overdue.slice(0, 5).map((e) => `${e.assetNo} ${e.name} (due ${e.nextCalibrationDate})`),
    });
  }

  // 5. overdue quality records (deviations/CAPA/SLA breach)
  const overdueRecords = db.all(
    `SELECT record_key, title, process_code, due_date, criticality FROM workflow_instances
     WHERE status NOT IN ('closed','cancelled','rejected') AND due_date IS NOT NULL AND due_date < date('now')${areaFilter}
     ORDER BY due_date LIMIT 50`,
    areaParams
  );
  if (overdueRecords.length) {
    blockers.push({
      code: 'QUALITY_RECORDS_OVERDUE', severity: 'major', count: overdueRecords.length,
      message: `${overdueRecords.length} quality record(s) past due date (ICH Q10 / 211.192 timeliness)`,
      items: overdueRecords.slice(0, 5).map((r) => `${r.record_key} ${r.process_code} (due ${r.due_date})`),
    });
  }

  // 6. audit trail integrity - if this fails, nothing else matters
  let chain = { ok: true, checked: 0 };
  try {
    chain = audit.verifyChain();
  } catch (err) {
    chain = { ok: false, reason: err.message };
  }
  if (!chain.ok) {
    blockers.unshift({
      code: 'AUDIT_CHAIN_BROKEN', severity: 'critical', count: 1,
      message: `Audit trail integrity check FAILED at sequence ${chain.brokenAt}: ${chain.reason}`,
      items: ['This is a data integrity incident - stop using the system and contact the system owner.'],
    });
  }

  // 7. electronic signature / account hygiene
  const weakAccounts = db.all(
    "SELECT username, full_name, role FROM users WHERE status = 'active' AND (password_hash IS NULL OR totp_enabled = 0)"
  );
  const sharedNameRisk = db.get(
    "SELECT COUNT(*) AS n FROM (SELECT full_name FROM users WHERE status='active' GROUP BY full_name HAVING COUNT(*) > 1)"
  ).n;
  const hygiene = [];
  if (weakAccounts.length) {
    hygiene.push({
      code: 'ACCOUNTS_WITHOUT_SECOND_FACTOR', severity: 'minor', count: weakAccounts.length,
      message: `${weakAccounts.length} active account(s) without a second authentication factor (weakens Part 11.200(a)(1)(i))`,
      items: weakAccounts.slice(0, 5).map((u) => `${u.username} (${u.role})`),
    });
  }
  if (sharedNameRisk) {
    hygiene.push({
      code: 'DUPLICATE_PERSON_NAMES', severity: 'minor', count: sharedNameRisk,
      message: `${sharedNameRisk} name(s) shared by multiple accounts - verify no shared logins (Annex 11 §12.1)`,
      items: [],
    });
  }

  const weighted = blockers.reduce((acc, b) => acc + (b.severity === 'critical' ? 25 : b.severity === 'major' ? 8 : 2), 0);
  const score = Math.max(0, 100 - weighted);

  return {
    gxpArea,
    generatedAt: nowIso(),
    readinessScore: score,
    rating: score >= 90 ? 'inspection_ready' : score >= 70 ? 'minor_gaps' : score >= 45 ? 'significant_gaps' : 'not_ready',
    blockers,
    hygiene,
    auditChain: { ok: chain.ok, checked: chain.checked, brokenAt: chain.brokenAt || null, reason: chain.reason || null },
    openFindings: {
      total: openFindings.length,
      critical: criticalFindings.length,
      major: majorFindings.length,
      minor: openFindings.filter((f) => f.risk_level === 'minor').length,
      overdueCount: openFindings.filter((f) => f.due_date && Date.parse(f.due_date) < Date.now()).length,
    },
    evidence: {
      documentsPastReview: reviewOverdue.length,
      trainingExpired: trainingReport.counts.expired,
      trainingOverdue: trainingReport.counts.overdue,
      calibrationOverdue: equipReport ? equipReport.overdue.length : null,
      recordsOverdue: overdueRecords.length,
    },
  };
}

function metrics() {
  const total = db.get('SELECT COUNT(*) AS n FROM inspections').n;
  const byType = db.all('SELECT inspection_type, COUNT(*) AS n FROM inspections GROUP BY inspection_type');
  const openFindings = db.get("SELECT COUNT(*) AS n FROM inspection_findings WHERE status IN ('open','in_progress')").n;
  const criticalOpen = db.get("SELECT COUNT(*) AS n FROM inspection_findings WHERE risk_level = 'critical' AND status IN ('open','in_progress')").n;
  const avgScore = db.get("SELECT AVG(readiness_score) AS s FROM inspections WHERE readiness_score IS NOT NULL").s;
  const byGxpArea = db.all(
    `SELECT f.risk_level, COUNT(*) AS n FROM inspection_findings f
     WHERE f.status IN ('open','in_progress') GROUP BY f.risk_level`
  );
  return {
    total, byType: Object.fromEntries(byType.map((r) => [r.inspection_type, r.n])),
    openFindings, criticalOpen,
    averageReadinessScore: avgScore != null ? Math.round(avgScore * 10) / 10 : null,
    openByRisk: Object.fromEntries(byGxpArea.map((r) => [r.risk_level, r.n])),
  };
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  registerTemplate,
  listTemplates,
  getTemplate,
  createInspection,
  getInspection,
  listInspections,
  assessItem,
  getFinding,
  escalateToCapa,
  closeInspection,
  recalculateScore,
  readinessDashboard,
  metrics,
  RISK_WEIGHTS,
  RISK_LEVELS,
  GRADES,
  FINDING_TYPES,
  httpError,
};
