'use strict';

/**
 * Domain workflow explorer.
 *
 * Turns a process definition into the thing a person actually needs to see:
 *   - the steps in order, and who hands what to whom;
 *   - a participant card per responsible role, stating its duties and the
 *     signature meanings it carries;
 *   - a three-state permission matrix per participant, so a demo never claims a
 *     capability the kernel would then refuse.
 *
 * WHY THREE STATES
 * ----------------
 * Permissions alone do not determine what a person may do. A QA manager holds
 * `record.close`, and the kernel still refuses to let them close a record they
 * authored. Presenting only allowed/denied would produce a screen that
 * contradicts the running system the first time somebody tries it. So each
 * permission carries ALLOWED, DENIED or CONDITIONAL with the reason and the
 * regulatory basis, sourced from the constraints catalogue.
 */

const db = require('../core/db');
const rbac = require('../core/rbac');
const workflow = require('./workflow');
const constraints = require('./constraints');
const visibility = require('./visibility');

const P = rbac.PERMISSIONS;

function nowIso() { return new Date().toISOString(); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * What a role is for, in one line, for the participant card.
 * Written as responsibilities rather than titles: "owns containment and CAPA
 * implementation" tells a viewer far more than "Production Manager".
 */
const ROLE_DUTY = {
  system_admin: { zh: '维护账号与系统配置，不参与 PV 决策', en: 'Maintains accounts and configuration, takes no PV decisions' },
  pv_head: { zh: '对药物警戒体系负最终责任，批准结案、信号处置与风险控制措施', en: 'Ultimately accountable for the PV system, approves closures, signal actions and RMMs' },
  pv_officer: { zh: '处理个例报告、掌握报告时限、随访并检测信号', en: 'Processes ICSRs, owns reporting timelines, follows up, detects signals' },
  pv_data_entry: { zh: '登记个案、核对四要素、MedDRA 编码', en: 'Registers cases, checks the four elements, codes events in MedDRA' },
  pv_medical: { zh: '因果关系评价、医学审核与病例叙述', en: 'Causality assessment, medical review and case narratives' },
  pv_writer: { zh: '按数据锁定点汇编 PSUR / PBRER 与获益-风险评估', en: 'Compiles PSUR / PBRER against data lock points, drafts benefit-risk chapters' },
  pv_regulatory: { zh: '按法定时限向监测机构递交报告并跟踪回执', en: 'Files expedited and periodic reports within legal timelines and tracks acknowledgements' },
  literature_reviewer: { zh: '按检索计划筛查医学文献并筛出可上报个例', en: 'Screens medical literature on schedule, triages reportable cases' },
  safety_committee: { zh: '审议确认信号并决定风险最小化措施', en: 'Reviews confirmed signals and decides risk minimisation measures' },
  qa_manager: { zh: '审批偏差、CAPA 与体系文件并评估整改有效性', en: 'Approves deviations, CAPAs and system documents; judges effectiveness' },
  qa_specialist: { zh: '执行调查、起草文件、跟踪整改与培训', en: 'Runs investigations, drafts documents, tracks actions and training' },
  qa_auditor: { zh: '执行药物警戒体系自查，缺陷升级为 CAPA', en: 'Runs PV system self-inspections, escalates findings to CAPA' },
  trainer: { zh: '维护 PV 课程、实施培训并评估有效性', en: 'Maintains PV curricula, delivers training and assesses effectiveness' },
  auditor_external: { zh: '限时只读访问，查看行为本身留痕', en: 'Time-boxed read-only access, with every view itself audited' },
  viewer: { zh: '只读了解', en: 'Read-only awareness' },
};

/**
 * 设计理念 —— 每一条都在直白回答"这个工作台为什么这样做"。
 * 与 PE-Workbench 相同的精神：理念不是悬浮提示，而是领域卡、领域页、
 * 工作流页反复出现的一行字，可以被截图、打印、贴到办公室墙上。
 * Each domain carries a philosophy line and the workflow pages echo it.
 */
const PHILOSOPHY = {
  ICSR: '时限不是目标，而是底线。报告时钟从你首次获知四要素的那一天开始计算，而不是从病例"做完"那天开始。',
  SIGNAL: '信号管理是获益-风险评估的引擎：个例报告是原料，比例失衡是线索，医学判断才是结论。',
  PSUR: '定期报告不是年度总结，而是对累积证据的获益-风险评估——数据锁定点决定它覆盖什么、何时提交。',
  RMP: '风险管理的价值不在写出一份计划，而在把风险最小化措施做进日常工作并验证它们真的有用。',
  LIT: '文献里的一句话可能就是一个待上报的个例。检索不能停，筛查必须有记录，转交必须有时限。',
  AEFI: '疫苗安全的第一课是分类：一般反应与异常反应的区别，决定了报告时限与公众沟通的方式。',
  COMPLAINT: '投诉里可能藏着未报告的不良反应。先判断是否涉及安全性，再处理质量本身。',
  GVP: '质量体系不是文档堆，而是把偏差、CAPA、变更、内审、培训变成可执行、可追溯、可审计的日常。',
};

const PHILOSOPHY_EN = {
  ICSR: 'Timelines are a floor, not a target. The reporting clock starts the day you first learn any of the four elements - not the day the case is "finished".',
  SIGNAL: 'Signal management is the engine of benefit-risk: case reports are the raw material, disproportionality is the clue, medical judgement is the conclusion.',
  PSUR: 'A periodic report is not an annual summary; it is a benefit-risk assessment of the accumulated evidence. The data lock point decides its scope and its deadline.',
  RMP: 'The value of risk management is not writing a plan; it is working risk minimisation measures into daily practice and verifying they actually work.',
  LIT: 'A sentence in a journal may be a reportable case. Search cannot stop, triage must be recorded, handover must have a timeline.',
  AEFI: 'The first lesson of vaccine safety is classification: the difference between a common reaction and an adverse event decides the timeline and how you communicate.',
  COMPLAINT: 'A complaint may hide an unreported adverse reaction. Decide the safety question first, then handle the quality issue itself.',
  GVP: 'A quality system is not a pile of documents; it turns deviations, CAPAs, change, audit and training into an executable, traceable, auditable routine.',
};

/**
 * Where a role sits in relation to a step, for the flow diagram.
 * Derived from the step's position rather than hard-coded per process, so a new
 * process definition gets a sensible diagram without any extra configuration.
 */
function participationKind(meta) {
  if (meta.signatureMeaning && meta.index > 0) return 'approve';
  if (meta.index === 0) return 'initiate';
  if (meta.signatureMeaning) return 'approve';
  return 'execute';
}

/**
 * Build the explorer payload for one process type.
 *
 * @param {{includeAllRoles?: boolean, anonymous?: boolean}} options
 *   `anonymous` withholds instance state - how many records exist, whether a role
 *   has an account. An unauthenticated visitor gets the reference model (steps,
 *   duties, permissions, constraints) and learns nothing about this
 *   organisation's records or its cast.
 */
function explore(processCode, options = {}) {
  const anonymous = Boolean(options.anonymous);
  const def = workflow.getDefinition(processCode);
  if (!def) {
    const err = new Error(`UNKNOWN_PROCESS_TYPE: ${processCode}`);
    err.status = 404;
    err.code = 'UNKNOWN_PROCESS_TYPE';
    throw err;
  }

  // ---- steps, annotated with their position and the roles that own them ----
  const steps = (def.steps || []).map((step, index) => {
    const roles = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
    return {
      index,
      seq: index + 1,
      code: step.code,
      name: step.name,
      nameEn: step.nameEn || null,
      type: step.type || 'task',
      roles,
      signatureMeaning: step.signatureMeaning || null,
      independentOfAuthor: Boolean(step.independentOfAuthor),
      optional: Boolean(step.optional),
      onComplete: step.onComplete || null,
      guidance: step.guidance || null,
      requiresFields: step.requiresFields || [],
      // The form schema is exposed so native clients (the WinForms desktop app)
      // can render the step's input form without a browser.
      form: (step.form || []).map((f) => ({
        key: f.key, label: f.label, labelEn: f.labelEn || null,
        type: f.type || 'text', required: Boolean(f.required),
        options: f.options || [], help: f.help || null,
      })),
      fieldCount: (step.form || []).length,
      participationKind: participationKind({ index, signatureMeaning: step.signatureMeaning }),
    };
  });

  // ---- the cast: every role named by any step ------------------------------
  const roleOrder = [];
  const roleAppearances = new Map();
  for (const step of steps) {
    for (const role of step.roles) {
      if (!roleAppearances.has(role)) {
        roleAppearances.set(role, []);
        roleOrder.push(role);
      }
      roleAppearances.get(role).push(step);
    }
  }

  const existingUsers = db.all(
    "SELECT id, username, full_name, full_name_en, role, status, job_title, department FROM users WHERE status = 'active'"
  );
  const userByRole = new Map();
  for (const u of existingUsers) {
    if (!userByRole.has(u.role)) userByRole.set(u.role, []);
    userByRole.get(u.role).push(u);
  }

  const participants = roleOrder.map((role, order) => {
    const roleDef = rbac.ROLES[role] || { label: role, labelZh: role, description: '' };
    const mySteps = roleAppearances.get(role) || [];
    const signedSteps = mySteps.filter((s) => s.signatureMeaning && s.participationKind === 'approve');
    const users = userByRole.get(role) || [];
    const permissions = rbac.permissionsFor(role);

    // Open work assigned to this role, so a card can show real load rather than
    // an abstract description.
    let pendingItems = 0;
    try {
      const placeholders = mySteps.map(() => '?').join(',');
      pendingItems = mySteps.length
        ? db.get(
          `SELECT COUNT(*) AS n FROM workflow_steps s
           JOIN workflow_instances i ON i.id = s.instance_id
           WHERE s.step_code IN (${placeholders}) AND s.status != 'completed'
             AND i.status NOT IN ('closed','cancelled','rejected')`,
          mySteps.map((s) => s.code)
        ).n
        : 0;
    } catch { pendingItems = 0; }

    return {
      order,
      role,
      roleLabel: roleDef.label,
      roleLabelZh: roleDef.labelZh,
      readOnly: Boolean(roleDef.readOnly),
      duty: ROLE_DUTY[role] ? ROLE_DUTY[role].zh : (roleDef.description || ''),
      dutyEn: ROLE_DUTY[role] ? ROLE_DUTY[role].en : (roleDef.description || ''),
      steps: mySteps.map((s) => ({
        seq: s.seq, code: s.code, name: s.name, nameEn: s.nameEn,
        participationKind: s.participationKind,
        signatureMeaning: s.signatureMeaning,
        independentOfAuthor: s.independentOfAuthor,
      })),
      firstStep: mySteps.length ? mySteps[0].seq : null,
      stepCount: mySteps.length,
      approvalCount: signedSteps.length,
      signatureMeanings: [...new Set(mySteps.map((s) => s.signatureMeaning).filter(Boolean))],
      permissionCount: permissions.includes('*') ? 'all' : permissions.length,
      permissionKeys: permissions,
      // Instance state is withheld from an anonymous caller: how much work is
      // waiting, who holds the role, and whether an account exists at all are
      // facts about this organisation, not about the process model.
      pendingItems: anonymous ? 0 : pendingItems,
      accountCount: anonymous ? 0 : users.length,
      accounts: anonymous ? [] : users.map((u) => ({
        id: u.id, username: u.username, fullName: u.full_name, jobTitle: u.job_title, department: u.department,
      })),
      // The card is clickable only when there is an account to sign in as.
      loginable: !anonymous && users.length > 0,
    };
  });

  return {
    generatedAt: nowIso(),
    process: {
      code: def.code,
      name: def.name,
      nameEn: def.nameEn || null,
      category: def.category,
      gxpAreas: def.gxpAreas || [],
      description: def.description || '',
      descriptionEn: def.descriptionEn || '',
      regulationRefs: def.regulationRefs || [],
      slaDays: def.slaDays || null,
      states: def.states || [],
      initialState: def.initialState,
      terminalStates: def.terminalStates || [],
      requiresRootCause: Boolean(def.requiresRootCause),
      requiresEffectivenessCheck: Boolean(def.requiresEffectivenessCheck),
      requiresQaApproval: def.requiresQaApproval !== false,
      criticalityLevels: def.criticalityLevels || [],
      fields: (def.fields || []).map((f) => ({
        key: f.key, label: f.label, labelEn: f.labelEn || null,
        type: f.type || 'text', required: Boolean(f.required),
        options: f.options || [], help: f.help || null,
      })),
      fieldCount: (def.fields || []).length,
    },
    steps,
    participants,
    // Who hands work to whom, derived from consecutive step ownership.
    handoffs: buildHandoffs(steps),
    summary: {
      stepCount: steps.length,
      participantCount: participants.length,
      signedStepCount: steps.filter((s) => s.signatureMeaning).length,
      independentStepCount: steps.filter((s) => s.independentOfAuthor).length,
      optionalStepCount: steps.filter((s) => s.optional).length,
    },
  };
}

/**
 * Derive the hand-off chain: for each consecutive pair of steps, which role
 * passes work to which. A step owned by the same role as its predecessor is a
 * continuation, not a hand-off, and is omitted so the diagram shows only real
 * transfers of responsibility.
 */
function buildHandoffs(steps) {
  const out = [];
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1];
    const curr = steps[i];
    const from = prev.roles.filter((r) => !curr.roles.includes(r));
    const to = curr.roles.filter((r) => !prev.roles.includes(r));
    out.push({
      fromStep: prev.code,
      fromStepName: prev.name,
      toStep: curr.code,
      toStepName: curr.name,
      fromRoles: from.length ? from : prev.roles,
      toRoles: to.length ? to : curr.roles,
      sameRole: from.length === 0 && to.length === 0,
      requiresSignature: Boolean(curr.signatureMeaning),
      signatureMeaning: curr.signatureMeaning || null,
    });
  }
  return out;
}

