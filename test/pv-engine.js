'use strict';

/**
 * Reporting clock, MedDRA coding and signal detection.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * These three modules carry the pharmacovigilance logic that a workflow engine
 * cannot supply by configuration, and each one exists because the thing it
 * replaced was quietly wrong:
 *
 *   deadline.js  The due date used to be `Date.now() + slaDays` - the day a
 *                clerk typed the case in, not the day the organisation learned
 *                of it. Nothing looked broken; the audit trail simply certified
 *                breaches as passes. The clock is now counted from Day 0 under
 *                GVP 2021 第四十九条 and 第五十一条, and these checks pin each
 *                rung of that ladder, including the cases that are easy to get
 *                wrong: an unknown awareness date, a case whose four elements
 *                are not yet complete, and a case reclassified from non-serious
 *                to serious mid-flow.
 *
 *   coding.js    A reaction used to be free text, which makes aggregation and
 *                disproportionality impossible by construction. These checks
 *                assert that synonymous Chinese and English verbatim terms
 *                collapse onto one PT with one SOC, and that an unknown term is
 *                reported as uncoded rather than quietly accepted.
 *
 *   signal.js    Disproportionality is only meaningful over case COUNTS. The
 *                statistics are verified against hand-computed values, and the
 *                engine is run over a synthetic database that contains both a
 *                real signal and flat controls, because an engine that returns
 *                "nothing" also passes a test that only checks it does not
 *                crash. Detection has to be shown to fire, and shown to stay
 *                quiet on the controls.
 *
 * A separate scratch database is used, so this suite never touches the
 * instance's own safety records.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.join(ROOT, 'data', '_test-pv-engine');
const MODULES = ROOT.replace(/\\/g, '/');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); }
  else { failed += 1; process.stdout.write(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}\n`); }
}

function section(title) { process.stdout.write(`\n  ${title}\n`); }

function freshDb() {
  if (fs.existsSync(SCRATCH)) fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.env.PV_DATA_DIR = SCRATCH;
}

/** Extract `PASS|name` / `FAIL|name` markers from a child's stdout. */
function parseResults(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(PASS|FAIL)\|(.*)$/);
    if (m) rows.push({ ok: m[1] === 'PASS', name: m[2] });
  }
  return rows;
}

/**
 * Run assertions in a child process so module-level DB state stays clean.
 *
 * A child that throws produces no markers, which would otherwise read as "no
 * failures" rather than "nothing ran". An empty result set is therefore surfaced
 * as a failure here, with the child's own error attached.
 */
function runIsolated(name, source) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const file = path.join(SCRATCH, `${name}.case.js`);
  fs.writeFileSync(file, source, 'utf8');
  const res = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, PV_DATA_DIR: SCRATCH },
  });
  const rows = parseResults(res.stdout || '');
  if (!rows.length) {
    const detail = (res.stderr || res.stdout || `exit ${res.status}`).trim().split('\n')
      .filter(Boolean).slice(0, 3).join(' | ');
    check(`${name}: assertions ran`, false, detail || 'no results produced');
  }
  return rows;
}

function emit(rows) {
  for (const r of rows) check(r.name, r.ok);
}

