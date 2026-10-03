'use strict';

/**
 * Built-in personas for a click-and-use LeebertyPV instance.
 *
 * WHY THIS EXISTS
 * ---------------
 * A workbench whose value comes from role separation is useless on first launch
 * if the user has to invent ten accounts before they can see any of it. This
 * module defines a small cast that between them exercise every distinctive part
 * of a pharmacovigilance system - intake clerk, case processor, medical
 * assessor, QPPV, report writer, regulator - so the role gates and the inbox
 * can be demonstrated in two clicks.
 *
 * SAFETY
 * ------
 * Provisioning is opt-in and off by default in the shipped configuration:
 *
 *   PV_BUILTIN_ACCOUNTS=1   create/refresh the personas at start-up
 *
 * A production instance must never be shipped with known credentials, so the
 * personas are also excluded from `GET /api/bootstrap` unless the same flag is
 * set, which is what makes the login screen render tiles instead of a bare form.
 * The credential is published on purpose - it is the point of a demo - and the
 * boot banner says so loudly.
 *
 * Every account is a real row in `users`, so the RBAC matrix, the signature
 * gates and the audit trail treat them exactly like human-created accounts.
 */

const config = require('../config');
const db = require('../core/db');
const auth = require('../core/auth');
const audit = require('../core/audit');

/** The single credential every built-in persona shares. */
const BUILTIN_PASSWORD = 'PV-Demo-2026!';

/**
 * The cast. Kept deliberately small: one persona per capability boundary that
 * a new user needs to *see* in order to understand the system.
 */
