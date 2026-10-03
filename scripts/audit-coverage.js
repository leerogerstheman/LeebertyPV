'use strict';

/*
 * Coverage audit: which GxP areas actually have content, in each module?
 *
 *   node scripts/audit-coverage.js
 *
 * Written because "the code supports GLP/GCP/GDP" and "there is something to
 * look at for GLP/GCP/GDP" are different claims, and the difference matters when
 * showing the system to a QA audience. This reports the second one honestly:
 * bare counts per area per module, plus what the background monitor can already
 * act on.
 */

const db = require('../src/core/db');
const config = require('../src/config');

const AREAS = ['ICSR', 'SIGNAL', 'PSUR', 'RMP', 'LIT', 'AEFI', 'COMPLAINT', 'GVP'];

/** SQLite stores gxp_areas as a JSON array in a TEXT column, so match on the quoted code. */
function likeParam(area) { return `%"${area}"%`; }

function countByArea(table, area) {
  return db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE gxp_areas LIKE ?`, [likeParam(area)]).n;
}

function main() {
  db.open();

  process.stdout.write('\n  LeebertyPV - content coverage audit\n');
  process.stdout.write(`  ${'='.repeat(78)}\n\n`);
  process.stdout.write(`  Database: ${config.dbFile}\n\n`);

  const areas = db.all('SELECT code, name, name_en FROM gxp_areas ORDER BY sort_order, code');
  const moduleOf = {
    ICSR: '个例安全性报告处理',
    SIGNAL: '信号检测与评估',
    PSUR: '定期安全性报告',
    RMP: '风险管理计划',
    LIT: '医学文献监测',
    AEFI: '疫苗不良事件',
    COMPLAINT: '投诉与召回',
    GVP: '药物警戒体系与质量合规',
  };

  // ---------------------------------------------------------------- table --
  const header = ['领域', '流程定义', '检查表', '检查项', '实际记录', '受控文件', '培训课程', '人员'];
  const widths = [20, 8, 7, 7, 8, 8, 8, 6];
  process.stdout.write('  ' + header.map((h, i) => h.padEnd(widths[i])).join('') + '\n');
  process.stdout.write('  ' + widths.map((w) => '-'.repeat(w - 1) + ' ').join('') + '\n');

  const coverage = {};
  for (const area of areas) {
    const code = area.code;
    const processTypes = countByArea('process_types', code);
    const templates = countByArea('checklist_templates', code);
    const items = db.get(
      'SELECT COUNT(*) AS n FROM checklist_items i JOIN checklist_templates t ON t.id = i.template_id ' +
      'WHERE i.gxp_areas LIKE ?', [likeParam(code)]
    ).n;
    const records = countByArea('workflow_instances', code);
    const documents = countByArea('documents', code);
    const curricula = countByArea('training_curricula', code);
    const staff = db.get('SELECT COUNT(*) AS n FROM users WHERE gxp_areas LIKE ?', [likeParam(code)]).n;

    coverage[code] = { processTypes, templates, items, records, documents, curricula, equipment: staff };

    const row = [
      `${code} ${moduleOf[code] || ''}`.slice(0, widths[0] - 1),
      String(processTypes).padEnd(widths[1] - 1),
      String(templates).padEnd(widths[2] - 1),
      String(items).padEnd(widths[3] - 1),
      String(records).padEnd(widths[4] - 1),
      String(documents).padEnd(widths[5] - 1),
      String(curricula).padEnd(widths[6] - 1),
      String(staff).padEnd(widths[7] - 1),
    ];
    process.stdout.write('  ' + row.join('') + '\n');
  }

  // -------------------------------------------------------------- verdict --
  // A record tagged ["GMP","GLP","GCP","GDP"] is a GMP deviation whose tag list
  // happens to mention the other areas - it is NOT a GLP, GCP or GDP record.
  // Counting it as coverage would overstate the demonstration, so "demonstrated"
  // below means a record whose PRIMARY area is this one, and separately reports
  // records that merely carry the tag.
  process.stdout.write('\n  "专属记录" = 该领域的专属流程或单一领域记录（真正能演示该领域场景）\n');
  process.stdout.write('  "含标签记录" = 标签含该领域、但主领域为其他（例如 GMP 偏差同时标注 GLP/GCP/GDP）\n\n');

  const primaryRecords = {};
  const taggedRecords = {};
  for (const area of areas) {
    primaryRecords[area.code] = db.get(
      `SELECT COUNT(*) AS n FROM workflow_instances
       WHERE gxp_areas LIKE ? AND json_array_length(gxp_areas) <= 2`,
      [likeParam(area.code)]
    ).n;
    taggedRecords[area.code] = coverage[area.code].records;
  }

  const extra = ['专属记录', '含标签记录'];
  process.stdout.write('  领域                  专属流程  专属检查表  专属记录  含标签记录\n');
  process.stdout.write('  ' + '-'.repeat(68) + '\n');
  for (const area of areas) {
    const c = coverage[area.code];
    // A flow counts as "dedicated" when this area is genuinely its subject
    // rather than an incidental tag on a broad multi-domain process. The
    // threshold has to allow a single-area checklist like GLP-OECD (gxpAreas
    // ["GLP"]) to qualify, while excluding general processes tagged with four
    // or five areas such as DEV or CAPA.
    const dedicatedFlows = db.all('SELECT gxp_areas FROM process_types WHERE active = 1 AND gxp_areas LIKE ?', [likeParam(area.code)])
      .filter((r) => JSON.parse(r.gxp_areas || '[]').length <= 3).length;
    const dedicatedTemplates = db.all('SELECT gxp_areas FROM checklist_templates WHERE active = 1 AND gxp_areas LIKE ?', [likeParam(area.code)])
      .filter((r) => JSON.parse(r.gxp_areas || '[]').length <= 3).length;
    process.stdout.write('  ' + [
      `${area.code} ${moduleOf[area.code] || ''}`.slice(0, 19).padEnd(20),
      String(dedicatedFlows).padEnd(10),
      String(dedicatedTemplates).padEnd(12),
      String(primaryRecords[area.code]).padEnd(10),
      String(taggedRecords[area.code]).padEnd(10),
    ].join('') + '\n');
  }

  process.stdout.write('\n  逐领域判定:\n');
  for (const area of areas) {
    const c = coverage[area.code];
    const dedicatedFlows = db.all('SELECT gxp_areas FROM process_types WHERE active = 1 AND gxp_areas LIKE ?', [likeParam(area.code)])
      .filter((r) => JSON.parse(r.gxp_areas || '[]').length <= 3).length;
    const dedicatedTemplates = db.all('SELECT gxp_areas FROM checklist_templates WHERE active = 1 AND gxp_areas LIKE ?', [likeParam(area.code)])
      .filter((r) => JSON.parse(r.gxp_areas || '[]').length <= 3).length;
    const hasOwn = primaryRecords[area.code] > 0;
    const executable = dedicatedFlows > 0 && dedicatedTemplates > 0;

    let verdict;
    if (executable && hasOwn) verdict = '完整：专属流程 + 专属检查表 + 专属演示记录';
    else if (executable && !hasOwn) verdict = '流程与检查表已就绪，但演示数据中没有该领域的独有记录';
    else if (!executable && hasOwn) verdict = '有记录但缺少专属流程或检查表';
    else verdict = '未覆盖';
    const mark = (executable && hasOwn) ? '✓' : (executable ? '△' : '✗');
    process.stdout.write(`    ${mark}  ${area.code.padEnd(20)} ${verdict}\n`);
  }

  // -------------------------------------------------- domain-specific flows --
  process.stdout.write('\n  具备专属流程定义的领域（演示时可直接看到完整流转）:\n');
  const byArea = {};
  for (const row of db.all('SELECT code, name, gxp_areas FROM process_types WHERE active = 1 ORDER BY code')) {
    const list = JSON.parse(row.gxp_areas || '[]');
    for (const a of list) {
      if (!byArea[a]) byArea[a] = [];
      byArea[a].push(`${row.code}(${row.name})`);
    }
  }
  for (const area of areas) {
    const flows = byArea[area.code] || [];
    const own = flows.filter((f) => {
      const code = f.split('(')[0];
      const areas = JSON.parse(db.get('SELECT gxp_areas FROM process_types WHERE code = ?', [code]).gxp_areas);
      // "Own" means this area is not merely an incidental tag on a general flow.
      return areas.length <= 3;
    });
    process.stdout.write(`    ${area.code.padEnd(20)} 共 ${String(flows.length).padStart(2)} 条关联流程`
      + (own.length ? `，其中专属 ${own.length} 条: ${own.join(', ')}` : '，无专属流程') + '\n');
  }

  // ------------------------------------------------------- monitor coverage --
  process.stdout.write('\n  后台进程实际生成的待办（按领域）:\n');
  const tasks = db.all('SELECT id, task_type, entity_type, entity_id FROM tasks');
  const perArea = {};
  for (const area of areas) perArea[area.code] = 0;
  for (const task of tasks) {
    let blob = null;
    if (task.entity_type === 'workflow_instances') {
      const row = db.get('SELECT gxp_areas FROM workflow_instances WHERE id = ?', [Number(task.entity_id)]);
      blob = row ? row.gxp_areas : null;
    } else if (task.entity_type === 'equipment') {
      const row = db.get('SELECT gxp_areas FROM equipment WHERE id = ?', [Number(task.entity_id)]);
      blob = row ? row.gxp_areas : null;
    } else if (task.entity_type === 'documents') {
      const row = db.get('SELECT gxp_areas FROM documents WHERE id = ?', [Number(task.entity_id)]);
      blob = row ? row.gxp_areas : null;
    }
    if (!blob) continue;
    for (const area of areas) {
      if (blob.includes(`"${area.code}"`)) perArea[area.code] += 1;
    }
  }
  const totalTasks = db.get('SELECT COUNT(*) AS n FROM tasks').n;
  process.stdout.write(`    任务总数: ${totalTasks}\n`);
  for (const area of areas) {
    if (perArea[area.code] > 0) {
      process.stdout.write(`    ${area.code.padEnd(20)} ${perArea[area.code]} 条\n`);
    }
  }
  const uncovered = areas.filter((a) => perArea[a.code] === 0).map((a) => a.code);
  if (uncovered.length) {
    process.stdout.write(`    无待办产出的领域: ${uncovered.join(', ')}\n`);
    process.stdout.write('    （原因通常是该领域没有会产生时间性条件的记录，例如校准、培训或记录期限）\n');
  }

  // ------------------------------------------------------------------ gaps --
  process.stdout.write('\n  缺口汇总:\n');
  const missingDemo = areas.filter((a) => coverage[a.code].processTypes > 0 && coverage[a.code].records === 0);
  if (missingDemo.length) {
    process.stdout.write('    有专属流程但演示数据中没有任何记录:\n');
    for (const a of missingDemo) {
      process.stdout.write(`      - ${a.code} ${moduleOf[a.code] || ''}`);
      const flows = (byArea[a.code] || []).join(', ');
      process.stdout.write(`（可用流程: ${flows}）\n`);
    }
  } else {
    process.stdout.write('    所有具备专属流程的领域都有演示记录。\n');
  }

  const noChecklist = areas.filter((a) => coverage[a.code].templates === 0);
  if (noChecklist.length) {
    process.stdout.write(`    没有专属检查表的领域: ${noChecklist.map((a) => a.code).join(', ')}\n`);
  }

  process.stdout.write('\n');
  db.close();
}

if (require.main === module) main();
