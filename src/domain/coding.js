'use strict';

/**
 * MedDRA coding.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reaction term used to be a free-text field. That looks harmless and is not:
 * "肝损伤", "肝损害", "ALT升高" and "Drug induced liver injury" are one PT in
 * MedDRA, and a database that stores them as four different strings cannot
 * aggregate them, cannot count them into a PSUR line listing, and cannot run a
 * disproportionality analysis - a signal is a property of a *coded pair*, and
 * there is no pair if the coding is prose. GVP 第五十六条 requires the holder to
 * choose appropriate, scientific and effective signal detection methods; free
 * text makes that impossible by construction, whatever the method.
 *
 * So a reaction is coded, not typed: a verbatim term is mapped to a PT, and the
 * PT carries its SOC. Both are stored, so counting is grouping rather than
 * string matching.
 *
 * SCOPE, STATED PLAINLY
 * --------------------
 * The bundled dictionary is a curated subset covering common reaction terms for
 * a Chinese MAH, not a licensed full MedDRA release. A term outside the subset
 * is NOT silently dropped and NOT silently accepted as valid: it is recorded as
 * uncoded with a warning, so the gap is visible and someone resolves it. That
 * distinction is the whole point - a system that quietly accepts an uncoded term
 * is worse than one that refuses it, because the refusal is visible.
 *
 * ICH E2D 第四十六条 minimal criteria remain the gate for starting a reporting
 * clock; coding quality determines whether the resulting data can be analysed.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let dictionary = null;
let index = null;

// --------------------------------------------------------------- loading --

function dictionaryPath() {
  return path.join(config.seedDir, 'dictionaries', 'meddra-subset.json');
}

function load(force = false) {
  if (dictionary && !force) return dictionary;
  const file = dictionaryPath();
  if (!fs.existsSync(file)) {
    dictionary = { version: 'none', socs: [], smqs: [] };
    index = buildIndex(dictionary);
    return dictionary;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  dictionary = {
    version: raw.version,
    versionLabel: raw.versionLabel,
    versionLabelEn: raw.versionLabelEn,
    notice: raw.notice,
    noticeEn: raw.noticeEn,
    structure: raw.structure || ['SOC', 'HLGT', 'HLT', 'PT', 'LLT'],
    socs: raw.socs || [],
    smqs: raw.smqs || [],
  };
  index = buildIndex(dictionary);
  return dictionary;
}

/** Flatten the hierarchy into lookup tables. Built once per load. */
function buildIndex(dict) {
  const byPt = new Map();
  const byLlt = new Map();
  const bySoc = new Map();
  const socNames = new Map();

  for (const soc of dict.socs) {
    socNames.set(soc.code, { code: soc.code, name: soc.name, nameEn: soc.nameEn });
    for (const hlt of soc.hlts || []) {
      for (const pt of hlt.pts || []) {
        const entry = {
          pt: pt.code,
          ptName: pt.name,
          ptNameEn: pt.nameEn,
          soc: soc.code,
          socName: soc.name,
          socNameEn: soc.nameEn,
          hlt: hlt.code,
          hltName: hlt.name,
          hltNameEn: hlt.nameEn,
          llt: pt.llts || [],
          version: dict.version,
        };
        byPt.set(pt.code, entry);
        for (const llt of pt.llts || []) byLlt.set(normalise(llt), entry);
      }
    }
  }

  // Standardised MedDRA Queries, expanded to their PTs for grouped analysis.
  const smqByPt = new Map();
  for (const smq of dict.smqs || []) {
    for (const pt of smq.pts || []) {
      if (!smqByPt.has(pt)) smqByPt.set(pt, []);
      smqByPt.get(pt).push(smq);
    }
  }

  return { byPt, byLlt, socNames, smqByPt };
}