const PERSONAS = [
  {
    username: 'demo.intake',
    fullName: '王敏',
    fullNameEn: 'Wang Min',
    role: 'pv_data_entry',
    department: '药物警戒部',
    jobTitle: '数据录入员',
    pvAreas: ['ICSR'],
    qualification: { ICSR: true },
    blurb: '数据录入员：登记新收到的个例报告、核对四要素、用 MedDRA 编码。不能作医学判断，也不能签署结案。',
    blurbEn: 'Data entry: registers incoming cases, checks the four elements, codes events in MedDRA. No medical judgement, no closure signing.',
    highlight: '看角色门如何限制一线录入',
  },
  {
    username: 'demo.pvofficer',
    fullName: '刘悦',
    fullNameEn: 'Liu Yue',
    role: 'pv_officer',
    department: '药物警戒部',
    jobTitle: '药物警戒专员',
    pvAreas: ['ICSR', 'SIGNAL'],
    qualification: { ICSR: true, SIGNAL: true },
    blurb: '药物警戒专员：处理个例报告、掌握时限、随访、做信号检测。时限从首次获知日起算。',
    blurbEn: 'PV officer: processes ICSRs, owns timelines, follows up, detects signals. The clock starts at first knowledge.',
    highlight: '报告时限与信号检测都在这里',
  },
  {
    username: 'demo.medical',
    fullName: '梅梦雪',
    fullNameEn: 'Mei Mengxue',
    role: 'pv_medical',
    department: '药物警戒部',
    jobTitle: '医学评价员（医师）',
    pvAreas: ['ICSR', 'PSUR'],
    qualification: { ICSR: true, PSUR: true },
    blurb: '医学评价员（医师）：作因果关系评价与医学审核，判断严重性与预期性，撰写病例叙述。',
    blurbEn: 'Medical assessor (physician): causality assessment, medical review, seriousness and expectedness judgement, case narrative.',
    highlight: '因果关系评价必须记录依据，不是只给结论',
  },
  {
    username: 'demo.pvhead',
    fullName: '陈立群',
    fullNameEn: 'Chen Liqun',
    role: 'pv_head',
    department: '药物警戒部',
    jobTitle: '药物警戒负责人（QPPV）',
    pvAreas: ['ICSR', 'SIGNAL', 'PSUR', 'RMP'],
    qualification: { ICSR: true, SIGNAL: true, PSUR: true, RMP: true },
    blurb: '药物警戒负责人（QPPV）：对药物警戒体系负最终责任，批准结案、信号处置与风险控制措施。',
    blurbEn: 'PV Head / QPPV: ultimately accountable for the PV system, approves closures, signal actions and RMMs.',
    highlight: '所有高风险决策最终落在这里',
  },
  {
    username: 'demo.writer',
    fullName: '赵一诺',
    fullNameEn: 'Zhao Yinuo',
    role: 'pv_writer',
    department: '药物警戒部',
    jobTitle: '定期报告撰写员',
    pvAreas: ['PSUR'],
    qualification: { PSUR: true },
    blurb: '定期报告撰写员：按数据锁定点汇编 PSUR / PBRER，组织获益-风险评估章节。',
    blurbEn: 'Report writer: compiles PSUR / PBRER against the data lock point, drafts the benefit-risk chapters.',
    highlight: '数据锁定点决定报告的范围与期限',
  },
  {
    username: 'demo.reg',
    fullName: '孙晓峰',
    fullNameEn: 'Sun Xiaofeng',
    role: 'pv_regulatory',
    department: '药物警戒部',
    jobTitle: '信息报送与递交专员',
    pvAreas: ['ICSR', 'PSUR'],
    qualification: { ICSR: true, PSUR: true },
    blurb: '信息报送专员：向国家药品不良反应监测中心与省级机构递交报告、跟踪回执、核对时限。',
    blurbEn: 'Submissions officer: files reports to national and provincial ADR centres, tracks acknowledgements, checks deadlines.',
    highlight: '超时提交属于严重缺陷，必须记录原因',
  },
  {
    username: 'demo.lit',
    fullName: '周倩',
    fullNameEn: 'Zhou Qian',
    role: 'literature_reviewer',
    department: '药物警戒部',
    jobTitle: '文献监测员',
    pvAreas: ['LIT'],
    qualification: { LIT: true },
    blurb: '文献监测员：按检索计划筛查国内外医学文献，把符合上报条件的个例转给受理流程。',
    blurbEn: 'Literature monitor: screens journals on a schedule, hands reportable cases to intake.',
    highlight: '文献里的个例同样计入报告时限',
  },
  {
    username: 'demo.qamanager',
    fullName: '李静',
    fullNameEn: 'Li Jing',
    role: 'qa_manager',
    department: '质量保证部',
    jobTitle: '药物警戒质量负责人',
    pvAreas: ['GVP'],
    qualification: { GVP: true },
    blurb: '药物警戒质量负责人：审批偏差与 CAPA、批准体系文件、评估信号处置的有效性。',
    blurbEn: 'PV QA manager: approves deviations and CAPAs, approves system documents, judges effectiveness.',
    highlight: 'GVP 质量体系与职责分离在这里体现',
  },
  {
    username: 'demo.auditor',
    fullName: '陈国华',
    fullNameEn: 'Chen Guohua',
    role: 'qa_auditor',
    department: '质量保证部',
    jobTitle: '内审员',
    pvAreas: ['GVP'],
    qualification: { GVP: true },
    blurb: '内审员：按 GVP 模块执行药物警戒体系自查，把缺陷转成 CAPA。不能批准自己审计的对象。',
    blurbEn: 'Internal auditor: runs PV system self-inspections per GVP modules and escalates findings, but cannot approve what they audited.',
    highlight: '内审员独立性是代码强制的',
  },
  {
    username: 'demo.trainer',
    fullName: '黄燕',
    fullNameEn: 'Huang Yan',
    role: 'trainer',
    department: '人力资源部',
    jobTitle: '培训协调员',
    pvAreas: ['GVP'],
    blurb: '培训协调员：分配 GVP 培训、登记完成、签署关键培训记录。',
    blurbEn: 'Training coordinator: assigns curricula, records completion, signs GVP-critical training.',
    highlight: '培训资质矩阵与签名门槛',
  },
  {
    username: 'demo.committee',
    fullName: '吴海',
    fullNameEn: 'Wu Hai',
    role: 'safety_committee',
    department: '药物警戒部',
    jobTitle: '药品安全委员会委员',
    pvAreas: ['SIGNAL', 'RMP'],
    blurb: '药品安全委员会成员：审议确认信号、投票决定风险最小化措施。',
    blurbEn: 'Drug safety committee member: reviews confirmed signals, votes on risk minimisation measures.',
    highlight: '信号与风险决策的集体审议',
  },
  {
    username: 'demo.external',
    fullName: '监管检查员',
    fullNameEn: 'Regulatory Inspector',
    role: 'auditor_external',
    department: '外部',
    jobTitle: '检查员（只读）',
    pvAreas: ['ICSR', 'SIGNAL', 'PSUR', 'RMP', 'GVP'],
    blurb: '只读账号：可以查阅记录与审计追踪，任何查看行为本身也会被记录。',
    blurbEn: 'Read-only account: can review records and the audit trail, and every view is itself audited.',
    highlight: '只读权限 + 查看留痕',
  },
  {
    username: 'demo.viewer',
    fullName: '只读访客',
    fullNameEn: 'Read-only Visitor',
    role: 'viewer',
    department: '外部',
    jobTitle: '只读用户',
    pvAreas: ['ICSR', 'GVP'],
    blurb: '只读用户：可浏览公开的流程参考模型与记录概况，不能执行任何操作。',
    blurbEn: 'Viewer: browse the public workflow reference model and record overviews, no actions.',
    highlight: '最小权限示例',
  },
];

