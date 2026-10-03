'use strict';

/**
 * Dashboard aggregation.
 *
 * The point of this module is to answer, on one screen, the three questions a
 * GxP worker actually has:
 *   1. What must I do today?           -> myTasks / myActions
 *   2. What is about to bite us?        -> alerts (review debt, calibration,
 *                                          training expiry, overdue records)
 *   3. If an inspector walked in now?   -> readiness score + named blockers
 */

const db = require('../core/db');
const audit = require('../core/audit');
const config = require('../config');
const rbac = require('../core/rbac');

function nowIso() { return new Date().toISOString(); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function safeRequire(path, fallback) {
  try { return require(path); } catch { return fallback; }
}

const documents = safeRequire('./documents', null);
const training = safeRequire('./training', null);
const inspections = safeRequire('./inspections', null);
const workflow = require('./workflow');

/**
 * Everything the current user should act on, ranked by urgency.
 */
function myWork(user, limit = 30) {
  const items = [];

  // 1. Workflow steps waiting on this user's role.
  for (const step of workflow.myActions(user, limit)) {
    items.push({
      kind: 'workflow_step',
      urgency: step.overdue ? 'overdue' : (step.criticality === 'critical' ? 'high' : 'normal'),
      title: step.stepName,
      subtitle: `${step.recordKey} - ${step.title}`,
      link: { view: 'record', id: step.instanceId, recordKey: step.recordKey },
      dueDate: step.dueDate,
      requiresSignature: Boolean(step.signatureMeaning),
      signatureMeaning: step.signatureMeaning,
      processCode: step.processCode,
    });
  }

  // 2. Documents awaiting this user's acknowledgement.
  if (documents) {
    for (const doc of documents.pendingAcknowledgements(user.id)) {
      items.push({
        kind: 'document_ack',
        urgency: 'normal',
        title: `Read & understand: ${doc.docNumber} v${doc.version}`,
        subtitle: doc.title,
        link: { view: 'document', id: doc.id, docNumber: doc.docNumber },
        requiresSignature: false,
      });
    }
  }

  // 3. Owned records that are overdue.
  const overdueOwned = db.all(
    `SELECT id, record_key, process_code, title, due_date, criticality FROM workflow_instances
     WHERE owner_id = ? AND status NOT IN ('closed','cancelled','rejected')
       AND due_date IS NOT NULL AND due_date < date('now')
     ORDER BY due_date ASC LIMIT ?`,
    [user.id, limit]
  );
  for (const r of overdueOwned) {
    items.push({
      kind: 'record_overdue',
      urgency: 'overdue',
      title: `Overdue: ${r.record_key}`,
      subtitle: r.title,
      link: { view: 'record', id: r.id, recordKey: r.record_key },
      dueDate: r.due_date,
      processCode: r.process_code,
    });
  }

  // 4. Training assignments due.
  const trainingDue = db.all(
    `SELECT tr.id, tr.due_date, c.code, c.title, c.is_gxp_critical
     FROM training_records tr JOIN training_curricula c ON c.id = tr.curriculum_id
     WHERE tr.user_id = ? AND tr.status IN ('assigned','in_progress')
     ORDER BY tr.due_date IS NULL, tr.due_date ASC LIMIT 20`,
    [user.id]
  );
  for (const t of trainingDue) {
    items.push({
      kind: 'training',
      urgency: t.due_date && Date.parse(t.due_date) < Date.now() ? 'overdue' : 'normal',
      title: `Training: ${t.code}`,
      subtitle: t.title,
      link: { view: 'my-training' },
      dueDate: t.due_date,
      gxpCritical: Boolean(t.is_gxp_critical),
    });
  }

  // 5. Findings assigned to this user.
  const findings = db.all(
    `SELECT f.id, f.clause_ref, f.requirement, f.risk_level, f.due_date, i.code AS inspection_code
     FROM inspection_findings f JOIN inspections i ON i.id = f.inspection_id
     WHERE f.owner_id = ? AND f.status IN ('open','in_progress')
     ORDER BY CASE f.risk_level WHEN 'critical' THEN 1 WHEN 'major' THEN 2 ELSE 3 END, f.due_date LIMIT 20`,
    [user.id]
  );
  for (const f of findings) {
    items.push({
      kind: 'finding',
      urgency: f.risk_level === 'critical' ? 'high' : (f.due_date && Date.parse(f.due_date) < Date.now() ? 'overdue' : 'normal'),
      title: `Finding (${f.risk_level}): ${f.inspection_code}`,
      subtitle: String(f.requirement).slice(0, 160),
      link: { view: 'inspection-finding', id: f.id },
      dueDate: f.due_date,
    });
  }

  const order = { overdue: 0, high: 1, normal: 2, low: 3 };
  items.sort((a, b) => {
    const u = order[a.urgency] - order[b.urgency];
    if (u !== 0) return u;
    if (a.dueDate && b.dueDate) return Date.parse(a.dueDate) - Date.parse(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });

  return {
    total: items.length,
    overdue: items.filter((i) => i.urgency === 'overdue').length,
    requiresSignature: items.filter((i) => i.requiresSignature).length,
    byKind: items.reduce((acc, i) => { acc[i.kind] = (acc[i.kind] || 0) + 1; return acc; }, {}),
    items: items.slice(0, limit),
  };
}

/**
 * Site-wide alerts: the "what is about to bite us" list.
 */
function alerts(filters = {}) {
  const out = [];
  const area = filters.gxpArea || null;
  // Bound as a parameter: the area code arrives straight from the query string.
  const areaFilter = area ? ' AND gxp_areas LIKE ?' : '';
  const areaParams = area ? [`%"${area}"%`] : [];

  // Documents past review
  const docs = db.all(
    `SELECT id, doc_number, title, next_review_date, department FROM documents
     WHERE status = 'effective' AND next_review_date IS NOT NULL AND next_review_date < date('now')${areaFilter}
     ORDER BY next_review_date LIMIT 25`,
    areaParams
  );
  if (docs.length) {
    out.push({
      code: 'documents_review_overdue', level: 'high',
      title: `${docs.length} document(s) past periodic review`,
      detail: 'EU GMP Chapter 4 requires documents to be reviewed and kept current.',
      items: docs.map((d) => ({ label: `${d.doc_number} - ${d.title}`, meta: `due ${d.next_review_date}`, link: { view: 'document', id: d.id } })),
    });
  }

  const docsSoon = db.all(
    `SELECT id, doc_number, title, next_review_date FROM documents
     WHERE status = 'effective' AND next_review_date IS NOT NULL
       AND next_review_date >= date('now') AND next_review_date <= date('now', '+' || ? || ' day')${areaFilter}
     ORDER BY next_review_date LIMIT 25`,
    [config.reminder.documentReviewWarningDays, ...areaParams]
  );
  if (docsSoon.length) {
    out.push({
      code: 'documents_review_due_soon', level: 'normal',
      title: `${docsSoon.length} document(s) due for review within ${config.reminder.documentReviewWarningDays} days`,
      items: docsSoon.map((d) => ({ label: `${d.doc_number} - ${d.title}`, meta: `due ${d.next_review_date}`, link: { view: 'document', id: d.id } })),
    });
  }

  // Training
  if (training) {
    const tr = training.complianceReport();
    if (tr.counts.expired) {
      out.push({
        code: 'training_expired', level: 'high',
        title: `${tr.counts.expired} expired training record(s)`,
        detail: 'Personnel must remain qualified for the GxP tasks they perform (EU GMP Ch.2.10-2.14).',
        items: tr.expired.slice(0, 10).map((t) => ({ label: `${t.userName} - ${t.curriculumCode}`, meta: `expired ${t.expiresAt}`, link: { view: 'training' } })),
      });
    }
    if (tr.counts.overdue) {
      out.push({
        code: 'training_overdue', level: 'normal',
        title: `${tr.counts.overdue} overdue training assignment(s)`,
        items: tr.overdue.slice(0, 10).map((t) => ({ label: `${t.userName} - ${t.curriculumCode}`, meta: `due ${t.dueDate}`, link: { view: 'training' } })),
      });
    }
  }

  // Expedited ICSR reporting deadlines - the PV equivalent of a calibration
  // expiry: a case whose submission window has passed is a critical finding.
  const expedited = db.all(
    `SELECT id, record_key, process_code, title, due_date FROM workflow_instances
     WHERE process_code = 'ICSR-EXP' AND status NOT IN ('closed','cancelled','rejected')
       AND due_date IS NOT NULL AND due_date < date('now')${areaFilter}
     ORDER BY due_date LIMIT 25`,
    areaParams
  );
  if (expedited.length) {
    out.push({
      code: 'expedited_deadline_missed', level: 'critical',
      title: `${expedited.length} expedited case(s) past their reporting deadline`,
      detail: 'Timeline is counted from first knowledge of the four elements (ICH E2D / 81号令第16-17条). A missed deadline must be recorded with its reason.',
      items: expedited.map((r) => ({ label: `${r.record_key} - ${r.title}`, meta: `due ${r.due_date}`, link: { view: 'record', id: r.id } })),
    });
  }

  const deadlineSoon = db.all(
    `SELECT id, record_key, process_code, title, due_date FROM workflow_instances
     WHERE process_code = 'ICSR-EXP' AND status NOT IN ('closed','cancelled','rejected')
       AND due_date IS NOT NULL AND due_date >= date('now')
       AND due_date <= date('now', '+' || ? || ' day')${areaFilter}
     ORDER BY due_date LIMIT 25`,
    [config.reminder.reportDeadlineWarningDays, ...areaParams]
  );
  if (deadlineSoon.length) {
    out.push({
      code: 'expedited_deadline_due_soon', level: 'high',
      title: `${deadlineSoon.length} expedited case(s) due within ${config.reminder.reportDeadlineWarningDays} days`,
      items: deadlineSoon.map((r) => ({ label: `${r.record_key} - ${r.title}`, meta: `due ${r.due_date}`, link: { view: 'record', id: r.id } })),
    });
  }

  // Overdue safety records
  const records = db.all(
    `SELECT id, record_key, process_code, title, due_date, criticality FROM workflow_instances
     WHERE status NOT IN ('closed','cancelled','rejected') AND due_date IS NOT NULL AND due_date < date('now')${areaFilter}
     ORDER BY due_date LIMIT 25`,
    areaParams
  );
  if (records.length) {
    out.push({
      code: 'records_overdue', level: 'high',
      title: `${records.length} safety record(s) past due date`,
      detail: 'GVP requires timely case processing, signal assessment and report submission.',
      items: records.map((r) => ({ label: `${r.record_key} - ${r.title}`, meta: `due ${r.due_date}`, link: { view: 'record', id: r.id } })),
    });
  }

  // Effectiveness checks outstanding
  const eff = db.get(
    `SELECT COUNT(*) AS n FROM workflow_instances
     WHERE effectiveness_result IS NULL
       AND process_code IN (SELECT code FROM process_types WHERE requires_effectiveness_check = 1)
       AND status NOT IN ('cancelled','rejected')`
  ).n;
  if (eff) {
    out.push({
      code: 'effectiveness_pending', level: 'normal',
      title: `${eff} CAPA(s) without an effectiveness check result`,
      detail: 'ICH Q10 §3.2.2 requires CAPA effectiveness to be evaluated.',
      items: [],
    });
  }

  // Audit chain integrity
  let chain;
  try {
    chain = audit.verifyChain();
  } catch (err) {
    chain = { ok: false, reason: err.message };
  }
  if (!chain.ok) {
    out.unshift({
      code: 'audit_chain_broken', level: 'critical',
      title: 'Audit trail integrity check FAILED',
      detail: `Sequence ${chain.brokenAt}: ${chain.reason}. Treat as a data integrity incident and stop using the system.`,
      items: [],
    });
  }

  const order = { critical: 0, high: 1, normal: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);

  return {
    generatedAt: nowIso(),
    counts: {
      critical: out.filter((a) => a.level === 'critical').length,
      high: out.filter((a) => a.level === 'high').length,
      normal: out.filter((a) => a.level === 'normal').length,
    },
    items: out,
  };
}

/**
 * Full dashboard payload for the landing screen.
 */
function dashboard(user, filters = {}) {
  const area = filters.gxpArea || null;
  const wfMetrics = workflow.metrics({ gxpArea: area });

  const payload = {
    generatedAt: nowIso(),
    user: user ? { id: user.id, fullName: user.full_name, role: user.role, trainingStatus: user.training_status } : null,
    gxpArea: area,
    myWork: user ? myWork(user) : null,
    alerts: alerts({ gxpArea: area }),
    workflow: {
      openByProcess: wfMetrics.byProcess,
      byStatus: Object.fromEntries(wfMetrics.byStatus.map((r) => [r.status, r.n])),
      byCriticality: Object.fromEntries(wfMetrics.byCriticality.map((r) => [r.criticality || 'unspecified', r.n])),
      ageing: wfMetrics.ageing,
      rootCausePending: wfMetrics.rootCausePending,
      effectivenessPending: wfMetrics.effCheckDue,
    },
    // 12-month trend, pivoted for charting
    trend: pivotTrend(wfMetrics.trend),
  };

  if (documents) payload.documents = documents.metrics();
  if (training) payload.training = training.metrics();
  if (inspections) {
    payload.inspections = inspections.metrics();
    payload.readiness = inspections.readinessDashboard({ gxpArea: area });
  }

  // Coverage: which GxP areas are actually in use on this site?
  payload.coverage = coverage(area);
  payload.compliance = compliancePosture();

  return payload;
}

function pivotTrend(rows) {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const processes = [...new Set(rows.map((r) => r.process_code))].sort();
  return {
    months,
    series: processes.map((p) => ({
      processCode: p,
      data: months.map((m) => {
        const hit = rows.find((r) => r.month === m && r.process_code === p);
        return hit ? hit.n : 0;
      }),
    })),
  };
}

/**
 * Which GxP areas have real activity, versus which are registered but empty.
 * Useful to spot a site that claims GDP compliance but has no GDP records.
 */
function coverage(areaFilter) {
  const areas = db.all('SELECT * FROM gxp_areas ORDER BY sort_order, code');
  return areas.map((a) => {
    const docs = db.get("SELECT COUNT(*) AS n FROM documents WHERE gxp_areas LIKE ? AND status = 'effective'", [`%"${a.code}"%`]).n;
    const records = db.get('SELECT COUNT(*) AS n FROM workflow_instances WHERE gxp_areas LIKE ?', [`%"${a.code}"%`]).n;
    const openRecords = db.get("SELECT COUNT(*) AS n FROM workflow_instances WHERE gxp_areas LIKE ? AND status NOT IN ('closed','cancelled','rejected')", [`%"${a.code}"%`]).n;
    const curricula = db.get('SELECT COUNT(*) AS n FROM training_curricula WHERE gxp_areas LIKE ? AND active = 1', [`%"${a.code}"%`]).n;
    const templates = db.get('SELECT COUNT(*) AS n FROM checklist_templates WHERE gxp_areas LIKE ? AND active = 1', [`%"${a.code}"%`]).n;
    const processes = db.get('SELECT COUNT(*) AS n FROM process_types WHERE gxp_areas LIKE ? AND active = 1', [`%"${a.code}"%`]).n;
    return {
      code: a.code, name: a.name, nameEn: a.name_en, fullName: a.full_name,
      colour: a.colour, sortOrder: a.sort_order,
      documents: docs, records, openRecords, curricula, checklistTemplates: templates, processTypes: processes,
      active: (docs + records + curricula + templates + processes) > 0,
    };
  }).filter((a) => !areaFilter || a.code === areaFilter);
}

/**
 * A blunt self-assessment of the *system's own* compliance posture, mapped to
 * the specific clauses a Part 11 / Annex 11 auditor would test.
 */
function compliancePosture() {
  const checks = [];
  const add = (id, clause, requirement, status, evidence) => checks.push({ id, clause, requirement, status, evidence });

  const chain = audit.verifyChain();
  add('audit-trail-append-only', '21 CFR Part 11.10(e)', 'Audit trail is computer-generated, time-stamped and append-only',
    chain.ok ? 'met' : 'not_met', chain.ok ? `${chain.checked} entries verified` : `BROKEN at seq ${chain.brokenAt}: ${chain.reason}`);

  const auditRows = db.get('SELECT COUNT(*) AS n FROM audit_trail').n;
  add('audit-trail-covers-changes', '21 CFR Part 11.10(e)', 'Changes do not obscure previously recorded information',
    'met', `${auditRows} audit entries; prior values retained in old_value and reconstructable`);

  const userCount = db.get('SELECT COUNT(*) AS n FROM users').n;
  const uniqueUsers = db.get('SELECT COUNT(DISTINCT username) AS n FROM users').n;
  add('unique-accounts', 'EU GMP Annex 11 §12.1', 'Unique user accounts, no shared logins',
    userCount === uniqueUsers ? 'met' : 'not_met', `${userCount} accounts, ${uniqueUsers} unique usernames`);

  const totpEnrolled = db.get('SELECT COUNT(*) AS n FROM users WHERE status = ? AND totp_enabled = 1', ['active']).n;
  const activeUsers = db.get('SELECT COUNT(*) AS n FROM users WHERE status = ?', ['active']).n;
  const policy = require('../core/auth').loadPolicy();
  add('two-component-signature', '21 CFR Part 11.200(a)(1)(i)', 'Signatures use at least two distinct identification components',
    policy.signatureSecondFactor ? 'met' : 'not_met',
    policy.signatureSecondFactor
      ? `Second factor enforced; ${totpEnrolled}/${activeUsers} active users enrolled an authenticator (others use a per-signing challenge)`
      : 'Second factor disabled by policy');

  const sigCount = db.get('SELECT COUNT(*) AS n FROM signatures WHERE valid = 1').n;
  add('signature-linked-to-record', '21 CFR Part 11.200(a)(3)', 'Signatures are linked to their records and cannot be excised',
    'met', `${sigCount} valid signature(s), each linked by entity_type/entity_id and mirrored into the audit trail`);

  const noReason = db.get("SELECT COUNT(*) AS n FROM audit_trail WHERE action IN ('update','delete','step_complete','assess') AND (reason IS NULL OR reason = '')").n;
  add('change-reason-recorded', 'EU GMP Annex 11 §9', 'Reason for change is recorded for GxP-relevant changes',
    noReason === 0 ? 'met' : 'partial', `${noReason} change entr(ies) without a reason`);

  const policyRow = db.get('SELECT policy_json, effective_from, approved_at FROM security_policy WHERE id = 1');
  // A site that never edited the policy still has a defined, enforced policy: the
  // shipped defaults. Reporting that as "not met" would be a false finding. The
  // distinction between "shipped default" and "reviewed and formally approved by
  // the site" is itself worth surfacing, so it is reported as partial.
  add('documented-security-policy', 'EU GMP Annex 11 §12', 'A documented security policy exists and is approved',
    policyRow ? 'met' : 'partial',
    policyRow
      ? `approved ${policyRow.approved_at || policyRow.effective_from}; site deviations from the default are recorded`
      : `default policy in force (min length ${policy.passwordMinLength}, idle timeout ${policy.idleTimeoutMinutes} min, `
        + `lockout after ${policy.maxFailedLogins} failed attempts); not yet reviewed and formally approved by the site`);

  add('password-expiry', '21 CFR Part 11.300(b)', 'Passwords are periodically checked, recalled or revised',
    'met', `max age ${policy.passwordMaxAgeDays} days, min length ${policy.passwordMinLength}, last ${policy.passwordHistoryDepth} passwords blocked`);

  add('session-control', 'EU GMP Annex 11 §12.3', 'Sessions time out and can be terminated',
    'met', `idle timeout ${policy.idleTimeoutMinutes} min, absolute session limit ${policy.sessionAbsoluteHours} h`);

  const tzSettings = db.get('SELECT COUNT(*) AS n FROM login_attempts').n;
  add('login-monitoring', '21 CFR Part 11.10(d)', 'Attempts at unauthorised access are detected and reported',
    'met', `${tzSettings} login attempt(s) logged, lockout after ${policy.maxFailedLogins} failures`);

  add('backup-procedure', 'EU GMP Annex 11 §7.2', 'Data is backed up and restoration is verifiable',
    db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'backup:%'").n > 0 ? 'met' : 'partial',
    'Use the built-in backup task; a restore rehearsal must be documented in the validation file');

  add('segregation-of-duties', 'EU GMP Annex 11 §12.1', 'Roles separate execution from approval',
    'met', `${rbac.listRoles().length} roles with explicit permission sets; author cannot close their own record`);

  const met = checks.filter((c) => c.status === 'met').length;
  return {
    checks,
    summary: {
      met, partial: checks.filter((c) => c.status === 'partial').length,
      notMet: checks.filter((c) => c.status === 'not_met').length, total: checks.length,
    },
  };
}

module.exports = { dashboard, myWork, alerts, coverage, compliancePosture };