/** Boilerplate every child needs: the workflow registry, and a marker printer. */
function harness(body) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '${MODULES}';
const wf = require(ROOT + '/src/domain/workflow');
for (const f of fs.readdirSync(path.join(ROOT, 'seed', 'workflows'))) {
  wf.register(JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'workflows', f), 'utf8')), f);
}
const rows = [];
const t = (n, ok) => rows.push((ok ? 'PASS|' : 'FAIL|') + n);
// No user row exists in a scratch database, and the instance's author columns
// are foreign keys, so the synthetic actor must stay unpersisted. Steps that
// require an independent reviewer are not exercised here.
const actor = { id: null, role: 'pv_officer', username: 'officer', full_name: 'PV Officer' };
try {
${body}
} catch (err) {
  t('child script completed without error: ' + err.message, false);
}
process.stdout.write(rows.join('\\n') + '\\n');
`;
}

// ===========================================================================

process.stdout.write('\nLeebertyPV  -  reporting clock, MedDRA coding, signal detection\n');

// ---------------------------------------------------- 1. the clock ladder --

section('GVP 2021 reporting clock (Article 49 / Article 51)');

freshDb();
emit(runIsolated('clock', harness(`
  const dl = require(ROOT + '/src/domain/deadline');
  const base = {
    reporterName: 'Wang', patientInfo: 'Zhang, 65, M', product: 'DrugX',
    meddraTerm: 'Hepatitis', awarenessDate: '2026-10-01',
  };
  const at = (f) => dl.resolveClock({ fields: f, now: '2026-10-10' });

  // Serious -> 15 days from Day 0 (Article 49).
  const serious = at({ ...base, seriousness: 'Hospitalisation' });
  t('a serious case is due 15 calendar days after Day 0',
    serious.day0 === '2026-10-01' && serious.deadline === '2026-10-16' && serious.rule.id === 'serious');

  // Non-serious -> 30 days (Article 49).
  const nonSerious = at({ ...base, seriousness: 'Non-serious' });
  t('a non-serious case is due 30 calendar days after Day 0',
    nonSerious.deadline === '2026-10-31' && nonSerious.rule.id === 'non_serious');

  // Fatal -> immediately.
  const death = at({ ...base, seriousness: 'Death', deathCase: 'Yes' });
  t('a fatal case is due immediately', death.rule.id === 'death' && death.deadlineDays === 0);

  // Overseas suspension / withdrawal -> 24 hours (Article 51).
  const overseas = at({ ...base, seriousness: 'Non-serious', isOverseas: 'Yes', overseasRegulatoryAction: 'Suspended' });
  t('an overseas suspension or withdrawal is due within 24 hours',
    overseas.rule.id === 'overseas_regulatory_action' && overseas.deadlineHours === 24);

  // THE REGRESSION THIS ENGINE EXISTS FOR.
  t('the clock runs from first awareness, not from the day the case was typed in',
    serious.day0Basis === 'awareness_date' && serious.daysLeft === 6);

  // Seriousness undetermined -> the conservative 15-day ladder, and it says so.
  const pending = at({ ...base, seriousness: 'Pending' });
  t('an undetermined seriousness falls back to the 15-day clock and says so',
    pending.deadline === '2026-10-16' && pending.rule.assumed === true
    && pending.warnings.some((w) => w.code === 'SERIOUSNESS_UNDETERMINED'));

  // Four elements incomplete -> the clock has not started.
  const incomplete = at({ awarenessDate: '2026-10-01', seriousness: 'Hospitalisation' });
  t('an incomplete case has not started its clock',
    incomplete.clockRunning === false
    && incomplete.warnings.some((w) => w.code === 'MINIMAL_CRITERIA_INCOMPLETE'));

  // No awareness date -> no invented deadline.
  const noAwareness = at({ ...base, awarenessDate: undefined, seriousness: 'Hospitalisation' });
  t('a case with no awareness date yields no deadline and a warning',
    noAwareness.deadline === null && noAwareness.warnings.some((w) => w.code === 'DAY0_UNKNOWN'));

  // A follow-up restarts on the new information date (Article 49).
  const followUp = dl.resolveClock({
    fields: { ...base, seriousness: 'Hospitalisation' }, isFollowUp: true,
    newInfoDate: '2026-10-20', now: '2026-10-22',
  });
  t('a follow-up report restarts the same timeline from the new information date',
    followUp.followUp.startDate === '2026-10-20' && followUp.followUp.dueDate === '2026-11-04');

  // Calendar arithmetic, including the cases that break naive date maths.
  t('day arithmetic crosses a month and a year boundary correctly',
    dl.addDays('2026-12-20', 15) === '2027-01-04');
  t('day arithmetic handles a leap year correctly',
    dl.addDays('2024-02-27', 2) === '2024-02-29' && dl.addDays('2026-02-27', 2) === '2026-03-01');
  t('day arithmetic is not shifted by a daylight-saving transition',
    dl.addDays('2026-03-08', 1) === '2026-03-09' && dl.addDays('2026-11-01', 1) === '2026-11-02');

  // The explanation a PV officer reads out during an inspection. Both locales
  // must carry their own citation: an overseas auditor cannot look up a Chinese
  // clause name, and a domestic inspector cannot look up an English one.
  const explainedEn = dl.explain(serious, 'en');
  const explainedZh = dl.explain(serious, 'zh');
  t('the English deadline explains itself with an English citation',
    explainedEn.includes('2026-10-01') && explainedEn.includes('2026-10-16')
    && explainedEn.includes('Article 49') && !explainedEn.includes('\\u300a'));
  t('the Chinese deadline explains itself with the Chinese citation',
    explainedZh.includes('2026-10-01') && explainedZh.includes('2026-10-16')
    && explainedZh.includes('\\u7b2c\\u56db\\u5341\\u4e5d\\u6761'));