/** True when the instance is configured to behave as a click-and-use demo. */
function builtinAccountsEnabled() {
  return process.env.PV_BUILTIN_ACCOUNTS === '1' || config.features.builtinAccounts === true;
}

/** Create or refresh one persona. Idempotent: safe to run on every start-up. */
function ensurePersona(persona, actor, ctx) {
  const existing = auth.getUserByUsername(persona.username);
  const at = new Date().toISOString();

  if (existing) {
    // Refresh the descriptive fields but never clobber a password the user set.
    const before = {
      full_name: existing.full_name, role: existing.role,
      department: existing.department, job_title: existing.job_title, status: existing.status,
    };
    db.run(
      'UPDATE users SET full_name = ?, full_name_en = ?, role = ?, department = ?, job_title = ?, ' +
      'gxp_areas = ?, qualification = ?, status = ?, updated_at = ? WHERE id = ?',
      [persona.fullName, persona.fullNameEn || null, persona.role, persona.department,
        persona.jobTitle, JSON.stringify(persona.pvAreas || []),
        JSON.stringify(persona.qualification || {}), 'active', at, existing.id]
    );
    const changed = before.full_name !== persona.fullName || before.role !== persona.role
      || before.status !== 'active';
    if (changed) {
      audit.recordChange({
        actor: actor || null,
        entityType: 'users',
        entityId: existing.id,
        recordKey: `users:${existing.id}`,
        before,
        after: { full_name: persona.fullName, role: persona.role, status: 'active' },
        reason: 'Built-in persona refreshed at start-up',
        ctx: ctx || {},
        action: 'update',
      });
    }
    return { user: existing, created: false, passwordReset: false };
  }

  let id;
  db.transaction(() => {
    db.run(
      'INSERT INTO users (username, full_name, full_name_en, email, department, job_title, role, status, ' +
      'locale, gxp_areas, qualification, must_change_password, created_at, updated_at, created_by) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [persona.username, persona.fullName, persona.fullNameEn || null,
        `${persona.username}@demo.local`, persona.department, persona.jobTitle, persona.role,
        'active', 'zh-CN', JSON.stringify(persona.pvAreas || []),
        JSON.stringify(persona.qualification || {}), 0, at, at, actor ? actor.id : null]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
  });

  const created = auth.getUserById(id);
  auth.setPassword(id, BUILTIN_PASSWORD, actor || created, ctx || {}, {
    mustChange: false,
    reason: 'Built-in demonstration account provisioned',
  });
  audit.append({
    action: 'create',
    entityType: 'users',
    entityId: id,
    recordKey: `users:${id}`,
    actor: actor || null,
    reason: `Built-in demonstration account "${persona.username}" provisioned (${persona.role})`,
    ctx: ctx || {},
    severity: 'critical',
    newValue: {
      username: persona.username, full_name: persona.fullName, role: persona.role,
      builtin: true, password_change_required: false,
    },
  });
  return { user: auth.getUserById(id), created: true, passwordReset: true };
}

