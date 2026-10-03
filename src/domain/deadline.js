'use strict';

/**
 * Reporting-clock engine for individual case safety reports.
 *
 * THE DEFECT THIS REPLACES
 * ------------------------
 * Record creation used to set the due date as `Date.now() + slaDays`. That is
 * the day the clerk happened to type the case in, which has nothing to do with
 * the day the organisation first learned of the event. A report that sat in a
 * mailbox for ten days before anyone registered it was given a fresh 15 days,
 * so the case was recorded as compliant while the regulatory clock had already
 * been breached. The inbox ranks by `due_date`, the monitor raises deadline
 * tasks from `due_date`, and the dashboard reports SLA from `due_date` - every
 * one of those surfaces inherited the error. This is the single most
 * dangerous defect a pharmacovigilance system can carry, because it is silent:
 * nothing looks wrong, and the audit trail then certifies a breach as a pass.
 *
 * WHAT THE CLOCK ACTUALLY RUNS ON
 * ------------------------------
 * GVP 2021 第四十九条 (Article 49), verbatim:
 *
 *   "报告时限的起始日期为持有人首次获知该个例药品不良反应且符合最低报告要求的日期。"
 *   The start date is the date the holder FIRST LEARNED of the case AND the
 *   case MEETS THE MINIMUM REPORTING CRITERIA.
 *
 * Two conditions, both required. "First learned" is the awareness date, not the
 * registration date. "Meets minimum criteria" is the four elements of
 * 第四十六条 / ICH E2D: an identifiable patient, an identifiable reporter, a
 * suspect product, and the adverse reaction itself. Until all four are present
 * the clock has not started - and that is not leniency, it is the rule: a case
 * missing the reporter's identity is not yet a reportable case, and the
 * follow-up obligation is what drives collection.
 *
 * THE LADDER
 * ----------
 * 第四十九条  serious  -> not later than 15 days from Day 0
 * 第四十九条  non-serious -> not later than 30 days from Day 0
 * 第五十一条  overseas suspension / use-withdrawal / market withdrawal
 *              -> not later than 24 HOURS from awareness
 * 死亡病例     report immediately, investigation report still within 15 days
 *              (《药品不良反应报告和监测管理办法》第十二条)
 * 跟踪报告     a follow-up report runs on the same timeline, restarted from the
 *              day the new information was received (第四十九条)
 *
 * All counts are CALENDAR days. Working days and public holidays are not
 * excluded - the countdown a PV officer reads on screen is the countdown the
 * inspector will reconstruct.
 *
 * WHY THE LADDER IS DATA, NOT CODE
 * --------------------------------
 * The same "领域是数据" rule the workflow engine already follows. Each process
 * definition in `seed/workflows/*.json` may carry a `deadlinePolicy` block; this
 * module reads it and evaluates it. A new jurisdiction, a new product class or a
 * new report type is a JSON edit, not a release. This engine supplies the
 * arithmetic and the reasoning; the policy supplies the numbers and the
 * citations.
 */

const DAY_MS = 86400000;

// ------------------------------------------------------------ date helpers --

/** Normalise anything date-ish to `YYYY-MM-DD`, or null when unusable. */
function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Add whole calendar days to a `YYYY-MM-DD` string.
 *
 * Done in UTC on purpose. Adding days by mutating a local `Date` shifts the
 * result across a daylight-saving boundary and silently produces an off-by-one
 * deadline twice a year, which is precisely the class of bug this engine exists
 * to remove.
 */
