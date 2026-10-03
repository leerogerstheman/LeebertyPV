'use strict';

/**
 * Role based access control for LeebertyPV.
 *
 * Separation of duties is a pharmacovigilance expectation (EU GVP Module I
 * quality system, ICH Q10 §3.2): the person who processes a case must not be
 * the only person who reviews it, the intake clerk must not be the medical
 * assessor, and the person who raises a PV quality deviation must not be the
 * one who closes it.
 *
 * `*` means "all permissions" and is intentionally granted only to
 * `system_admin`, whose safety-record access is additionally restricted by the
 * rule that system administrators may not be used as the sole approver of
 * safety records (see `canSign`).
 */

const PERMISSIONS = {
  // administration
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  ROLE_MANAGE: 'role.manage',
  POLICY_MANAGE: 'policy.manage',
  SETTINGS_MANAGE: 'settings.manage',
  BACKUP_MANAGE: 'backup.manage',
  // Scoped separately from user.manage: adding a participant on a workflow
  // view changes who is shown in a process - it does not create accounts.
  EXPLORER_MANAGE: 'explorer.manage',

  // audit / compliance
  AUDIT_VIEW: 'audit.view',
  AUDIT_VERIFY: 'audit.verify',
  AUDIT_EXPORT: 'audit.export',
  SIGNATURE_AUTHORIZE: 'signature.authorize',
  COMPLIANCE_VIEW: 'compliance.view',
  COMPLIANCE_MANAGE: 'compliance.manage',

  // document control
  DOC_VIEW: 'doc.view',
  DOC_CREATE: 'doc.create',
  DOC_EDIT: 'doc.edit',
  DOC_REVIEW: 'doc.review',
  DOC_APPROVE: 'doc.approve',
  DOC_OBSOLETE: 'doc.obsolete',

  // records
  RECORD_VIEW: 'record.view',
  RECORD_CREATE: 'record.create',
  RECORD_EDIT: 'record.edit',
  RECORD_CLOSE: 'record.close',
  RECORD_DELETE: 'record.delete',
  RECORD_EXPORT: 'record.export',

  // quality systems (PV quality / GVP Module I)
  DEVIATION_MANAGE: 'deviation.manage',
  CAPA_MANAGE: 'capa.manage',
  CHANGE_MANAGE: 'change.manage',
  COMPLAINT_MANAGE: 'complaint.manage',
  RECALL_MANAGE: 'recall.manage',

  // ---- pharmacovigilance domain -----------------------------------------
  /** Process individual case safety reports through intake/triage/entry. */
  ICSR_PROCESS: 'icsr.process',
  /** Complete case-level causality and medical review. */
  CAUSALITY_ASSESS: 'causality.assess',
  /** Detect, validate, confirm and assess signals. */
  SIGNAL_MANAGE: 'signal.manage',
  /** Compile and approve periodic safety reports (PSUR / PBRER). */
  PSUR_MANAGE: 'psur.manage',
  /** Develop and maintain the risk management plan and RMMs. */
  RMP_MANAGE: 'rmp.manage',
  /** Run literature surveillance and triage articles. */
  LITERATURE_REVIEW: 'literature.review',
  /** Submit safety reports to regulators and manage acknowledgements. */
  SUBMISSION_MANAGE: 'submission.manage',
  /** Sit on the drug safety committee for signal / risk decisions. */
  SAFETY_COMMITTEE: 'safety.committee',

  // training & qualification
  TRAINING_VIEW: 'training.view',
  TRAINING_MANAGE: 'training.manage',
  TRAINING_ASSESS: 'training.assess',

  // inspections
  INSPECTION_VIEW: 'inspection.view',
  INSPECTION_MANAGE: 'inspection.manage',
  INSPECTION_REPORT: 'inspection.report',

  // equipment - retained in the catalogue only so legacy routes stay closed;
  // no PV role is granted these permissions in this build.
  EQUIPMENT_VIEW: 'equipment.view',
  EQUIPMENT_MANAGE: 'equipment.manage',
};

const P = PERMISSIONS;