/**
 * Provision every persona. Called from server start-up when enabled.
 * @returns {{enabled:boolean, created:number, refreshed:number, personas:Array}}
 */
function provision(actor, ctx) {
  const summary = { enabled: builtinAccountsEnabled(), created: 0, refreshed: 0, personas: [] };
  if (!summary.enabled) return summary;

  for (const persona of PERSONAS) {
    try {
      const result = ensurePersona(persona, actor, ctx);
      if (result.created) summary.created += 1; else summary.refreshed += 1;
      summary.personas.push({ username: persona.username, role: persona.role, created: result.created });
    } catch (err) {
      process.stderr.write(`  [builtin-accounts] ${persona.username} failed: ${err.message}\n`);
    }
  }
  return summary;
}

/**
 * Demonstration blurbs for roles seeded by scripts/seed-demo.js.
 */
const ROLE_BLURBS = {
  system_admin: {
    zh: '系统管理员：维护账号、权限与系统配置。可以看到全部内容，但不能作为任何安全性记录的唯一批准人。',
    en: 'System administrator: maintains accounts, permissions and configuration. Sees everything, but cannot be the sole approver of any safety record.',
    highlight: '技术权限与质量决策权被强制分离',
  },
  pv_head: {
    zh: '药物警戒负责人（QPPV）：对药物警戒体系负最终责任，批准结案、信号处置与风险控制措施；审批体系文件与 CAPA。',
    en: 'PV Head / QPPV: accountable for the PV system, approves closures, signal actions and risk minimisation measures; approves system documents and CAPAs.',
    highlight: '药物警戒体系的单一最终责任人',
  },
  pv_officer: {
    zh: '药物警戒专员：处理个例报告、管理报告时限、随访、检测信号。时限从首次获知日起算，这是检查的高频缺陷。',
    en: 'PV officer: processes ICSRs, manages reporting timelines, follows up, detects signals. The clock starts at first knowledge.',
    highlight: '报告时限起算日是检查最高频缺陷',
  },
  pv_data_entry: {
    zh: '数据录入员：登记个案、核对四要素、MedDRA 编码。录入错误会直接影响信号检测质量。',
    en: 'Data entry: registers cases, checks the four elements, codes in MedDRA. Entry errors directly degrade signal detection.',
    highlight: '四要素齐全是有效个例的最低门槛',
  },
  pv_medical: {
    zh: '医学评价员（医师）：作因果关系评价与医学审核。判断必须记录依据，而不是只给结论。',
    en: 'Medical assessor (physician): causality assessment and medical review. Judgements must record their basis, not just a conclusion.',
    highlight: 'WHO-UMC 因果评价六级分类的落地',
  },
  pv_writer: {
    zh: '定期报告撰写员：按数据锁定点汇编 PSUR / PBRER，撰写获益-风险评估章节并组织审批。',
    en: 'Report writer: compiles PSUR / PBRER against data lock points, drafts benefit-risk chapters, organises approval.',
    highlight: '数据锁定点决定报告范围与期限',
  },
  pv_regulatory: {
    zh: '信息报送专员：按法定时限向监测机构递交快速与定期报告、跟踪回执。超时提交必须记录原因。',
    en: 'Submissions officer: files expedited and periodic reports within legal timelines, tracks acknowledgements. Late submissions must record why.',
    highlight: '递交时限与超时原因的留痕',
  },
  literature_reviewer: {
    zh: '文献监测员：按检索计划筛查国内外医学文献，把可上报的个例转给受理流程。',
    en: 'Literature monitor: screens journals on schedule, hands reportable cases to intake.',
    highlight: '文献个案同样计入报告时限',
  },
  safety_committee: {
    zh: '药品安全委员会成员：审议确认信号与风险最小化措施。委员会意见进入审计追踪。',
    en: 'Drug safety committee member: reviews confirmed signals and risk minimisation measures. Committee views enter the audit trail.',
    highlight: '信号与风险决策的集体审议',
  },
  qa_manager: {
    zh: '药物警戒质量负责人：审批偏差、CAPA 与体系文件，评估纠正措施的有效性。',
    en: 'PV QA manager: approves deviations, CAPAs and system documents; judges the effectiveness of corrective actions.',
    highlight: '调查者与决定者分离',
  },
  qa_specialist: {
    zh: '质量保证专员：执行调查、起草文件、跟踪整改与培训。承担大量步骤，但不作最终处置决定。',
    en: 'QA specialist: runs investigations, drafts documents, tracks actions and training. Carries many steps but makes no final decision.',
    highlight: '质量体系的执行层',
  },
  qa_auditor: {
    zh: '内审员：按 EU GVP 模块执行体系自查，缺陷一键转 CAPA。不能批准自己审计的对象。',
    en: 'Internal auditor: runs PV self-inspections per EU GVP modules, escalates findings to CAPAs. Cannot approve what they audited.',
    highlight: '内审员独立性由服务端强制',
  },
};

