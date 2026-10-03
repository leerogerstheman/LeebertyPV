'use strict';

/**
 * Code-enforced constraints catalogue.
 *
 * WHY THIS EXISTS
 * ---------------
 * A permission matrix that only shows "allowed / not allowed" is misleading when
 * the system also refuses actions for reasons that have nothing to do with the
 * permission set. A QA manager *has* `record.close` - yet the kernel will still
 * refuse to let them close a record they authored, because separation of duties
 * forbids it. If the matrix says "you may close records" and the button then
 * fails, the interface has lied to the user and undermined their trust in every
 * other claim the system makes.
 *
 * So every constraint that is enforced *in code*, independently of the role
 * configuration, is catalogued here and surfaced as a third state in the matrix:
 * ALLOWED / DENIED / CONDITIONAL (with the reason and the regulatory basis).
 *
 * This is a hand-maintained catalogue of real enforcement points, not an
 * aspiration list. Each entry names where in the kernel it is enforced, so it
 * can be checked against the source. If a constraint is removed from the code,
 * its entry must be removed here in the same change - otherwise this file
 * becomes exactly the kind of unverified claim the rest of the system avoids.
 */

const CONSTRAINTS = [
  // ------------------------------------------------- separation of duties --
  {
    id: 'author-cannot-close-own-record',
    category: 'separation_of_duties',
    appliesTo: ['record.close', 'record.edit', 'deviation.manage', 'capa.manage', 'change.manage', 'causality.assess'],
    kind: 'conditional',
    label: '记录作者不能关闭自己的记录',
    labelEn: 'The record author cannot close their own record',
    reason: '步骤声明了 independentOfAuthor 时，系统拒绝记录创建人或报告人本人签署。',
    reasonEn: 'Where a step declares independentOfAuthor, the kernel refuses the signature from the record creator or reporter.',
    basis: 'GVP Module I 质量体系 · ICH Q10 §3.2 · 21 CFR Part 11.10(g)',
    enforcedAt: 'src/domain/workflow.js completeStep() ',
    affectsRoles: ['pv_head', 'pv_officer', 'pv_medical', 'qa_manager', 'qa_specialist'],
  },
  {
    id: 'system-admin-not-sole-approver',
    category: 'separation_of_duties',
    appliesTo: ['record.close', 'doc.approve', 'causality.assess', 'submission.manage'],
    kind: 'conditional',
    label: '系统管理员不能作为安全性记录的唯一批准人',
    labelEn: 'A system administrator may not be the sole PV approver',
    reason: '系统管理员账号在质量审批场景下被明确拒绝，避免技术权限与质量决策权合一。',
    reasonEn: 'System administrator accounts are explicitly refused in quality-approval contexts, preventing technical and PV authority from converging.',
    basis: 'GVP Module I 质量体系 · 21 CFR Part 11.10(g)',
    enforcedAt: 'src/core/rbac.js canSign()',
    affectsRoles: ['system_admin'],
  },
  {
    id: 'step-role-gate',
    category: 'separation_of_duties',
    appliesTo: ['record.create', 'record.edit', 'record.close'],
    kind: 'conditional',
    label: '步骤只接受其定义声明的角色',
    labelEn: 'A step accepts only the roles its definition declares',
    reason: '每个流程步骤声明了责任角色，角色不匹配时返回 403 并记入审计追踪。',
    reasonEn: 'Each step declares its responsible roles; a mismatch returns 403 and is written to the audit trail.',
    basis: 'GVP Module I 质量体系 · ICH Q10 §3.2',
    enforcedAt: 'src/domain/workflow.js completeStep()',
    affectsRoles: [],
  },

  // ---------------------------------------------------------- signatures --
  {
    id: 'signature-two-components',
    category: 'signature',
    appliesTo: ['signature.authorize'],
    kind: 'conditional',
    label: '电子签名必须使用两个识别要素',
    labelEn: 'An electronic signature requires two identification components',
    reason: '签署时需重新输入密码，并提供动态口令或系统签发的一次性挑战码。签名人必须是本人账号。',
    reasonEn: 'Signing requires re-entering the password plus a TOTP code or a single-use server challenge, and the signer must be the account holder.',
    basis: '21 CFR Part 11.200(a)(1)(i)',
    enforcedAt: 'src/core/auth.js sign()',
    affectsRoles: [],
  },
  {
    id: 'signature-own-name-only',
    category: 'signature',
    appliesTo: ['signature.authorize'],
    kind: 'conditional',
    label: '不得代他人签署',
    labelEn: 'A signature cannot be applied on behalf of another person',
    reason: '签名时重新输入的识别码必须与当前登录账号一致，否则拒绝。',
    reasonEn: 'The identification code re-entered at signing must match the signed-in account, otherwise the signature is refused.',
    basis: '21 CFR Part 11.200(a)(1)(i) · 11.10(j)',
    enforcedAt: 'src/core/auth.js sign()',
    affectsRoles: [],
  },
  {
    id: 'step-signature-required',
    category: 'signature',
    appliesTo: ['record.close', 'doc.approve', 'causality.assess'],
    kind: 'conditional',
    label: '部分步骤必须先签名才能完成',
    labelEn: 'Some steps cannot be completed without first signing',
    reason: '定义中声明了 signatureMeaning 的步骤，未提供有效签名时返回 428 拒绝完成。',
    reasonEn: 'Steps declaring a signatureMeaning return 428 unless a valid signature is supplied.',
    basis: '21 CFR Part 11.200(a) · GVP Module I',
    enforcedAt: 'src/domain/workflow.js completeStep()',
    affectsRoles: [],
  },

  // -------------------------------------------------------- authorisation --
  {
    id: 'pv-change-reason-required',
    category: 'authorisation',
    appliesTo: ['record.edit', 'doc.edit', 'training.manage'],
    kind: 'conditional',
    label: '修改安全性记录必须填写理由',
    labelEn: 'Every safety record change requires a stated reason',
    reason: '未提供理由（或理由少于 3 个字符）的修改请求返回 400 拒绝。',
    reasonEn: 'A change without a reason, or with fewer than three characters, is rejected with 400.',
    basis: '21 CFR Part 11.10(e) · GVP Module I',
    enforcedAt: 'src/api/routes.js requireReason()',
    affectsRoles: [],
  },
  {
    id: 'closed-record-readonly',
    category: 'authorisation',
    appliesTo: ['record.edit', 'record.close'],
    kind: 'conditional',
    label: '已关闭记录不可修改',
    labelEn: 'A closed record cannot be modified',
    reason: '处于终态的记录拒绝字段修改，要求新建关联记录而非改动历史。',
    reasonEn: 'Records in a terminal state refuse field edits; a new linked record is required instead of altering history.',
    basis: 'ALCOA+ (Enduring / Original) · 21 CFR Part 11.10(e)',
    enforcedAt: 'src/domain/workflow.js updateInstance()',
    affectsRoles: [],
  },
  {
    id: 'password-policy',
    category: 'authorisation',
    appliesTo: ['user.manage'],
    kind: 'conditional',
    label: '密码受站点策略约束',
    labelEn: 'Passwords are subject to the site policy',
    reason: '长度、字符类别、历史密码、有效期与常见弱密码检查全部在服务端强制。',
    reasonEn: 'Length, character classes, password history, expiry and common-password checks are all enforced server-side.',
    basis: '21 CFR Part 11.300(b)',
    enforcedAt: 'src/core/auth.js validatePassword()',
    affectsRoles: [],
  },
  {
    id: 'account-uniqueness',
    category: 'authorisation',
    appliesTo: ['user.manage'],
    kind: 'conditional',
    label: '账号必须唯一对应到人',
    labelEn: 'Accounts must map one-to-one to people',
    reason: '重复账号名被拒绝；账号名不允许复用给他人。',
    reasonEn: 'Duplicate account names are rejected and accounts are not reassigned between people.',
    basis: '21 CFR Part 11.300(a) · EU GMP Annex 11 §12.1',
    enforcedAt: 'src/api/routes.js createUser()',
    affectsRoles: ['system_admin'],
  },
  {
    id: 'submission-requires-permission',
    category: 'authorisation',
    appliesTo: ['submission.manage', 'causality.assess'],
    kind: 'conditional',
    label: '递交与结案结论需持有对应权限的角色作出',
    labelEn: 'Submissions and closure conclusions are limited to roles holding the permission',
    reason: '仅持有 submission.manage 或 causality.assess 的角色可执行对应动作；递交与信号结论属药品安全决策，不向录入角色开放。',
    reasonEn: 'Only roles holding submission.manage or causality.assess may perform the corresponding actions; submissions and signal conclusions are drug-safety decisions, not open to entry roles.',
    basis: 'GVP Module I · ICH E2D',
    enforcedAt: 'src/core/rbac.js ROLES',
    affectsRoles: ['pv_regulatory', 'pv_head'],
  },

  // ------------------------------------------------------ documents & SLA --
  {
    id: 'document-approval-signature',
    category: 'document_control',
    appliesTo: ['doc.approve'],
    kind: 'conditional',
    label: '文件批准与生效需电子签名',
    labelEn: 'Document approval and release require an electronic signature',
    reason: '状态流转至 approved 或 effective 时无签名返回 428；生效时上一版本自动转为「已被替代」。',
    reasonEn: 'Transitions to approved or effective return 428 without a signature; on release the prior version becomes superseded automatically.',
    basis: 'EU GMP Chapter 4 · 21 CFR Part 11.200(a)',
    enforcedAt: 'src/domain/documents.js transitionVersion()',
    affectsRoles: ['qa_manager'],
  },
  {
    id: 'document-review-cycle',
    category: 'document_control',
    appliesTo: ['doc.edit', 'doc.approve'],
    kind: 'warning',
    label: '生效文件受定期审核周期约束',
    labelEn: 'Effective documents are bound by a periodic review cycle',
    reason: '超过 next_review_date 的文件会被后台进程标记并生成待办，检查中属常见缺陷。',
    reasonEn: 'Documents past their next_review_date are flagged by the background monitor and raise a task; a common inspection finding.',
    basis: 'EU GMP Chapter 4 · 21 CFR 211.180(e)',
    enforcedAt: 'src/daemon/monitor.js scanDocuments()',
    affectsRoles: [],
  },

  // ------------------------------------------------------------ lifecycle --
  {
    id: 'training-required-for-pv-task',
    category: 'qualification',
    appliesTo: ['record.create', 'record.edit', 'icsr.process', 'causality.assess'],
    kind: 'conditional',
    label: 'PV 操作要求培训资质在有效期内',
    labelEn: 'PV work requires current training qualification',
    reason: '缺少必修 PV 关键课程或课程过期时，资质判定为不符合并给出受阻原因。',
    reasonEn: 'A missing or expired PV-critical curriculum renders the person not qualified, with the blocking reasons stated.',
    basis: 'GVP Module I（培训与资质）· 21 CFR Part 11.10(i)',
    enforcedAt: 'src/domain/training.js canPerformGxPTask()',
    affectsRoles: ['pv_data_entry', 'pv_officer', 'literature_reviewer'],
  },
  {
    id: 'training-completion-signature',
    category: 'qualification',
    appliesTo: ['training.assess'],
    kind: 'conditional',
    label: 'PV 关键培训完成需签名',
    labelEn: 'Completing PV-critical training requires a signature',
    reason: '关键课程的完成记录无签名返回 428；成绩低于及格线返回 409 并要求记为未通过。',
    reasonEn: 'Completing a critical curriculum without a signature returns 428; a score below the pass mark returns 409 and must be recorded as failed.',
    basis: 'GVP Module I · 21 CFR Part 11.10(i)',
    enforcedAt: 'src/domain/training.js recordCompletion()',
    affectsRoles: ['trainer'],
  },
  {
    id: 'inspection-gap-requires-evidence',
    category: 'inspection',
    appliesTo: ['inspection.manage'],
    kind: 'conditional',
    label: '判定缺陷必须提供客观证据',
    labelEn: 'Recording a gap requires objective evidence',
    reason: '判定为「部分符合」或「存在缺陷」但客观证据少于 10 个字符时返回 400。',
    reasonEn: 'A "partial" or "gap" assessment with fewer than ten characters of objective evidence is rejected with 400.',
    basis: 'GVP Module I · ICH Q10',
    enforcedAt: 'src/domain/inspections.js assessItem()',
    affectsRoles: ['qa_auditor', 'qa_manager'],
  },
  {
    id: 'inspection-critical-blocks-closure',
    category: 'inspection',
    appliesTo: ['inspection.manage'],
    kind: 'conditional',
    label: '存在未关闭严重缺陷时不得直接关闭自查',
    labelEn: 'A self-inspection cannot be closed with open critical findings',
    reason: '未评估项或未关闭严重缺陷存在时返回 409，需显式确认后方可强制关闭并留痕。',
    reasonEn: 'Unassessed items or open critical findings return 409; closure requires explicit confirmation and is recorded as a close with open items.',
    basis: 'GVP Module I · ICH Q10',
    enforcedAt: 'src/domain/inspections.js closeInspection()',
    affectsRoles: ['qa_manager', 'qa_auditor'],
  },
  {
    id: 'audit-chain-freeze',
    category: 'data_integrity',
    appliesTo: ['settings.manage', 'backup.manage'],
    kind: 'conditional',
    label: '审计链断裂时系统拒绝启动写入',
    labelEn: 'The system refuses to run when the audit chain is broken',
    reason: '完整性校验失败时启动退出并给出事件处置指引；后台进程同样拒绝在断链账本上运行。',
    reasonEn: 'A failed integrity check aborts start-up with incident guidance, and the monitor likewise refuses to run against a broken ledger.',
    basis: '21 CFR Part 11.10(e) · EU GMP Annex 11 §9',
    enforcedAt: 'src/server.js · src/daemon/monitor.js',
    affectsRoles: ['system_admin'],
  },
  {
    id: 'audit-trail-append-only',
    category: 'data_integrity',
    appliesTo: ['audit.view', 'audit.verify', 'settings.manage'],
    kind: 'conditional',
    label: '审计追踪不可修改或删除',
    labelEn: 'The audit trail cannot be modified or deleted',
    reason: 'SQLite 触发器阻止 UPDATE 与 DELETE；哈希链校验可定位到具体断点。',
    reasonEn: 'SQLite triggers block UPDATE and DELETE, and hash-chain verification locates the exact break point.',
    basis: '21 CFR Part 11.10(e) · EU GMP Annex 11 §9',
    enforcedAt: 'src/core/db.js SCHEMA_SQL · src/core/audit.js verifyChain()',
    affectsRoles: [],
  },
  {
    id: 'session-and-lockout',
    category: 'authorisation',
    appliesTo: [],
    kind: 'warning',
    label: '会话超时与失败锁定在服务端强制',
    labelEn: 'Session timeout and lockout are enforced server-side',
    reason: '空闲超时、会话绝对上限与连续失败锁定对全部角色一致生效，并在登出时说明原因。',
    reasonEn: 'Idle timeout, absolute session limit and failed-attempt lockout apply uniformly, and the sign-out reason is explained.',
    basis: 'EU GMP Annex 11 §12.3 · 21 CFR Part 11.10(d)',
    enforcedAt: 'src/core/auth.js resolveSession()',
    affectsRoles: [],
  },
];

/** Constraints that affect a given permission code. */
function forPermission(permission) {
  if (!permission) return [];
  return CONSTRAINTS.filter((c) => (c.appliesTo || []).includes(permission));
}

/** Constraints that affect a given role, plus the ones that apply to everyone. */
function forRole(role) {
  return CONSTRAINTS.filter((c) => !c.affectsRoles.length || c.affectsRoles.includes(role));
}

function byCategory() {
  const out = {};
  for (const c of CONSTRAINTS) {
    if (!out[c.category]) out[c.category] = [];
    out[c.category].push(c);
  }
  return out;
}

module.exports = { CONSTRAINTS, forPermission, forRole, byCategory };