// ------------------------------------------------------- permission matrix --

/** Permission groups, so the matrix reads as a structure rather than a wall. */
const PERMISSION_GROUPS = [
  { key: 'pv', labelZh: '药物警戒业务', labelEn: 'Pharmacovigilance operations', match: (p) => /^(icsr|causality|signal|psur|rmp|literature|submission|safety)\./.test(p) },
  { key: 'records', labelZh: '安全性记录', labelEn: 'Safety records', match: (p) => p.startsWith('record.') },
  { key: 'quality', labelZh: 'PV 质量体系', labelEn: 'PV quality system', match: (p) => /^(deviation|capa|change|recall|complaint)\./.test(p) },
  { key: 'documents', labelZh: '文件控制', labelEn: 'Document control', match: (p) => p.startsWith('doc.') },
  { key: 'inspection', labelZh: '自查与审计', labelEn: 'Inspection and audit', match: (p) => p.startsWith('inspection.') || p.startsWith('audit.') || p === 'compliance.view' || p === 'compliance.manage' },
  { key: 'training', labelZh: '培训资质', labelEn: 'Training', match: (p) => p.startsWith('training.') },
  { key: 'signature', labelZh: '签名与权限', labelEn: 'Signature and access', match: (p) => p.startsWith('signature.') || /^(user|role|policy|settings|backup)\./.test(p) },
];