`)));

// ------------------------------- 2. the clock applied to a real record ----

section('the clock recomputes as a case is triaged');

freshDb();
emit(runIsolated('clock-wiring', harness(`
  const db = require(ROOT + '/src/core/db');
  const rec = wf.createInstance({
    processCode: 'ICSR-REG', title: 'Engine test case', summary: 's',
    occurredAt: '2026-09-28', criticality: 'minor', reportSource: 'Spontaneous',
    data: {
      awarenessDate: '2026-10-01', reporterName: 'Dr Li', patientInfo: 'Zhang',
      product: 'DrugX', meddraTerm: 'Hepatitis', seriousness: 'Non-serious',
    },
  }, actor, {});

  t('a newly registered case is given the 30-day non-serious deadline',
    rec.dueDate === '2026-10-31' && rec.clock.rule.id === 'non_serious');
  t('Day 0 is stored on the record', rec.clock.day0 === '2026-10-01');
  t('the suspect product is stored in a queryable column', rec.product === 'DrugX');

  // Triage reclassifies it as serious: the deadline must tighten.
  wf.completeStep({ instanceId: rec.id, stepCode: 'intake', actor,
    formData: { minimalCriteriaComplete: 'Complete', receivedDate: '2026-10-08',
      reportChannel: 'Telephone', patientInfo: 'Zhang', reporterName: 'Dr Li',
      awarenessDate: '2026-10-01' } });
  wf.completeStep({ instanceId: rec.id, stepCode: 'triage', actor,
    formData: { seriousness: 'Hospitalisation', expectedness: 'Unexpected',
      deathCase: 'No', escalationNeeded: 'No' } });

  const after = wf.getInstance(rec.id);
  t('reclassifying to serious tightens the deadline to 15 days',
    after.dueDate === '2026-10-16' && after.clock.rule.id === 'serious');
  t('Day 0 is not reset by re-registration', after.clock.day0 === '2026-10-01');

  // The change must be on the audit trail, not only in a column.
  const rows = db.all("SELECT meta FROM audit_trail WHERE entity_type = 'workflow_instances' ORDER BY seq");
  const clocks = rows.map((r) => { try { return JSON.parse(r.meta || '{}').clock || null; } catch { return null; } })
    .filter(Boolean);
  t('the deadline change is recorded on the audit trail',
    clocks.some((c) => c.rule === 'serious' && c.deadline === '2026-10-16')
    && clocks.some((c) => c.rule === 'non_serious'));