function normalise(text) {
  return String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------- lookup --

/**
 * Resolve a reaction term to a coded PT.
 *
 * @returns {{status:'coded'|'unmapped'|'empty', entry?:object, smqs?:array,
 *            input:string, message?:string, messageEn?:string}}
 */
function code(term) {
  load();
  const raw = String(term == null ? '' : term).trim();
  if (!raw) {
    return {
      status: 'empty',
      input: raw,
      message: '未填写不良反应术语，无法进行 MedDRA 编码。',
      messageEn: 'No reaction term supplied, so it cannot be coded against MedDRA.',
    };
  }

  // 1. An exact PT code, e.g. a value carried over from an import or E2B file.
  const asCode = index.byPt.get(raw);
  if (asCode) return coded(raw, asCode);

  const key = normalise(raw);
  const lltHit = index.byLlt.get(key);
  if (lltHit) return coded(raw, lltHit);

  // 2. A PT name given in either language.
  for (const entry of index.byPt.values()) {
    if (normalise(entry.ptName) === key || normalise(entry.ptNameEn) === key) return coded(raw, entry);
  }

  return {
    status: 'unmapped',
    input: raw,
    message: `术语「${raw}」不在当前 MedDRA 子集（${dictionary.versionLabel || dictionary.version}）中。未编码术语无法汇入定期报告与信号分析，须由授权编码员补充词典或改选术语。`,
    messageEn: `Term "${raw}" is not in the loaded MedDRA subset (${dictionary.versionLabelEn || dictionary.version}). Uncoded terms cannot enter aggregate reporting or signal analysis; an authorised coder must extend the dictionary or choose another term.`,
  };
}

function coded(input, entry) {
  return {
    status: 'coded',
    input,
    entry,
    smqs: index.smqByPt.get(entry.pt) || [],
  };
}

/** Every PT, optionally filtered, for a picker or a bulk list. */
function listPts(options = {}) {
  load();
  const { soc, smq, search } = options;
  const out = [];
  for (const entry of index.byPt.values()) {
    if (soc && entry.soc !== soc) continue;
    if (smq) {
      const hit = (index.smqByPt.get(entry.pt) || []).some((s) => s.code === smq);
      if (!hit) continue;
    }
    out.push(entry);
  }
  const q = search ? normalise(search) : null;
  const filtered = q
    ? out.filter((e) => normalise(e.ptName).includes(q)
      || normalise(e.ptNameEn).includes(q)
      || normalise(e.socName).includes(q)
      || e.pt.includes(search)
      || e.llt.some((l) => normalise(l).includes(q)))
    : out;
  const locale = options.locale === 'en' ? 'en' : 'zh';
  filtered.sort((a, b) => {
    const an = locale === 'en' ? a.ptNameEn || a.ptName : a.ptName;
    const bn = locale === 'en' ? b.ptNameEn || b.ptName : b.ptName;
    return String(an).localeCompare(String(bn), locale === 'en' ? 'en' : 'zh-Hans-CN');
  });
  return filtered.slice(0, Math.min(Number(options.limit) || 200, 1000));
}

function listSocs() {
  load();
  return [...index.socNames.values()];
}

function listSmqs() {
  load();
  return dictionary.smqs || [];
}

function getPt(code) {
  load();
  return index.byPt.get(code) || null;
}

/** Expand a Standardised MedDRA Query into its member PTs. */
function expandSmq(smqCode) {
  load();
  const smq = (dictionary.smqs || []).find((s) => s.code === smqCode);
  if (!smq) return null;
  return {
    ...smq,
    members: (smq.pts || []).map((c) => index.byPt.get(c)).filter(Boolean),
  };
}

/**
 * Best-effort coding of many terms at once - used when a batch is imported or a
 * PSUR data set is assembled. Reports coverage so the caller can refuse to
 * publish a line listing built mostly from uncoded terms.
 */
function codeMany(terms) {
  const results = (terms || []).map(code);
  const codedCount = results.filter((r) => r.status === 'coded').length;
  return {
    total: results.length,
    coded: codedCount,
    unmapped: results.length - codedCount,
    coverage: results.length ? codedCount / results.length : 1,
    results,
  };
}

module.exports = {
  load,
  code,
  codeMany,
  listPts,
  listSocs,
  listSmqs,
  getPt,
  expandSmq,
  dictionaryPath,
};