const PERMISSION_LABEL = {
  'user.view': ['查看用户列表', 'View user list'],
  'user.manage': ['创建与修改用户', 'Create and modify users'],
  'explorer.manage': ['管理工作流参与者', 'Manage workflow participants'],
  'role.manage': ['管理角色', 'Manage roles'],
  'policy.manage': ['修改安全策略', 'Change security policy'],
  'settings.manage': ['修改系统设置', 'Change system settings'],
  'backup.manage': ['执行备份与恢复', 'Perform backup and restore'],
  'audit.view': ['查阅审计追踪', 'View the audit trail'],
  'audit.verify': ['校验审计链完整性', 'Verify audit chain integrity'],
  'audit.export': ['导出审计追踪', 'Export the audit trail'],
  'signature.authorize': ['应用电子签名', 'Apply an electronic signature'],
  'compliance.view': ['查看合规态势', 'View compliance posture'],
  'compliance.manage': ['执行自查与缺陷处理', 'Run inspections and handle findings'],
  'doc.view': ['查阅受控文件', 'View controlled documents'],
  'doc.create': ['新建受控文件', 'Create controlled documents'],
  'doc.edit': ['修订受控文件', 'Revise controlled documents'],
  'doc.review': ['审核文件版本', 'Review document versions'],
  'doc.approve': ['批准文件生效', 'Approve document release'],
  'doc.obsolete': ['作废文件', 'Obsolete documents'],
  'record.view': ['查阅安全性记录', 'View safety records'],
  'record.create': ['新建安全性记录', 'Create safety records'],
  'record.edit': ['修改安全性记录字段', 'Edit safety record fields'],
  'record.close': ['关闭安全性记录', 'Close safety records'],
  'record.delete': ['删除安全性记录', 'Delete safety records'],
  'record.export': ['导出安全性记录', 'Export safety records'],
  'deviation.manage': ['处理 PV 质量偏差', 'Handle PV quality deviations'],
  'capa.manage': ['处理 CAPA', 'Handle CAPAs'],
  'change.manage': ['处理变更控制', 'Handle change controls'],
  'recall.manage': ['处理召回与退货', 'Handle recalls and returns'],
  'complaint.manage': ['处理药品投诉', 'Handle product complaints'],
  'icsr.process': ['处理个例安全性报告（受理/分类/录入/随访）', 'Process ICSRs (intake/triage/entry/follow-up)'],
  'causality.assess': ['作因果关系评价与医学审核', 'Perform causality assessment and medical review'],
  'signal.manage': ['检测、验证与评估信号', 'Detect, validate and assess signals'],
  'psur.manage': ['汇编与审批定期安全性报告', 'Compile and approve periodic safety reports'],
  'rmp.manage': ['制定与维护风险管理计划及 RMM', 'Develop and maintain the RMP and RMMs'],
  'literature.review': ['执行文献检索与个案筛查', 'Run literature surveillance and case triage'],
  'submission.manage': ['向监管机构递交报告并跟踪回执', 'Submit reports to regulators and track acknowledgements'],
  'safety.committee': ['参加药品安全委员会审议', 'Take part in drug safety committee review'],
  'training.view': ['查看培训记录', 'View training records'],
  'training.manage': ['分配与管理培训', 'Assign and manage training'],
  'training.assess': ['登记培训完成与考核', 'Record training completion and assessment'],
  'inspection.view': ['查看自查活动', 'View inspections'],
  'inspection.manage': ['执行自查与评估检查项', 'Run inspections and assess findings'],
  'inspection.report': ['出具自查报告', 'Issue inspection reports'],
  'equipment.view': ['查看设备台账', 'View the equipment register'],
  'equipment.manage': ['登记校准与维护', 'Record calibration and maintenance'],
};