`)));

// ------------------------------------------------------ 3. MedDRA coding --

section('MedDRA coding');

freshDb();
emit(runIsolated('coding', harness(`
  const c = require(ROOT + '/src/domain/coding');

  t('the dictionary loads with a hierarchy and PTs', c.listPts({ limit: 9999 }).length > 0);
  t('SOCs are available for grouping', c.listSocs().length > 0);

  const a = c.code('\\u809d\\u635f\\u4f24');
  const b = c.code('\\u836f\\u7269\\u6027\\u809d\\u635f\\u4f24');
  t('a verbatim term codes to a PT', a.status === 'coded' && a.entry.pt === '10019851');
  t('Chinese synonyms collapse onto one PT',
    a.entry.pt === b.entry.pt && a.entry.ptName === '\\u809d\\u635f\\u4f24');
  t('an English verbatim term codes to the same PT',
    c.code('Drug induced liver injury').entry.pt === '10019851');
  t('a coded PT carries its SOC', a.entry.soc === '10005329');
  t('an exact PT code resolves', c.code('10019851').entry.ptName === '\\u809d\\u635f\\u4f24');

  const miss = c.code('not-a-real-term-xyz');
  t('an unknown term is reported as uncoded, never silently accepted', miss.status === 'unmapped');
  t('an uncoded term explains why it matters',
    /\\u4fe1\\u53f7|\\u5b9a\\u671f\\u62a5\\u544a|aggregate/i.test(miss.message + miss.messageEn));
  t('an empty term is reported as empty', c.code('').status === 'empty');

  const grouped = c.listPts({ soc: '10005329', limit: 99 });
  t('a SOC groups its PTs for aggregate reporting',
    grouped.length > 1 && grouped.every((p) => p.soc === '10005329'));
  t('a Standardised MedDRA Query expands to its member PTs',
    c.expandSmq('SMQ-HEPATIC').members.length > 0);

  const many = c.codeMany(['\\u809d\\u635f\\u4f24', '\\u76ae\\u75b9', 'unknownA', 'unknownB']);
  t('batch coding reports its coverage',
    many.total === 4 && many.coded === 2 && many.coverage === 0.5);
`)));

// ------------------------------------------------- 4. signal statistics --

section('Disproportionality statistics');

freshDb();
emit(runIsolated('statistics', harness(`
  const s = require(ROOT + '/src/domain/signal');
  const near = (x, y, tol) => Math.abs(x - y) < (tol || 0.01);

  // a=8 drug/event, b=2 drug/other, c=20 other/event, d=970 other/other
  //   PRR = (8/10) / (20/990) = 39.6
  //   ROR = (8*970) / (2*20)   = 194
  const p = s.prr(8, 2, 20, 970);
  const r = s.ror(8, 2, 20, 970);
  t('PRR matches its hand-computed value', near(p.prr, 39.6, 0.1));
  t('ROR matches its hand-computed value', near(r.ror, 194, 0.5));
  t('a mirrored table gives the reciprocal ROR', near(s.ror(20, 970, 8, 2).ror, 1 / 194, 0.001));
  t('PRR confidence interval is ordered around the estimate',
    p.ci.lower < p.prr && p.prr < p.ci.upper);
  t('ROR confidence interval is ordered around the estimate',
    r.ci.lower < r.ror && r.ror < r.ci.upper);
  t('a pair with no imbalance does not clear the Evans threshold', s.prr(3, 97, 300, 9600).prr < 2);

  // Shrinkage: the same reporting ratio with far fewer reports must be pulled
  // towards the null, which is exactly what IC025 exists to do.
  const dense = s.informationComponent(40, 60, 400, 9500);
  const sparse = s.informationComponent(3, 12, 300, 9685);
  t('a sparse over-reported pair still shows positive IC', sparse.ic > 0);
  t('shrinkage lowers IC025 towards the null as the count falls',
    sparse.ic025 < dense.ic025);

  // Guard rails: a zero cell must not leak NaN or Infinity into the UI.
  t('a zero cell yields no NaN', s.prr(0, 5, 5, 90).prr === 0 && s.ror(0, 5, 5, 90).ror === 0);
  t('an empty table is handled',
    s.chiSquare(0, 0, 0, 0) === 0 && s.informationComponent(0, 0, 0, 0).ic === 0);
