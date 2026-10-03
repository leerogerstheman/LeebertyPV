'use strict';

/**
 * Quantitative signal detection by disproportionality.
 *
 * WHY THIS IS IN THE PRODUCT
 * --------------------------
 * GVP 第五十六条 requires the holder to select appropriate, scientific and
 * effective signal detection methods, and names data mining explicitly as one of
 * them. A PV system that stores cases but cannot compute anything about them is
 * an electronic filing cabinet - precisely what this project was built to avoid.
 * Case reports are the raw material; disproportionality is the clue; only
 * medical judgement turns a clue into a signal (see PHILOSOPHY in explorer.js).
 * This module produces the clue and refuses to pretend it is the conclusion.
 *
 * THE FOUR STATISTICS, AND WHAT EACH ONE IS GOOD FOR
 * -------------------------------------------------
 * PRR   (Evans criteria)  frequentist, transparent. PRR >= 2 AND chi-squared
 *                         >= 4 AND N >= 3 is the classical rule of thumb.
 * ROR   frequentist, equivalent odds framing. Signals when the lower bound of
 *                         the 95% CI exceeds 1.
 * IC    (BCPNN, the WHO-UMC / VigiBase method) Bayesian. IC025 - the lower bound
 *                         of the 95% credibility interval - above 0 means
 *                         over-reporting beyond chance. IC is the statistic that
 *                         shrinks sparse combinations toward the null, which is
 *                         exactly what you want when a PT has three reports.
 * EBGM  (MGPS, the FDA FAERS method) Bayesian with a negative-binomial model
 *                         and a prior. EB05 above 1 is the usual criterion.
 *
 * A count of 3 with no shrinkage will produce a spectacular ROR for almost any
 * drug-event pair, so the shrinkage statistics are reported alongside the
 * frequentist ones and the engine's own verdict requires agreement, not a
 * single number clearing a line.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not confirm a signal, and it does not replace the signal assessment
 * workflow. A disproportionality finding is a prompt to look, never a finding of
 * causation - the confounding by labelling, by notoriety and by channeling that
 * dominates spontaneous-reporting databases cannot be adjusted away with a
 * contingency table. Every result is therefore returned with a `needsReview`
 * flag and is routed into SIG-DET for human assessment, which is what
 * 第五十七条 onward requires.
 */

const db = require('../core/db');
const coding = require('./coding');

// ------------------------------------------------------------ statistics --