/**
 * Which roles a domain involves, used to decide who may be entered as there.
 *
 * TWO PASSES, AND WHY
 * -------------------
 * A single pass over "every process tagged with this area" produced a useless
 * list in the GxP predecessor: general processes (CAPA, deviation, change
 * control) are tagged with several areas, so almost every role came out as
 * belonging to every area and the domain-scoped entry was decoration.
 *
 * So the first pass takes only the area's OWN processes - the ones that belong
 * to one area or a small set - and the second pass adds the genuinely
 * cross-cutting functions that a PV domain cannot exclude: QA, internal audit
 * and training. Those roles are not intruders in ICSR; a PV system with no QA
 * presence is not a pharmacovigilance system (GVP Module I).
 */
function rolesByArea() {
  const out = {};
  const counts = {};

  // ---- pass 1: the area's own processes ------------------------------------
  try {
    for (const row of db.all('SELECT gxp_areas, definitions_json FROM process_types WHERE active = 1')) {
      let areas = [];
      try { areas = JSON.parse(row.gxp_areas || '[]'); } catch { areas = []; }
      let def = {};
      try { def = JSON.parse(row.definitions_json || '{}'); } catch { def = {}; }
      if (areas.length > 3) continue;   // a general process, not this area's own
      for (const step of def.steps || []) {
        const roles = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
        for (const area of areas) {
          if (!out[area]) { out[area] = new Set(); counts[area] = {}; }
          for (const role of roles) {
            out[area].add(role);
            counts[area][role] = (counts[area][role] || 0) + 1;
          }
        }
      }
    }
  } catch { /* configuration not loaded yet */ }

  // ---- functions every domain has to include --------------------------------
  // EXPLICIT, NOT DERIVED. A derivation cannot tell "a role that oversees the
  // quality system" from "a role that appears in a process which happens to
  // span several domains".
  const CROSS_CUTTING = {
    qa_manager: '质量体系覆盖全部 PV 领域——没有 QA 的领域就不构成受控体系',
    qa_specialist: '执行调查、文件与整改跟踪，服务于所有领域',
    qa_auditor: '内审范围必须覆盖全部 PV 领域（GVP Module I / ICH Q10）',
    trainer: '培训与资质对每个领域一致适用',
  };
  const allAreas = new Set(Object.keys(out));
  try {
    for (const row of db.all('SELECT code FROM gxp_areas')) allAreas.add(row.code);
  } catch { /* areas table not present yet */ }
  for (const area of allAreas) if (!out[area]) out[area] = new Set();
  for (const role of Object.keys(CROSS_CUTTING)) {
    for (const area of allAreas) out[area].add(role);
  }

  // The external inspector may examine any domain, and appears in no process
  // definition, so no derivation would ever place them. The system
  // administrator is deliberately NOT added to the domains: they hold no PV
  // process role at all.
  for (const area of allAreas) out[area].add('auditor_external');

  const result = {};
  for (const [area, roles] of Object.entries(out)) result[area] = [...roles].sort();
  return result;
}