function addDays(dateOnly, days) {
  const base = toDateOnly(dateOnly);
  if (!base) return null;
  const ms = Date.parse(`${base}T00:00:00Z`) + Math.round(Number(days) || 0) * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`. Negative when `to` is in the past. */
function daysBetween(from, to) {
  const a = toDateOnly(from);
  const b = toDateOnly(to);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Today, in the instance's local calendar day. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ----------------------------------------------------------------- policy --

/**
 * Default ladder. Deliberately mirrors GVP 2021 for a post-marketing MAH, and
 * is overridden per process by `definition.deadlinePolicy`.
 */
const DEFAULT_POLICY = {
  jurisdiction: 'CN',
  /** How many days of head-room to leave when the policy allows a choice. */
  clockBasis: 'awareness_date_with_minimal_criteria',
  seriousDays: 15,
  nonSeriousDays: 30,
  deathImmediate: true,
  deathInvestigationDays: 15,
  overseasActionHours: 24,
  /** Rules are tried in order; the first whose `when` matches wins. */
  rules: [
    {
      id: 'overseas_regulatory_action',
      when: 'overseasRegulatoryAction',
      hours: 24,
      label: '境外暂停销售/使用/撤市',
      labelEn: 'Overseas suspension, use-withdrawal or market withdrawal',
      regulation: '《药物警戒质量管理规范》第五十一条',
      regulationEn: 'GVP 2021 Article 51',
    },
    {
      id: 'death',
      when: 'deathCase',
      days: 0,
      followUpDays: 15,
      label: '死亡病例立即报告',
      labelEn: 'Fatal case - report immediately',
      regulation: '《药物警戒质量管理规范》第四十九条；《药品不良反应报告和监测管理办法》第十二条',
      regulationEn: 'GVP 2021 Article 49; Measures for ADR Reporting and Monitoring Article 12',
    },
    {
      id: 'serious',
      when: 'serious',
      label: '严重不良反应',
      labelEn: 'Serious adverse reaction',
      regulation: '《药物警戒质量管理规范》第四十九条',
      regulationEn: 'GVP 2021 Article 49',
    },
    {
      id: 'non_serious',
      when: 'nonSerious',
      label: '非严重不良反应',
      labelEn: 'Non-serious adverse reaction',
      regulation: '《药物警戒质量管理规范》第四十九条',
      regulationEn: 'GVP 2021 Article 49',
    },
  ],
};

// ------------------------------------------------------- field recognition --

/**
 * Read a field by any of its plausible keys, so the engine works whether the
 * value came from the intake step, the triage step or a data import. Field
 * names differ between process definitions; the *meaning* does not.
 */
function pick(fields, keys) {
  if (!fields) return undefined;
  const lower = new Map();
  for (const k of Object.keys(fields)) lower.set(k.toLowerCase(), fields[k]);
  for (const key of keys) {
    if (lower.has(key.toLowerCase())) return lower.get(key.toLowerCase());
  }
  return undefined;
}

const FIELD_KEYS = {
  awarenessDate: ['awarenessDate', 'dateOfFirstAwareness', 'dayZero', 'day0', 'awareness_date'],
  receivedDate: ['receivedDate', 'dateReceived', 'received_date'],
  occurredAt: ['occurredAt', 'eventOnsetDate', 'reactionStartDate', 'onsetDate'],
  minimalCriteria: [
    'minimalCriteriaComplete', 'minimalCriteria', 'fourElements', 'four_elements',
    'elementsComplete',
  ],
  seriousness: ['seriousness', 'seriousnessCriteria', 'serious'],
  deathCase: ['deathCase', 'fatalCase', 'death'],
  overseas: ['isOverseas', 'overseas', 'occurrenceCountry', 'countryOfOccurrence', '境外'],
  overseasAction: [
    'overseasRegulatoryAction', 'regulatoryAction', 'suspensionWithdrawal',
    'overseasSuspension', 'suspension',
  ],
  seriousnessFinal: ['severityFinal', 'seriousnessFinal', 'severity'],
};

/**
 * A seriousness value is only meaningful if it is a real verdict, not the
 * triage form's "pending review" option. Anything unrecognised is treated as
 * NOT YET CLASSIFIED rather than silently defaulting to non-serious, which
 * would hand out a 30-day deadline to a case that may be a 15-day one.
 */
const NON_SERIOUS_TOKENS = new Set(['非严重', '非嚴重', 'nonserious', 'non-serious', 'not serious', '0', 'false']);
const PENDING_TOKENS = new Set(['待评价', '待評價', '待判定', 'pending', 'tbd', 'unknown', '未知']);
const DEATH_TOKENS = new Set(['是', '死亡', 'yes', 'true', '1', 'y']);
const YES_TOKENS = new Set(['是', '齐备', '具备', '齐備', 'yes', 'true', '1', 'y', 'complete', '齐备无误']);

/**
 * Read the four elements off whatever the process recorded. Accepts either an
 * explicit tri-state select (`齐备` / `缺失-需随访`) or, when the case supplies
 * the four elements as separate values, derives completeness from them.
 *
 * Returns `true` / `false` / `null` (not yet determinable).
 */
function resolveMinimalCriteria(fields) {
  const explicit = pick(fields, FIELD_KEYS.minimalCriteria);
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const token = String(explicit).trim();
    if (YES_TOKENS.has(token) || YES_TOKENS.has(token.toLowerCase())) return true;
    // Anything that is not an explicit "yes" - including a pending marker - is
    // treated as not-yet-complete. Starting the clock early is the lesser evil
    // only if it is flagged, so an explicit pending state returns null.
    if (PENDING_TOKENS.has(token) || PENDING_TOKENS.has(token.toLowerCase())) return null;
    return false;
  }

  const has = (...keys) => {
    const v = pick(fields, keys);
    return v !== undefined && v !== null && String(v).trim() !== '';
  };
  const reporter = has('reporterName', 'reporterContact', 'reporter');
  const patient = has('patientInfo', 'patientInitials', 'patient');
  const product = has('product', 'suspectProduct', 'suspectDrug');
  const event = has('meddraTerm', 'reactionTerm', 'eventTerm', 'adverseEvent', 'reaction');
  if ([reporter, patient, product, event].some((v) => v === false)) return false;
  if (reporter && patient && product && event) return true;
  return null;
}

/** Classify seriousness. `true` serious, `false` non-serious, `null` unknown. */
function resolveSeriousness(fields) {
  for (const key of [FIELD_KEYS.seriousnessFinal, FIELD_KEYS.seriousness]) {
    const raw = pick(fields, key);
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const token = String(raw).trim();
    if (PENDING_TOKENS.has(token) || PENDING_TOKENS.has(token.toLowerCase())) return null;
    // GVP 第四十四条 lists six seriousness criteria. Any of them means serious.
    if (NON_SERIOUS_TOKENS.has(token) || NON_SERIOUS_TOKENS.has(token.toLowerCase())) return false;
    if (YES_TOKENS.has(token) || YES_TOKENS.has(token.toLowerCase())) return true;
    return true; // a named criterion (death / hospitalisation / disability / ...)
  }
  return null;
}

function resolveDeathCase(fields, seriousnessKnown) {
  const raw = pick(fields, FIELD_KEYS.deathCase);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const token = String(raw).trim();
    if (DEATH_TOKENS.has(token) || DEATH_TOKENS.has(token.toLowerCase())) return true;
    if (NON_SERIOUS_TOKENS.has(token) || NON_SERIOUS_TOKENS.has(token.toLowerCase())) return false;
  }
  if (seriousnessKnown === true) {
    const s = pick(fields, FIELD_KEYS.seriousnessFinal) ?? pick(fields, FIELD_KEYS.seriousness);
    if (s && String(s).includes('死亡')) return true;
  }
  return false;
}

function resolveOverseas(fields) {
  const raw = pick(fields, FIELD_KEYS.overseas);
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const token = String(raw).trim().toLowerCase();
  if (['false', '0', 'no', '否', '境内', 'domestic', 'cn'].includes(token)) return false;
  return true;
}

function resolveOverseasAction(fields) {
  const raw = pick(fields, FIELD_KEYS.overseasAction);
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const token = String(raw).trim();
  if (['无', '否', 'none', 'no', 'n/a', '不适用', 'false', '0'].includes(token.toLowerCase())) return false;
  return true;
}

// ------------------------------------------------------------------- clock --

/**
 * Pick the governing policy: the process definition's, else the GVP default.
 *
 * The ladder is materialised here rather than read at the point of use, so every
 * rule carries a resolved `days` / `hours`. A rule that names a category but not
 * a number inherits it from the policy, which is what lets one process override
 * `seriousDays` without restating all four rules.
 */
function policyFor(definition) {
  const custom = definition && definition.deadlinePolicy;
  const base = custom
    ? { ...DEFAULT_POLICY, ...custom }
    : { ...DEFAULT_POLICY };
  const rules = Array.isArray(base.rules) && base.rules.length ? base.rules : DEFAULT_POLICY.rules;

  // Category -> resolved day count. A rule that already carries its own number
  // keeps it; otherwise it inherits the policy's value for its category.
  const inherited = {
    serious: base.seriousDays,
    non_serious: base.nonSeriousDays,
    nonSerious: base.nonSeriousDays,
    death: base.deathInvestigationDays,
  };

  const resolved = rules.map((rule) => {
    const out = { ...rule };
    if (out.days == null) {
      const from = inherited[rule.when] ?? inherited[rule.id];
      if (from != null) out.days = Number(from);
    }
    if (out.followUpDays == null && out.days != null) out.followUpDays = Number(out.days);
    // A fatal case is reported immediately; the 15-day figure is the
    // investigation report, carried on the rule for the UI to surface.
    if (rule.when === 'death' && base.deathImmediate) {
      out.days = Number(rule.days != null ? rule.days : 0);
      out.investigationDays = Number(base.deathInvestigationDays);
    }
    return out;
  });

  return { ...base, rules: resolved, source: custom ? 'process_definition' : 'default' };
}

/**
 * Resolve the reporting clock for one case.
 *
 * @param {object} options
 * @param {object} options.definition  process definition (for its policy)
 * @param {object} options.fields      case data collected so far
 * @param {string} [options.fallbackStart] date to use when no awareness date exists
 * @param {boolean} [options.isFollowUp] true for a follow-up report
 * @param {string} [options.newInfoDate] date new significant information arrived
 * @param {string} [options.now]        today's date, for tests
 * @returns {object} clock - always returned, never throws
 */
function resolveClock(options = {}) {
  const { definition, fields = {}, isFollowUp = false, newInfoDate = null } = options;
  const policy = policyFor(definition);
  const asOf = toDateOnly(options.now) || today();

  const awareness = toDateOnly(pick(fields, FIELD_KEYS.awarenessDate));
  const occurred = toDateOnly(pick(fields, FIELD_KEYS.occurredAt));
  const received = toDateOnly(pick(fields, FIELD_KEYS.receivedDate));

  const minimalCriteria = resolveMinimalCriteria(fields);
  const serious = resolveSeriousness(fields);
  const death = resolveDeathCase(fields, serious);
  const overseas = resolveOverseas(fields);
  const overseasAction = resolveOverseasAction(fields);

  // A follow-up report runs on the same ladder, restarted from the day the new
  // information arrived (第四十九条: 跟踪报告按照个例药品不良反应报告的时限提交).
  const followUpStart = isFollowUp ? toDateOnly(newInfoDate) : null;

  // ---- Day 0 -----------------------------------------------------------
  // First awareness is authoritative. A received/registration date is only a
  // fallback for a case whose awareness date was never captured; using the
  // registration date as Day 0 silently restarts the clock, which is the exact
  // failure this module was written to remove.
  let day0 = awareness || followUpStart || null;
  let day0Basis = 'awareness_date';
  if (!day0) {
    day0 = received || null;
    day0Basis = received ? 'received_date_fallback' : 'none';
  }

  const clockRunning = minimalCriteria === true;
  const warnings = [];

  if (!day0) {
    warnings.push({
      code: 'DAY0_UNKNOWN',
      severity: 'high',
      message: '尚未记录首次获知日期，报告时钟无法起算。请在接收登记步骤补录「首次获知日期」。',
      messageEn: 'No date of first awareness is recorded, so the reporting clock cannot start. Capture it at intake.',
      regulation: '《药物警戒质量管理规范》第四十九条',
    });
  } else if (minimalCriteria === false) {
    warnings.push({
      code: 'MINIMAL_CRITERIA_INCOMPLETE',
      severity: 'info',
      message: '四要素尚未齐备，报告时钟未起算；缺失要素须立即随访。随访期间不得以信息不全为由不报告。',
      messageEn: 'The four elements are not yet complete, so the clock has not started. Follow up now: incomplete data is never a reason not to report.',
      regulation: '《药物警戒质量管理规范》第四十六条、第四十二条',
    });
  } else if (minimalCriteria === null) {
    warnings.push({
      code: 'MINIMAL_CRITERIA_UNKNOWN',
      severity: 'high',
      message: '四要素齐备状态未判定，报告时钟起算时点待确认。',
      messageEn: 'Completeness of the four elements is undetermined, so the clock start is unconfirmed.',
      regulation: '《药物警戒质量管理规范》第四十六条',
    });
  }

  if (awareness && occurred && daysBetween(occurred, awareness) < 0) {
    warnings.push({
      code: 'AWARENESS_BEFORE_ONSET',
      severity: 'high',
      message: '首次获知日期早于事件发生日期，请核实日期录入。',
      messageEn: 'First awareness precedes event onset; verify the dates.',
    });
  }

  // ---- governing rule --------------------------------------------------
  const facts = {
    deathCase: death,
    overseasRegulatoryAction: overseasAction && overseas,
    serious: serious === true,
    nonSerious: serious === false,
  };

  let rule = null;
  for (const candidate of policy.rules) {
    if (facts[candidate.when] === true) { rule = candidate; break; }
  }

  // Seriousness undetermined: default to the SHORT applicable clock. Handing out
  // 30 days to a case that turns out to be serious is a reportable breach that
  // no later discovery can repair, whereas a conservative 15-day deadline merely
  // causes a report to go out sooner than strictly required.
  let assumed = null;
  if (!rule && serious === null) {
    rule = policy.rules.find((r) => r.when === 'serious');
    assumed = 'serious';
    warnings.push({
      code: 'SERIOUSNESS_UNDETERMINED',
      severity: 'high',
      message: '严重性尚未判定，系统按严重个案 15 日时限从严起算；判定为非严重后可重算。',
      messageEn: 'Seriousness is undetermined; the conservative 15-day serious-case clock applies until it is classified.',
      regulation: '《药物警戒质量管理规范》第四十四条、第四十九条',
    });
  }

  // ---- deadline --------------------------------------------------------
  let deadline = null;
  let deadlineDays = null;
  let deadlineHours = null;

  if (rule && day0) {
    if (rule.hours != null) {
      deadlineHours = Number(rule.hours);
      // 24-hour rules are anchored to the instant of awareness, not to midnight.
      // Day 0 + 1 calendar day, and the hours are carried so the UI can say
      // "24 小时" rather than silently rounding a clinical deadline to a day.
      deadline = addDays(day0, Math.ceil(deadlineHours / 24));
    } else {
      deadlineDays = rule.days != null ? Number(rule.days) : 0;
      deadline = addDays(day0, deadlineDays);
    }
  }

  if (!clockRunning && deadline) {
    // Provisional: computed but not yet enforceable.
    warnings.push({
      code: 'CLOCK_PROVISIONAL',
      severity: 'info',
      message: '该时限为暂算值，四要素齐备后正式起算。',
      messageEn: 'Provisional deadline; it becomes enforceable once the four elements are complete.',
    });
  }

  const daysLeft = deadline ? daysBetween(asOf, deadline) : null;

  // ---- follow-up -------------------------------------------------------
  let followUp = null;
  if (isFollowUp) {
    const base = followUpStart || day0;
    const days = rule && rule.followUpDays != null
      ? Number(rule.followUpDays)
      : (rule && rule.hours != null ? Math.ceil(rule.hours / 24) : deadlineDays);
    followUp = {
      startDate: base,
      basis: followUpStart ? 'new_information_date' : 'awareness_date',
      dueDate: base ? addDays(base, days == null ? 0 : days) : null,
      days,
      note: '跟踪报告按首次报告的时限重新起算（第四十九条）。',
      noteEn: 'A follow-up report runs on the same timeline, restarted from the new information date.',
    };
  }

  return {
    jurisdiction: policy.jurisdiction,
    policySource: policy.source,
    asOf,

    day0,
    day0Basis,
    awarenessDate: awareness,
    receivedDate: received,
    occurredAt: occurred,

    minimalCriteria,
    clockRunning,
    isFollowUp,
    followUp,

    serious,
    deathCase: death,
    overseas,
    overseasRegulatoryAction: overseasAction,

    rule: rule
      ? {
        id: rule.id,
        label: rule.label,
        labelEn: rule.labelEn,
        regulation: rule.regulation,
        regulationEn: rule.regulationEn || rule.regulation,
        days: rule.days,
        hours: rule.hours,
        assumed: assumed === 'serious',
      }
      : null,

    deadline,
    deadlineDays,
    deadlineHours,
    daysLeft,
    overdue: deadline ? daysLeft < 0 : false,

    warnings,
  };
}

/**
 * One sentence a PV officer can read out loud in an inspection, plus the clause
 * it came from. The audit trail stores the clock, not just the date, so the
 * basis of a deadline is reviewable years later.
 */
function explain(clock, locale = 'zh') {
  if (!clock) return '';
  const zh = locale !== 'en';
  if (!clock.day0) {
    return zh
      ? '尚未记录首次获知日期，报告时钟未起算。'
      : 'No date of first awareness recorded; the reporting clock has not started.';
  }
  if (!clock.deadline) {
    return zh
      ? '首次获知日期已记录，但时限规则未匹配，需人工判定。'
      : 'Awareness date recorded, but no timeline rule matched; manual determination required.';
  }
  const day0 = clock.day0;
  const deadline = clock.deadline;
  const basis = clock.deadlineHours
    ? `${clock.deadlineHours} 小时`
    : `${clock.deadlineDays} 日`;
  const rule = clock.rule ? (zh ? clock.rule.label : clock.rule.labelEn) : (zh ? '未分类' : 'unclassified');
  // The citation follows the locale. A PV officer reading the English interface
  // still has to cite a clause an overseas auditor can look up, and vice versa.
  const reg = clock.rule
    ? `（${zh ? (clock.rule.regulation || '') : (clock.rule.regulationEn || clock.rule.regulation || '')}）`
    : '';
  const tail = zh
    ? `自 ${day0} 起算，${rule}${reg}，应于 ${deadline} 前报送（${basis}）。`
    : `Counted from ${day0}, ${clock.rule ? clock.rule.labelEn : 'unclassified'}${reg}, due ${deadline} (${clock.deadlineHours ? `${clock.deadlineHours}h` : `${clock.deadlineDays}d`}).`;
  return tail;
}

module.exports = {
  DEFAULT_POLICY,
  policyFor,
  resolveClock,
  resolveMinimalCriteria,
  resolveSeriousness,
  explain,
  toDateOnly,
  addDays,
  daysBetween,
  today,
};