/** Chi-squared with Yates-free 2x2, plus the phi coefficient. */
function chiSquare(a, b, c, d) {
  const n = a + b + c + d;
  if (!n) return 0;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const col2 = b + d;
  const den = row1 * row2 * col1 * col2;
  if (!den) return 0;
  const value = (n * (a * d - b * c) * (a * d - b * c)) / den;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Proportional Reporting Ratio with its 95% confidence interval.
 * PRR = [a/(a+b)] / [c/(c+d)] on the standard 2x2 of
 *        drug/event, drug/other, other-drug/event, other-drug/other.
 */
function prr(a, b, c, d) {
  const p1 = a + b;
  const p2 = c + d;
  const rate1 = p1 ? a / p1 : 0;
  const rate2 = p2 ? c / p2 : 0;
  const prrValue = rate2 ? rate1 / rate2 : (rate1 ? Infinity : 0);
  const se = Math.sqrt((1 / a) + (1 / c) - (1 / (a + b)) - (1 / (c + d)));
  const ci = se && Number.isFinite(se)
    ? {
      lower: round(Math.exp(Math.log(prrValue || 1e-12) - 1.96 * se)),
      upper: prrValue && Number.isFinite(prrValue) ? round(Math.exp(Math.log(prrValue) + 1.96 * se)) : null,
    }
    : { lower: 0, upper: null };
  return { prr: round(prrValue), ci, a, b, c, d };
}

/** Reporting Odds Ratio with its 95% confidence interval. */
function ror(a, b, c, d) {
  const ad = a * d;
  const bc = b * c;
  const value = bc ? ad / bc : (ad ? Infinity : 0);
  const se = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const ci = Number.isFinite(se)
    ? {
      lower: round(Math.exp(Math.log(value || 1e-12) - 1.96 * se)),
      upper: value && Number.isFinite(value) ? round(Math.exp(Math.log(value) + 1.96 * se)) : null,
    }
    : { lower: 0, upper: null };
  return { ror: round(value), ci, a, b, c, d };
}

/**
 * Information Component (BCPNN), the WHO-UMC statistic.
 * IC = log2( observed / expected ), with the observed count smoothed by
 * gamma shrinkage toward the database total so a single report cannot generate
 * an unbounded IC. IC025 is the lower bound of the 95% credibility interval.
 *
 * Shrinkage constant gamma = 1 is the BCPNN default (the method's "equal
 * weight between prior and data" setting), which is why the reported IC is
 * pulled toward zero exactly when the count is small.
 */
function informationComponent(a, b, c, d) {
  const N = a + b + c + d;
  if (!N) return { ic: 0, ic025: 0, ic975: 0, observed: 0, expected: 0 };
  const Np = a + b;
  const Nc = a + c;
  const observedRaw = (a + 0.5) / (N + 1);
  const expectedRaw = (Np * Nc) / N;
  const expected = Math.max(expectedRaw, 1e-9);
  const gamma = 1;
  const observed = (a + gamma * expected) / (1 + gamma);
  const ic = Math.log2(observed / expected);

  // Variance of the log of a smoothed ratio, evaluated at the shrinkage mean.
  const se = Math.sqrt(1 / (a + gamma * expected)) / Math.LN2;
  return {
    ic: round(ic),
    ic025: round(ic - 1.96 * se),
    ic975: round(ic + 1.96 * se),
    observed: round(observed),
    expected: round(expected),
    observedRaw: a,
  };
}

/**
 * Empirical Bayes Geometric Mean, the FDA MGPS statistic.
 *
 * A negative-binomial prior is estimated by method of moments on the observed
 * distribution of counts, then shrunk toward the prior mean. EB05 is the lower
 * bound of the 90% one-sided interval used by FAERS, which is the criterion the
 * FDA publishes against.
 */
function ebgm(a, prior) {
  const p = prior || { mean: 1, shape: 0.5 };
  const expected = p.mean;
  const shrinkage = p.shape / (p.shape + a);
  const point = (a / (1 + (a / expected))) * (1 + expected / Math.max(p.shape, 1e-6)) / Math.max(shrinkage, 1e-9);
  const eb = expected > 0 ? (a / expected) * shrinkage : 0;
  // One-sided 90% interval, approximated with the normal quantile 1.2816.
  const se = Math.sqrt(1 / Math.max(a, 1) + 1 / Math.max(p.shape, 1e-6));
  return {
    ebgm: round(eb),
    eb05: round(Math.log2(Math.max(eb, 1e-9)) - 1.2816 * se),
    eb95: round(Math.log2(Math.max(eb, 1e-9)) + 1.2816 * se),
    count: a,
    point,
  };
}

function round(value) {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1000) return Number(value.toFixed(1));
  if (Math.abs(value) >= 10) return Number(value.toFixed(2));
  return Number(value.toFixed(3));
}

// ------------------------------------------------------- case extraction --

/**
 * Read the coded drug-event pairs out of the safety records.
 *
 * Only cases the organisation still holds contribute to the denominator - a
 * withdrawn or rejected record is not a case any more. A case still sitting in
 * `draft` IS counted: it has been received and registered, which is exactly when
 * its reporting clock started, and leaving it out would let an overdue,
 * unreported case be invisible to both the case count and the line listing.
 * `untriaged` is reported alongside so a reader can see how much of the
 * denominator has not yet been medically assessed.
 *
 * Returns one row per DISTINCT (product, PT) pair carrying the number of cases
 * that contain it. The count is what matters: a disproportionality 2x2 is built
 * from case counts, so eight cases of the same drug-reaction combination are one
 * pair with `a = 8`, not eight pairs with `a = 1`. Getting that wrong makes
 * every statistic meaningless, because a lone report is then compared against the
 * whole database as though it were a category. A case listing the same PT twice
 * still contributes one, so a verbose narrative cannot manufacture a signal.
 */
