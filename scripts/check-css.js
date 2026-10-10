'use strict';
/*
 * design-system.css 静态体检
 *
 * 检查三件在这个文件里真实会出错的事：
 *   1. 花括号配平（手写 CSS 最常见的硬伤）
 *   2. 自定义属性在「同一条规则内」直接或间接引用自己 —— CSS 规范把这种情况
 *      判定为 invalid，而不是回退到旧值，所以成环 = 整条属性静默消失
 *   3. 声明了 var(--x) 但整个文件从未定义 --x（拼写错误的兜底）
 */

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
const css = fs.readFileSync(file, 'utf8');

const problems = [];
const notes = [];

/* ---------- 1. 花括号配平 ---------- */
let depth = 0;
let line = 1;
let firstUnbalanced = null;
for (const ch of css) {
  if (ch === '\n') line += 1;
  if (ch === '{') depth += 1;
  if (ch === '}') {
    depth -= 1;
    if (depth < 0 && firstUnbalanced === null) firstUnbalanced = line;
  }
}
if (depth !== 0) problems.push(`花括号不配平：结束时深度 ${depth}`);
if (firstUnbalanced !== null) problems.push(`第 ${firstUnbalanced} 行出现多余的 }`);

/* ---------- 去掉注释，避免注释里的示例被当成真声明 ---------- */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/* ---------- 2. 每条规则内的自定义属性自引用 ---------- */
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
let ruleCount = 0;
let declCount = 0;
while ((m = ruleRe.exec(stripped)) !== null) {
  const selector = m[1].trim().split('\n').pop().trim();
  const body = m[2];
  ruleCount += 1;

  // 收集本规则声明的自定义属性
  const declared = new Map();
  for (const d of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+)/g)) {
    declared.set(d[1], d[2]);
    declCount += 1;
  }
  if (!declared.size) continue;

  // 对每个属性做可达性搜索：从它的值出发，看能否回到它自己
  for (const name of declared.keys()) {
    const seen = new Set();
    const stack = [name];
    let cyclic = false;
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const value = declared.get(cur);
      if (value === undefined) continue; // 引用了本规则外的属性，交给浏览器继承
      for (const ref of value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        if (ref[1] === name) { cyclic = true; break; }
        stack.push(ref[1]);
      }
      if (cyclic) break;
    }
    if (cyclic) {
      problems.push(`自引用成环：规则 "${selector}" 内 ${name} 引用了自己（该属性会整条失效）`);
    }
  }
}

/* ---------- 3. var() 引用的属性是否有定义 ---------- */
const defined = new Set();
for (const d of stripped.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(d[1]);
const referenced = new Set();
for (const r of stripped.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) referenced.add(r[1]);

const undefinedRefs = [...referenced].filter((r) => !defined.has(r));
if (undefinedRefs.length) {
  problems.push(`引用了从未定义的属性：${undefinedRefs.join(', ')}`);
}

const unused = [...defined].filter((d) => !referenced.has(d) && !d.startsWith('--ds-n-') && !d.startsWith('--ds-d-'));
notes.push(`定义了 ${defined.size} 个自定义属性，其中 ${unused.length} 个在本文件内未被引用`);

/* ---------- 输出 ---------- */
const rel = path.basename(file);
console.log(`\n  体检 ${rel}  (${(css.length / 1024).toFixed(1)} KB, ${css.split('\n').length} 行)`);
console.log(`  规则 ${ruleCount} 条 · 自定义属性声明 ${declCount} 处 · 定义 ${defined.size} 个\n`);
for (const n of notes) console.log(`  · ${n}`);

if (problems.length) {
  console.log(`\n  发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  process.exit(1);
}
console.log('\n  ✓ 花括号配平、无自引用成环、无未定义引用\n');
