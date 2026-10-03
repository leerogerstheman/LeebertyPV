'use strict';

/**
 * Demo / training dataset generator for LeebertyPV.
 *
 *   node scripts/seed-demo.js                 populate an empty instance
 *   node scripts/seed-demo.js --force         allow adding to a populated instance
 *   node scripts/seed-demo.js --dry-run       report what would be created
 *
 * WHY THIS IS NOT PART OF seed.js
 * -------------------------------
 * The PV configuration library (process types, checklist templates, area
 * register) is *configuration*: it must be present in every instance,
 * including production. This file creates *fictional pharmacovigilance
 * records* - ICSRs, signals, PSURs, an RMP, literature cycles, complaints,
 * deviations, CAPAs, a change control and a GVP self-inspection. In a real
 * instance those would pollute the audit trail with fabricated safety cases
 * and destroy the evidential value of the ledger. So demo data lives here and
 * is never loaded automatically.
 *
 * The script refuses to touch an instance that already contains safety/quality
 * records unless --force is given, and marks every record it creates through
 * the summary text so the data is identifiable as fictional.
 *
 * Every record is created through the real domain services: signatures are
 * applied through auth.sign() with both components (password + single-use
 * server challenge, 21 CFR Part 11.200(a)(1)(i)), steps advance through
 * workflow.completeStep() with the role gates actually enforced, and the audit
 * chain grows the same way it would with real work.
 */

const db = require('../src/core/db');
const audit = require('../src/core/audit');
const auth = require('../src/core/auth');
const workflow = require('../src/domain/workflow');
const documents = require('../src/domain/documents');
const inspections = require('../src/domain/inspections');
const training = require('../src/domain/training');
const seed = require('../src/seed');

const MARKER = '[演示数据 DEMO]';

// One password for every demonstration account, identical to the built-in
// personas so the shared credential published by the start-up screen works for
// the accounts this script creates (see src/domain/accounts.js).
const DEMO_PASSWORD = require('../src/domain/accounts').BUILTIN_PASSWORD;

const ctx = { ip: '127.0.0.1', userAgent: 'seed-demo/1.0', sessionId: null };

/**
 * Apply a real electronic signature as a given user.
 *
 * Component A is the username plus password, component B is a fresh single-use
 * server challenge (auth.issueSigningNonce). The two-component requirement is
 * deliberately not bypassed here - passing only a password is refused by the
 * kernel with SECOND_FACTOR_REQUIRED.
 */
function signAs(user, entityType, entityId, recordKey, meaning, reason, stepCode) {
  const session = auth.createSession(user, ctx);
  const challenge = auth.issueSigningNonce(user, session, meaning);
  const result = auth.sign({
    user, session,
    username: user.username, password: DEMO_PASSWORD,
    nonce: challenge.nonce,
    meaning, reason: `${MARKER} ${reason}`,
    entityType, entityId, recordKey, stepCode,
    ctx,
  });
  if (!result.ok) {
    throw new Error(`electronic signature failed for ${user.username}: ${result.code}`);
  }
  return result.signature.id;
}