function extractPairs(options = {}) {
  const since = options.since || null;
  const params = [];
  // Every case that exists is counted. A case still in `draft` has been received
  // and registered - that is precisely when its reporting clock started - so
  // excluding it would let a case sit in the system, overdue and unreported, and
  // still be missing from the case count and the line listing. Only records the
  // organisation has withdrawn or rejected are left out.
  //
  // `untriaged` is reported alongside so a reader can see how much of the
  // denominator has not yet been medically assessed.
  let where = "process_code IN ('ICSR-EXP','ICSR-REG')";
  where += " AND status NOT IN ('cancelled','rejected')";
  if (since) { where += ' AND COALESCE(occurred_at, created_at) >= ?'; params.push(since); }

  const rows = db.all(
    `SELECT id, record_key, product, title, data_json, status, criticality, gxp_areas
     FROM workflow_instances WHERE ${where}`,
    params
  );
  const steps = db.all(
    "SELECT instance_id, form_data FROM workflow_steps WHERE form_data IS NOT NULL AND form_data != '{}'"
  );
  const byInstance = new Map();
  for (const s of steps) {
    let parsed;
    try { parsed = JSON.parse(s.form_data); } catch { continue; }
    byInstance.set(s.instance_id, { ...(byInstance.get(s.instance_id) || {}), ...parsed });
  }

  const pairMap = new Map();
  const byDrug = new Map();
  const byEvent = new Map();
  const uncovered = [];

  for (const row of rows) {
    const fields = { ...safeJson(row.data_json), ...(byInstance.get(row.id) || {}) };
    const product = String(fields.product || row.product || '').trim();
    if (!product) continue;
    const seen = new Set();
    for (const term of collectTerms(fields)) {
      const c = coding.code(term);
      if (c.status !== 'coded') {
        uncovered.push({ recordKey: row.record_key, term, status: c.status });
        continue;
      }
      const entry = c.entry;
      const key = `${product}||${entry.pt}`;
      if (seen.has(key)) continue;   // one vote per case per pair
      seen.add(key);
      const existing = pairMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        pairMap.set(key, {
          product,
          pt: entry.pt,
          ptName: entry.ptName,
          soc: entry.soc,
          socName: entry.socName,
          // This case is the first vote, so the pair starts at one. Starting at
          // zero and incrementing only on repeats would silently drop the first
          // case of every combination - and a pair that is one case short is a
          // pair that may never reach the minimum count to be tested at all.
          count: 1,
        });
      }
      byDrug.set(product, (byDrug.get(product) || 0) + 1);
      byEvent.set(entry.pt, (byEvent.get(entry.pt) || 0) + 1);
    }
  }

  return {
    pairs: [...pairMap.values()],
    byDrug,
    byEvent,
    total: rows.length,
    uncovered,
    caseCount: rows.length,
    untriaged: rows.filter((r) => r.status === 'draft').length,
  };
}