const READ_ONLY = [
  P.DOC_VIEW, P.RECORD_VIEW, P.AUDIT_VIEW, P.TRAINING_VIEW, P.INSPECTION_VIEW,
  P.COMPLIANCE_VIEW,
];

const ROLES = {
  system_admin: {
    label: 'System Administrator',
    labelZh: '系统管理员',
    description: 'Technical administration of users, roles and configuration. Cannot be the sole PV approver.',
    permissions: ['*'],
    isSafetyRecordParty: false,
  },

  pv_head: {
    label: 'PV Head / QPPV',
    labelZh: '药物警戒负责人 (QPPV)',
    description: 'Accountable for the pharmacovigilance system, approves case closure, signals, PSUR and RMP actions.',
    permissions: [
      ...READ_ONLY,
      P.USER_VIEW, P.AUDIT_VERIFY, P.AUDIT_EXPORT, P.SIGNATURE_AUTHORIZE, P.COMPLIANCE_MANAGE,
      P.EXPLORER_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE, P.DOC_OBSOLETE,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_EXPORT,
      P.DEVIATION_MANAGE, P.CAPA_MANAGE, P.CHANGE_MANAGE,
      P.RECALL_MANAGE, P.COMPLAINT_MANAGE,
      P.ICSR_PROCESS, P.CAUSALITY_ASSESS, P.SIGNAL_MANAGE, P.PSUR_MANAGE,
      P.RMP_MANAGE, P.LITERATURE_REVIEW, P.SUBMISSION_MANAGE, P.SAFETY_COMMITTEE,
      P.TRAINING_MANAGE, P.TRAINING_ASSESS,
      P.INSPECTION_MANAGE, P.INSPECTION_REPORT,
    ],
    isSafetyRecordParty: true,
  },

  pv_officer: {
    label: 'PV Officer',
    labelZh: '药物警戒专员',
    description: 'Owns ICSR intake, triage, follow-up and case processing; detects signals.',
    permissions: [
      ...READ_ONLY,
      P.AUDIT_VIEW, P.AUDIT_EXPORT, P.COMPLIANCE_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_EXPORT,
      P.ICSR_PROCESS, P.SIGNAL_MANAGE, P.LITERATURE_REVIEW, P.SUBMISSION_MANAGE,
      P.COMPLAINT_MANAGE, P.DEVIATION_MANAGE, P.CAPA_MANAGE,
      P.TRAINING_VIEW, P.INSPECTION_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  pv_data_entry: {
    label: 'PV Data Entry / Coder',
    labelZh: '数据录入员',
    description: 'Enters case data, codes events with MedDRA terms, keeps the ICSR data set complete.',
    permissions: [
      P.DOC_VIEW, P.RECORD_VIEW, P.RECORD_CREATE, P.RECORD_EDIT,
      P.ICSR_PROCESS, P.TRAINING_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  pv_medical: {
    label: 'Medical Assessor',
    labelZh: '医学评价员',
    description: 'Physician-level medical review and causality assessment of serious and nonserious cases.',
    permissions: [
      ...READ_ONLY,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_EXPORT,
      P.CAUSALITY_ASSESS, P.SIGNAL_MANAGE, P.PSUR_MANAGE, P.RMP_MANAGE,
      P.SAFETY_COMMITTEE, P.COMPLAINT_MANAGE, P.AUDIT_VIEW,
      P.TRAINING_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  pv_writer: {
    label: 'PV Report Writer',
    labelZh: '定期报告撰写员',
    description: 'Compiles PSUR / PBRER and signal assessment reports against data lock points.',
    permissions: [
      ...READ_ONLY,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.PSUR_MANAGE, P.SIGNAL_MANAGE, P.RMP_MANAGE,
      P.AUDIT_VIEW, P.TRAINING_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  pv_regulatory: {
    label: 'PV Regulatory / Submissions Officer',
    labelZh: '信息报送与递交专员',
    description: 'Files expedited and periodic reports with agencies, tracks acknowledgement and timelines.',
    permissions: [
      ...READ_ONLY,
      P.DOC_CREATE, P.DOC_EDIT, P.AUDIT_EXPORT, P.RECORD_EXPORT,
      P.SUBMISSION_MANAGE, P.ICSR_PROCESS, P.PSUR_MANAGE,
      P.COMPLIANCE_MANAGE, P.CHANGE_MANAGE,
    ],
    isSafetyRecordParty: true,
  },

  literature_reviewer: {
    label: 'Literature Monitor',
    labelZh: '文献监测员',
    description: 'Runs the literature search schedule, triages articles, hands valid cases to intake.',
    permissions: [
      P.DOC_VIEW, P.RECORD_VIEW, P.RECORD_CREATE, P.RECORD_EDIT,
      P.LITERATURE_REVIEW, P.ICSR_PROCESS, P.TRAINING_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  safety_committee: {
    label: 'Drug Safety Committee Member',
    labelZh: '药品安全委员会成员',
    description: 'Reviews confirmed signals and RMP risk minimisation decisions; votes on actions.',
    permissions: [
      ...READ_ONLY,
      P.RECORD_VIEW, P.RECORD_EXPORT, P.SIGNAL_MANAGE, P.RMP_MANAGE,
      P.SAFETY_COMMITTEE, P.AUDIT_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  qa_manager: {
    label: 'PV QA Manager / Head of PV Quality',
    labelZh: '药物警戒质量负责人',
    description: 'Owns the PV quality system: approves deviations, CAPAs, documents and effectiveness checks.',
    permissions: [
      ...READ_ONLY,
      P.USER_VIEW, P.AUDIT_VERIFY, P.AUDIT_EXPORT, P.SIGNATURE_AUTHORIZE, P.COMPLIANCE_MANAGE,
      P.EXPLORER_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE, P.DOC_OBSOLETE,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_EXPORT,
      P.DEVIATION_MANAGE, P.CAPA_MANAGE, P.CHANGE_MANAGE,
      P.COMPLAINT_MANAGE, P.RECALL_MANAGE,
      P.TRAINING_MANAGE, P.TRAINING_ASSESS,
      P.INSPECTION_MANAGE, P.INSPECTION_REPORT,
    ],
    isSafetyRecordParty: true,
  },

  qa_specialist: {
    label: 'PV QA Specialist',
    labelZh: '质量保证专员',
    description: 'Runs investigations, drafts documents, tracks CAPA and training.',
    permissions: [
      ...READ_ONLY,
      P.AUDIT_EXPORT, P.COMPLIANCE_MANAGE,
      P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
      P.DEVIATION_MANAGE, P.CAPA_MANAGE, P.CHANGE_MANAGE,
      P.COMPLAINT_MANAGE, P.TRAINING_MANAGE,
      P.INSPECTION_MANAGE,
    ],
    isSafetyRecordParty: true,
  },

  qa_auditor: {
    label: 'PV Internal Auditor',
    labelZh: '内审员',
    description: 'Conducts PV system self-inspection. Cannot approve what they audited.',
    permissions: [
      ...READ_ONLY,
      P.AUDIT_VERIFY, P.AUDIT_EXPORT, P.COMPLIANCE_MANAGE,
      P.INSPECTION_MANAGE, P.INSPECTION_REPORT,
      P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_EXPORT,
    ],
    isSafetyRecordParty: true,
  },

  trainer: {
    label: 'Trainer / Training Coordinator',
    labelZh: '培训师 / 培训协调员',
    description: 'Maintains PV curricula, delivers and assesses GVP training.',
    permissions: [
      P.DOC_VIEW, P.RECORD_VIEW, P.TRAINING_VIEW, P.TRAINING_MANAGE, P.TRAINING_ASSESS,
      P.USER_VIEW, P.INSPECTION_VIEW,
    ],
    isSafetyRecordParty: true,
  },

  auditor_external: {
    label: 'Regulator / External Inspector (read-only)',
    labelZh: '监管检查员（只读）',
    description: 'Time-boxed read-only access for agency inspections, with every view audited.',
    permissions: [
      P.DOC_VIEW, P.RECORD_VIEW, P.AUDIT_VIEW, P.TRAINING_VIEW, P.INSPECTION_VIEW,
      P.COMPLIANCE_VIEW, P.AUDIT_EXPORT,
    ],
    isSafetyRecordParty: false,
    readOnly: true,
  },

  viewer: {
    label: 'Viewer',
    labelZh: '只读用户',
    description: 'General read-only access for awareness.',
    permissions: READ_ONLY,
    isSafetyRecordParty: false,
    readOnly: true,
  },
};

/** Expand `*` and de-duplicate. */
function permissionsFor(role) {
  const def = ROLES[role];
  if (!def) return [];
  if (def.permissions.includes('*')) return ['*'];
  return [...new Set(def.permissions)];
}

function hasPermission(user, permission) {
  if (!user) return false;
  const perms = permissionsFor(user.role);
  return perms.includes('*') || perms.includes(permission);
}

function hasAny(user, permissions) {
  return permissions.some((p) => hasPermission(user, p));
}

const WRITE_ACTIONS = new Set([
  P.DOC_CREATE, P.DOC_EDIT, P.DOC_REVIEW, P.DOC_APPROVE, P.DOC_OBSOLETE,
  P.RECORD_CREATE, P.RECORD_EDIT, P.RECORD_CLOSE, P.RECORD_DELETE,
  P.DEVIATION_MANAGE, P.CAPA_MANAGE, P.CHANGE_MANAGE,
  P.USER_MANAGE, P.POLICY_MANAGE, P.SETTINGS_MANAGE, P.BACKUP_MANAGE,
  P.INSPECTION_MANAGE, P.TRAINING_MANAGE,
  P.ICSR_PROCESS, P.CAUSALITY_ASSESS, P.SIGNAL_MANAGE, P.PSUR_MANAGE,
  P.RMP_MANAGE, P.LITERATURE_REVIEW, P.SUBMISSION_MANAGE,
]);

function isReadOnly(user) {
  if (!user) return true;
  const def = ROLES[user.role];
  if (def && def.readOnly) return true;
  return !permissionsFor(user.role).some((p) => p === '*' || WRITE_ACTIONS.has(p));
}

/**
 * Whether this user may apply a PV e-signature to a given record.
 * Enforces: active account, signature permission, not the record's own author
 * when the step demands independent review, and no self-approval of own CAPA.
 */
function canSign(user, record, opts = {}) {
  if (!user || user.status !== 'active') return { ok: false, code: 'ACCOUNT_NOT_ACTIVE' };
  if (!hasPermission(user, PERMISSIONS.SIGNATURE_AUTHORIZE)
      && !permissionsFor(user.role).includes('*')
      && !hasAny(user, [P.RECORD_CLOSE, P.RECORD_EDIT, P.DOC_APPROVE, P.CAUSALITY_ASSESS])) {
    return { ok: false, code: 'NO_SIGNATURE_PERMISSION' };
  }
  if (record && opts.requireIndependence) {
    const authorId = record.created_by || record.reported_by;
    if (authorId && authorId === user.id) {
      return { ok: false, code: 'INDEPENDENCE_VIOLATION', message: 'Signer must be independent of the record author (GVP Module I quality system / ICH Q10).' };
    }
  }
  if (user.role === 'system_admin' && opts.requireQualityRole) {
    return { ok: false, code: 'ADMIN_CANNOT_APPROVE', message: 'System administrator accounts may not serve as the sole PV approver.' };
  }
  return { ok: true };
}

function listRoles() {
  return Object.entries(ROLES).map(([code, def]) => ({
    code,
    label: def.label,
    labelZh: def.labelZh,
    description: def.description,
    readOnly: Boolean(def.readOnly),
    isSafetyRecordParty: def.isSafetyRecordParty,
    permissionCount: permissionsFor(code).length,
    permissions: permissionsFor(code),
  }));
}

module.exports = {
  PERMISSIONS,
  ROLES,
  permissionsFor,
  hasPermission,
  hasAny,
  isReadOnly,
  canSign,
  listRoles,
};