'use strict';

/**
 * Seed loader for LeebertyPV.
 *
 * Two distinct things are loaded at start-up:
 *
 *  1. The **PV configuration library** - process-type definitions and
 *     inspection checklist templates. These are configuration, not data: they
 *     describe how the pharmacovigilance system works and are version
 *     controlled alongside the code. They are (re)loaded on every start so
 *     editing a JSON file is enough to change a workflow.
 *
 *  2. Reference data - the PV area register. Loaded once, then left alone.
 *
 * Demo records are deliberately NOT loaded here; `scripts/seed-demo.js` does
 * that explicitly, so a production instance never accidentally gets fictional
 * safety cases in its audit trail.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./core/db');
const workflow = require('./domain/workflow');
const inspections = require('./domain/inspections');

function nowIso() { return new Date().toISOString(); }

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
}

/**
 * The PV area register. Each entry is a discipline of pharmacovigilance with
 * its own regulatory basis; the workbench treats them uniformly, which is what
 * lets one codebase serve ICSR processing, signal management, periodic reports,
 * risk management, literature monitoring, vaccine safety and the PV quality
 * system side by side.
 */
const PV_AREAS = [
  {
    code: 'ICSR', name: '个例安全性报告', nameEn: 'Individual Case Safety Reports',
    fullName: '个例安全性报告处理', fullNameEn: 'Individual Case Safety Report Processing',
    description: '接收、登记、分类、因果关系评价、随访与提交个例安全性报告（ICSR）。依据：ICH E2A/E2B(R3)/E2D、《药品不良反应报告和监测管理办法》（卫生部令第 81 号）、《药物警戒质量管理规范》（NMPA 2021）。',
    colour: '#e11d48',
  },
  {
    code: 'SIGNAL', name: '信号检测与评估', nameEn: 'Signal Detection & Assessment',
    fullName: '信号检测、验证与评估', fullNameEn: 'Signal Detection, Validation and Assessment',
    description: '用比例失衡法（PRR/ROR/EBGM/BCPNN）检测信号，验证、确认并评估其临床与公共卫生意义，输出处置建议。依据：EU GVP Module IX、WHO 信号管理指南、ICH E2E（药物警戒计划）。',
    colour: '#f59e0b',
  },
  {
    code: 'PSUR', name: '定期安全性报告', nameEn: 'Periodic Safety Reports',
    fullName: '定期安全性更新报告（PSUR/PBRER）', fullNameEn: 'Periodic Safety Update Reports',
    description: '按数据锁定点定期汇编获益-风险评估报告，评估累积安全性数据。依据：ICH E2C(R2)（PBRER）、《药品不良反应报告和监测管理办法》第 18 条（每年一次直至再注册）。',
    colour: '#2563eb',
  },
  {
    code: 'RMP', name: '风险管理', nameEn: 'Risk Management',
    fullName: '风险管理计划（RMP）与风险最小化措施', fullNameEn: 'Risk Management Plan and Risk Minimisation',
    description: '制定、更新风险管理计划，设计并跟踪常规与附加风险最小化措施（RMM）。依据：EU GVP Module V/XV、ICH E2E、《药物警戒质量管理规范》（药物警戒计划要求）。',
    colour: '#7c3aed',
  },
  {
    code: 'LIT', name: '医学文献监测', nameEn: 'Medical Literature Monitoring',
    fullName: '医学文献检索与个案筛查', fullNameEn: 'Medical Literature Search and Case Triage',
    description: '定期检索国内外医学文献，筛出需要上报的个例报告并转交 ICSR 流程。依据：EU GVP Module VI.B、《药物警戒质量管理规范》（文献监测要求）。',
    colour: '#0891b2',
  },
  {
    code: 'AEFI', name: '疫苗不良事件', nameEn: 'Vaccine Safety (AEFI)',
    fullName: '疑似预防接种异常反应（AEFI）', fullNameEn: 'Adverse Events Following Immunisation',
    description: '接收、分类（一般反应/异常反应/心因性反应/偶合症等）并按法定时限上报疑似预防接种异常反应。依据：《疫苗管理法》、《全国疑似预防接种异常反应监测方案》、WHO AEFI 分类指南。',
    colour: '#16a34a',
  },
  {
    code: 'COMPLAINT', name: '投诉与召回', nameEn: 'Complaints & Recalls',
    fullName: '药品质量投诉与召回', fullNameEn: 'Product Complaints and Recalls',
    description: '接收药品质量投诉，判断是否涉及安全性事件，必要时启动召回并联动公众沟通。依据：《药品管理法》、《药品召回管理办法》、EU GVP Module VI（投诉中的不良反应）。',
    colour: '#ea580c',
  },
  {
    code: 'GVP', name: '药物警戒体系', nameEn: 'PV System & Quality',
    fullName: '药物警戒体系与质量合规', fullNameEn: 'PV System and Quality Compliance',
    description: '药物警戒体系的组织、文件、偏差/CAPA、变更控制、内审、培训与持续改进。依据：EU GVP Module I（质量体系）、ICH Q10、《药物警戒质量管理规范》第一至三章。',
    colour: '#475569',
  },
];