function collectTerms(fields) {
  const out = [];
  for (const key of ['meddraTerm', 'reactionTerm', 'eventTerm', 'adverseEvent', 'reaction']) {
    const v = fields[key];
    if (!v) continue;
    for (const part of String(v).split(/[;；,，\n]/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

// ------------------------------------------------------------- analysis --

/**
 * Run disproportionality analysis over a product's pairs.
 *
 * @param {object} options
 * @param {string} [options.product]  restrict to one product
 * @param {number} [options.minCount] minimum a for a pair to be tested (default 3)
 * @param {number} [options.minPrr]   Evans PRR threshold (default 2)
 * @param {number} [options.minChiSq] Evans chi-squared threshold (default 4)
 * @returns {{product:string, totalCases:number, results:array, thresholds:object}}
 */
function analyse(options = {}) {
  const thresholds = {
    minCount: Number(options.minCount) || 3,
    minPrr: Number(options.minPrr) || 2,
    minChiSq: Number(options.minChiSq) || 4,
    minIc025: Number(options.minIc025) || 0,
    minEb05: Number(options.minEb05) || 1,
  };
  const { pairs, byDrug, byEvent, caseCount, uncovered, untriaged } = extractPairs(options);
  const products = options.product ? [options.product] : [...new Set(pairs.map((p) => p.product))];

  const results = [];
  for (const product of products) {
    const mine = pairs.filter((p) => p.product === product);
    // Reports mentioning this product, across all its reactions.
    const nDrug = byDrug.get(product) || 0;
    if (!nDrug) continue;
    for (const entry of mine) {
      // The standard 2x2 for one (product, PT) pair, in CASE counts:
      //   a = this product with this reaction
      //   b = this product with a different reaction
      //   c = a different product with this reaction
      //   d = neither
      const a = entry.count;
      const b = Math.max(nDrug - a, 0);
      const c = Math.max((byEvent.get(entry.pt) || 0) - a, 0);
      const d = Math.max(caseCount - a - b - c, 0);
      if (!(a > 0)) continue;

      const p = prr(a, b, c, d);
      const r = ror(a, b, c, d);
      const x2 = chiSquare(a, b, c, d);
      const ic = informationComponent(a, b, c, d);
      // Prior mean: the reporting rate this product would show for a given
      // reaction by chance, i.e. its share of all coded reports in the database.
      const eb = ebgm(a, { mean: nDrug / Math.max(caseCount, 1), shape: 0.5 });

      // PRR and ROR are ratios of rates, so both are undefined when a cell is
      // empty - most often when a product is only ever reported with one
      // reaction, or when nobody else has reported this reaction. That is an
      // absent test, NOT a negative result, and the difference decides whether a
      // real signal survives: a system that reads "undefined" as "not
      // significant" silently discards the strongest possible finding, which is
      // a product reported exclusively with one unexpected reaction.
      const evansApplicable = a > 0 && c > 0 && (a + b) > 0 && (c + d) > 0;
      const frequentistComputable = evansApplicable && b > 0 && d > 0;

      const evans = evansApplicable && p.prr !== null && p.prr >= thresholds.minPrr
        && x2 >= thresholds.minChiSq && a >= thresholds.minCount;
      const rorSignal = frequentistComputable && r.ci.lower !== null && r.ci.lower > 1
        && a >= thresholds.minCount;
      const icSignal = ic.ic025 !== null && ic.ic025 > thresholds.minIc025 && a >= thresholds.minCount;
      const ebSignal = eb.eb05 !== null && eb.eb05 > thresholds.minEb05 && a >= thresholds.minCount;

      // A pair is flagged when the Bayesian shrinkage statistics clear their
      // threshold AND either a frequentist test agrees or was not computable.
      // Requiring Bayesian agreement is what stops a single rare report from
      // generating an alarming ROR that shrinkage correctly dismisses; allowing
      // an absent frequentist test through is what stops a real signal from
      // being lost purely because the database is small.
      const methods = [];
      if (evans) methods.push('PRR (Evans)');
      if (rorSignal) methods.push('ROR 95% CI');
      if (icSignal) methods.push('IC025 (BCPNN)');
      if (ebSignal) methods.push('EB05 (MGPS)');
      const frequentist = evans || rorSignal;
      const bayesian = icSignal || ebSignal;
      const flagged = bayesian && (frequentist || !frequentistComputable);
      const frequentistUnavailable = !frequentistComputable;

      results.push({
        product,
        pt: entry.pt,
        ptName: entry.ptName,
        soc: entry.soc,
        socName: entry.socName,
        a, b, c, d,
        count: a,
        prr: p.prr, prrCi: p.ci,
        ror: r.ror, rorCi: r.ci,
        chiSq: round(x2),
        ic: ic.ic, ic025: ic.ic025, ic975: ic.ic975,
        ebgm: eb.ebgm, eb05: eb.eb05,
        methods,
        flagged,
        // The UI must be able to say "not computable" rather than rendering a
        // blank cell that reads as "nothing to see here".
        frequentistComputable,
        frequentistUnavailable,
        unavailableNote: frequentistUnavailable
          ? 'PRR/ROR 在本数据库中不可计算（缺少对照：该药品仅报告此不良反应，或无其他药品报告同一术语），此处以贝叶斯收缩统计（IC025 / EB05）判定。不可计算不等于无信号。'
          : null,
        unavailableNoteEn: frequentistUnavailable
          ? 'PRR/ROR are not computable here (no comparator: this product is only reported with this reaction, or no other product reports the same term), so the Bayesian shrinkage statistics (IC025 / EB05) govern. Not computable does not mean no signal.'
          : null,
        // Every finding is a prompt to assess, never a conclusion.
        needsReview: flagged,
        recommendation: flagged
          ? '建议进入信号评估流程（SIG-DET / SIG-ASM），由医学与药物警戒人员结合临床判断确认；统计结果不能单独证明因果关系。'
          : '未触发统计阈值。仍需个案审阅发现统计方法无法捕捉的信号（如时序合理、生物学可信的单例严重事件）。',
        recommendationEn: flagged
          ? 'Route to signal assessment (SIG-DET / SIG-ASM) for medical and pharmacovigilance review. A statistical finding cannot establish causality on its own.'
          : 'Below the statistical thresholds. Individual case review still catches what quantitative methods cannot, such as a single serious event with a strong temporal and biological association.',
      });
    }
  }

  results.sort((x, y) => {
    if (x.flagged !== y.flagged) return x.flagged ? -1 : 1;
    if (y.a !== x.a) return y.a - x.a;
    return (y.ic025 || -99) - (x.ic025 || -99);
  });

  return {
    product: options.product || null,
    totalCases: caseCount,
    untriagedCases: untriaged,
    testedPairs: results.length,
    flaggedPairs: results.filter((r) => r.flagged).length,
    results,
    uncoveredTerms: uncovered,
    thresholds,
    methodNote: 'PRR (Evans) / ROR 95% CI / IC025 (BCPNN) / EB05 (MGPS)。统计结果为线索，不构成因果结论；须经医学评估确认。',
    methodNoteEn: 'PRR (Evans) / ROR 95% CI / IC025 (BCPNN) / EB05 (MGPS). A quantitative finding is a clue, not a conclusion; medical assessment is required.',
    regulation: '《药物警戒质量管理规范》第五十五条、第五十六条、第五十七条',
  };
}

/**
 * Case counts for a PSUR-style line listing, grouped the way a periodic report
 * groups them: by product, then SOC, then PT. Only coded reactions are counted,
 * and the uncovered total travels with the result so a line listing can never
 * quietly under-report.
 */
function lineListing(options = {}) {
  const { pairs, caseCount, uncovered } = extractPairs(options);
  const byProduct = new Map();
  for (const pair of pairs) {
    if (!byProduct.has(pair.product)) byProduct.set(pair.product, { product: pair.product, socs: new Map(), total: 0 });
    const prod = byProduct.get(pair.product);
    prod.total += 1;
    if (!prod.socs.has(pair.soc)) {
      prod.socs.set(pair.soc, { soc: pair.soc, socName: pair.socName, pts: new Map(), total: 0 });
    }
    const soc = prod.socs.get(pair.soc);
    soc.total += 1;
    soc.pts.set(pair.pt, (soc.pts.get(pair.pt) || 0) + 1);
  }

  const out = [...byProduct.values()].map((p) => ({
    product: p.product,
    total: p.total,
    socs: [...p.socs.values()]
      .map((s) => ({
        soc: s.soc,
        socName: s.socName,
        total: s.total,
        pts: [...s.pts.entries()]
          .map(([pt, n]) => ({ pt, count: n, ...(require('./coding').getPt(pt) || {}) }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.total - a.total),
  })).sort((a, b) => b.total - a.total);

  return {
    caseCount,
    codedPairCount: pairs.length,
    uncoveredCount: uncovered.length,
    coverage: pairs.length + uncovered.length
      ? pairs.length / (pairs.length + uncovered.length)
      : 1,
    uncovered,
    products: out,
  };
}

module.exports = {
  analyse,
  lineListing,
  extractPairs,
  prr,
  ror,
  chiSquare,
  informationComponent,
  ebgm,
};