`)));

// ------------------------------------------- 5. detection fires and stays --

section('Signal detection over a synthetic safety database');

freshDb();
emit(runIsolated('signal-detection', harness(`
  const signal = require(ROOT + '/src/domain/signal');
  const mk = (product, term, n) => {
    for (let i = 0; i < n; i += 1) {
      wf.createInstance({
        processCode: 'ICSR-REG', title: product + '-' + term + '-' + i, summary: 's',
        occurredAt: '2026-09-01', criticality: 'minor', reportSource: 'Spontaneous',
        data: { product, meddraTerm: term, seriousness: 'Non-serious' },
      }, actor, {});
    }
  };

  // A product with one rare, unexpected reaction among ordinary ones.
  mk('DrugA', '\\u6025\\u6027\\u809d\\u8870\\u7aed', 6);
  ['Nausea', 'Dizziness', 'Headache', 'Diarrhoea'].forEach((x) => mk('DrugA', x, 3));
  // Background reporting: the rare reaction never appears.
  ['Nausea', 'Dizziness', 'Headache', 'Diarrhoea', 'Rash', 'Somnolence']
    .forEach((x) => mk('BackgroundDrug', x, 14));
  // A control product with an ordinary profile.
  ['Nausea', 'Dizziness', 'Headache'].forEach((x) => mk('DrugB', x, 9));

  const a = signal.analyse({});
  const hit = a.results.find((r) => r.product === 'DrugA' && r.ptName === '\\u6025\\u6027\\u809d\\u8870\\u7aed');

  t('the engine counts cases rather than pair instances', a.totalCases === 6 + 12 + 84 + 27);
  t('a genuinely over-reported pair is flagged', Boolean(hit && hit.flagged));
  t('the flagged pair reports its count correctly', Boolean(hit && hit.count === 6));
  t('a flagged pair names the methods that fired',
    Boolean(hit && hit.methods.length > 0 && hit.needsReview === true));
  t('a flagged pair is routed to assessment, not declared causal',
    Boolean(hit && /signal assessment|\\u4fe1\\u53f7\\u8bc4\\u4f30/i.test(hit.recommendation + hit.recommendationEn)));

  const flagged = a.results.filter((r) => r.flagged);
  t('no control product is flagged',
    !flagged.some((r) => r.product === 'BackgroundDrug' || r.product === 'DrugB'));
  t('only the intended pair is flagged', flagged.length === 1);

  // Shrinkage must overrule a frequentist false positive: the background
  // product's diarrhoea pair clears PRR 2, but its IC025 is negative, so it is
  // not a signal. Asserted by PT code, since the dictionary stores the Chinese
  // preferred term while the case supplied the English verbatim.
  const flatPr = a.results.find((r) => r.product === 'BackgroundDrug' && r.pt === '10007613');
  t('shrinkage rejects a pair that only clears the frequentist threshold',
    Boolean(flatPr && flatPr.prr >= 2 && !flatPr.flagged));

  // The line listing must group the way a periodic report does.
  const ll = signal.lineListing({});
  t('the line listing groups by product, SOC and PT',
    ll.products.length === 3 && ll.products[0].socs.length > 0 && ll.products[0].socs[0].pts.length > 0);
  t('the line listing reaches full coding coverage on coded terms', ll.uncoveredCount === 0);
  t('the line listing totals match the pairs analysed', ll.codedPairCount > 0);
`)));

// ------------------------------------------------------------------ done --

if (fs.existsSync(SCRATCH)) fs.rmSync(SCRATCH, { recursive: true, force: true });

process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n`);
process.exit(failed ? 1 : 0);