/**
 * Step counts per area per role, for ranking a domain's roster.
 * Only processes that BELONG to the area count, not every process that
 * mentions it.
 */
function areaStepCounts() {
  const counts = {};
  try {
    for (const row of db.all('SELECT gxp_areas, definitions_json FROM process_types WHERE active = 1')) {
      let areas = [];
      try { areas = JSON.parse(row.gxp_areas || '[]'); } catch { areas = []; }
      let def = {};
      try { def = JSON.parse(row.definitions_json || '{}'); } catch { def = {}; }
      if (areas.length > 3) continue;
      for (const step of def.steps || []) {
        const roles = Array.isArray(step.role) ? step.role : (step.role ? [step.role] : []);
        for (const area of areas) {
          if (!counts[area]) counts[area] = {};
          for (const role of roles) counts[area][role] = (counts[area][role] || 0) + 1;
        }
      }
    }
  } catch { /* not loaded */ }
  return counts;
}

/**
 * Functions defined across every area. Declared once and used both here and by
 * the domain rosters, so the two cannot disagree about who works everywhere.
 */
const CROSS_DOMAIN_ROLES = {
  qa_manager: '质量体系覆盖全部 PV 领域',
  qa_specialist: '执行调查、文件与整改跟踪，服务于所有领域',
  qa_auditor: '内审范围必须覆盖全部 PV 领域',
  trainer: '培训与资质对每个领域一致适用',
  auditor_external: '监管检查员可检查任何领域',
};

/**
 * Where an identity reaches, which is what the start-up list groups by.
 * @param {string} role
 * @param {string[]} homeAreas
 * @returns {'whole_system'|'domain'|'none'}
 */
function scopeOfRole(role, homeAreas = []) {
  if (role === 'system_admin') return 'whole_system';
  if (CROSS_DOMAIN_ROLES[role]) return 'whole_system';
  return homeAreas.length ? 'domain' : 'none';
}

/**
 * Which interface this identity should land in after signing in.
 * `whole_system` identities get the domain chooser; single-domain roles go
 * straight to their domain's own interface.
 */
function landingFor(role, homeAreas = [], homeSteps = {}) {
  const scope = scopeOfRole(role, homeAreas);
  if (scope === 'whole_system') return { view: 'domains', domain: null, areas: homeAreas };
  if (scope === 'domain' && homeAreas.length) {
    const ranked = homeAreas.slice().sort(
      (a, b) => (homeSteps[b] || 0) - (homeSteps[a] || 0) || a.localeCompare(b)
    );
    return {
      view: 'domain',
      domain: ranked[0],
      areas: ranked,
      others: ranked.slice(1),
    };
  }
  return { view: 'domains', domain: null, areas: [] };
}

/**
 * The areas a role genuinely works IN, as opposed to the ones it merely
 * touches.
 */
function homeAreasByRole() {
  const counts = areaStepCounts();
  const out = {};
  for (const [area, byRole] of Object.entries(counts)) {
    for (const [role, steps] of Object.entries(byRole)) {
      if (steps <= 0) continue;
      if (!out[role]) out[role] = {};
      out[role][area] = steps;
    }
  }
  return out;
}

/** The areas a start-up screen can offer, in display order. */
function loginDomains() {
  const areas = db.all(
    'SELECT code, name, name_en, full_name, full_name_en, description, colour, sort_order ' +
    'FROM gxp_areas ORDER BY sort_order, code'
  );
  const byArea = rolesByArea();
  const personas = loginChoices();
  return areas.map((a) => {
    const participants = (byArea[a.code] || []);
    let processCount = 0;
    try {
      processCount = db.all(
        'SELECT gxp_areas FROM process_types WHERE active = 1'
      ).filter((r) => {
        try { return JSON.parse(r.gxp_areas || '[]').includes(a.code); } catch { return false; }
      }).length;
    } catch { processCount = 0; }
    const roster = personas.filter((p) => participants.includes(p.role));
    return {
      code: a.code,
      name: a.name,
      nameEn: a.name_en,
      fullName: a.full_name,
      fullNameEn: a.full_name_en,
      description: a.description,
      colour: a.colour,
      processCount,
      participantRoles: participants,
      personaCount: roster.length,
      personaRoles: roster.map((p) => p.role),
    };
  });
}