function parseArgs(argv) {
  const args = { force: false, dryRun: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function log(message) { process.stdout.write(`  ${message}\n`); }

/** Days ago, as an ISO date-time. Used to spread records over recent months. */
function daysAgo(days, hour = 9) {
  const d = new Date(Date.now() - days * 86400000);
  d.setHours(hour, Math.floor((days * 7) % 60), 0, 0);
  return d.toISOString();
}

function dateAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function dateAhead(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Shorthand used inside narrative strings (YYYY-MM-DD only). */
function day(days) { return dateAgo(days); }
function dayAhead(days) { return dateAhead(days); }

/**
 * Schema compatibility: the seeded workflow definitions (seed/workflows/*.json)
 * declare `persistFields` on several steps (e.g. SIG-DET data_prep persists
 * db_snapshot_date / observation_window / data_source). Those columns are not
 * part of the base schema in src/core/db.js, so workflow.completeStep() would
 * throw "no such column" the first time such a step is completed - both here
 * and for a real user. The seeder adds the missing columns idempotently so the
 * demonstration data can flow through the real kernel unchanged. Safe on any
 * instance: columns that already exist are left alone, additions are nullable
 * TEXT columns that the engine itself writes and reads.
 */
function ensurePersistColumns() {
  const cols = new Set();
  for (const row of db.all('SELECT definitions_json FROM process_types WHERE active = 1')) {
    let def = {};
    try { def = JSON.parse(row.definitions_json || '{}'); } catch { def = {}; }
    for (const step of def.steps || []) {
      for (const col of Object.keys(step.persistFields || {})) cols.add(col);
    }
  }
  const existing = new Set(db.all('PRAGMA table_info(workflow_instances)').map((c) => c.name));
  let added = 0;
  for (const col of [...cols].sort()) {
    if (existing.has(col)) continue;
    try {
      db.run(`ALTER TABLE workflow_instances ADD COLUMN ${col} TEXT`);
      added += 1;
    } catch (err) {
      process.stderr.write(`  [warn] could not add workflow_instances.${col}: ${err.message}\n`);
    }
  }
  return added;
}

// ------------------------------------------------------------------ users ---

function createUser({ username, fullName, fullNameEn, role, department, jobTitle, gxpAreas, qualification }) {
  const existing = auth.getUserByUsername(username);
  if (existing) return auth.getUserById(existing.id);
  const at = new Date().toISOString();
  let id;
  db.transaction(() => {
    db.run(
      'INSERT INTO users (username, full_name, full_name_en, email, employee_no, department, job_title, role, ' +
      'status, locale, gxp_areas, qualification, must_change_password, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [username, fullName, fullNameEn || null, `${username}@demo.example`, `EMP-${1000 + Math.floor(Math.random() * 8999)}`,
        department, jobTitle, role, 'active', 'zh-CN', JSON.stringify(gxpAreas || []),
        JSON.stringify(qualification || {}), 0, at, at]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;
  });
  const user = auth.getUserById(id);
  auth.setPassword(id, DEMO_PASSWORD, user, ctx, { mustChange: false, reason: `${MARKER} demo account created` });
  return auth.getUserById(id);
}

const PEOPLE = [
  { username: 'pv.head', fullName: '陈立群', fullNameEn: 'Chen Liqun', role: 'pv_head', department: '药物警戒部', jobTitle: '药物警戒负责人（QPPV）', gxpAreas: ['ICSR', 'SIGNAL', 'PSUR', 'RMP'], qualification: { ICSR: true, SIGNAL: true, PSUR: true, RMP: true } },
  { username: 'pv.officer', fullName: '刘悦', fullNameEn: 'Liu Yue', role: 'pv_officer', department: '药物警戒部', jobTitle: '药物警戒专员', gxpAreas: ['ICSR', 'SIGNAL', 'LIT'], qualification: { ICSR: true, SIGNAL: true, LIT: true } },
  { username: 'pv.dataentry', fullName: '王敏', fullNameEn: 'Wang Min', role: 'pv_data_entry', department: '药物警戒部', jobTitle: '数据录入员', gxpAreas: ['ICSR'], qualification: { ICSR: true } },
  { username: 'pv.medical', fullName: '梅梦雪', fullNameEn: 'Mei Mengxue', role: 'pv_medical', department: '医学部', jobTitle: '医学评价员（医师）', gxpAreas: ['ICSR', 'PSUR'], qualification: { ICSR: true, PSUR: true } },
  { username: 'pv.writer', fullName: '赵一诺', fullNameEn: 'Zhao Yinuo', role: 'pv_writer', department: '药物警戒部', jobTitle: '定期报告撰写员', gxpAreas: ['PSUR'], qualification: { PSUR: true } },
  { username: 'pv.regulatory', fullName: '孙晓峰', fullNameEn: 'Sun Xiaofeng', role: 'pv_regulatory', department: '注册事务部', jobTitle: '信息报送专员', gxpAreas: ['ICSR', 'PSUR'], qualification: { ICSR: true, PSUR: true } },
  { username: 'lit.monitor', fullName: '周倩', fullNameEn: 'Zhou Qian', role: 'literature_reviewer', department: '药物警戒部', jobTitle: '文献监测员', gxpAreas: ['LIT'], qualification: { LIT: true } },
  { username: 'safety.committee', fullName: '吴海', fullNameEn: 'Wu Hai', role: 'safety_committee', department: '医学部', jobTitle: '药品安全委员会委员', gxpAreas: ['SIGNAL', 'RMP'], qualification: { SIGNAL: true, RMP: true } },
  { username: 'qa.manager', fullName: '李静', fullNameEn: 'Li Jing', role: 'qa_manager', department: '质量保证部', jobTitle: '药物警戒质量负责人', gxpAreas: ['GVP'], qualification: { GVP: true } },
  { username: 'qa.specialist', fullName: '王涛', fullNameEn: 'Wang Tao', role: 'qa_specialist', department: '质量保证部', jobTitle: '质量保证专员', gxpAreas: ['GVP'], qualification: { GVP: true } },
  { username: 'qa.auditor', fullName: '陈国华', fullNameEn: 'Chen Guohua', role: 'qa_auditor', department: '质量保证部', jobTitle: '内审员', gxpAreas: ['GVP'], qualification: { GVP: true } },
  { username: 'trainer', fullName: '黄燕', fullNameEn: 'Huang Yan', role: 'trainer', department: '人力资源部', jobTitle: '培训协调员', gxpAreas: ['GVP'], qualification: { GVP: true } },
];

// ------------------------------------------------------------- curricula ----

const CURRICULA = [
  {
    code: 'PV-BASIC', title: 'PV 基础与法规（81号令/GVP）', titleEn: 'PV Fundamentals & Regulations',
    gxpAreas: ['GVP', 'ICSR'], appliesToRoles: ['pv_head', 'pv_officer', 'pv_data_entry', 'pv_medical', 'pv_writer', 'pv_regulatory', 'literature_reviewer', 'safety_committee', 'qa_manager', 'qa_specialist', 'qa_auditor', 'trainer'],
    validityMonths: 24, isGxpCritical: true,
    description: '《药品不良反应报告和监测管理办法》（卫生部令第 81 号）与《药物警戒质量管理规范》（NMPA 2021 年第 65 号公告）要点：药物警戒体系构成、个例报告四要素与快速报告时限、信号与定期报告基本概念。全员必修。',
  },
  {
    code: 'ICSR-4ELEMS', title: 'ICSR 处理与四要素', titleEn: 'ICSR Handling & Four Elements',
    gxpAreas: ['ICSR'], appliesToRoles: ['pv_officer', 'pv_data_entry', 'pv_medical', 'pv_regulatory', 'literature_reviewer'],
    validityMonths: 24, isGxpCritical: true,
    description: '个例安全性报告的接收、登记、分类与随访；可识别患者、可识别报告者、怀疑药品、不良事件四要素与时限起算（Day 0）；严重性六条标准与预期性判定。',
  },
  {
    code: 'MEDDRA-BASIC', title: 'MedDRA 编码基础', titleEn: 'MedDRA Coding Basics',
    gxpAreas: ['ICSR'], appliesToRoles: ['pv_data_entry', 'pv_officer', 'pv_medical'],
    validityMonths: 24, isGxpCritical: true,
    description: 'MedDRA 层级结构与 PT 术语选择原则、保留原始表述要求、编码一致性与质量核查。',
  },
  {
    code: 'CAUSALITY-UMC', title: '因果关系评价（WHO-UMC）', titleEn: 'Causality Assessment (WHO-UMC)',
    gxpAreas: ['ICSR'], appliesToRoles: ['pv_medical', 'pv_head', 'safety_committee'],
    validityMonths: 24, isGxpCritical: true,
    description: 'WHO-UMC 六级关联性评价：时间关系、停药/再激发、其他病因排除与评价依据的记录要求（GVP 第 45 条）。',
  },
  {
    code: 'SIG-DETECT', title: '信号检测方法（PRR/ROR/EBGM）', titleEn: 'Signal Detection Methods',
    gxpAreas: ['SIGNAL'], appliesToRoles: ['pv_officer', 'pv_medical', 'pv_head'],
    validityMonths: 12, isGxpCritical: true,
    description: '比例失衡法原理、数据切片与背景库、参考阈值（PRR/ROR/EBGM）、伪信号排查与优先排序（GVP 第 55-59 条）。',
  },
  {
    code: 'PSUR-WRITE', title: 'PSUR/PBRER 撰写', titleEn: 'PSUR / PBRER Authoring',
    gxpAreas: ['PSUR'], appliesToRoles: ['pv_writer', 'pv_medical', 'pv_regulatory', 'pv_head'],
    validityMonths: 24, isGxpCritical: true,
    description: '数据锁定点（DLP）与报告期连续性、期内数据汇编、获益-风险评估章节结构与提交时限（DLP 后 60 日）。',
  },
  {
    code: 'RMP-RMM', title: '风险管理计划与 RMM', titleEn: 'RMP & Risk Minimisation Measures',
    gxpAreas: ['RMP'], appliesToRoles: ['pv_head', 'pv_medical', 'safety_committee', 'qa_manager'],
    validityMonths: 24, isGxpCritical: true,
    description: '重要已识别/潜在风险与缺失信息清单、药物警戒计划、常规与附加风险最小化措施（RMM）及有效性评估（GVP 第 87-99 条）。',
  },
  {
    code: 'LIT-SEARCH', title: '文献检索方法', titleEn: 'Literature Search Methods',
    gxpAreas: ['LIT'], appliesToRoles: ['literature_reviewer', 'pv_officer'],
    validityMonths: 12, isGxpCritical: true,
    description: '品种化检索策略与频率、中英文数据库、检索记录留痕（检索式/日期/结果数）、文献个例转交 ICSR 的条件（GVP 第 36、50 条）。',
  },
  {
    code: 'AEFI-MONITOR', title: 'AEFI 监测与分类', titleEn: 'AEFI Monitoring & Classification',
    gxpAreas: ['AEFI'], appliesToRoles: ['pv_officer', 'pv_data_entry', 'pv_medical'],
    validityMonths: 24, isGxpCritical: true,
    description: '《疫苗管理法》与全国疑似预防接种异常反应监测方案：六类分类、48 小时/2 小时报告时限、群体性事件处置。',
  },
  {
    code: 'ALCOA-PLUS', title: '数据完整性（ALCOA+）', titleEn: 'Data Integrity (ALCOA+)',
    gxpAreas: ['GVP'], appliesToRoles: ['pv_head', 'pv_officer', 'pv_data_entry', 'pv_medical', 'pv_writer', 'pv_regulatory', 'literature_reviewer', 'qa_manager', 'qa_specialist', 'qa_auditor', 'trainer'],
    validityMonths: 12, isGxpCritical: true,
    description: 'ALCOA+ 原则、原始数据定义、审计追踪的查阅与审核、禁止行为清单与报告渠道。全员必修。',
  },
  {
    code: 'CSV-PART11', title: '计算机化系统验证 21 CFR Part 11', titleEn: 'Computerised Systems & 21 CFR Part 11',
    gxpAreas: ['GVP'], appliesToRoles: ['qa_manager', 'qa_specialist', 'pv_head', 'pv_officer'],
    validityMonths: 24, isGxpCritical: true,
    description: 'PV 数据库系统的验证、权限与审计追踪、电子签名的两个识别要素（Part 11.200(a)(1)(i)）。',
  },
];

// ------------------------------------------------------------------ docs ----

const DOCUMENTS = [
  { docNumber: 'SOP-PV-001', title: '个例安全性报告接收与处理规程', titleEn: 'ICSR Intake and Processing Procedure', docType: 'sop', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['ICSR', 'GVP'], summary: '规定各渠道（含销售、市场、热线、投诉）个例报告的接收、登记、四要素核验、随访与数据录入要求；禁止以信息不全为由删除报告。' },
  { docNumber: 'SOP-PV-002', title: '快速报告时限管理规程', titleEn: 'Expedited Reporting Timelines Procedure', docType: 'sop', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['ICSR', 'GVP'], summary: '厘清 Day 0（首次获知且四要素齐备）的起算规则，规定严重 ADR 15 日、非严重 30 日、死亡病例立即报告、境外 30 日/24 小时的时限与超时偏差处理。' },
  { docNumber: 'SOP-PV-003', title: '因果关系评价规程', titleEn: 'Causality Assessment Procedure', docType: 'sop', department: '医学部', reviewPeriodMonths: 24, gxpAreas: ['ICSR'], summary: 'WHO-UMC 六级评价方法、评价依据的记录要求、初始报告人意见的处理与医学审核闭环。' },
  { docNumber: 'SOP-PV-004', title: '信号检测与评估规程', titleEn: 'Signal Detection and Assessment Procedure', docType: 'sop', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['SIGNAL', 'GVP'], summary: '按品种确定检测频率、数据切片与背景库、PRR/ROR/EBGM 参考阈值、优先排序、验证-确认-评估流程与药品安全委员会审议要求。' },
  { docNumber: 'SOP-PV-005', title: 'PSUR 撰写规程', titleEn: 'PSUR Compilation Procedure', docType: 'sop', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['PSUR', 'GVP'], summary: '报告期计算与 DLP 设定、数据冻结、期内数据汇编、获益-风险评估章节撰写、内部审核与质量放行、DLP 后 60 日内提交。' },
  { docNumber: 'SOP-PV-006', title: '医学文献监测规程', titleEn: 'Medical Literature Monitoring Procedure', docType: 'sop', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['LIT', 'GVP'], summary: '品种化检索策略、中英文数据库与检索频率、检索记录留痕（检索式/日期/结果数）、文献个例的四要素判定与转交时限。' },
  { docNumber: 'SOP-PV-007', title: '药品投诉处理规程', titleEn: 'Product Complaint Handling Procedure', docType: 'sop', department: '质量保证部', reviewPeriodMonths: 24, gxpAreas: ['COMPLAINT', 'GVP'], summary: '投诉接收与登记、安全性判定（投诉中的不良反应必须转 ICSR）、质量调查、处置与召回联动、CAPA 衔接。' },
  { docNumber: 'SOP-PV-008', title: 'AEFI 报告规程', titleEn: 'AEFI Reporting Procedure', docType: 'sop', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['AEFI', 'GVP'], summary: '疑似预防接种异常反应的六类分类、48 小时个案卡与 2 小时加急报告、临床与流行病学调查、向疾控/药监上报与公众沟通。' },
  { docNumber: 'SOP-PV-009', title: '药物警戒数据完整性规程', titleEn: 'PV Data Integrity Procedure', docType: 'sop', department: '质量保证部', reviewPeriodMonths: 24, gxpAreas: ['GVP'], summary: '原始数据定义、ALCOA+ 要求、电子记录与审计追踪的查阅和审核、禁止行为清单与数据完整性事件上报渠道。' },
  { docNumber: 'PSMF-001', title: '药物警戒体系主文件（PSMF）说明文件', titleEn: 'PSMF Description Document', docType: 'pv_plan', department: '药物警戒部', reviewPeriodMonths: 12, gxpAreas: ['GVP'], summary: '描述药物警戒体系组织结构、QPPV 与专职人员、委托活动、质量体系（偏差/CAPA/变更/内审/培训）及主文件更新机制。' },
  { docNumber: 'TPL-RMP-001', title: '风险管理计划模板', titleEn: 'RMP Template', docType: 'form', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['RMP', 'GVP'], summary: '按 ICH E2E 与 CDE 临床风险管理计划撰写指导原则组织的 RMP 模板：风险清单、药物警戒计划、RMM 与有效性评估。' },
  { docNumber: 'TPL-PSUR-001', title: 'PSUR 模板', titleEn: 'PSUR Template', docType: 'form', department: '药物警戒部', reviewPeriodMonths: 24, gxpAreas: ['PSUR', 'GVP'], summary: '按 ICH E2C(R2) PBRER 与中国撰写规范组织的 PSUR 模板：暴露量、病例汇总、信号清单与获益-风险评估章节。' },
];

// ------------------------------------------------------------------- run ----

function countExistingBusinessRecords() {
  return db.get('SELECT COUNT(*) AS n FROM workflow_instances').n;
}

/** Complete a workflow step through the domain service (real role gate). */
function step(recordId, stepCode, actor, formData, comment, signatureId) {
  return workflow.completeStep({
    instanceId: recordId, stepCode, actor, ctx,
    formData, comment: `${MARKER} ${comment || ''}`.trim(), signatureId: signatureId || null,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write([
      '',
      '  Populate a LeebertyPV instance with a realistic demonstration scenario.',
      '',
      '  Usage:',
      '    node scripts/seed-demo.js              populate an empty instance',
      '    node scripts/seed-demo.js --force      also add to an instance with existing records',
      '    node scripts/seed-demo.js --dry-run    report what would be created, change nothing',
      '',
      `  Every account created uses the password:  ${DEMO_PASSWORD}`,
      '',
    ].join('\n'));
    process.exit(0);
  }

  db.open();

  process.stdout.write('\n  LeebertyPV - pharmacovigilance demonstration dataset\n');
  process.stdout.write(`  ${'='.repeat(64)}\n\n`);
  process.stdout.write('  This creates FICTIONAL PV records (ICSRs, signals, PSURs,\n');
  process.stdout.write('  deviations, CAPAs, signatures, self-inspection findings) written\n');
  process.stdout.write('  to the real audit trail.\n');
  process.stdout.write('  NEVER run this against a production instance.\n\n');

  const existing = countExistingBusinessRecords();
  if (existing > 0 && !args.force) {
    process.stdout.write(`  Refusing to run: this instance already holds ${existing} safety/quality record(s).\n`);
    process.stdout.write('  Re-run with --force only if you are certain this is a demo instance.\n\n');
    process.exit(1);
  }

  if (args.dryRun) {
    log(`would create ${PEOPLE.length} users`);
    log(`would create ${CURRICULA.length} training curricula`);
    log(`would create ${DOCUMENTS.length} controlled documents`);
    log('would create 21 workflow records:');
    log('  ICSR-EXP ×4 (1 死亡病例超时限待递交、1 严重非预期肝衰竭在医学审核、1 严重预期在分诊、1 已关闭含信号评估)');
    log('  ICSR-REG ×2 (1 数据录入中、1 已关闭)');
    log('  AEFI-EXP ×2 (1 一般反应已关闭、1 疑似严重异常反应在调查)');
    log('  SIG-DET ×2 (1 已结案的肝损伤信号检测、1 进行中)');
    log('  SIG-EVAL ×1 (信号评估待药品安全委员会审议)');
    log('  PSUR-COMP ×1 (撰写中，DLP 已设定)');
    log('  RMP-LIFE ×1 (审批途中)');
    log('  LIT-MON ×2 (1 已归档含检索留痕、1 筛查中)');
    log('  COMP-HANDLE ×1 (投诉含不良反应，已转 ICSR)');
    log('  PV-DEV ×1 (严重个例超期偏差，调查完成待 CAPA)');
    log('  PV-CAPA ×2 (1 已关闭含有效性检查、1 实施中)');
    log('  PV-CHANGE ×1 (PV 数据库系统变更待验证)');
    log('would create 1 GVP 年度自查（GVP-CN-2021 检查表）并评估，部分缺陷转 CAPA');
    log('would set up 1 overdue and 1 expiring training record');
    process.stdout.write('\n  Dry run complete. Nothing was written.\n\n');
    db.close();
    process.exit(0);
  }

  // Load the PV configuration library before creating any record, so a freshly
  // opened database (e.g. a scratch PV_DATA_DIR) has the process types and the
  // GVP-CN-2021 checklist template available. Idempotent: on an instance where
  // the server already loaded the library this is a no-op.
  seed.run({ silent: true });
  const persistColumnsAdded = ensurePersistColumns();
  if (persistColumnsAdded) {
    log(`schema: added ${persistColumnsAdded} persist column(s) to workflow_instances (engine compatibility)`);
  }

  const started = Date.now();

  // ---- people -------------------------------------------------------------
  const U = {};
  for (const person of PEOPLE) {
    U[person.username] = createUser(person);
  }
  // The administrator created during first-run setup acts as the system owner.
  // If nobody has completed setup yet, create one here so the demo can be
  // generated without a detour through the browser.
  let admin = db.get("SELECT * FROM users WHERE role = 'system_admin' AND status = 'active' ORDER BY id LIMIT 1");
  let adminCreated = false;
  if (!admin) {
    U['admin'] = createUser({
      username: 'admin', fullName: '系统负责人', fullNameEn: 'System Owner',
      role: 'system_admin', department: '信息管理部', jobTitle: '系统管理员',
      gxpAreas: ['GVP'],
    });
    admin = auth.getUserById(U['admin'].id);
    adminCreated = true;
  }
  log(`users              ${PEOPLE.length + (adminCreated ? 1 : 0)} created/updated (password: ${DEMO_PASSWORD})`);
  if (adminCreated) {
    log('                   administrator "admin" created because none existed');
  }

  // ---- curricula and training records -------------------------------------
  const curricula = {};
  for (const c of CURRICULA) {
    curricula[c.code] = training.createCurriculum({
      code: c.code, title: c.title, titleEn: c.titleEn, gxpAreas: c.gxpAreas,
      appliesToRoles: c.appliesToRoles, validityMonths: c.validityMonths,
      isGxpCritical: c.isGxpCritical, description: c.description,
    }, U['qa.manager'], ctx);
  }
  log(`curricula          ${CURRICULA.length} created`);

  /**
   * Assign and then complete a training record through the domain service, so
   * the completion flows through the same signature gate and audit path as real
   * use (a real electronic signature is applied by the trainer).
   */
  function assignAndComplete(curriculumCode, username, daysAgoDone, opts = {}) {
    const cur = curricula[curriculumCode];
    const user = U[username];
    training.assign(cur.id, { userIds: [user.id], dueDate: dateAgo(Math.max(1, daysAgoDone - 20)) }, U['trainer'], ctx);
    const rec = db.get(
      'SELECT * FROM training_records WHERE curriculum_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
      [cur.id, user.id]
    );
    // GxP-critical curricula cannot be completed without a signed record, so the
    // trainer signs the completion exactly as they would in real use.
    const signatureId = signAs(
      U['trainer'], 'training_records', rec.id, `training:${rec.id}`, 'completed',
      `确认 ${user.full_name} 已完成《${cur.title}》培训并通过考核`, null
    );
    training.recordCompletion(rec.id, {
      status: 'completed',
      method: opts.method || 'classroom',
      score: opts.score != null ? opts.score : 92,
      passMark: opts.passMark != null ? opts.passMark : 80,
      result: 'pass',
      trainerName: U['trainer'].full_name,
      trainedBy: U['trainer'].id,
      completedAt: daysAgo(daysAgoDone, 14),
      validityMonths: CURRICULA.find((x) => x.code === curriculumCode).validityMonths,
      evidence: `${MARKER} 培训记录与考核卷归档于培训档案`,
      notes: `${MARKER} 演示培训记录`,
      signatureId,
    }, U['trainer'], ctx);
    return rec.id;
  }

  // A realistic spread: most people current, a few with real gaps.
  assignAndComplete('PV-BASIC', 'pv.head', 250);
  assignAndComplete('PV-BASIC', 'pv.officer', 220);
  assignAndComplete('PV-BASIC', 'pv.dataentry', 240);
  assignAndComplete('PV-BASIC', 'pv.medical', 175);
  assignAndComplete('PV-BASIC', 'pv.writer', 170);
  assignAndComplete('PV-BASIC', 'pv.regulatory', 165);
  assignAndComplete('PV-BASIC', 'lit.monitor', 160);
  assignAndComplete('PV-BASIC', 'safety.committee', 195);
  assignAndComplete('PV-BASIC', 'qa.manager', 200);
  assignAndComplete('PV-BASIC', 'qa.specialist', 190);
  assignAndComplete('PV-BASIC', 'qa.auditor', 185);
  assignAndComplete('PV-BASIC', 'trainer', 210);

  assignAndComplete('ICSR-4ELEMS', 'pv.dataentry', 180);
  assignAndComplete('ICSR-4ELEMS', 'pv.officer', 200);
  assignAndComplete('ICSR-4ELEMS', 'pv.medical', 150);
  assignAndComplete('ICSR-4ELEMS', 'pv.regulatory', 160);
  assignAndComplete('ICSR-4ELEMS', 'lit.monitor', 90);

  assignAndComplete('MEDDRA-BASIC', 'pv.dataentry', 100);
  assignAndComplete('MEDDRA-BASIC', 'pv.officer', 120);

  assignAndComplete('CAUSALITY-UMC', 'pv.medical', 220);
  assignAndComplete('CAUSALITY-UMC', 'pv.head', 230);

  assignAndComplete('SIG-DETECT', 'pv.officer', 60);
  assignAndComplete('SIG-DETECT', 'pv.medical', 75);
  assignAndComplete('SIG-DETECT', 'pv.head', 50);

  assignAndComplete('PSUR-WRITE', 'pv.writer', 30);
  assignAndComplete('PSUR-WRITE', 'pv.medical', 40);
  assignAndComplete('PSUR-WRITE', 'pv.regulatory', 45);
  assignAndComplete('PSUR-WRITE', 'pv.head', 55);

  assignAndComplete('RMP-RMM', 'pv.head', 70);
  assignAndComplete('RMP-RMM', 'pv.medical', 80);

  assignAndComplete('LIT-SEARCH', 'lit.monitor', 20);
  assignAndComplete('LIT-SEARCH', 'pv.officer', 35);

  assignAndComplete('AEFI-MONITOR', 'pv.officer', 80);
  assignAndComplete('AEFI-MONITOR', 'pv.dataentry', 85);
  assignAndComplete('AEFI-MONITOR', 'pv.medical', 90);

  assignAndComplete('ALCOA-PLUS', 'pv.officer', 120);
  assignAndComplete('ALCOA-PLUS', 'pv.dataentry', 130);
  assignAndComplete('ALCOA-PLUS', 'qa.specialist', 60);
  assignAndComplete('ALCOA-PLUS', 'qa.manager', 65);
  assignAndComplete('ALCOA-PLUS', 'qa.auditor', 70);

  assignAndComplete('CSV-PART11', 'qa.manager', 90);
  assignAndComplete('CSV-PART11', 'qa.specialist', 95);
  assignAndComplete('CSV-PART11', 'pv.head', 100);
  assignAndComplete('CSV-PART11', 'pv.officer', 110);

  // Deliberate gaps so the dashboard has something real to report.
  // 1. An overdue assignment nobody has completed (RMP 培训 for the committee member).
  training.assign(curricula['RMP-RMM'].id, { userIds: [U['safety.committee'].id], dueDate: dateAgo(15) }, U['trainer'], ctx);
  // 2. A required curriculum never assigned to someone who needs it (MedDRA 编码必修 for the medical assessor).
  training.assign(curricula['MEDDRA-BASIC'].id, { userIds: [U['pv.medical'].id], dueDate: dayAhead(20) }, U['trainer'], ctx);
  // 3. An expired record: backdate a completion so it falls outside validity.
  const expiredRec = db.get(
    'SELECT tr.id FROM training_records tr JOIN training_curricula c ON c.id = tr.curriculum_id ' +
    "WHERE c.code = 'ALCOA-PLUS' AND tr.user_id = ? AND tr.status = 'completed'",
    [U['pv.head'].id]
  );
  if (expiredRec) {
    db.run('UPDATE training_records SET expires_at = ? WHERE id = ?', [dateAgo(25), expiredRec.id]);
  }
  log(`training records   ${db.get('SELECT COUNT(*) AS n FROM training_records').n} created (含超期与即将到期案例)`);

  // ---- controlled documents ----------------------------------------------
  const docs = {};
  for (const d of DOCUMENTS) {
    docs[d.docNumber] = documents.createDocument({
      docNumber: d.docNumber, title: d.title, titleEn: d.titleEn, docType: d.docType,
      department: d.department, reviewPeriodMonths: d.reviewPeriodMonths,
      gxpAreas: d.gxpAreas, summary: d.summary, retentionYears: 10,
      changeReason: `${MARKER} 建立演示用受控文件`,
      changeSummary: '初始发布',
    }, U['qa.manager'], ctx);
  }

  // Take most documents through to effective, leaving two deliberately behind so
  // the "stale draft" and "awaiting review" indicators have real content.
  const toRelease = Object.entries(docs).filter(([num]) => !['TPL-PSUR-001', 'TPL-RMP-001'].includes(num));
  for (const [num, doc] of toRelease) {
    const version = doc.versions[0].version;
    documents.transitionVersion(doc.id, version, 'in_review',
      { reason: `${MARKER} 提交审核` }, U['qa.specialist'], ctx);
    documents.transitionVersion(doc.id, version, 'approved',
      { reason: `${MARKER} 审核通过`, signatureId: signAs(U['qa.manager'], 'documents', doc.id, `doc:${num}`, 'approved', '文件内容符合法规与公司要求，批准发布') },
      U['qa.manager'], ctx);
    documents.transitionVersion(doc.id, version, 'effective',
      { reason: `${MARKER} 生效发布`, effectiveDate: dateAgo(60 + Math.floor(Math.random() * 300)),
        signatureId: signAs(U['qa.manager'], 'documents', doc.id, `doc:${num}`, 'released', '批准该文件于指定日期生效，并安排相关培训') },
      U['qa.manager'], ctx);
  }
  // One document left in draft (TPL-PSUR-001), one left in review (TPL-RMP-001).
  documents.transitionVersion(docs['TPL-RMP-001'].id, docs['TPL-RMP-001'].versions[0].version, 'in_review',
    { reason: `${MARKER} 已提交，等待审核` }, U['qa.specialist'], ctx);
  // Backdate review dates so the periodic-review report has overdue/soon items.
  db.run('UPDATE documents SET next_review_date = ? WHERE doc_number = ?', [dateAgo(40), 'SOP-PV-003']);
  db.run('UPDATE document_versions SET review_due_date = ? WHERE document_id = ? AND status = ?',
    [dateAgo(40), docs['SOP-PV-003'].id, 'effective']);
  db.run('UPDATE documents SET next_review_date = ? WHERE doc_number = ?', [dateAhead(12), 'SOP-PV-008']);
  db.run('UPDATE document_versions SET review_due_date = ? WHERE document_id = ? AND status = ?',
    [dateAhead(12), docs['SOP-PV-008'].id, 'effective']);
  log(`documents          ${Object.keys(docs).length} created (${toRelease.length} 生效, 1 审核中, 1 草稿, 1 审核超期, 1 即将到期)`);

  // ---- pharmacovigilance records ------------------------------------------
  const records = {};

  // ======== ICSR-EXP：严重/非预期个例快速报告（AES）========
  // 1) 死亡病例：处于递交待完成，时限已超期（置于 submission，当前步骤留白）
  {
    const dev = workflow.createInstance({
      processCode: 'ICSR-EXP',
      title: '康宁胶囊（演示）——老年女性用药后死亡病例',
      summary: `${MARKER} ${day(8)} 女性 60-69 岁组患者口服康宁胶囊（演示）期间突发晕厥送医，次日死亡；已按死亡病例程序电话报告，但书面快速报告递交尚未完成，时限已超期（死亡病例应即时报告并在 15 日内完成调查）。患者身份信息不可识别，仅记录年龄组与性别。`,
      product: '康宁胶囊（演示）', occurredAt: day(9), criticality: 'critical',
      reportSource: '自发报告', department: '药物警戒部', site: '华东制药（演示）',
      dueDate: dateAgo(3),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'intake', U['pv.dataentry'], {
      reporterName: '县人民医院 王医生（住院部）',
      reporterContact: '住院部直线电话（已登记）',
      patientInfo: '女性，60-69 岁组，既往有慢性病史（具体信息待随访补充）',
      awarenessDate: day(8), receivedDate: day(8),
      reportChannel: '电话', minimalCriteriaComplete: '齐备',
    }, '死亡病例登记，四要素齐备，立即升级处理');
    step(dev.id, 'triage', U['pv.officer'], {
      seriousness: '死亡', expectedness: '非预期（说明书外）', deathCase: '是',
      reportDeadline: dateAgo(3), routeDecision: '死亡病例（立即+15日调查）',
      needsFollowUp: '是',
      triageComment: '死亡病例按 81 号令第 21、22 条应立即报告并在 15 日内完成调查报告；获知当日已电话通报，书面快速报告应不迟于获知之日，现已超期。',
    }, '判定死亡病例，时限已超期待纠正');
    step(dev.id, 'data_entry', U['pv.dataentry'], {
      meddraTerm: '死亡', reactionStartDate: day(9), outcome: '死亡',
      dosageRegimen: '口服，每日 3 次，每次 2 粒，餐后服用；已服药约 14 天。',
      indication: '用于改善循环（演示适应症）',
      concomitantDrugs: '既往使用降压药（名称待随访确认）',
      narrative: `女性 60-69 岁组患者，${day(9)} 服药后出现头晕、心悸，当晚突发晕厥，送医后次日死亡。医院考虑与心源性因素有关，但时间上紧邻服药。患者身份信息不可识别。`,
      duplicateCheck: '未重复',
    }, '录入死亡病例信息并编码');
    step(dev.id, 'causality', U['pv.medical'], {
      causalityLevel: '可能（possible）', timeRelationship: '合理',
      dechallenge: '未停药', rechallenge: '未知',
      alternativeCause: '患者存在心血管基础疾病，尚不能排除疾病本身进展；但事件与末次服药时间关联紧密，需继续收集资料。',
      reporterInitialOpinion: '未评价（默认存在关联）',
      causalityRationale: '时间关系合理（服药后当日出现症状），存在可解释的合并病因，资料尚不完整，按 WHO-UMC 判为「可能」。',
    }, '完成因果关系初评', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'verified', '死亡病例关联性初评：可能（possible），时间关系合理，需补充合并用药与既往史', 'causality'));
    step(dev.id, 'medical_review', U['pv.medical'], {
      reviewConclusion: '同意初评', completenessCheck: '缺失需随访',
      severityFinal: '确认严重',
      reviewComments: '死亡结局确认严重；四要素齐备；死亡病例调查尚在进行，先报后补。',
      medicalLogic: '服药后及时序合理，严重性六条标准命中「死亡」，初步评价为可能相关，医学逻辑闭环。',
      reviewerNote: '建议加签后立即递交，并启动死亡病例调查（15 日内完成）。',
    }, '医学审核通过，加签后递交', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'reviewed', '审核确认严重性与初评结论，同意先报后补', 'medical_review'));
    // 递交步骤留白：待递交且已超期（报告时限超期告警）。
    records['AES-1'] = dev;
  }

  // 2) 严重非预期（肝衰竭）：处于医学审核待评价
  {
    const dev = workflow.createInstance({
      processCode: 'ICSR-EXP',
      title: '乐平注射液（演示）——严重非预期肝损伤（肝衰竭）',
      summary: `${MARKER} 男性 50-59 岁组患者使用乐平注射液（演示）期间出现黄疸、肝功能急剧恶化，临床诊断药物性肝损伤（肝衰竭倾向），已住院治疗。严重非预期，需医学审核后 15 日内快速报告。患者身份信息不可识别，仅记录年龄组与性别。`,
      product: '乐平注射液（演示）', occurredAt: day(12), criticality: 'major',
      reportSource: '自发报告', department: '药物警戒部', site: '华东制药（演示）',
      dueDate: dateAhead(5),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'intake', U['pv.dataentry'], {
      reporterName: '市第一人民医院 李医生',
      reporterContact: '消化科电话（已登记）',
      patientInfo: '男性，50-59 岁组，无乙肝/酒精性肝病史',
      awarenessDate: day(12), receivedDate: day(12),
      reportChannel: '电话', minimalCriteriaComplete: '齐备',
    }, '肝衰竭病例登记，四要素齐备');
    step(dev.id, 'triage', U['pv.officer'], {
      seriousness: '住院或住院时间延长', expectedness: '非预期（说明书外）', deathCase: '否',
      reportDeadline: dateAhead(5), routeDecision: '快速报告（15日）',
      needsFollowUp: '是',
      triageComment: `住院且说明书未提及的严重肝损伤，按 GVP 第 43、44、49 条走快速报告路径，时限自 ${day(12)} 起算 15 日。`,
    }, '判定严重非预期，进入快速报告路径');
    step(dev.id, 'data_entry', U['pv.dataentry'], {
      meddraTerm: '肝衰竭', reactionStartDate: day(12), outcome: '恢复中',
      dosageRegimen: '静脉滴注，每日 1 次，每次 100 mg，连续 8 天。',
      indication: '用于成人急性缺血性卒中辅助治疗（演示适应症）',
      concomitantDrugs: '阿司匹林（长期）、瑞舒伐他汀（长期）',
      narrative: `男性 50-59 岁组患者因急性缺血性卒中于 ${day(12)} 前开始使用乐平注射液（演示）8 天，用药第 8 天出现乏力、巩膜黄染，查 ALT 1,240 U/L、总胆红素 98 μmol/L，临床倾向药物性肝损伤并住院。既往无肝病史。患者身份信息不可识别。`,
      duplicateCheck: '未重复',
    }, '录入并完成 MedDRA 编码');
    step(dev.id, 'causality', U['pv.medical'], {
      causalityLevel: '很可能（probable）', timeRelationship: '合理',
      dechallenge: '改善', rechallenge: '未再激发',
      alternativeCause: '患者无肝病病史，无酒精滥用史；阿司匹林与瑞舒伐他汀长期稳定使用，用药时间窗不支持为新发致病因素。',
      reporterInitialOpinion: '已评价-同意',
      causalityRationale: '时间关联紧密、停药后肝功能开始改善、无更合理的替代解释，判为「很可能」。',
    }, '因果关系评价（很可能）', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'verified', '严重肝损伤很可能与本品相关，等待医学审核', 'causality'));
    // 医学审核留白：pv.medical / pv.head 待办。
    records['AES-2'] = dev;
  }

  // 3) 严重预期：分类与时限判定已完成，处于分诊后待数据录入
  {
    const dev = workflow.createInstance({
      processCode: 'ICSR-EXP',
      title: '康宁胶囊（演示）——严重但预期内的心律失常（住院）',
      summary: `${MARKER} 女性 40-49 岁组患者使用康宁胶囊（演示）后出现心悸、晕厥前状态并住院观察，说明书已收录心律失常相关不良反应，判定为严重且预期内，走快速报告 15 日时限。患者身份信息不可识别，仅记录年龄组与性别。`,
      product: '康宁胶囊（演示）', occurredAt: day(6), criticality: 'major',
      reportSource: '数字化渠道', department: '药物警戒部', site: '华东制药（演示）',
      dueDate: dateAhead(10),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'intake', U['pv.dataentry'], {
      reporterName: '患者经医院药师代报',
      reporterContact: '医院药学部（已登记）',
      patientInfo: '女性，40-49 岁组',
      awarenessDate: day(6), receivedDate: day(6),
      reportChannel: '数字化渠道', minimalCriteriaComplete: '齐备',
    }, '严重预期病例登记');
    step(dev.id, 'triage', U['pv.officer'], {
      seriousness: '住院或住院时间延长', expectedness: '预期（说明书内）', deathCase: '否',
      reportDeadline: dateAhead(10), routeDecision: '快速报告（15日）',
      needsFollowUp: '是',
      triageComment: '命中严重性六条标准（住院），对照最新说明书属预期内，按 15 日快速报告。',
    }, '分类完成：严重且预期，15 日时限');
    records['AES-3'] = dev;
  }

  // 4) 已关闭的一条：因果「很可能」，信号评估转信号检测队列
  {
    const dev = workflow.createInstance({
      processCode: 'ICSR-EXP',
      title: '乐平注射液（演示）——急性荨麻疹（住院观察）',
      summary: `${MARKER} 女性 20-29 岁组患者首次使用乐平注射液（演示）后约 30 分钟内出现全身风团样皮疹伴瘙痒，急诊观察后缓解出院；严重性命中「住院或住院时间延长」。已完成快速报告递交、随访闭环与结案，信号评估结论由无需评估转为转信号检测队列。患者身份信息不可识别，仅记录年龄组与性别。`,
      product: '乐平注射液（演示）', occurredAt: day(75), criticality: 'major',
      reportSource: '自发报告', department: '药物警戒部', site: '华东制药（演示）',
      dueDate: dateAgo(55),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'intake', U['pv.dataentry'], {
      reporterName: '市三医院 急诊科',
      reporterContact: '急诊科电话（已登记）',
      patientInfo: '女性，20-29 岁组，无药物过敏史',
      awarenessDate: day(75), receivedDate: day(75),
      reportChannel: '电话', minimalCriteriaComplete: '齐备',
    }, '急性荨麻疹病例登记');
    step(dev.id, 'triage', U['pv.officer'], {
      seriousness: '住院或住院时间延长', expectedness: '预期（说明书内）', deathCase: '否',
      reportDeadline: day(60), routeDecision: '快速报告（15日）',
      needsFollowUp: '是',
      triageComment: '严重且说明书已收录荨麻疹反应，按 15 日快速报告。',
    }, '分类完成');
    step(dev.id, 'data_entry', U['pv.dataentry'], {
      meddraTerm: '荨麻疹', reactionStartDate: day(75), outcome: '恢复',
      dosageRegimen: '静脉滴注 100 mg 单次。',
      indication: '用于成人急性缺血性卒中辅助治疗（演示适应症）',
      concomitantDrugs: '无',
      narrative: `女性 20-29 岁组患者单次滴注后约 30 分钟出现全身风团样皮疹伴瘙痒，无呼吸困难；急诊抗过敏处理后缓解，观察后出院。患者身份信息不可识别。`,
      duplicateCheck: '未重复',
    }, '录入完成');
    step(dev.id, 'causality', U['pv.medical'], {
      causalityLevel: '很可能（probable）', timeRelationship: '合理',
      dechallenge: '改善', rechallenge: '未再激发',
      alternativeCause: '无合并用药，无过敏史，无其他可解释因素。',
      reporterInitialOpinion: '已评价-同意',
      causalityRationale: '单次用药后约 30 分钟内出现、停药后改善、无替代解释，判为「很可能」；原始报告人亦判存在关联。',
    }, '因果关系评价（很可能）', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'verified', '荨麻疹很可能与本品相关', 'causality'));
    step(dev.id, 'medical_review', U['pv.medical'], {
      reviewConclusion: '同意初评', completenessCheck: '完整',
      severityFinal: '确认严重',
      reviewComments: '符合说明书预期内严重反应，评价有据，同意递交。',
      medicalLogic: '时间关系清晰，停药后缓解，因果链条闭环。',
    }, '医学审核通过', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'reviewed', '医学审核同意递交', 'medical_review'));
    step(dev.id, 'submission', U['pv.regulatory'], {
      submissionType: '首次报告', reportingTarget: '国家药品不良反应监测系统',
      submissionDate: day(58), nationalSystemReceipt: 'AES-E2B-2026-0187',
      e2bValidation: '通过', deadlineCompliance: '合规（15日内）',
    }, '15 日内完成快速报告递交并留存回执', null);
    step(dev.id, 'follow_up', U['pv.officer'], {
      followUpReason: '常规补充信息', contactDate: day(50),
      followUpResult: '患者皮疹在 24 小时内完全消退，无后遗症；未再使用本品。',
      newInfoEffect: '否', escalationNeeded: '否',
      followUpNotes: '随访闭环，无需新增报告。',
    }, '随访闭环', null);
    step(dev.id, 'closure', U['pv.head'], {
      signalAssessment: '转信号检测队列',
      dataQualityCheck: '通过', submissionComplete: '齐备',
      archiveRef: `PV-FILE-ICSR/${dev.recordKey}`,
      closureComments: `${MARKER} 递交回执与随访闭环齐备；信号评估初判无需评估，但本品种近期荨麻疹报告增多，转为 potential_signal，转 SIG-DET 信号检测队列。`,
    }, '结案并转信号检测队列', signAs(U['pv.head'], 'workflow_instances', dev.id, dev.recordKey, 'closed', '结案：回执齐备、随访闭环，信号评估 potential_signal 转检测队列', 'closure'));
    records['AES-4'] = dev;
  }

  // ======== ICSR-REG：非严重个例常规报告（AEN）========
  // 1) 皮疹病例（源自投诉，另一条 COMP-1 关联）：数据录入中
  {
    const dev = workflow.createInstance({
      processCode: 'ICSR-REG',
      title: '康宁胶囊（演示）——女性患者服药后皮疹（源自投诉）',
      summary: `${MARKER} 女性 30-39 岁组患者口服康宁胶囊（演示）数日后躯干出现散在红色皮疹，未就医，非严重；来自患者投诉渠道，投诉流程（COMP-HANDLE）安全性判定为「是」后转入本 ICSR 受理，30 日常规报告时限。患者身份信息不可识别，仅记录年龄组与性别。`,
      product: '康宁胶囊（演示）', occurredAt: day(5), criticality: 'minor',
      reportSource: '投诉', department: '药物警戒部', site: '华东制药（演示）',
      dueDate: dateAhead(20),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'intake', U['pv.dataentry'], {
      reporterName: '患者（经投诉渠道代报）',
      reporterContact: '患者本人电话（已登记）',
      patientInfo: '女性，30-39 岁组',
      awarenessDate: day(5), receivedDate: day(5),
      reportChannel: '患者投诉', minimalCriteriaComplete: '齐备',
    }, '投诉来源个例登记');
    step(dev.id, 'triage', U['pv.officer'], {
      seriousness: '非严重', expectedness: '预期（说明书内）',
      reportDeadline: dateAhead(20), escalationNeeded: '否', needsFollowUp: '是',
      triageComment: '非严重且预期内，30 日常规报告；来自患者投诉，与 COMP-HANDLE 记录关联。',
    }, '分类完成：常规报告路径');
    records['AEN-1'] = dev;
  }

  // 2) 已关闭的非严重个例
  {
    const dev = workflow.createInstance({
      processCode: 'ICSR-REG',
      title: '康宁胶囊（演示）——轻度消化不良（常规）',
      summary: `${MARKER} 女性 50-59 岁组患者口服康宁胶囊（演示）后出现腹部不适、轻度消化不良，停药后缓解，非严重且说明书已收录。已完成 30 日递交、随访闭环与结案。患者身份信息不可识别，仅记录年龄组与性别。`,
      product: '康宁胶囊（演示）', occurredAt: day(95), criticality: 'minor',
      reportSource: '自发报告', department: '药物警戒部', site: '华东制药（演示）',
      dueDate: dateAgo(60),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'intake', U['pv.dataentry'], {
      reporterName: '社区卫生服务站 张医生',
      reporterContact: '社区站电话（已登记）',
      patientInfo: '女性，50-59 岁组',
      awarenessDate: day(95), receivedDate: day(95),
      reportChannel: '电话', minimalCriteriaComplete: '齐备',
    }, '非严重个例登记');
    step(dev.id, 'triage', U['pv.officer'], {
      seriousness: '非严重', expectedness: '预期（说明书内）',
      reportDeadline: day(65), escalationNeeded: '否', needsFollowUp: '否',
      triageComment: '非严重且预期，30 日常规报告。',
    }, '分类完成');
    step(dev.id, 'data_entry', U['pv.dataentry'], {
      meddraTerm: '消化不良', reactionStartDate: day(95), outcome: '恢复',
      dosageRegimen: '口服，每日 3 次，每次 2 粒，餐后服用；用药第 5 天出现不适。',
      indication: '用于改善循环（演示适应症）',
      concomitantDrugs: '无',
      narrative: `女性 50-59 岁组患者服药第 5 天出现上腹不适、嗳气，自行停药后 2 天缓解，未就医。患者身份信息不可识别。`,
      duplicateCheck: '未重复',
    }, '录入完成');
    step(dev.id, 'causality', U['pv.medical'], {
      causalityLevel: '可能（possible）', timeRelationship: '合理',
      dechallenge: '改善', rechallenge: '未知',
      alternativeCause: '无合并用药，饮食因素不能完全排除。',
      reporterInitialOpinion: '未评价（默认存在关联）',
      causalityRationale: '时间关联合理、停药后改善，判为「可能」。',
    }, '因果关系评价', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'verified', '消化不良与本品可能相关', 'causality'));
    step(dev.id, 'medical_review', U['pv.medical'], {
      reviewConclusion: '同意初评', completenessCheck: '完整',
      severityFinal: '确认非严重',
      reviewComments: '非严重、预期内，评价一致，同意递交。',
      medicalLogic: '临床过程良性，无升级信号。',
    }, '医学审核通过', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'reviewed', '医学审核同意', 'medical_review'));
    step(dev.id, 'submission', U['pv.regulatory'], {
      submissionType: '首次报告', reportingTarget: '国家药品不良反应监测系统',
      submissionDate: day(70), nationalSystemReceipt: 'AEN-E2B-2026-0093',
      e2bValidation: '通过', deadlineCompliance: '合规（30日内）',
    }, '30 日内完成常规报告递交', null);
    step(dev.id, 'follow_up', U['pv.officer'], {
      followUpReason: '常规补充信息', contactDate: day(60),
      followUpResult: '症状缓解，未再用药，无新信息。',
      newInfoEffect: '否', escalationToExp: '否',
      followUpNotes: '随访闭环。',
    }, '随访闭环', null);
    step(dev.id, 'closure', U['pv.head'], {
      signalAssessment: '无需信号评估',
      dataQualityCheck: '通过', submissionComplete: '齐备',
      archiveRef: `PV-FILE-ICSR/${dev.recordKey}`,
      closureComments: `${MARKER} 非严重个例递交与随访闭环，无需信号评估，结案归档。`,
    }, '结案归档', signAs(U['pv.head'], 'workflow_instances', dev.id, dev.recordKey, 'closed', '结案：常规报告闭环', 'closure'));
    records['AEN-2'] = dev;
  }

  // ======== AEFI-EXP：疑似预防接种异常反应（AEFI）========
  // 1) 一般反应：已关闭
  {
    const dev = workflow.createInstance({
      processCode: 'AEFI-EXP',
      title: '乐福疫苗（演示）——接种后低热与局部红肿（一般反应）',
      summary: `${MARKER} 儿童（7-17 岁组）接种乐福疫苗（演示）批号 L2026-0301 第 1 剂后约 6 小时出现低热（37.8℃）与局部红肿，48 小时内消退；分类为一般反应，个案报告卡在 48 小时内填报，已结案。患者身份信息不可识别，仅记录年龄组。`,
      product: '乐福疫苗（演示）', occurredAt: day(120), population: '儿童（7-17岁）',
      severityClass: '一般', reportChannel: '接种单位',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAgo(110),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'receive', U['pv.dataentry'], {
      reporterInfo: '接种门诊 陈护士',
      vaccinationDate: day(120), lotNumber: 'L2026-0301', doseNumber: '第 1 剂',
      initialSeverity: '一般', verificationResult: '核实为真实接种，接种操作规范，疫苗在效期内。',
      reportMode: '48小时个案卡',
    }, '接收并初步核实');
    step(dev.id, 'classify', U['pv.officer'], {
      aefiCategory: '一般反应', classifyBasis: '低热与局部红肿为常见接种后反应，符合一般反应特征。',
      exclusionCheck: '是-不属于异常反应', severityConfirm: '一般（48小时）',
      reportTimeline: '48小时个案卡',
      classificationNote: '无惊厥、过敏等异常表现。',
    }, '分类为一般反应');
    step(dev.id, 'investigate', U['pv.officer'], {
      clinicalData: '低热 37.8℃、接种部位红肿直径约 2 cm，无压痛加重，48 小时内自行缓解。',
      epidemiologicalData: '同批号 L2026-0301 门诊当日接种 86 人，仅此 1 例报告，无聚集性。',
      lotDisposition: '无需处置', preliminaryFindings: '符合一般反应表现，无疫苗质量异常线索。',
      qualityReportPlan: '不需要',
    }, '完成临床与流行病学调查');
    step(dev.id, 'causality', U['pv.medical'], {
      causalityConclusion: '可能相关', evidenceBasis: '接种后约 6 小时出现，48 小时缓解，符合一般反应时限特征；同批号无聚集。',
      alternativeExplanation: '偶合呼吸道感染证据不足，无其他解释。',
      timeAssociation: '合理', classificationImpact: '维持原分类',
    }, '因果评价：可能相关', signAs(U['pv.medical'], 'workflow_instances', dev.id, dev.recordKey, 'verified', '一般反应，与疫苗接种可能相关', 'causality'));
    step(dev.id, 'report', U['pv.regulatory'], {
      reportTarget: '疾控中心', caseCardNo: 'AEFI-CARD-2026-0081',
      reportDate: day(119), reportMode: '48小时个案卡填报',
      receiptNumber: 'AEFI-RCPT-2026-0081', escalationToAuthority: '不需要',
    }, '48 小时内填报个案报告卡', null);
    step(dev.id, 'response', U['pv.head'], {
      communicationStrategy: '接种点通知与科普', riskControl: '无需',
      compensationCoordination: '不适用', committeeEscalation: '无需',
      communicationOwner: '药物警戒部（刘悦）',
      responseRecord: '已向接种门诊反馈处理建议并安抚家长，无舆情风险。',
    }, '公众沟通与后续处置');
    step(dev.id, 'closure', U['pv.head'], {
      investigationClosed: '完成', submissionVerified: '齐备',
      finalConclusion: '一般反应，可能与疫苗接种相关，无需特别处置，个案关闭。',
      archiveRef: `PV-FILE-AEFI/${dev.recordKey}`, lessonsLearned: '持续关注同批号后续报告。',
      compensationStatus: '不适用',
    }, '结案归档', signAs(U['pv.head'], 'workflow_instances', dev.id, dev.recordKey, 'closed', '结案：一般反应处置闭环', 'closure'));
    records['AEFI-1'] = dev;
  }

  // 2) 疑似严重异常反应：调查中
  {
    const dev = workflow.createInstance({
      processCode: 'AEFI-EXP',
      title: '乐福疫苗（演示）——接种后疑似严重异常反应（死亡病例调查中）',
      summary: `${MARKER} 成人（18-59 岁组）接种乐福疫苗（演示）批号 L2026-0412 第 2 剂后次日突发意识障碍，送医后死亡，正在临床与流行病学调查。按死亡病例 2 小时加急报告，调查未完成。患者身份信息不可识别，仅记录年龄组。`,
      product: '乐福疫苗（演示）', occurredAt: day(4), population: '成人（18-59岁）',
      severityClass: '死亡', reportChannel: '医疗机构',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAhead(1),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'receive', U['pv.dataentry'], {
      reporterInfo: '市疾控中心反馈（经办人 赵某）',
      vaccinationDate: day(5), lotNumber: 'L2026-0412', doseNumber: '第 2 剂',
      initialSeverity: '死亡', verificationResult: '核实为真实接种，接种记录与疫苗批号一致，正在调取病历。',
      reportMode: '2小时加急报告',
    }, '按死亡病例 2 小时时限升级');
    step(dev.id, 'classify', U['pv.officer'], {
      aefiCategory: '异常反应', classifyBasis: '死亡病例，须按异常反应路径调查；最终分类待因果评价。',
      exclusionCheck: '否', severityConfirm: '死亡/严重残疾/群体性/重大影响（2小时）',
      reportTimeline: '2小时加急',
      classificationNote: '已电话报告疾控中心，待组织调查。',
    }, '分类为疑似异常反应（死亡）');
    // 调查留白：临床与流行病学调查进行中。
    records['AEFI-2'] = dev;
  }

  // ======== SIG-DET：信号检测（SIG）========
  // 1) 已结案的肝损伤信号检测（PRR 阈值、数据库切片、优先排序）
  {
    const dev = workflow.createInstance({
      processCode: 'SIG-DET',
      title: '乐平注射液（演示）肝损伤信号检测',
      summary: `${MARKER} 对乐平注射液（演示）上市后 12 个月自发报告数据库切片（${day(45)}）进行 PRR 比例失衡检测：肝细胞损伤组合命中 PRR 4.2、χ² 28.6、n=17，经人工审阅与优先排序后确认检出信号，检测记录已归档，并转入 SIG-EVAL 评估。患者身份信息不可识别。`,
      product: '乐平注射液（演示）', observationWindow: '近12个月',
      method: 'PRR', thresholdUsed: 'PRR≥2 且 χ²≥4 且 n≥3（MHRA）',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAgo(30),
    }, U['pv.officer'], ctx);
    step(dev.id, 'data_prep', U['pv.officer'], {
      dataSource: '自发报告数据库', dbSnapshotDate: day(45),
      backgroundDb: '自有安全数据库（演示库 v2026.2）',
      windowStart: dateAgo(410), windowEnd: day(45), observationWindowSet: '近12个月',
      productFilter: '乐平注射液（演示）全部相关报告，含合并用药对照，不含境外数据（另立切片）',
    }, '锁定数据切片与观察期');
    step(dev.id, 'computation', U['pv.officer'], {
      methodUsed: 'PRR', thresholdUsedSet: 'PRR≥2 且 χ²≥4 且 n≥3（MHRA）',
      minCaseCount: '3', stratification: '按年龄组、适应症分层复核',
      outputFile: 'SIG-2026-LP-LIVER.xlsx（内部归档）',
      computationNote: '使用 MedDRA PT 级汇总；肝细胞损伤组包括 PT：肝损伤、肝衰竭、肝酶升高。',
    }, '完成比例失衡计算');
    step(dev.id, 'screening', U['pv.officer'], {
      hitsList: '乐平注射液-肝细胞损伤（PRR 4.2, χ² 28.6, n=17）；乐平注射液-皮疹（PRR 2.1, χ² 6.8, n=11，弱信号保留观察）',
      manualReview: '逐一核对 17 例肝损伤个例：剔除 2 例重复报告与 1 例明显适应症偏倚（晚期肝病用药）后剩 n=14，机制与临床报告方向一致。',
      duplicateCheck: '通过', biasNote: '本品用于卒中人群，部分个例存在合并用药，已分层复核。',
      screeningResult: '保留',
    }, '人工审阅完成，保留肝损伤组合');
    step(dev.id, 'prioritisation', U['pv.medical'], {
      severityLevel: '住院/残疾', noveltyLevel: '说明书未提及',
      exposureLevel: '中', preventability: '中',
      priorityLevel: '高优先',
      priorityRationale: '严重性高、说明书未提及、暴露量中等且已有住院个例，按 GVP 第 59 条列为高优先。',
    }, '优先排序：高优先');
    step(dev.id, 'documented', U['pv.officer'], {
      detectionRecord: `切片 ${day(45)}；方法 PRR（MHRA 阈值）；人工审阅剔除 3 例伪信号后 n=14；排序高优先；全程留痕见检测工作表。`,
      detectionConclusion: '检出信号', actionRecommendation: '转入信号评估（SIG-EVAL）',
      linkedRecordNo: '', attachmentLink: 'SIG-2026-LP-LIVER.xlsx',
      documentRemarks: '关联的 SIG-EVAL 记录由药物警戒专员在评估启动后回填编号。',
    }, '形成信号检测记录并签名确认', signAs(U['pv.officer'], 'workflow_instances', dev.id, dev.recordKey, 'verified', '确认信号检测记录完整：方法、阈值、切片、审阅与排序均有留痕', 'documented'));
    step(dev.id, 'closed', U['pv.head'], {
      closureSummary: '肝损伤信号已检出并转入 SIG-EVAL 评估；皮疹组合为弱信号保留至下期复检。',
      closureDate: day(40), archivePath: `PV-FILE-SIGNAL/${dev.recordKey}`,
      followupPlan: '下季度复检皮疹组合；评估结论回填后归档。',
      closureRemarks: '结案归档，保存至注册证书注销后 10 年。',
    }, '结案归档', signAs(U['pv.head'], 'workflow_instances', dev.id, dev.recordKey, 'approved', '批准结案：信号去向已落实', 'closed'));
    records['SIG-1'] = dev;
  }

  // 2) 进行中的信号检测
  {
    const dev = workflow.createInstance({
      processCode: 'SIG-DET',
      title: '康宁胶囊（演示）心律失常相关信号检测',
      summary: `${MARKER} 对康宁胶囊（演示）近 6 个月数据库切片进行 ROR 检测，筛查心律失常相关组合；计算完成，正在人工审阅初筛清单。`,
      product: '康宁胶囊（演示）', observationWindow: '近6个月',
      method: 'ROR', thresholdUsed: 'ROR 95%CI下限≥1',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAhead(20),
    }, U['pv.officer'], ctx);
    step(dev.id, 'data_prep', U['pv.officer'], {
      dataSource: '多来源汇总', dbSnapshotDate: day(7),
      backgroundDb: '自有安全数据库（演示库 v2026.2）',
      windowStart: dateAgo(190), windowEnd: day(7), observationWindowSet: '近6个月',
      productFilter: '康宁胶囊（演示）全部剂量规格，含合并用药背景。',
    }, '数据准备完成');
    step(dev.id, 'computation', U['pv.officer'], {
      methodUsed: 'ROR', thresholdUsedSet: 'ROR 95%CI下限≥1',
      minCaseCount: '3', stratification: '按年龄组分层',
      outputFile: 'SIG-2026-KN-RHYTHM.xlsx（内部归档）',
      computationNote: 'ROR 计算含 95% CI；初筛命中 3 个药品-事件组合。',
    }, 'ROR 计算完成');
    // screening 留白：人工审阅待办。
    records['SIG-2'] = dev;
  }

  // ======== SIG-EVAL：信号评估（SIGA）========
  {
    const dev = workflow.createInstance({
      processCode: 'SIG-EVAL',
      title: '乐平注射液（演示）肝损伤信号评估',
      summary: `${MARKER} 承接 SIG-DET 检出的肝损伤信号（PRR 4.2, n=17），已完成验证、确认与临床评估，现提交药品安全委员会审议。`,
      sourceSignal: records['SIG-1'] ? records['SIG-1'].recordKey : 'SIG-2026-0001',
      product: '乐平注射液（演示）',
      eventTerms: '肝损伤、肝衰竭、肝酶升高（MedDRA PT）',
      impact: '严重程度较高，多有住院，说明书未提及；发生率估算约 2.1 例/10 万患者年。',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAhead(25),
    }, U['pv.officer'], ctx);
    step(dev.id, 'validation', U['pv.officer'], {
      sourceCheck: '来自SIG-DET检测', duplicateExclusion: '已排除',
      validationBasis: '检测记录显示 14 例（剔除重复与偏倚后）肝损伤个例，时间关联明确，与文献与机制方向一致，值得评估。',
      validationResult: '有效信号', validationDate: day(38),
      validationRemarks: '由检测专员记录，确认非伪信号。',
    }, '信号验证通过');
    step(dev.id, 'confirmation', U['pv.medical'], {
      evidenceSummary: '14 例肝损伤个例时间关联明确，10 例停药后肝功能改善；文献支持本品经肝脏代谢。',
      causalityLevel: '很可能', rechallengeInfo: '仅有停药好转',
      biologicPlausibility: '有机制支持', confirmationResult: '确认为信号',
      confirmRemarks: '由独立于检测专员的医学评价员确认。',
    }, '信号确认');
    step(dev.id, 'clinical_assessment', U['pv.medical'], {
      assessSeverity: '住院/残疾', assessIncidence: '约 2.1 例/10 万患者年（按销量折算暴露量估算）',
      timeRelation: '用药后 1-4 周出现肝功能异常，停药后改善。',
      dechallengeRechallenge: '仅停药好转',
      riskType: '潜在风险',
      assessmentReport: '证据强度中等，机制合理，严重程度高，当前获益-风险平衡尚可维持但需加强监测并考虑说明书更新。',
    }, '完成临床与流行病学评估');
    // committee 留白：safety.committee 待办（药品安全委员会审议）。
    records['SIGA-1'] = dev;
  }

  // ======== PSUR-COMP：定期安全性更新报告（PSUR）========
  {
    const dev = workflow.createInstance({
      processCode: 'PSUR-COMP',
      title: '康宁胶囊（演示）2026 年度 PSUR',
      summary: `${MARKER} 康宁胶囊（演示）年度 PSUR：DLP 已锁定（${day(40)}），数据已冻结并完成汇编，正在撰写获益-风险评估章节；法定提交时限为 DLP 后 60 日内（${dayAhead(20)}）。`,
      product: '康宁胶囊（演示）', dlp: day(40),
      periodStart: dateAgo(430), periodEnd: day(40), rhythm: 'annual',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAhead(20),
    }, U['pv.writer'], ctx);
    step(dev.id, 'datalock', U['pv.writer'], {
      cycleBasis: '首次批准证明文件日', overlapCheck: '无重叠',
      freezeTimestamp: day(40), dataFreezeScope: `自有安全数据库（演示库）全部已完结与进行中个例，冻结时刻 ${day(40)} 00:00。`,
      lateArrivalsNote: 'DLP 后新到个例列入下期并在文中说明（ICH E2C(R2) 迟发信息）。',
      datalockRemarks: '与上期 PSUR 报告期无重叠、无缺口。',
    }, '设定 DLP 并冻结数据');
    step(dev.id, 'assembly', U['pv.dataentry'], {
      caseLineListing: '期内严重个例 3 例（死亡 1、住院 2）、非严重 18 例；line listing 与汇总表见汇编工作表。',
      exposureData: '按销售数量折算约 8.6 万患者年暴露。',
      signalList: '期内检出 1 个信号（心律失常，待评估）；无已确认信号。',
      dataQualityNote: '重复报告 1 例已合并；缺失四要素个案 2 例已在跟进。',
      assemblyRemarks: '与数据库交叉核对一致。',
    }, '期内数据汇编完成');
    // writing 留白：pv.writer / pv.medical 撰写待办。
    records['PSUR-1'] = dev;
  }

  // ======== RMP-LIFE：风险管理计划（RMP）========
  {
    const dev = workflow.createInstance({
      processCode: 'RMP-LIFE',
      title: '乐平注射液（演示）风险管理计划 V1.0',
      summary: `${MARKER} 乐平注射液（演示）RMP：产品与风险范围、重要风险与缺失信息清单、药物警戒计划与 RMM 设计已完成，待质量放行审批后实施。`,
      product: '乐平注射液（演示）', indication: '成人急性缺血性卒中辅助治疗（演示适应症）',
      riskCategory: '重要潜在风险',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAhead(45),
    }, U['pv.officer'], ctx);
    step(dev.id, 'scope', U['pv.officer'], {
      productInfo: '乐平注射液（演示）（规格：100 mg/支），国内上市约 18 个月，目标人群为急性缺血性卒中患者。',
      dataSources: '说明书、PSUR（首期）、信号评估（肝损伤 SIG-EVAL）、上市后研究计划。',
      scopeConfirm: '已确认', attachedDoc: '产品说明书 v3.0、首期 PSUR 摘要',
      scopeRemarks: '范围仅限国内上市品种。',
    }, '确定产品与风险范围');
    step(dev.id, 'risk_profile', U['pv.medical'], {
      identifiedRisks: '注射部位反应（说明书已收录，低风险）。',
      potentialRisks: '药物性肝损伤（信号评估中）、心律失常（说明书未提及，信号检测关注）。',
      missingInfo: '老年人（75 岁以上）用药安全性、肝功能异常患者的用药数据。',
      evidenceLevel: '肝损伤：中等证据（14 例个案+机制）；心律失常：弱证据（信号筛选中）。',
      riskListReview: '已复核一致',
    }, '完成风险清单');
    step(dev.id, 'pv_plan', U['pv.officer'], {
      routineActivities: '常规个例报告处理、快速报告时限管理、季度信号检测、年度 PSUR。',
      additionalActivities: '上市后肝肾功能专项监测方案（计划 500 例，与 3 家中心合作）；说明书更新后随访。',
      planObjective: '专项监测目的：验证肝损伤发生率估计值；样本量 500 例；12 个月完成；以 ALT/AST 监测达标为成功标准。',
      planReview: '完善', planRemarks: '与信号评估处置建议衔接。',
    }, '完成药物警戒计划');
    step(dev.id, 'rmm_design', U['pv.head'], {
      routineRmm: '说明书增加肝功能监测提示（拟修订）与肝功能异常者慎用语句。',
      additionalRmm: '致医务人员函（DHPC）告知肝损伤风险与监测建议。',
      targetRisk: 'DHPC 与说明书修订针对药物性肝损伤潜在风险；暂无针对心律失常的独立措施（待信号结论）。',
      feasibility: '说明书修订走年度再注册前变更窗口；DHPC 需经质量与医学审核，4 个工作日内可发出。',
      designReview: '通过',
    }, '完成 RMM 设计');
    // approval 留白：pv.head / qa.manager 审批待办（药品安全委员会审议+质量放行）。
    records['RMP-1'] = dev;
  }

  // ======== LIT-MON：医学文献监测（LIT）========
  // 1) 已归档周期（含检索式/日期/结果数，个例转交 ICSR）
  {
    const dev = workflow.createInstance({
      processCode: 'LIT-MON',
      title: '康宁胶囊（演示）文献监测 2026 年第 3 期',
      summary: `${MARKER} 康宁胶囊（演示）月刊文献检索第 3 期：多库联合检索命中 38 篇，筛出 1 篇含本产品非严重个例的文献，按四要素判定转入 ICSR 受理（AEN-2），检索记录已归档。`,
      product: '康宁胶囊（演示）', database: '多库联合', frequency: 'monthly',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAgo(85),
    }, U['lit.monitor'], ctx);
    step(dev.id, 'schedule', U['lit.monitor'], {
      databaseList: 'PubMed/Medline、CNKI、万方、维普（多库联合）',
      journalList: '《中国新药杂志》《中国临床药理学杂志》等中文核心期刊',
      searchFrequency: 'monthly', searchStrategy: '「康宁胶囊」AND (不良反应 OR 不良事件 OR adverse reaction) 中英文同义词组。',
      retentionPlan: '检索记录按 SOP-PV-006 归档至 PV-FILE-LIT。',
      scheduleConfirm: '已确认',
    }, '建立检索计划');
    step(dev.id, 'search', U['lit.monitor'], {
      searchDate: day(95), searchText: 'Kangning capsule AND (adverse event OR adverse reaction OR safety)；中文同义检索式。',
      hitCount: '38', coveragePeriod: `${day(95)} 起往前 30 天，与上期连续`,
      engineVersion: 'PubMed 2026-07 版界面；CNKI 2026-07',
      searchRemarks: '结果数已核对。',
    }, '执行定期检索');
    step(dev.id, 'screen', U['lit.monitor'], {
      hitsList: '38 篇命中文献清单（标题/作者/年份索引见检索工作表）',
      relevantSelection: '1 篇疑似相关：《康宁胶囊致消化不良 1 例》',
      screenCriteria: '是否涉及本品、是否个例报道、是否新增安全性信息',
      screenResult: '有疑似个例',
      screenRemarks: '该文献含可识别患者信息，按四要素处理。',
    }, '完成人工筛查');
    step(dev.id, 'triage', U['lit.monitor'], {
      fourElements: '齐备', attribution: '可疑药品为本产品',
      seriousness: '非严重', reportDeadline: day(95),
      triageResult: '转入ICSR受理',
    }, '判为可上报个例，起算文献获知时限');
    step(dev.id, 'handover', U['pv.officer'], {
      targetCaseNo: records['AEN-2'] ? records['AEN-2'].recordKey : 'AEN-2026-0002',
      caseSummary: '文献报道 1 例使用康宁胶囊（演示）后出现消化不良，四要素齐备，非严重。',
      handoverDate: day(94), literatureRef: '张三 等. 康宁胶囊致消化不良 1 例[J]. 中国临床药理学杂志, 2026.',
      receivedConfirm: '已受理',
    }, '转交 ICSR 受理并记录', null);
    step(dev.id, 'archive', U['lit.monitor'], {
      searchRecords: `第 3 期：检索式、日期（${day(95)}）、结果数 38、筛查 1 篇、分流转交 AEN-2。`,
      missingLog: '无归属不确定文献。',
      archivePath: `PV-FILE-LIT/${dev.recordKey}`, retentionNote: '保存至注册证书注销后 10 年（GVP 第 115 条）。',
      archiveDate: day(90),
    }, '检索记录归档');
    step(dev.id, 'closed', U['pv.head'], {
      cycleSummary: '第 3 期检索-筛查-分流全链路完成，1 例转交 ICSR 并确认受理。',
      nextSchedule: dayAhead(10), closureDate: day(90),
      closeRemarks: '周期闭环。', closeVerify: '已核对转交闭环',
    }, '周期结案', signAs(U['pv.head'], 'workflow_instances', dev.id, dev.recordKey, 'approved', '批准结案：检索连续性保持，个例转交闭环', 'closed'));
    records['LIT-1'] = dev;
  }

  // 2) 筛查中
  {
    const dev = workflow.createInstance({
      processCode: 'LIT-MON',
      title: '乐平注射液（演示）文献监测 2026 年第 28 周',
      summary: `${MARKER} 乐平注射液（演示）周度文献检索第 28 周：PubMed/Medline 检索完成，命中 17 篇，正在人工筛查标题摘要。`,
      product: '乐平注射液（演示）', database: 'PubMed/Medline', frequency: 'weekly',
      department: '药物警戒部', site: '华东制药（演示）', dueDate: dateAhead(7),
    }, U['lit.monitor'], ctx);
    step(dev.id, 'schedule', U['lit.monitor'], {
      databaseList: 'PubMed/Medline（EMA 覆盖品种周检）',
      journalList: 'Stroke、Neurology 等',
      searchFrequency: 'weekly', searchStrategy: 'Leping injection AND (liver injury OR hepatic OR adverse event)。',
      retentionPlan: '按 SOP-PV-006 留痕。',
      scheduleConfirm: '已确认',
    }, '确认检索计划');
    step(dev.id, 'search', U['lit.monitor'], {
      searchDate: day(1), searchText: 'Leping injection AND (liver injury OR hepatic OR adverse event OR safety)',
      hitCount: '17', coveragePeriod: `上周 ${day(8)} 至今，连续无缺口`,
      engineVersion: 'PubMed 2026-07',
      searchRemarks: '结果数已核对。',
    }, '完成周度检索');
    // screen 留白：筛查待办。
    records['LIT-2'] = dev;
  }

  // ======== COMP-HANDLE：药品投诉与召回联动（COMP）========
  {
    const dev = workflow.createInstance({
      processCode: 'COMP-HANDLE',
      title: '康宁胶囊（演示）患者投诉：服药后出现皮疹',
      summary: `${MARKER} 患者经电话投诉：服用康宁胶囊（演示）批号 B2026-0601 后出现皮疹。接收与安全性判定已完成，判定疑似不良反应并转入 ICSR（关联 AEN-1），质量调查待开展。患者身份信息不可识别，仅记录年龄组。`,
      product: '康宁胶囊（演示）', batchNumber: 'B2026-0601',
      complaintChannel: '电话', wasSafetyRelated: '是',
      department: '质量保证部', site: '华东制药（演示）', dueDate: dateAhead(20),
    }, U['pv.dataentry'], ctx);
    step(dev.id, 'receive', U['pv.dataentry'], {
      title: dev.title, product: '康宁胶囊（演示）', complaintChannel: '电话',
      recv_complaintDate: day(5), recv_contactTime: day(5),
      recv_complainantCategory: '患者/消费者', recv_complainantName: '患者本人（匿名登记，联系方式已录入）',
      recv_channelDetail: '公司 400 热线转药物警戒部',
      recv_contentDetail: '患者自述服用批号 B2026-0601 康宁胶囊（演示）数日后躯干出现红色皮疹，伴轻度瘙痒，未就医；询问是否药品质量问题。',
      recv_attachments: '无（电话投诉）',
    }, '登记投诉并保存记录');
    step(dev.id, 'safety_triage', U['pv.officer'], {
      wasSafetyRelated: '是',
      tri_adverseReaction: '是', tri_patientHarm: '轻微伤害（未就医）',
      tri_seriousness: '非严重', tri_icsrLink: records['AEN-1'] ? records['AEN-1'].recordKey : 'AEN-2026-0001',
      tri_medicalReview: '是',
      tri_conclusion: '投诉内容含疑似不良反应描述，不得按纯质量问题处理：先转入 ICSR 受理（AEN-1），30 日常规报告；质量调查同步开展。',
    }, '安全性判定为「是」，转入 ICSR 受理');
    // qualify 留白：qa.specialist / qa.manager 质量调查待办。
    records['COMP-1'] = dev;
  }

  // ======== PV-DEV：药物警戒质量偏差（DEV）========
  {
    const dev = workflow.createInstance({
      processCode: 'PV-DEV',
      title: '严重个例报告超时限提交偏差',
      summary: `${MARKER} ${day(20)} 复核发现 1 例严重个例（死亡病例）的书面快速报告比获知日晚了 3 个自然日才递交，构成报告时限偏差。已完成即时遏制、根本原因调查与影响评估，待制定 CAPA。`,
      occurredAt: day(20), processArea: '报告提交与时限', impactOnTimelines: '是',
      criticality: 'critical', department: '质量保证部', site: '华东制药（演示）',
      dueDate: dateAhead(10),
    }, U['pv.regulatory'], ctx);
    step(dev.id, 'report', U['pv.regulatory'], {
      rep_discoveredBy: '孙晓峰（信息报送专员）',
      rep_deviationType: '报告时限偏差',
      rep_containment: '立即完成书面快速报告补报并留存系统回执；电话报告死亡病例已同步核实；冻结相关时限台账。',
      rep_affectedRecords: 'AES-2026-xxxx（死亡病例严重个例 1 例）',
      rep_detail: `首次获知日 ${day(20)}，书面快速报告本应于当日递交，实际 ${day(17)}（晚 3 个自然日）递交；期间随访信息滞留在录入员邮箱未导入系统。`,
    }, '发现并即时遏制');
    step(dev.id, 'investigate', U['qa.specialist'], {
      processArea: '报告提交与时限',
      inv_method: '5 Why + 邮箱与系统日志分析',
      inv_evidence: `随访邮件时间戳（${day(20)} 08:12 到达录入员邮箱）、系统导入记录（${day(17)} 15:05）、补报回执（${day(17)}）。`,
      inv_rootCause: '随访邮件进入个人邮箱后无系统自动提醒，录入员休假期间无代理接收；系统时限看板仅在个案进入系统后才启动计时，对「已获知但未登记」状态无预警。',
      inv_factors: '录入员休假未设置邮件自动转发；无超期升级 SLA。',
      inv_conclusion: '根因为系统与流程对获知-登记间隙缺乏管控与升级机制，而非个别人员疏忽。',
    }, '根本原因调查完成');
    step(dev.id, 'impact', U['qa.manager'], {
      impactOnTimelines: '是',
      imp_scope: '受影响 1 例死亡病例书面报告晚 3 个自然日；已补报并获回执；未影响其他报告。',
      imp_timeline: '是', imp_overdue: '1 例',
      imp_dataIntegrity: '轻微', imp_regulatory: '公司内部评估是否需要向省中心书面说明，建议按偏差记录备查。',
      imp_severity: 'major',
    }, '完成影响评估（严重度 major）');
    // capa 留白：qa.specialist 制定 CAPA 计划待办。
    records['DEV-1'] = dev;
  }

  // ======== PV-CAPA：纠正与预防措施（CAPA）========
  // 1) 已关闭，含有有效性检查
  {
    const capa = workflow.createInstance({
      processCode: 'PV-CAPA',
      title: '修订个例报告接收 SOP 并建立超期自动升级',
      summary: `${MARKER} 源自药物警戒体系自查缺陷：随访信息滞留个人邮箱导致 1 例严重报告超期。纠正措施为补报并修订接收渠道管理，预防措施为系统超期自动升级与邮件代理机制。有效性核查通过后关闭。`,
      sourceType: '内审发现', department: '质量保证部', site: '华东制药（演示）',
      dueDate: dateAgo(40),
    }, U['qa.specialist'], ctx);
    step(capa.id, 'plan', U['qa.specialist'], {
      sourceType: '内审发现', dueDate: dateAgo(40),
      plan_corrective: '1. 补报超期严重报告并留存回执；2. 对全渠道邮箱建立每日清空核对机制。',
      plan_preventive: '1. 修订 SOP-PV-001 与 SOP-PV-002，明确获知-登记间隙管控；2. 系统时限看板对超 24 小时未登记个案自动升级至 QPPV；3. 休假代理与邮件自动转发。',
      plan_owners: '刘悦（PV）、王涛（QA）', plan_due: dateAgo(45),
      plan_review: 'QA 评审通过：措施针对根因且可验证。',
    }, '制定措施计划');
    step(capa.id, 'implement', U['qa.specialist'], {
      imp_actions: '补报完成并归档回执；升级规则（24 小时未登记→QPPV）已上线时限看板；邮件转发规则已配置并测试。',
      imp_evidence: 'SOP-PV-001 v2.0 生效记录、时限看板升级日志截图、邮件转发配置单。',
      imp_date: dateAgo(35), imp_obstacles: '升级规则经 2 轮与系统管理员联调，上线延迟 2 天。',
      imp_status: '全部完成',
    }, '措施实施完成，证据齐备');
    const sigEff = signAs(U['qa.manager'], 'workflow_instances', capa.id, capa.recordKey, 'verified', '有效性核查：观察期 30 天内无同类超期，时限指标恢复合规', 'effectiveness');
    step(capa.id, 'effectiveness', U['qa.manager'], {
      eff_recurrence: '未复发', eff_timeline: '是',
      eff_conclusion: '有效', eff_followup: '否',
      eff_method: '观察期 30 天：时限台账复查未发现同类超期；抽查 10 例严重报告递交通讯录均合规。',
    }, '有效性核查通过（独立于实施人）', sigEff);
    step(capa.id, 'close', U['qa.manager'], {
      clo_comment: '措施实施与有效性核查均已完成，关联偏差闭环，同意关闭。',
      clo_lessons: '获知-登记间隙必须纳入时限监控范围。',
      clo_date: dateAgo(28),
      clo_effectivenessConfirmed: '是', clo_relatedClosed: '是',
    }, '关闭并归档', signAs(U['qa.manager'], 'workflow_instances', capa.id, capa.recordKey, 'approved', '批准关闭：CAPA 闭环', 'close'));
    records['CAPA-1'] = capa;
  }

  // 2) 实施中且已超期（源自 PV-DEV 关联）
  {
    const capa = workflow.createInstance({
      processCode: 'PV-CAPA',
      title: '修订报告时限监控规则并配置系统自动提醒',
      summary: `${MARKER} 源自 PV-DEV（严重个例报告超时限偏差）关联 CAPA：将「24 小时未登记自动升级」规则扩展至全部严重/快速报告渠道并完成相关人员培训。措施计划已批准，实施中且已超期。`,
      sourceType: '时限超期', department: '质量保证部', site: '华东制药（演示）',
      dueDate: dateAgo(8),
      parentId: records['DEV-1'] ? records['DEV-1'].id : null, linkType: 'capa_for',
    }, U['qa.specialist'], ctx);
    step(capa.id, 'plan', U['qa.specialist'], {
      sourceType: '时限超期', dueDate: dateAgo(8),
      plan_corrective: '对近 3 个月全部快速报告渠道开展时限合规回溯核查。',
      plan_preventive: '1. 时限看板升级规则覆盖所有快速报告渠道；2. 快速报告相关岗位完成时限管理培训；3. 季度复核升级规则有效性。',
      plan_owners: '王涛（QA）牵头，刘悦（PV）配合', plan_due: dateAgo(8),
      plan_review: 'QA 评审通过。',
    }, '措施计划已批准');
    // implement 留白且超期：qa.specialist / pv.officer 待办。
    records['CAPA-2'] = capa;
  }

  // ======== PV-CHANGE：药物警戒体系变更控制（CHG）========
  {
    const dev = workflow.createInstance({
      processCode: 'PV-CHANGE',
      title: '药物警戒数据库系统升级（v2.4）',
      summary: `${MARKER} 自有药物警戒数据库（演示系统）从 v2.3 升级至 v2.4：新增时限自动升级规则与 E2B(R3) 字段校验。影响评估、实施计划与实施均已完成，待验证并更新 PSMF。`,
      changeType: '系统变更', effectiveDate: dayAhead(15), psmfUpdateRequired: '是',
      criticality: 'major', department: '质量保证部', site: '华东制药（演示）',
      dueDate: dateAhead(15),
    }, U['qa.specialist'], ctx);
    step(dev.id, 'scope', U['qa.specialist'], {
      changeType: '系统变更',
      sco_description: '演示 PV 数据库 v2.3→v2.4：升级报告受理模块（时限看板增加 24 小时未登记自动升级）、E2B(R3) 必填校验、审计追踪页面改版。',
      sco_scope: '受理、时限、递交三个模块；影响全部 PV 流程的录入与递交页面。',
      sco_affected: 'ICSR-EXP、ICSR-REG、AEFI-EXP、COMP-HANDLE 的受理与递交环节及时限看板。',
      sco_proposed: dayAhead(15), sco_requiresVerification: '是',
    }, '变更描述与影响面');
    step(dev.id, 'assess', U['qa.manager'], {
      ass_reporting: '否', ass_dataIntegrity: '是',
      ass_regulatory: '升级不改变报告时限与路径，仅增加自动提醒与校验，需同步更新 SOP 与 PSMF 系统章节。',
      ass_risk: '中',
      ass_conclusion: '变更可行；需完成功能验证、E2B 校验联测与用户培训，过渡期保留旧版查询入口。',
    }, '完成影响评估');
    step(dev.id, 'plan', U['qa.specialist'], {
      effectiveDate: dayAhead(15),
      pln_steps: '1. 测试库安装与功能验证；2. E2B(R3) 校验规则比对；3. 生产库上线；4. 时限看板规则回归。回退方案：保留 v2.3 快照，48 小时内可回退。',
      pln_validation: '是', pln_training: '是',
      pln_owner: '王涛（QA）、系统管理员', pln_date: dayAhead(13),
    }, '制定实施计划与验证方案');
    step(dev.id, 'implement', U['pv.officer'], {
      imp_items: `测试库安装完成；功能验证用例 32/32 通过；生产库 v2.4 于 ${day(2)} 上线；时限看板升级规则当日生效。`,
      imp_evidence: '升级记录单、验证用例清单、上线通知。',
      imp_date: day(2), imp_issues: 'E2B 必填校验对历史草稿个例产生 3 例警告，已逐一说明并确认不影响递交。',
      imp_planAdherence: '按计划',
    }, '实施完成');
    // verify 留白：qa.manager 验证/更新 PSMF 待办。
    records['CHG-1'] = dev;
  }

  log(`workflow records   ${db.get('SELECT COUNT(*) AS n FROM workflow_instances').n} created`);
  const perProcess = db.all('SELECT process_code, COUNT(*) AS n FROM workflow_instances GROUP BY process_code ORDER BY process_code');
  for (const row of perProcess) {
    const open = db.get(
      "SELECT COUNT(*) AS n FROM workflow_instances WHERE process_code = ? AND status NOT IN ('closed','cancelled')",
      [row.process_code]
    ).n;
    log(`                   ${row.process_code.padEnd(14)} ${String(row.n).padStart(2)} 条(${open} 条进行中)`);
  }

  // ---- GVP 年度自查（真实检查表 GVP-CN-2021）-----------------------------
  // 内审员独立性规则（inspections.assertAuditorIndependence）禁止内审员审计其
  // 声明职责的领域（GVP），因此本次自查由药物警戒质量负责人（qa.manager）以
  // 管理评审形式牵头，评估缺陷并转 CAPA。
  {
    const insp = inspections.createInspection({
      templateCode: 'GVP-CN-2021',
      title: '2026 年度药物警戒体系自查',
      inspectionType: 'self_inspection',
      site: '华东制药（演示）',
      scope: '按《药物警戒质量管理规范》（2021 年第 65 号公告）对药物警戒体系开展年度自查，覆盖注册登记、组织机构与人员、培训、信息收集、个例报告、信号检测、定期报告、风险控制、主文件与记录保存。自查期间：上一年度 8 月至本年度 7 月。',
      leadAuditor: U['qa.manager'].full_name,
      scheduledDate: dateAgo(45),
      gxpAreas: ['GVP'],
    }, U['qa.manager'], ctx);

    const findings = db.all('SELECT * FROM inspection_findings WHERE inspection_id = ? ORDER BY id', [insp.id]);

    // Grade a realistic portion and deliberately leave the rest unassessed, so
    // the progress bar and the "not yet assessed" counters stay meaningful.
    const gapFindings = [];
    let idx = 0;
    for (const f of findings) {
      idx += 1;
      if (idx > Math.floor(findings.length * 0.66)) break;

      const isGap = (idx % 5 === 0) || (f.risk_level === 'critical' && idx % 4 === 1);
      const isPartial = !isGap && idx % 7 === 0;
      const isNotApplicable = !isGap && !isPartial && idx % 9 === 0;

      if (isGap || isPartial) {
        gapFindings.push(f);
        inspections.assessItem(f.id, {
          grade: isGap ? 'gap' : 'partial',
          observation: gapObservation(idx),
          objectiveEvidence: gapEvidence(idx),
          riskLevel: f.risk_level,
          findingType: f.risk_level === 'critical' ? 'critical' : (f.risk_level === 'major' ? 'major' : 'minor'),
          ownerId: isGap && f.risk_level === 'critical' ? U['qa.manager'].id : U['qa.specialist'].id,
          dueDate: dateAhead(30 + (idx % 5) * 15),
          notes: `${MARKER} 自查评估`,
        }, U['qa.manager'], ctx);
      } else {
        inspections.assessItem(f.id, {
          grade: isNotApplicable ? 'not_applicable' : 'compliant',
          observation: isNotApplicable ? '本场所无相应活动，判定为不适用。' : null,
          objectiveEvidence: isNotApplicable ? '经与药物警戒负责人确认，本场所未开展该项活动，故不适用。' : null,
          notes: `${MARKER} 自查评估`,
        }, U['qa.manager'], ctx);
      }
    }

    const assessedCount = db.get(
      "SELECT COUNT(*) AS n FROM inspection_findings WHERE inspection_id = ? AND assessed_grade != 'not_assessed'",
      [insp.id]
    ).n;
    log(`self-inspection    ${insp.code} created (${assessedCount}/${findings.length} 项已评估, ${gapFindings.length} 项缺陷, 其余待评估)`);

    const refreshed = inspections.getInspection(insp.id);
    log(`readiness score    ${refreshed.readinessScore}% (含 ${refreshed.progress.openFindings} 项未关闭缺陷)`);

    // Escalate the most serious gap into a CAPA. inspections.escalateToCapa is not
    // usable here because PV-CAPA declares `sourceType` as a required top-level
    // field and the escalation helper does not pass it, so the CAPA is created
    // through workflow.createInstance and the finding is linked with the same
    // record/audit semantics (finding.workflow_id + escalate audit entry).
    if (gapFindings.length) {
      const target = gapFindings.find((f) => f.risk_level === 'critical') || gapFindings[0];
      const capa = workflow.createInstance({
        processCode: 'PV-CAPA',
        title: '建立疑似聚集性事件的跨部门升级通报机制',
        summary: `${MARKER} 源自自查 ${insp.code}（${target.clause_ref || ''}）：聚集性疑似不良反应信息发现后仅停留在药物警戒部，未按 GVP 第 61 条及时升级至药品安全委员会并启动调查，机制缺失。`,
        sourceType: '内审发现',
        criticality: target.risk_level === 'critical' ? 'critical' : (target.risk_level === 'minor' ? 'minor' : 'major'),
        gxpAreas: ['GVP'],
        ownerId: U['qa.specialist'].id,
        dueDate: dateAhead(30),
        site: '华东制药（演示）',
        data: {
          sourceInspection: insp.code,
          clauseRef: target.clause_ref,
          requirement: target.requirement,
          objectiveEvidence: target.objective_evidence,
        },
      }, U['qa.manager'], ctx);
      db.run(
        'UPDATE inspection_findings SET workflow_id = ?, status = ?, updated_at = ? WHERE id = ?',
        [capa.id, 'in_progress', new Date().toISOString(), target.id]
      );
      audit.append({
        action: 'escalate',
        entityType: 'inspection_findings',
        entityId: target.id,
        recordKey: `inspection:${insp.code}`,
        actor: U['qa.manager'],
        reason: `Finding escalated to ${capa.recordKey} (PV-CAPA)`,
        ctx,
        newValue: { workflow_id: capa.id, workflow_key: capa.recordKey },
        severity: target.risk_level === 'critical' ? 'critical' : 'warning',
      });
      records['CAPA-3'] = capa;
      log(`escalation         ${target.clause_ref || ''} → ${capa.recordKey}`);
    }
    records['INSP-1'] = insp;
  }

  // ---- final integrity check ---------------------------------------------
  const chain = audit.verifyChain();
  const elapsed = Date.now() - started;

  process.stdout.write('\n');
  log(`users              ${db.get('SELECT COUNT(*) AS n FROM users').n}`);
  log(`curricula          ${db.get('SELECT COUNT(*) AS n FROM training_curricula WHERE active = 1').n}`);
  log(`training records   ${db.get('SELECT COUNT(*) AS n FROM training_records').n}`);
  log(`documents          ${db.get('SELECT COUNT(*) AS n FROM documents').n}`);
  log(`workflow records   ${db.get('SELECT COUNT(*) AS n FROM workflow_instances').n} (by process: `
    + perProcess.map((r) => `${r.process_code}=${r.n}`).join(', ') + ')');
  log(`self-inspections   ${db.get('SELECT COUNT(*) AS n FROM inspections').n}`);
  log(`audit entries      ${db.get('SELECT COUNT(*) AS n FROM audit_trail').n}`);
  log(`signatures         ${db.get('SELECT COUNT(*) AS n FROM signatures WHERE valid = 1').n}`);
  log(`audit chain        ${chain.ok ? 'VERIFIED' : `*** BROKEN at seq ${chain.brokenAt}: ${chain.reason}`}`);
  log(`elapsed            ${elapsed} ms`);
  process.stdout.write('\n');
  process.stdout.write('  Demo accounts (password for all):  ' + DEMO_PASSWORD + '\n');
  if (adminCreated) {
    process.stdout.write(`    ${'admin'.padEnd(18)} ${'系统负责人'.padEnd(8)} ${'系统管理员'}${adminCreated ? '  <- administrator' : ''}\n`);
  }
  for (const p of PEOPLE) {
    process.stdout.write(`    ${p.username.padEnd(18)} ${p.fullName.padEnd(8)} ${p.jobTitle}\n`);
  }
  process.stdout.write('\n  Sign in at http://127.0.0.1:8793 as pv.head to see a fully\n');
  process.stdout.write('  populated PV dashboard (ICSR inbox, signal queue, PSUR/RMP status,\n');
  process.stdout.write('  self-inspection readiness), or as safety.committee to find the\n');
  process.stdout.write('  signal assessment waiting for committee review.\n');
  process.stdout.write('\n  REMINDER: this instance now contains fictional PV records. Do not use it\n');
  process.stdout.write('  for real work. Delete data\\pv.db to start clean.\n\n');

  db.close();
  process.exit(chain.ok ? 0 : 2);
}

/** Narrative observations for the self-inspection gaps. */
function gapObservation(i) {
  const texts = [
    '聚集性疑似不良反应信息的发现后未按规定及时升级至药品安全委员会并启动调查，跨部门通报机制缺失，与 GVP 第 61 条、81 号令第 27 条要求不符。',
    '文献检索记录第 2 季度存在一处覆盖期缺口（与上期检索间隔 42 天，超出月刊频率），检索连续性和留痕要求未完全满足（GVP 第 36 条）。',
    '部分 E2B(R3) 传输回执未在个案记录中集中归档，递交留痕分散，难以快速回应检查（GVP 第 48-49 条）。',
    '药物警戒负责人变更登记信息未在 30 日内同步更新至国家药品不良反应监测系统注册信息（GVP 第 10 条）。',
    '个别快速报告时限台账以「系统录入日」而非「首次获知且四要素齐备之日」起算，时限起算口径存在错误风险（GVP 第 49 条最高频缺陷）。',
    '关键岗位（药物警戒负责人）培训资质矩阵最近一次更新为 14 个月前，未覆盖本年度新增法规要求与内部规程修订。',
  ];
  return texts[i % texts.length];
}

function gapEvidence(i) {
  const texts = [
    '调阅近 12 个月会议纪要：药品安全委员会未收到过聚集性事件通报；访谈药物警戒专员确认跨部门升级仅靠口头通知，无书面机制文件。',
    '检索台账显示第 2 季度第 1 期与第 2 期检索日期间隔 42 天，超出 SOP-PV-006 规定的月刊频率；无调整原因的书面说明。',
    '抽查 5 例快速报告个案，其中 2 例的系统回执截图存放于个人电脑桌面而非个案记录，未按 SOP-PV-001 归档。',
    '比对国家系统注册信息与公司任命文件：负责人于 4 月变更，注册信息仍未更新（超出 30 日）。',
    '抽查 3 例严重个例的时限台账：1 例的起算日期与首次获知邮件时间戳相差 2-3 个工作日，台账口径与 GVP 第 49 条不符。',
    '培训矩阵最近更新年月为上年 7 月；本年度《药物警戒质量管理规范》相关新规培训未在矩阵中登记。',
  ];
  return texts[i % texts.length];
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\n  Demo seed failed: ${err && err.stack ? err.stack : err}\n\n`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  });
}