function loadPvAreas() {
  const at = nowIso();
  let added = 0;
  PV_AREAS.forEach((area, index) => {
    const existing = db.get('SELECT code FROM gxp_areas WHERE code = ?', [area.code]);
    db.run(
      'INSERT INTO gxp_areas (code, name, name_en, full_name, full_name_en, description, colour, sort_order) ' +
      'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, name_en = excluded.name_en, ' +
      'full_name = excluded.full_name, full_name_en = excluded.full_name_en, description = excluded.description, ' +
      'colour = excluded.colour, sort_order = excluded.sort_order',
      [area.code, area.name, area.nameEn, area.fullName, area.fullNameEn, area.description, area.colour, index + 1]
    );
    if (!existing) added += 1;
  });
  return { total: PV_AREAS.length, added };
}

function loadProcessTypes() {
  const dir = path.join(config.seedDir, 'workflows');
  const files = listJsonFiles(dir);
  const loaded = [];
  const errors = [];
  for (const file of files) {
    try {
      const definition = readJson(file);
      const result = workflow.register(definition, path.basename(file));
      loaded.push({ code: result.code, file: path.basename(file), changed: result.changed });
    } catch (err) {
      errors.push({ file: path.basename(file), message: err.message });
    }
  }
  // Deactivate process types whose definition file was removed, so a deleted
  // workflow stops appearing rather than silently persisting.
  const knownFiles = new Set(files.map((f) => path.basename(f)));
  const allRows = db.all('SELECT code, source_file FROM process_types WHERE active = 1');
  const orphaned = allRows.filter((r) => r.source_file && !knownFiles.has(r.source_file));
  for (const row of orphaned) {
    db.run('UPDATE process_types SET active = 0 WHERE code = ?', [row.code]);
  }
  return { loaded, errors, deactivated: orphaned.length };
}

function loadChecklistTemplates() {
  const dir = path.join(config.seedDir, 'checklists');
  const files = listJsonFiles(dir);
  const loaded = [];
  const errors = [];
  for (const file of files) {
    try {
      const template = readJson(file);
      const result = inspections.registerTemplate(template, path.basename(file));
      loaded.push({ code: result.code, file: path.basename(file), items: result.items });
    } catch (err) {
      errors.push({ file: path.basename(file), message: err.message });
    }
  }
  const knownFiles = new Set(files.map((f) => path.basename(f)));
  const allRows = db.all('SELECT code, source_file FROM checklist_templates WHERE active = 1');
  const orphaned = allRows.filter((r) => r.source_file && !knownFiles.has(r.source_file));
  for (const row of orphaned) {
    db.run('UPDATE checklist_templates SET active = 0 WHERE code = ?', [row.code]);
  }
  return { loaded, errors, deactivated: orphaned.length };
}

/**
 * Run the whole seed process.
 * @param {object} [opts]
 * @param {boolean} [opts.silent] suppress console output (used at start-up)
 * @param {boolean} [opts.throwOnError] fail hard instead of reporting
 */
function run(opts = {}) {
  const hadConfig = db.get('SELECT COUNT(*) AS n FROM process_types').n > 0;
  const areas = loadPvAreas();
  const processes = loadProcessTypes();
  const checklists = loadChecklistTemplates();

  const errors = [...processes.errors, ...checklists.errors];
  if (errors.length && opts.throwOnError) {
    throw new Error(errors.map((e) => `${e.file}: ${e.message}`).join('; '));
  }

  const summary = {
    bootstrapped: !hadConfig,
    pvAreas: areas.total,
    processTypes: processes.loaded.length,
    checklistTemplates: checklists.loaded.length,
    checklistItems: checklists.loaded.reduce((a, b) => a + b.items, 0),
    errors,
  };

  if (!opts.silent) {
    process.stdout.write(`\n  PV configuration library\n`);
    process.stdout.write(`    PV areas             ${summary.pvAreas}\n`);
    process.stdout.write(`    Process types        ${summary.processTypes}\n`);
    process.stdout.write(`    Checklist templates  ${summary.checklistTemplates} (${summary.checklistItems} requirements)\n`);
    if (processes.deactivated) process.stdout.write(`    Deactivated          ${processes.deactivated} removed process type(s)\n`);
    if (checklists.deactivated) process.stdout.write(`    Deactivated          ${checklists.deactivated} removed checklist(s)\n`);
    if (errors.length) {
      process.stdout.write('\n  WARNINGS while loading configuration:\n');
      for (const e of errors) process.stdout.write(`    ${e.file}: ${e.message}\n`);
    }
    process.stdout.write('\n');
  } else if (errors.length) {
    process.stdout.write(`  [seed] ${errors.length} configuration file(s) failed to load:\n`);
    for (const e of errors) process.stdout.write(`         ${e.file}: ${e.message}\n`);
  }

  return summary;
}

module.exports = { run, PV_AREAS };