/**
 * The list shown on the start-up screen.
 * Only exposed when built-in accounts are enabled, because publishing
 * usernames is only acceptable on a demonstration instance.
 */
function loginChoices(opts = {}) {
  if (!builtinAccountsEnabled()) return [];
  const withPending = Boolean(opts.withPending);
  const byArea = rolesByArea();
  const stepCounts = areaStepCounts();
  const home = homeAreasByRole();
  const rbac = require('../core/rbac');
  const personaByName = new Map(PERSONAS.map((p) => [p.username, p]));

  let rows = [];
  try {
    rows = db.all(
      "SELECT id, username, full_name, full_name_en, role, department, job_title, gxp_areas " +
      "FROM users WHERE status = 'active' ORDER BY username"
    );
  } catch { return []; }

  const available = [];
  for (const row of rows) {
    const curated = personaByName.has(row.username);
    const persona = personaByName.get(row.username) || null;
    const roleDef = rbac.ROLES[row.role] || { label: row.role, labelZh: row.role };

    // The areas this account can be offered for: its role's process involvement.
    const areas = new Set();
    let declared = [];
    try { declared = JSON.parse(row.gxp_areas || '[]'); } catch { declared = []; }
    for (const a of declared) areas.add(a);
    for (const [area, roles] of Object.entries(byArea)) {
      if (roles.includes(row.role)) areas.add(area);
    }

    let pending = 0;
    if (withPending) {
      try { pending = require('./inbox').build(row, { limit: 1 }).counts.total; } catch { pending = 0; }
    }

    const areaSteps = {};
    for (const a of areas) areaSteps[a] = (stepCounts[a] || {})[row.role] || 0;

    const homeAreas = Object.keys(home[row.role] || {}).sort();

    const landingAreas = (() => {
      if (!declared.length) return homeAreas;
      const inArea = homeAreas.filter((a) => declared.includes(a));
      return inArea.length ? inArea : homeAreas;
    })();

    available.push({
      username: row.username,
      fullName: row.full_name,
      fullNameEn: row.full_name_en,
      role: row.role,
      roleLabel: roleDef.label,
      roleLabelZh: roleDef.labelZh,
      department: row.department || (persona ? persona.department : ''),
      jobTitle: row.job_title || (persona ? persona.jobTitle : ''),
      blurb: persona ? persona.blurb
        : (ROLE_BLURBS[row.role] ? ROLE_BLURBS[row.role].zh : (roleDef.description || '')),
      blurbEn: persona ? persona.blurbEn
        : (ROLE_BLURBS[row.role] ? ROLE_BLURBS[row.role].en : (roleDef.description || '')),
      highlight: persona ? persona.highlight
        : (ROLE_BLURBS[row.role] ? ROLE_BLURBS[row.role].highlight : null),
      pendingItems: pending,
      gxpAreas: [...areas].sort(),
      areaSteps,
      homeAreas,
      homeSteps: home[row.role] || {},
      scope: scopeOfRole(row.role, homeAreas),
      landing: landingFor(row.role, landingAreas, home[row.role] || {}),
      curated: curated || Boolean(ROLE_BLURBS[row.role]),
    });
  }
  return available;
}

function passwordHint() {
  return builtinAccountsEnabled() ? BUILTIN_PASSWORD : null;
}

function passwordCandidates() {
  if (!builtinAccountsEnabled()) return [];
  const legacy = 'Demo-PV-2026!';
  return legacy === BUILTIN_PASSWORD ? [BUILTIN_PASSWORD] : [BUILTIN_PASSWORD, legacy];
}

module.exports = {
  PERSONAS,
  BUILTIN_PASSWORD,
  builtinAccountsEnabled,
  provision,
  loginChoices,
  loginDomains,
  rolesByArea,
  areaStepCounts,
  homeAreasByRole,
  passwordHint,
  passwordCandidates,
  ensurePersona,
};