function labelFor(permission) {
  const l = PERMISSION_LABEL[permission];
  return l ? { zh: l[0], en: l[1] } : { zh: permission, en: permission };
}

/**
 * Build the permission matrix for a set of roles.
 *
 * Each cell is one of:
 *   allowed     - the role holds the permission and nothing restricts it
 *   denied      - the role does not hold the permission
 *   conditional - the role holds it, but a code-enforced constraint also applies
 */
function permissionMatrix(roleCodes, options = {}) {
  const roles = roleCodes.map((code) => {
    const def = rbac.ROLES[code] || { label: code, labelZh: code, readOnly: false, permissions: [] };
    const perms = rbac.permissionsFor(code);
    return {
      code,
      label: def.label,
      labelZh: def.labelZh,
      readOnly: Boolean(def.readOnly),
      isWildcard: perms.includes('*'),
      permissions: perms,
    };
  });

  const allPermissions = Object.values(P);
  const groups = PERMISSION_GROUPS.map((group) => {
    const perms = allPermissions.filter(group.match).sort();
    return {
      key: group.key,
      labelZh: group.labelZh,
      labelEn: group.labelEn,
      rows: perms.map((permission) => {
        const label = labelFor(permission);
        const applicable = constraints.forPermission(permission);
        const cells = roles.map((role) => {
          const holds = role.isWildcard || role.permissions.includes(permission);
          // Constraints differ per role: a constraint listing affectsRoles is
          // role-specific (e.g. the administrator rule affects only admins).
          const roleConstraints = applicable.filter(
            (c) => !c.affectsRoles.length || c.affectsRoles.includes(role.code)
          );
          let state;
          if (!holds) state = 'denied';
          else if (roleConstraints.length) state = 'conditional';
          else state = 'allowed';
          // Cells carry constraint IDs, not copies. The same constraint applies
          // to many permission/role pairs, so inlining the full object per cell
          // made the payload about eighty percent duplicated text. The definitions
          // live once in `constraintIndex` alongside the matrix.
          return {
            role: role.code,
            state,
            constraintIds: state === 'conditional' ? roleConstraints.map((c) => c.id) : [],
          };
        });
        return {
          permission,
          label: label.zh,
          labelEn: label.en,
          constraintCount: applicable.length,
          cells,
        };
      }),
    };
  }).filter((g) => g.rows.length);

  const totals = {};
  for (const role of roles) {
    let allowed = 0;
    let conditional = 0;
    for (const group of groups) {
      for (const row of group.rows) {
        const cell = row.cells.find((c) => c.role === role.code);
        if (!cell) continue;
        if (cell.state === 'allowed') allowed += 1;
        else if (cell.state === 'conditional') conditional += 1;
      }
    }
    totals[role.code] = { allowed, conditional, denied: allPermissions.length - allowed - conditional };
  }

  const constraintIndex = {};
  for (const c of constraints.CONSTRAINTS) {
    constraintIndex[c.id] = {
      id: c.id, category: c.category, kind: c.kind,
      label: c.label, labelEn: c.labelEn,
      reason: c.reason, reasonEn: c.reasonEn,
      basis: c.basis, enforcedAt: c.enforcedAt,
      appliesTo: c.appliesTo, affectsRoles: c.affectsRoles,
    };
  }

  return {
    roles,
    groups,
    totals,
    permissionTotal: allPermissions.length,
    // One definition per constraint, referenced by id from the cells above.
    constraintIndex,
    constraints: Object.values(constraintIndex),
    constraintCount: constraints.CONSTRAINTS.length,
  };
}

/**
 * Everything the participant explorer needs in one call: the flow, the cast, the
 * matrix, and the login credentials when the instance is a demo.
 */
function explorerPayload(processCode, options = {}) {
  const data = explore(processCode, options);
  // The matrix covers every role in the cast plus, when editable, every role the
  // instance could add - so the editor can show the effect of a change before it
  // is made.
  const castRoles = data.participants.map((p) => p.role);
  const allRoles = Object.keys(rbac.ROLES);
  const matrixRoles = options.includeAllRoles === false ? castRoles : [...new Set([...castRoles, ...allRoles])];
  const matrix = permissionMatrix(matrixRoles);

  // Ranked permission rows per role, so the flow diagram can print each person's
  // rights beneath their own card instead of pointing at a separate matrix. The
  // order is deliberate: what the role may do, then what it may do only under a
  // constraint, then what it may not - three states, most consequential first.
  const permissionsByRole = {};
  for (const role of castRoles) {
    const rows = [];
    for (const group of matrix.groups) {
      for (const row of group.rows) {
        const cell = row.cells.find((c) => c.role === role);
        if (!cell || cell.state === 'denied') continue;
        rows.push({
          permission: row.permission,
          label: row.label,
          labelEn: row.labelEn,
          group: group.labelZh,
          groupEn: group.labelEn,
          state: cell.state,
          constraintIds: cell.constraintIds || [],
        });
      }
    }
    permissionsByRole[role] = {
      allowed: rows.filter((r) => r.state === 'allowed'),
      conditional: rows.filter((r) => r.state === 'conditional'),
      total: rows.length,
    };
  }

  return {
    ...data,
    matrix,
    castRoles,
    permissionsByRole,
    // The demonstration credential is instance configuration. A caller with no
    // session gets the reference model and nothing else - it is published on the
    // identity panel via /api/login-choices, which is the screen that needs it.
    demoLogin: options.anonymous ? null : demoLoginInfo(),
  };
}

/** The demonstration credential, with its compliance warning attached. */
function demoLoginInfo() {
  try {
    const accounts = require('./accounts');
    if (!accounts.builtinAccountsEnabled()) return null;
    return {
      enabled: true,
      password: accounts.BUILTIN_PASSWORD,
      // Stated plainly in the payload so the interface can warn the viewer
      // rather than quietly normalising a non-compliant pattern.
      warning: '演示实例：全部内置角色共用同一密码。'
        + '21 CFR Part 11.300(a) 要求账号唯一、不得共用，真实部署必须为每人设置独立凭证。',
      warningEn: 'Demonstration instance: every built-in role shares one password. '
        + '21 CFR Part 11.300(a) requires unique accounts and prohibits sharing; a real deployment must issue individual credentials.',
    };
  } catch { return null; }
}

// ================================================== per-domain exploration ==

/**
 * Which of this area's participants the current viewer may see.
 *
 * Computed server-side and shipped with the payload rather than re-implemented in
 * the browser. Two reasons, and the second is the important one:
 *
 *   1. The rule lives in one place. A frontend copy would drift, and the drift
 *      would be invisible until somebody's screen disagreed with the API.
 *   2. The interface must be able to EXPLAIN a refusal. A greyed card that says
 *      nothing teaches the reader nothing and invites them to look for a way
 *      around it; the same card with the reason attached is an instruction.
 *
 * The role name, duties and permissions are never withheld - a process diagram
 * that hides its own roles is useless. What the decision governs is the person
 * behind the role.
 *
 * @param {object|null} viewer  the signed-in user row, or null
 * @param {string} areaCode
 * @param {Array} participants  the domain's participant list
 */
function visibilityFor(viewer, areaCode, participants) {
  let homeAreas = [];
  let scope = null;

  if (viewer) {
    try {
      homeAreas = Object.keys((require('./accounts').homeAreasByRole()[viewer.role]) || {});
    } catch { homeAreas = []; }
    if (!homeAreas.length) {
      // Fall back to the account's declared scope so a viewer whose role is not in
      // the configuration still gets a sensible answer rather than a blanket no.
      try { homeAreas = JSON.parse(viewer.gxp_areas || '[]'); } catch { homeAreas = []; }
    }
    scope = visibility.scopeFor(viewer.role, homeAreas);
  }

  const decisions = {};
  for (const p of participants || []) {
    if (!viewer) {
      // No session: the reference material is public, the people are not. The
      // domain screen already says "choose an identity to see who holds this".
      decisions[p.role] = {
        allowed: false,
        scope: 'public',
        reason: '尚未选择身份，只能查看岗位名称、职责与权限',
        reasonEn: 'No identity chosen yet; only the role name, duties and permissions are visible',
      };
      continue;
    }
    if (viewer.role === p.role) {
      decisions[p.role] = {
        allowed: true,
        scope: 'self',
        reason: '这是你自己承担的岗位',
        reasonEn: 'This is your own role',
      };
      continue;
    }
    const decision = visibility.canSeePerson(
      { role: viewer.role, homeAreas },
      { role: p.role, homeAreas: homeAreasOf(p.role), area: areaCode }
    );
    decisions[p.role] = decision;
  }

  return {
    viewerRole: viewer ? viewer.role : null,
    viewerHomeAreas: homeAreas,
    area: areaCode,
    scope: scope ? scope.scope : 'public',
    scopeReason: scope ? scope.reason : '尚未选择身份',
    scopeReasonEn: scope ? scope.reasonEn : 'No identity chosen yet',
    decisions,
  };
}

/** The areas a role works in, or an empty list when the config is not loaded. */
function homeAreasOf(role) {
  try {
    return Object.keys((require('./accounts').homeAreasByRole()[role]) || {});
  } catch { return []; }
}

/**
 * A GxP area as a first-class destination, not just a group heading.
 *
 * This is where somebody who works in GLP actually starts. It shows that area's
 * own processes, everyone involved across all of them, and the permissions those
 * people hold. Before this existed the only entry points were a flat list of all
 * sixteen processes and the sidebar, so "the GLP interface" was not a place.
 *
 * @param {string} areaCode
 * @param {{anonymous?: boolean}} options  withholding instance state for a caller
 *   who has not signed in, so the domain screen renders before identity selection
 *   without disclosing record counts or account holders.
 */
function exploreDomain(areaCode, options = {}) {
  const anonymous = Boolean(options.anonymous);
  const viewer = options.viewer || null;
  const area = db.get(
    'SELECT code, name, name_en, full_name, full_name_en, description, colour FROM gxp_areas WHERE code = ?',
    [areaCode]
  ) || { code: areaCode, name: areaCode, full_name: areaCode, description: '', colour: null };

  const allProcesses = db.all(
    'SELECT code, name, name_en, category, gxp_areas, description, description_en, definitions_json ' +
    'FROM process_types WHERE active = 1 ORDER BY code'
  ).filter((r) => parseJson(r.gxp_areas, []).includes(areaCode));

  const processes = allProcesses.map((row) => {
    const def = JSON.parse(row.definitions_json);
    const steps = def.steps || [];
    const roles = new Set();
    for (const s of steps) {
      const rs = Array.isArray(s.role) ? s.role : (s.role ? [s.role] : []);
      for (const r of rs) roles.add(r);
    }
    // Record counts are this organisation's state, not the process model.
    let instances = 0;
    let open = 0;
    try {
      if (anonymous) throw new Error('withheld');
      instances = db.get('SELECT COUNT(*) AS n FROM workflow_instances WHERE process_code = ?', [row.code]).n;
      open = db.get(
        "SELECT COUNT(*) AS n FROM workflow_instances WHERE process_code = ? " +
        "AND status NOT IN ('closed','cancelled','rejected')", [row.code]
      ).n;
    } catch { /* tables not present yet */ }
    return {
      code: row.code,
      name: row.name,
      nameEn: row.name_en,
      category: row.category,
      description: row.description,
      descriptionEn: row.description_en,
      stepCount: steps.length,
      participantCount: roles.size,
      signedStepCount: steps.filter((s) => s.signatureMeaning).length,
      independentStepCount: steps.filter((s) => s.independentOfAuthor).length,
      slaDays: def.slaDays || null,
      requiresRootCause: Boolean(def.requiresRootCause),
      requiresEffectivenessCheck: Boolean(def.requiresEffectivenessCheck),
      instanceCount: instances,
      openCount: open,
      // Is this process genuinely about this domain, or merely tagged with it?
      // A CAPA touches GLP without being a GLP process; the page sorts and marks
      // accordingly so the area's own flows come first.
      dedicated: parseJson(row.gxp_areas, []).length <= 3,
      gxpAreas: parseJson(row.gxp_areas, []),
    };
  }).sort((a, b) => (b.dedicated - a.dedicated)
    || (b.instanceCount - a.instanceCount)
    || a.code.localeCompare(b.code));

  // ---- the people across every process in this area ------------------------
  const roleSet = new Map();
  for (const row of allProcesses) {
    const def = JSON.parse(row.definitions_json);
    for (const step of def.steps || []) {
      const rs = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
      for (const r of rs) {
        if (!roleSet.has(r)) roleSet.set(r, { role: r, processes: new Set(), steps: 0, approvals: 0 });
        const e = roleSet.get(r);
        e.processes.add(row.code);
        e.steps += 1;
        if (step.signatureMeaning) e.approvals += 1;
      }
    }
  }

  const usersByRole = new Map();
  for (const u of db.all("SELECT id, username, full_name, job_title, department, role FROM users WHERE status = 'active'")) {
    if (!usersByRole.has(u.role)) usersByRole.set(u.role, []);
    usersByRole.get(u.role).push(u);
  }

  const cast = [...roleSet.values()].sort((a, b) => b.steps - a.steps).map((e) => {
    const def = rbac.ROLES[e.role] || { label: e.role, labelZh: e.role };
    const users = usersByRole.get(e.role) || [];
    const perms = rbac.permissionsFor(e.role);
    return {
      role: e.role,
      roleLabel: def.label,
      roleLabelZh: def.labelZh,
      readOnly: Boolean(def.readOnly),
      duty: ROLE_DUTY[e.role] ? ROLE_DUTY[e.role].zh : def.description,
      dutyEn: ROLE_DUTY[e.role] ? ROLE_DUTY[e.role].en : def.description,
      processCount: e.processes.size,
      processes: [...e.processes].sort(),
      stepCount: e.steps,
      approvalCount: e.approvals,
      permissionCount: perms.includes('*') ? 'all' : perms.length,
      loginable: !anonymous && users.length > 0,
      accounts: anonymous ? [] : users.map((u) => ({
        id: u.id, username: u.username, fullName: u.full_name, jobTitle: u.job_title, department: u.department,
      })),
    };
  });

  // The matrix covers only the roles this area involves, so the table stays
  // legible instead of turning into a wall of columns.
  const matrix = permissionMatrix(cast.map((c) => c.role));

  // Who holds each role, so a step in a flow diagram can show a person's card
  // directly beneath it rather than only the role's name. Held separately from
  // the cast because a flow may put several roles under one step and the same
  // person may appear more than once across an area's processes.
  const roleAccounts = {};
  for (const [role, users] of usersByRole) {
    const def = rbac.ROLES[role] || { label: role, labelZh: role };
    roleAccounts[role] = {
      role,
      roleLabel: def.label,
      roleLabelZh: def.labelZh,
      readOnly: Boolean(def.readOnly),
      duty: ROLE_DUTY[role] ? ROLE_DUTY[role].zh : def.description,
      dutyEn: ROLE_DUTY[role] ? ROLE_DUTY[role].en : def.description,
      accounts: anonymous ? [] : users.map((u) => ({
        id: u.id, username: u.username, fullName: u.full_name, jobTitle: u.job_title, department: u.department,
      })),
    };
  }

  // Which checklists cover this area, so the page links to the inspection side
  // of the same domain rather than dead-ending.
  const checklists = db.all(
    'SELECT id, code, title, title_en, gxp_areas, category FROM checklist_templates WHERE active = 1 ORDER BY code'
  ).filter((r) => parseJson(r.gxp_areas, []).includes(areaCode)).map((r) => ({
    code: r.code,
    title: r.title,
    titleEn: r.title_en,
    itemCount: db.get('SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ?', [r.id]).n,
  }));

  const openRecords = processes.reduce((a, p) => a + p.openCount, 0);
  const totalRecords = processes.reduce((a, p) => a + p.instanceCount, 0);

  return {
    generatedAt: nowIso(),
    area: {
      code: area.code,
      name: area.name,
      fullName: area.fullName || area.name,
      description: area.description || '',
      colour: area.colour || null,
      philosophy: PHILOSOPHY[area.code] || null,
      philosophyEn: PHILOSOPHY_EN[area.code] || null,
    },
    processes,
    participants: cast,
    matrix,
    roleAccounts,
    // Which participants this viewer may see, with the reason for each refusal.
    visibility: visibilityFor(viewer, areaCode, cast),
    checklists,
    summary: {
      processCount: processes.length,
      dedicatedProcessCount: processes.filter((p) => p.dedicated).length,
      participantCount: cast.length,
      openRecords,
      totalRecords,
    },
    demoLogin: anonymous ? null : demoLoginInfo(),
  };
}

/** The list of domains for the picker, each with enough to make a real choice. */
function listDomains(options = {}) {
  const anonymous = Boolean(options.anonymous);
  const areas = db.all(
    'SELECT code, name, name_en, full_name, full_name_en, description, colour, sort_order FROM gxp_areas ORDER BY sort_order, code'
  );
  return {
    generatedAt: nowIso(),
    domains: areas.map((area) => {
      const rows = db.all(
        'SELECT code, name, name_en, gxp_areas, definitions_json FROM process_types WHERE active = 1'
      ).filter((r) => parseJson(r.gxp_areas, []).includes(area.code));
      const dedicated = rows.filter((r) => parseJson(r.gxp_areas, []).length <= 3);
      const roles = new Set();
      let signed = 0;
      for (const r of rows) {
        const def = JSON.parse(r.definitions_json);
        for (const s of def.steps || []) {
          const rs = Array.isArray(s.role) ? s.role : (s.role ? [s.role] : []);
          for (const x of rs) roles.add(x);
          if (s.signatureMeaning) signed += 1;
        }
      }
      const checklists = db.all(
        'SELECT gxp_areas FROM checklist_templates WHERE active = 1'
      ).filter((r) => parseJson(r.gxp_areas, []).includes(area.code));
      let records = 0;
      try {
        if (rows.length) {
          const placeholders = rows.map(() => '?').join(',');
          records = db.get(
            `SELECT COUNT(*) AS n FROM workflow_instances WHERE process_code IN (${placeholders})`,
            rows.map((r) => r.code)
          ).n;
        }
      } catch { records = 0; }
      return {
        code: area.code,
        name: area.name,
        fullName: area.fullName || area.name,
        description: area.description || '',
        colour: area.colour || null,
        philosophy: PHILOSOPHY[area.code] || null,
        philosophyEn: PHILOSOPHY_EN[area.code] || null,
        processCount: rows.length,
        dedicatedProcessCount: dedicated.length,
        processCodes: rows.map((r) => r.code),
        participantCount: roles.size,
        signedStepCount: signed,
        checklistCount: checklists.length,
        recordCount: anonymous ? 0 : records,
        // A caller with no session does not learn how much work this instance holds.
        withheld: anonymous,
        // "Complete" means there are dedicated processes, a dedicated checklist
        // and at least one real record - the same bar the coverage audit uses.
        ready: dedicated.length > 0 && checklists.length > 0 && records > 0,
      };
    }).filter((d) => d.processCount > 0),
    demoLogin: anonymous ? null : demoLoginInfo(),
  };
}

module.exports = {
  explore,
  exploreDomain,
  listDomains,
  permissionMatrix,
  explorerPayload,
  buildHandoffs,
  listParticipants,
  addParticipant,
  removeParticipant,
  isParticipantEnabled,
  PERMISSION_GROUPS,
  ROLE_DUTY,
  PHILOSOPHY,
  PHILOSOPHY_EN,
};

// ==================================================== participant management ==

/**
 * Which roles are currently "on stage" for the demonstration.
 *
 * WHY THIS IS A SEPARATE LAYER, NOT A ROLE EDIT
 * ---------------------------------------------
 * A user cannot invent a role here, and cannot edit what a role may do. Roles
 * and their permissions are code: they are what the server-side gates actually
 * check, and letting an interface rewrite them would make the demo contradict
 * the kernel. What a user *can* do is choose which of the existing roles appear
 * as participants - genuinely useful for a demo or a training session, and
 * incapable of creating a capability that does not exist.
 *
 * The baseline is every role the process definition names. Removing one hides it
 * from the cast; adding one beyond the definition is allowed and clearly marked,
 * because showing "what if QA were involved in this step" is a legitimate
 * training need.
 */
let participantsTableReady = false;
function ensureParticipantsTable() {
  if (participantsTableReady) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS demo_participants (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT NOT NULL,
      action      TEXT NOT NULL,
      note        TEXT,
      actor_id    INTEGER,
      actor_name  TEXT,
      created_at  TEXT NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_demo_participants_role ON demo_participants(role)');
  participantsTableReady = true;
}

/**
 * Resolve the effective cast for a process: the roles its definition names,
 * plus any a user added, minus any a user removed.
 */
function listParticipants(processCode) {
  ensureParticipantsTable();
  const def = workflow.getDefinition(processCode);
  if (!def) {
    const err = new Error(`UNKNOWN_PROCESS_TYPE: ${processCode}`);
    err.status = 404;
    err.code = 'UNKNOWN_PROCESS_TYPE';
    throw err;
  }

  const fromDefinition = new Set();
  for (const step of def.steps || []) {
    const roles = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
    for (const r of roles) fromDefinition.add(r);
  }

  const events = db.all(
    'SELECT role, action, note, actor_name, created_at FROM demo_participants ORDER BY id ASC'
  );
  const added = new Set();
  const removed = new Set();
  for (const e of events) {
    if (e.action === 'add') { added.add(e.role); removed.delete(e.role); }
    else if (e.action === 'remove') { removed.add(e.role); added.delete(e.role); }
    else if (e.action === 'reset') { added.clear(); removed.clear(); }
  }

  const active = [];
  for (const role of fromDefinition) if (!removed.has(role)) active.push({ role, origin: 'definition' });
  for (const role of added) if (!fromDefinition.has(role)) active.push({ role, origin: 'added' });

  return {
    processCode,
    fromDefinition: [...fromDefinition],
    added: [...added],
    removed: [...removed],
    active: active.map((a) => ({
      role: a.role,
      origin: a.origin,
      enabled: isParticipantEnabled(a.role),
    })),
    history: events.map((e) => ({
      role: e.role, action: e.action, note: e.note,
      actor: e.actor_name, at: e.created_at,
    })),
  };
}

/**
 * Add a role to the cast. The role must exist in the RBAC catalogue: this is the
 * boundary that keeps the demo from inventing capabilities.
 */
function addParticipant(processCode, roleCode, actor, ctx, note) {
  ensureParticipantsTable();
  if (!rbac.ROLES[roleCode]) {
    const err = new Error(`UNKNOWN_ROLE: ${roleCode}. Roles are defined in the application, not created in the interface.`);
    err.status = 400;
    err.code = 'UNKNOWN_ROLE';
    throw err;
  }
  const current = listParticipants(processCode);
  // Match on the same combination the cast itself uses (fromDefinition OR added),
  // because listParticipants returns the resolved cast rather than the raw
  // addition log. Checking `added` alone would let a role that the definition
  // already names be "added" a second time.
  const alreadyPresent = current.active.some((a) => a.role === roleCode);
  if (alreadyPresent) {
    const err = new Error(`${roleCode} is already a participant in this workflow view`);
    err.status = 409;
    err.code = 'ALREADY_PARTICIPANT';
    throw err;
  }
  db.run(
    'INSERT INTO demo_participants (role, action, note, actor_id, actor_name, created_at) VALUES (?,?,?,?,?,?)',
    [roleCode, 'add', note || null, actor ? actor.id : null,
      actor ? (actor.full_name || actor.username) : 'system', nowIso()]
  );
  auditParticipant(actor, ctx, 'add', roleCode, note, processCode);
  return listParticipants(processCode);
}

function removeParticipant(processCode, roleCode, actor, ctx, note) {
  ensureParticipantsTable();
  db.run(
    'INSERT INTO demo_participants (role, action, note, actor_id, actor_name, created_at) VALUES (?,?,?,?,?,?)',
    [roleCode, 'remove', note || null, actor ? actor.id : null,
      actor ? (actor.full_name || actor.username) : 'system', nowIso()]
  );
  auditParticipant(actor, ctx, 'remove', roleCode, note, processCode);
  return listParticipants(processCode);
}

function isParticipantEnabled(roleCode) {
  const row = db.get(
    "SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = 'active'", [roleCode]
  );
  return row.n > 0;
}

/**
 * Participant changes are configuration changes to a demonstration, not GxP
 * record changes. They are still written to the audit trail, because a change to
 * who appears in a workflow view should be attributable like anything else - and
 * the entry says plainly that no GxP record was altered by it.
 */
function auditParticipant(actor, ctx, action, roleCode, note, processCode) {
  const audit = require('../core/audit');
  audit.append({
    action: `participant_${action}`,
    entityType: 'demo_participants',
    entityId: roleCode,
    recordKey: `explorer:${processCode}`,
    actor: actor || null,
    reason: note || `Participant "${roleCode}" ${action === 'add' ? 'added to' : 'removed from'} the ${processCode} workflow view`,
    ctx: ctx || {},
    severity: 'info',
    meta: {
      processCode,
      role: roleCode,
      note: 'Demonstration workflow view only - no GxP record was created, modified or deleted.',
      reversible: true,
    },
  });
}

