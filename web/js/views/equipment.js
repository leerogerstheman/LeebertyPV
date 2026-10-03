/* View: equipment and calibration - the register, the calibration due report and
 * the per-instrument compliance answer.
 *
 * The design point: an instrument's *scheduling* state is not the same as its
 * *usable* state. A failed calibration takes the instrument out of service
 * immediately, and a later pass does NOT put it back - returning to service is a
 * separate, reasoned decision recorded in the audit trail (21 CFR 211.160(b)(4),
 * 21 CFR 211.67, EU GMP Annex 11). The UI states this at the point of action so
 * nobody assumes a green calibration badge means "released".
 */
(function () {
  'use strict';

  const { t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, statusBadge, criticalityBadge, button, field, input, textarea, select } = U;

  /** Computed calibration / maintenance state -> badge tone. */
  const SCHEDULE_TONES = {
    overdue: 'bad',
    due_soon: 'warn',
    valid: 'ok',
    not_required: 'muted',
  };

  const CAL_LABEL_KEYS = {
    valid: 'equipment.calibrationValid',
    due_soon: 'equipment.calibrationDueSoon',
    overdue: 'equipment.calibrationOverdue',
    not_required: 'equipment.notRequired',
  };

  const CSV_TONES = {
    validated: 'ok',
    in_progress: 'warn',
    pending: 'warn',
    not_started: 'bad',
    not_assessed: 'muted',
    not_applicable: 'muted',
  };

  const CSV_STATUSES = ['not_assessed', 'not_started', 'in_progress', 'pending', 'validated', 'not_applicable'];

  const PASS_WORDS = ['pass', 'passed', '合格', 'compliant', 'ok', 'yes'];
  const FAIL_WORDS = ['fail', 'failed', '不合格', 'non_compliant', 'non-compliant', 'no'];

  const DAYS_WINDOW = 60;

  function scheduleLabel(status, kind) {
    if (status === 'overdue') return kind === 'calibration' ? t('equipment.calibrationOverdue') : t('common.overdue');
    if (status === 'due_soon') return kind === 'calibration' ? t('equipment.calibrationDueSoon') : t('equipment.nextMaintenance');
    if (status === 'not_required') return t('equipment.notRequired');
    return kind === 'calibration' ? t('equipment.calibrationValid') : t('equipment.maintenance');
  }

  function daysSuffix(days) {
    if (days === null || days === undefined || Math.abs(days) > DAYS_WINDOW) return '';
    return ` (${days >= 0 ? '+' : ''}${days}${t('common.days')})`;
  }

  function calibrationBadge(row) {
    const status = row.calibrationStatus || 'not_required';
    const label = t(CAL_LABEL_KEYS[status] || 'equipment.notRequired');
    return badge(`${label}${daysSuffix(row.daysToCalibration)}`, SCHEDULE_TONES[status] || 'neutral', {
      title: `${t('equipment.nextCalibration')}: ${U.fmtDate(row.nextCalibrationDate)}`,
    });
  }

  function maintenanceBadge(row) {
    const status = row.maintenanceStatus || 'not_required';
    return badge(`${scheduleLabel(status, 'maintenance')}${daysSuffix(row.daysToMaintenance)}`, SCHEDULE_TONES[status] || 'neutral', {
      title: `${t('equipment.nextMaintenance')}: ${U.fmtDate(row.nextMaintenanceDate)}`,
    });
  }

  function csvBadge(row) {
    if (!row.csvStatus) return badge(bilingual('未评估', 'Not assessed'), 'muted', { title: t('equipment.csvStatus') });
    return badge(U.humanise(row.csvStatus), CSV_TONES[row.csvStatus] || 'neutral', {
      title: `${t('equipment.csvStatus')}${row.csvRef ? ` \u00b7 ${row.csvRef}` : ''}`,
    });
  }

  function hasQualificationGap(row) {
    if (row.qualificationComplete === false) return true;
    return ['not_qualified', 'disqualified', 'requalification_due'].includes(row.qualificationStatus);
  }

  function nameOf(row) {
    if (!row) return '';
    return getLocale() === 'en' && row.nameEn ? row.nameEn : (row.name || row.nameEn || '');
  }

  function normaliseResult(value) {
    const v = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    if (!v) return null;
    if (PASS_WORDS.includes(v)) return 'pass';
    if (FAIL_WORDS.includes(v)) return 'fail';
    return v;
  }

  function resultOptions() {
    return [
      { value: 'pass', label: `${t('equipment.pass')} / pass` },
      { value: 'fail', label: `${t('equipment.fail')} / fail` },
      { value: '合格', label: `合格 / ${t('equipment.pass')}` },
      { value: '不合格', label: `不合格 / ${t('equipment.fail')}` },
    ];
  }

  function statusOptions() {
    return [
      { value: 'in_service', label: t('equipment.inService') },
      { value: 'out_of_service', label: t('equipment.outOfService') },
      { value: 'under_maintenance', label: bilingual('维护中', 'Under maintenance') },
      { value: 'quarantined', label: bilingual('隔离', 'Quarantined') },
      { value: 'retired', label: bilingual('已退役', 'Retired') },
    ];
  }

  function qualificationStatusOptions() {
    return [
      { value: 'not_qualified', label: bilingual('未确认', 'Not qualified') },
      { value: 'in_progress', label: bilingual('确认中', 'Qualification in progress') },
      { value: 'qualified', label: bilingual('已确认', 'Qualified') },
      { value: 'requalification_due', label: bilingual('需再确认', 'Requalification due') },
      { value: 'disqualified', label: bilingual('确认不合格', 'Disqualified') },
    ];
  }

  function criticalityOptions() {
    return [
      { value: 'low', label: bilingual('低', 'Low') },
      { value: 'medium', label: bilingual('中', 'Medium') },
      { value: 'high', label: bilingual('高', 'High') },
      { value: 'critical', label: bilingual('关键', 'Critical') },
    ];
  }

  function csvStatusOptions() {
    return CSV_STATUSES.map((s) => ({ value: s, label: U.humanise(s) }));
  }

  function todayInput() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function debounced(fn, ms) {
    let timer = null;
    return (value) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(value), ms);
    };
  }

  function setQuery(patch) {
    const route = window.Views.resolveRoute(window.location.hash);
    const query = { ...(route ? route.query : {}), ...patch };
    const base = (window.location.hash.split('?')[0]) || '#/equipment';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  /** Multi-select as a checkbox group; returns { node, values() }. */
  function checkGroup(name, options, initial) {
    const selected = new Set(initial || []);
    const controls = (options || []).map((opt) => U.checkbox(
      `${name}-${opt.value}`,
      selected.has(opt.value),
      opt.label,
      {
        onchange: (ev) => {
          if (ev.target.checked) selected.add(opt.value);
          else selected.delete(opt.value);
        },
      }
    ));
    return {
      node: el('div.check-group', {}, controls.length ? controls : el('span.muted', {}, t('common.noData'))),
      values: () => Array.from(selected),
    };
  }

  function areaOptions() {
    return ((window.App.boot && window.App.boot.gxpAreas) || []).map((a) => ({
      value: a.code,
      label: `${a.code}${a.fullName ? ` \u00b7 ${a.fullName}` : ''}`,
    }));
  }

  function processOptions() {
    return ((window.App.boot && window.App.boot.processTypes) || []).map((p) => ({
      value: p.code,
      label: getLocale() === 'en' && p.nameEn ? p.nameEn : `${p.name} / ${p.nameEn || p.code}`,
    }));
  }

  function defaultProcessCode() {
    const defs = (window.App.boot && window.App.boot.processTypes) || [];
    const dev = defs.find((p) => p.code === 'DEV');
    return (dev || defs[0] || {}).code || '';
  }

  function uniqueValues(rows, key) {
    const out = [];
    for (const r of rows || []) {
      const v = r[key];
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }

  // ============================================================== list ======

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      clear(container);
      container.appendChild(U.spinner());

      const filters = {
        search: query.search || '',
        status: query.status || '',
        department: query.department || '',
        gxpArea: query.gxpArea || '',
        criticality: query.criticality || '',
        calibrationStatus: query.calibrationStatus || '',
        qualificationStatus: query.qualificationStatus || '',
      };

      let data;
      try {
        data = await window.Api.get('/api/equipment', { ...filters, limit: 200 });
      } catch (err) {
        clear(container);
        container.appendChild(U.errorBox(err, () => listView.render(container, params)));
        return;
      }
      const report = await window.Api.get('/api/reports/calibration', { daysAhead: 90 })
        .then((body) => ({ data: body }), (error) => ({ error }));

      clear(container);
      const rows = data.rows || [];
      const commitSearch = debounced((v) => setQuery({ search: v || null }), 350);
      const departments = uniqueValues(rows, 'department');

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('equipment.title')),
            el('p.view-sub', {}, t('equipment.subtitle')),
          ]),
          el('div.view-head-actions', {}, [
            button(t('common.refresh'), { variant: 'ghost', onclick: () => window.App.refresh() }),
            window.App.can('equipment.manage')
              ? button(t('equipment.newEquipment'), {
                  variant: 'primary',
                  onclick: () => newEquipmentDialog(() => window.App.refresh()),
                })
              : null,
          ]),
        ]),

        el('div.filter-bar', {}, [
          input('search', filters.search, {
            placeholder: `${t('common.search')} \u00b7 ${t('equipment.assetNo')} / ${t('equipment.name')}`,
            oninput: (ev) => commitSearch(ev.target.value.trim()),
          }),
          select('status', filters.status, statusOptions(), {
            placeholder: `\u2014 ${t('common.status')} \u2014`,
            onchange: (ev) => setQuery({ status: ev.target.value || null }),
          }),
          select('department', filters.department, departments.map((d) => ({ value: d, label: d })), {
            placeholder: `\u2014 ${t('common.department')} \u2014`,
            onchange: (ev) => setQuery({ department: ev.target.value || null }),
          }),
          select('calibrationStatus', filters.calibrationStatus, [
            { value: 'overdue', label: t('equipment.calibrationOverdue') },
            { value: 'due_soon', label: t('equipment.calibrationDueSoon') },
            { value: 'valid', label: t('equipment.calibrationValid') },
            { value: 'not_required', label: t('equipment.notRequired') },
          ], {
            placeholder: `\u2014 ${t('equipment.calibration')} \u2014`,
            onchange: (ev) => setQuery({ calibrationStatus: ev.target.value || null }),
          }),
          select('criticality', filters.criticality, criticalityOptions(), {
            placeholder: `\u2014 ${t('common.criticality')} \u2014`,
            onchange: (ev) => setQuery({ criticality: ev.target.value || null }),
          }),
          select('qualificationStatus', filters.qualificationStatus, qualificationStatusOptions(), {
            placeholder: `\u2014 ${t('equipment.qualification')} \u2014`,
            onchange: (ev) => setQuery({ qualificationStatus: ev.target.value || null }),
          }),
          select('gxpArea', filters.gxpArea, areaOptions(), {
            placeholder: '\u2014 GxP \u2014',
            onchange: (ev) => setQuery({ gxpArea: ev.target.value || null }),
          }),
        ]),

        statStrip(rows, data.total),

        card(t('equipment.title'), table(equipmentColumns(), rows, {
          emptyText: t('common.noData'),
          onRowClick: (r) => { window.location.hash = `#/equipment/${r.id}`; },
          rowClass: (r) => [
            r.calibrationStatus === 'overdue' ? 'row-gap' : '',
            r.status === 'out_of_service' ? 'row-out-of-service' : '',
          ].filter(Boolean).join(' '),
        }), {
          subtitle: `${rows.length} / ${U.fmtNumber(data.total)} ${t('common.items')} \u00b7 limit ${data.limit}`,
        }),

        calibrationPanel(report, () => window.App.refresh()),
      ]));
    },
  };

  function equipmentColumns() {
    return [
      {
        key: 'assetNo',
        label: t('equipment.assetNo'),
        render: (r) => el('span', {}, [
          el('a.mono.strong', { href: `#/equipment/${r.id}` }, r.assetNo),
          r.gxpCritical ? badge('GxP', 'warn', { title: t('common.criticality') }) : null,
        ]),
      },
      {
        key: 'name',
        label: t('equipment.name'),
        render: (r) => el('span', { title: [r.name, r.nameEn].filter(Boolean).join(' / ') }, [
          el('span', {}, nameOf(r)),
          r.model || r.manufacturer
            ? el('div.small.muted', {}, [r.manufacturer, r.model, r.serialNo].filter(Boolean).join(' \u00b7 '))
            : null,
        ]),
      },
      {
        key: 'location',
        label: t('equipment.location'),
        render: (r) => el('span', {}, [r.location || '\u2014', r.department ? el('div.small.muted', {}, r.department) : null]),
      },
      { key: 'status', label: t('common.status'), render: (r) => statusBadge(r.status) },
      { key: 'criticality', label: t('common.criticality'), render: (r) => criticalityBadge(r.criticality) },
      {
        key: 'qualificationStatus',
        label: t('equipment.qualification'),
        render: (r) => el('span', {}, [
          statusBadge(r.qualificationStatus),
          !r.qualificationComplete ? el('div.small.muted', {}, bilingual('IQ/OQ/PQ 不完整', 'IQ/OQ/PQ incomplete')) : null,
        ]),
      },
      { key: 'calibrationStatus', label: t('equipment.calibration'), render: (r) => calibrationBadge(r) },
      {
        key: 'nextCalibrationDate',
        label: t('equipment.nextCalibration'),
        render: (r) => el('span', { class: r.calibrationStatus === 'overdue' ? 'overdue' : '' }, U.fmtDate(r.nextCalibrationDate)),
      },
      { key: 'maintenanceStatus', label: t('equipment.maintenance'), render: (r) => maintenanceBadge(r) },
    ];
  }

  function statStrip(rows, total) {
    const inService = rows.filter((r) => r.status === 'in_service').length;
    const outOfService = rows.filter((r) => r.status === 'out_of_service').length;
    const calOverdue = rows.filter((r) => r.calibrationStatus === 'overdue').length;
    const calDueSoon = rows.filter((r) => r.calibrationStatus === 'due_soon').length;
    const qualGaps = rows.filter(hasQualificationGap).length;

    return el('div.stat-strip', {}, [
      stat(t('common.total'), U.fmtNumber(total), { hint: `${rows.length} ${t('common.items')}` }),
      stat(t('equipment.inService'), U.fmtNumber(inService), { tone: 'ok' }),
      stat(t('equipment.outOfService'), U.fmtNumber(outOfService), { tone: outOfService ? 'bad' : 'ok' }),
      stat(t('equipment.calibrationOverdue'), U.fmtNumber(calOverdue), { tone: calOverdue ? 'bad' : 'ok' }),
      stat(t('equipment.calibrationDueSoon'), U.fmtNumber(calDueSoon), { tone: calDueSoon ? 'warn' : 'ok' }),
      stat(bilingual('确认状态缺口', 'Qualification gaps'), U.fmtNumber(qualGaps), { tone: qualGaps ? 'warn' : 'ok' }),
    ]);
  }

  function dueColumns() {
    return [
      {
        key: 'assetNo',
        label: t('equipment.assetNo'),
        render: (r) => el('a.mono.strong', { href: `#/equipment/${r.id}` }, r.assetNo),
      },
      { key: 'name', label: t('equipment.name'), render: (r) => el('span', { title: r.name }, U.truncate(nameOf(r), 50)) },
      { key: 'department', label: t('common.department'), render: (r) => r.department || '\u2014' },
      { key: 'location', label: t('equipment.location'), render: (r) => r.location || '\u2014' },
      { key: 'criticality', label: t('common.criticality'), render: (r) => criticalityBadge(r.criticality) },
      { key: 'nextCalibrationDate', label: t('equipment.nextCalibration'), render: (r) => U.fmtDate(r.nextCalibrationDate) },
      {
        key: 'daysToCalibration',
        label: t('common.daysToDue'),
        align: 'right',
        render: (r) => (r.daysToCalibration === null || r.daysToCalibration === undefined
          ? el('span.muted', {}, '\u2014')
          : el('span', { class: r.daysToCalibration < 0 ? 'overdue' : '' }, `${r.daysToCalibration >= 0 ? '+' : ''}${r.daysToCalibration}${t('common.days')}`)),
      },
      { key: 'calibrationStatus', label: t('common.status'), render: (r) => calibrationBadge(r) },
    ];
  }

  /** Collapsible calibration due report - out-of-calibration instruments are a
   *  data-integrity exposure, not a housekeeping item. */
  function calibrationPanel(result, retry) {
    if (!result) return null;
    if (result.error) {
      return card(t('equipment.calibration'), U.errorBox(result.error, retry));
    }
    const report = result.data || {};
    const overdue = report.overdue || [];
    const dueSoon = report.dueSoon || [];
    const byDepartment = report.byDepartment || [];
    const open = overdue.length > 0 || (report.gxpCriticalOverdue || 0) > 0;

    return card(t('equipment.calibration'), el('details.panel-details', { open: open ? 'open' : null }, [
      el('summary.panel-summary', {}, [
        el('span.panel-title', {}, bilingual('校准到期报告', 'Calibration due report')),
        badge(`${overdue.length} ${t('common.overdue')}`, overdue.length ? 'bad' : 'ok'),
        badge(`${dueSoon.length} ${t('equipment.calibrationDueSoon')}`, dueSoon.length ? 'warn' : 'ok'),
        (report.gxpCriticalOverdue || 0) > 0
          ? badge(`${bilingual('GxP 关键超期', 'GxP-critical overdue')}: ${report.gxpCriticalOverdue}`, 'bad')
          : null,
        el('span.small.muted', {}, `${report.daysAhead || 0}${t('common.days')}`),
      ]),
      el('div.panel-body', {}, [
        el('h3.section-mini', {}, t('equipment.calibrationOverdue')),
        table(dueColumns(), overdue, {
          emptyText: bilingual('没有校准超期设备', 'Nothing is out of calibration'),
          onRowClick: (r) => { window.location.hash = `#/equipment/${r.id}`; },
        }),
        el('h3.section-mini', {}, t('equipment.calibrationDueSoon')),
        table(dueColumns(), dueSoon, {
          emptyText: bilingual('近期没有到期校准', 'Nothing falls due in this window'),
          onRowClick: (r) => { window.location.hash = `#/equipment/${r.id}`; },
        }),
        el('h3.section-mini', {}, bilingual('按部门统计', 'By department')),
        table([
          { key: 'department', label: t('common.department') },
          { key: 'total', label: t('common.total'), align: 'right' },
          { key: 'overdue', label: t('common.overdue'), align: 'right', render: (r) => (r.overdue ? badge(String(r.overdue), 'bad') : '0') },
          { key: 'dueSoon', label: t('equipment.calibrationDueSoon'), align: 'right', render: (r) => (r.dueSoon ? badge(String(r.dueSoon), 'warn') : '0') },
        ], byDepartment, { emptyText: t('common.noData') }),
      ]),
    ]), {
      subtitle: bilingual(
        '校准超期设备产生的数据不可靠——这是数据完整性风险，不只是台账问题。',
        'Data from an out-of-calibration instrument is not reliable: this is a data-integrity risk, not a housekeeping item.'
      ),
    });
  }

  // ============================================================== item ======

  const itemView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());
      let row;
      try {
        row = await window.Api.get(`/api/equipment/${params.id}`);
      } catch (err) {
        clear(container);
        container.appendChild(U.errorBox(err, () => itemView.render(container, params)));
        return;
      }
      clear(container);
      container.appendChild(paintItem(row, () => window.App.refresh()));
    },
  };

  function paintItem(row, refresh) {
    const manage = window.App.can('equipment.manage');

    const actions = [
      button(t('common.refresh'), { variant: 'ghost', onclick: () => window.App.refresh() }),
      manage ? button(t('equipment.recordCalibration'), { variant: 'primary', onclick: () => calibrationDialog(row, refresh) }) : null,
      manage ? button(t('equipment.recordMaintenance'), { variant: 'ghost', onclick: () => maintenanceDialog(row, refresh) }) : null,
      manage ? button(bilingual('设置确认状态', 'Set qualification'), { variant: 'ghost', onclick: () => qualificationDialog(row, refresh) }) : null,
      manage ? button(t('common.edit'), { variant: 'ghost', onclick: () => editEquipmentDialog(row, refresh) }) : null,
      manage && row.status === 'out_of_service'
        ? button(bilingual('恢复在用', 'Return to service'), { variant: 'ghost', onclick: () => returnToService(row, refresh) })
        : null,
      window.App.can('deviation.manage')
        ? button(t('equipment.raiseRecord'), { variant: 'ghost', onclick: () => raiseDeviationDialog(row, refresh) })
        : null,
    ].filter(Boolean);

    return el('div.view', {}, [
      el('div.view-head', {}, [
        el('div', {}, [
          el('div.breadcrumb', {}, el('a', { href: '#/equipment' }, t('equipment.title'))),
          el('h1.view-title', {}, [
            el('span.mono', {}, row.assetNo),
            el('span.title-sep', {}, ' \u00b7 '),
            nameOf(row),
          ]),
          el('div.head-badges', {}, [
            statusBadge(row.status),
            statusBadge(row.qualificationStatus),
            calibrationBadge(row),
            criticalityBadge(row.criticality),
            csvBadge(row),
            ...(row.gxpAreas || []).map((a) => badge(a, 'info')),
          ]),
        ]),
        el('div.view-head-actions', {}, actions),
      ]),

      row.status === 'out_of_service' ? outOfServiceBanner(row, manage, refresh) : null,

      el('div.record-grid', {}, [
        el('div.record-main', {}, [
          calibrationVisual(row, manage, refresh),
          qualificationCard(row),
          csvCard(row),
        ]),
        el('div.record-side', {}, [
          detailsCard(row),
          notesCard(row),
        ]),
      ]),
    ]);
  }

  function outOfServiceBanner(row, manage, refresh) {
    return el('div.warning-note.banner-note', {}, [
      el('strong', {}, `${t('equipment.outOfService')} \u2014 ${row.assetNo}`),
      el('p', {}, t('equipment.calibrationWarning')),
      el('p.small.muted', {}, '21 CFR 211.160(b)(4) \u00b7 21 CFR 211.67(a) \u00b7 EU GMP Annex 11 \u00a73'),
      manage
        ? el('div.banner-actions', {}, [
            button(bilingual('恢复在用（需填写理由）', 'Return to service (reason required)'), {
              variant: 'primary',
              onclick: () => returnToService(row, refresh),
            }),
          ])
        : null,
    ]);
  }

  /** The "can I trust data from this instrument?" visual. */
  function calibrationVisual(row, manage, refresh) {
    const status = row.calibrationStatus || 'not_required';
    const tone = SCHEDULE_TONES[status] || 'muted';
    const label = t(CAL_LABEL_KEYS[status] || 'equipment.notRequired');

    const node = el(`div.cal-visual.cal-${tone}`, {}, [
      el('div.cal-head', {}, [
        el('span.cal-icon', {}, status === 'overdue' ? '\u26a0' : status === 'due_soon' ? '\u23f3' : status === 'valid' ? '\u2713' : '\u2014'),
        el('div', {}, [
          el('div.cal-title', {}, `${t('equipment.calibration')}: ${label}${daysSuffix(row.daysToCalibration)}`),
          el('div.cal-dates.small', {}, [
            `${t('equipment.lastCalibration')}: ${U.fmtDate(row.lastCalibrationDate)}`,
            ` \u00b7 ${t('equipment.nextCalibration')}: ${U.fmtDate(row.nextCalibrationDate)}`,
            row.calibrationIntervalDays ? ` \u00b7 ${bilingual('周期', 'Interval')}: ${row.calibrationIntervalDays}${t('common.days')}` : '',
            row.calibrationRequired ? '' : ` \u00b7 ${t('equipment.notRequired')}`,
          ].join('')),
        ]),
      ]),
    ]);

    if (status === 'overdue') {
      node.appendChild(el('div.cal-alert', {}, [
        el('strong', {}, bilingual(
          '校准超期期间产生的数据不可靠，不得用于放行或 GxP 决策。',
          'Data generated while the instrument is out of calibration is not reliable and must not support release or GxP decisions.'
        )),
        el('p', {}, bilingual(
          '21 CFR 211.160(b)(4) 要求用于 GxP 决策的仪器按既定周期校准。在本设备重新校准并恢复在用状态之前，必须评估其已产生数据的影响，并保留评估记录。',
          '21 CFR 211.160(b)(4) requires instruments used for GxP decisions to be calibrated on an established schedule. Until this instrument is recalibrated and returned to service, the impact on data it already generated must be assessed and that assessment documented.'
        )),
        manage
          ? el('div.cal-actions', {}, [
              button(t('equipment.recordCalibration'), {
                variant: 'primary',
                onclick: () => calibrationDialog(row, refresh),
              }),
              button(t('equipment.raiseRecord'), {
                variant: 'ghost',
                onclick: () => raiseDeviationDialog(row, refresh),
              }),
            ])
          : null,
      ]));
    } else if (status === 'due_soon') {
      node.appendChild(el('div.cal-note', {}, bilingual(
        `校准将在 ${row.daysToCalibration} 天内到期，请提前安排，避免设备被迫停用。`,
        `Calibration falls due in ${row.daysToCalibration} day(s); schedule it now so the instrument is not forced out of service.`
      )));
    } else if (status === 'not_required') {
      node.appendChild(el('div.cal-note.muted', {}, bilingual(
        '该设备未标记为需要校准。如实际用于 GxP 测量，必须重新评估这一标记。',
        'This instrument is not flagged as requiring calibration. If it is in fact used for GxP measurement, that flag must be re-assessed.'
      )));
    }

    return node;
  }

  function qualificationCard(row) {
    const tiles = [
      { code: 'IQ', label: bilingual('安装确认', 'Installation qualification'), value: row.iqDate },
      { code: 'OQ', label: bilingual('运行确认', 'Operational qualification'), value: row.oqDate },
      { code: 'PQ', label: bilingual('性能确认', 'Performance qualification'), value: row.pqDate },
    ];
    return card(t('equipment.qualification'), [
      el('div.qual-tiles', {}, tiles.map((tile) => el(`div.qual-tile${tile.value ? '.qt-done' : '.qt-missing'}`, {}, [
        el('div.qt-code', {}, tile.code),
        el('div.qt-date', {}, tile.value ? U.fmtDate(tile.value) : bilingual('未完成', 'Not done')),
        el('div.qt-label.small.muted', {}, tile.label),
      ]))),
      el('div.qual-summary', {}, [
        statusBadge(row.qualificationStatus),
        row.qualificationComplete
          ? badge(bilingual('IQ/OQ/PQ 完整', 'IQ/OQ/PQ complete'), 'ok')
          : badge(bilingual('IQ/OQ/PQ 不完整', 'IQ/OQ/PQ incomplete'), 'bad'),
      ]),
      !row.qualificationComplete
        ? el('p.small.muted', {}, bilingual(
          '确认不完整的设备用于 GxP 工作前必须完成确认并保留记录（EU GMP Annex 15）。',
          'Equipment without complete qualification must not be used for GxP work until qualification is finished and recorded (EU GMP Annex 15).'
        ))
        : null,
    ], {
      subtitle: row.qualificationStatus ? U.humanise(row.qualificationStatus) : null,
      actions: window.App.can('equipment.manage')
        ? [button(bilingual('设置确认状态', 'Set qualification'), { variant: 'ghost', onclick: () => qualificationDialog(row, window.App.refresh) })]
        : null,
    });
  }

  function csvCard(row) {
    return card(t('equipment.csvStatus'), [
      el('dl.field-list', {}, [
        el('div.field-row', {}, [el('dt', {}, t('equipment.csvStatus')), el('dd', {}, csvBadge(row))]),
        el('div.field-row', {}, [el('dt', {}, bilingual('验证编号 / 引用', 'CSV reference')), el('dd', {}, row.csvRef || '\u2014')]),
      ]),
      row.csvStatus && ['not_started', 'pending'].includes(row.csvStatus)
        ? el('div.warning-note', {}, bilingual(
          '计算机化系统验证尚未完成。若该系统生成或处理 GxP 数据，必须完成验证并保留记录后再投入使用。',
          'Computerised system validation is not complete. If this system creates or processes GxP data, validation must be finished and recorded before use.'
        ))
        : null,
    ]);
  }

  function detailsCard(row) {
    const rows = [
      [t('equipment.assetNo'), row.assetNo],
      [bilingual('记录编号', 'Record key'), row.recordKey],
      [t('equipment.name'), nameOf(row)],
      [bilingual('英文名称', 'Name (English)'), row.nameEn],
      [t('equipment.model'), row.model],
      [t('equipment.manufacturer'), row.manufacturer],
      [bilingual('序列号', 'Serial no.'), row.serialNo],
      [t('equipment.location'), row.location],
      [t('common.department'), row.department],
      ['GxP', (row.gxpAreas || []).join(', ')],
      [t('common.criticality'), row.criticality ? U.humanise(row.criticality) : null],
      [t('equipment.qualification'), row.qualificationStatus ? U.humanise(row.qualificationStatus) : null],
      [bilingual('校准周期（天）', 'Calibration interval (days)'), row.calibrationIntervalDays],
      [t('equipment.lastCalibration'), row.lastCalibrationDate ? U.fmtDate(row.lastCalibrationDate) : null],
      [t('equipment.nextCalibration'), row.nextCalibrationDate ? U.fmtDate(row.nextCalibrationDate) : null],
      [bilingual('维护周期（天）', 'Maintenance interval (days)'), row.maintenanceIntervalDays],
      [bilingual('上次维护', 'Last maintenance'), row.lastMaintenanceDate ? U.fmtDate(row.lastMaintenanceDate) : null],
      [t('equipment.nextMaintenance'), row.nextMaintenanceDate ? U.fmtDate(row.nextMaintenanceDate) : null],
      [bilingual('维护状态', 'Maintenance status'), row.maintenanceStatus ? U.humanise(row.maintenanceStatus) : null],
      [bilingual('计算机化系统验证', 'CSV status'), row.csvStatus ? U.humanise(row.csvStatus) : null],
      [bilingual('验证编号 / 引用', 'CSV reference'), row.csvRef],
      [t('common.updatedAt'), row.updatedAt ? U.fmtDateTime(row.updatedAt) : null],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '');

    return card(t('common.detail'), el('dl.field-list', {}, rows.map(([label, value]) => el('div.field-row', {}, [
      el('dt', {}, label),
      el('dd', {}, String(value)),
    ]))), {
      actions: window.App.can('equipment.manage')
        ? [button(t('common.edit'), { variant: 'ghost', onclick: () => editEquipmentDialog(row, window.App.refresh) })]
        : null,
    });
  }

  function notesCard(row) {
    return card(bilingual('备注', 'Notes'), [
      row.notes ? el('p', {}, row.notes) : el('div.empty', {}, t('common.noData')),
      el('p.small.muted', {}, bilingual(
        '设备台账的每次变更都会写入审计追踪，并记录变更前后的值与理由。',
        'Every change to this register entry is written to the audit trail with the before and after values and a stated reason.'
      )),
    ]);
  }

  // ======================================================= calibration ======

  function calibrationDialog(row, onDone) {
    const form = U.buildForm([
      { key: 'performedAt', label: t('equipment.performedAt'), type: 'date', required: true },
      { key: 'performedBy', label: t('equipment.performedBy'), type: 'text', required: true },
      { key: 'result', label: t('equipment.result'), type: 'select', required: true, options: resultOptions() },
      { key: 'certificateNo', label: t('equipment.certificateNo'), type: 'text' },
      { key: 'nextDueDate', label: t('equipment.nextCalibration'), type: 'date' },
      { key: 'intervalDays', label: bilingual('校准周期（天）', 'Calibration interval (days)'), type: 'number', min: 1 },
      { key: 'notes', label: bilingual('备注', 'Notes'), type: 'textarea' },
    ], {
      performedAt: todayInput(),
      performedBy: window.App.user ? (window.App.user.fullName || window.App.user.username) : null,
      result: 'pass',
      intervalDays: row.calibrationIntervalDays || null,
      nextDueDate: row.nextCalibrationDate || null,
    });

    let signFlag = Boolean(row.gxpCritical);
    const warnHost = el('div');
    const refreshWarn = () => {
      clear(warnHost);
      if (normaliseResult(form.values().result) === 'fail') {
        warnHost.appendChild(el('div.warning-note', {}, [
          el('strong', {}, `${t('equipment.fail')} \u2192 ${t('equipment.outOfService')}`),
          el('p', {}, t('equipment.calibrationWarning')),
        ]));
      }
    };
    if (form.controls.result) {
      form.controls.result.addEventListener('change', refreshWarn);
      form.controls.result.addEventListener('input', refreshWarn);
    }
    refreshWarn();

    U.modal({
      title: `${t('equipment.recordCalibration')} \u00b7 ${row.assetNo}`,
      width: '720px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '校准记录写入设备台账与审计追踪。结果为「不合格」时设备会被自动置为「停用」。',
          'The calibration is written to the register and the audit trail. A failed result takes the instrument out of service automatically.'
        )),
        form.node,
        warnHost,
        el('div.form-grid', {}, [
          field(bilingual('电子签名', 'Electronic signature'),
            U.checkbox('cal-sign', signFlag, bilingual('应用电子签名', 'Apply electronic signature'), {
              onchange: (ev) => { signFlag = ev.target.checked; },
            }),
            { help: '21 CFR Part 11.200(a)(1)(i)' }),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) {
                U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                return;
              }
              const values = form.values();
              const result = normaliseResult(values.result);
              const interval = values.intervalDays === null ? null : Number(values.intervalDays);
              if (interval !== null && !(interval > 0)) {
                U.toast(bilingual('校准周期必须是大于 0 的天数。', 'The calibration interval must be a positive number of days.'), 'warn');
                return;
              }

              let signatureId = null;
              if (signFlag) {
                const sig = await U.signatureDialog({
                  meaning: 'performed',
                  entityType: 'equipment',
                  entityId: row.id,
                  recordKey: row.recordKey,
                  reason: `${t('equipment.recordCalibration')} ${row.assetNo} \u00b7 ${t('equipment.result')}: ${result}`,
                  secondFactorRequired: (window.App.boot.policy && window.App.boot.policy.signatureSecondFactor) !== false,
                });
                if (!sig) return;
                signatureId = sig.id;
              }

              try {
                const updated = await window.Api.post(`/api/equipment/${row.id}/calibration`, {
                  performedAt: values.performedAt,
                  performedBy: values.performedBy,
                  result,
                  certificateNo: values.certificateNo,
                  notes: values.notes,
                  nextDueDate: values.nextDueDate,
                  intervalDays: interval,
                  signatureId,
                });
                close();
                U.toast(`${t('toast.saved')}: ${t('equipment.recordCalibration')}`, 'ok');
                if (result === 'fail') {
                  outOfServiceNotice(updated || row, onDone);
                } else if (onDone) {
                  onDone();
                }
              } catch (err) {
                U.toast(err.message || t('common.error'), 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  /**
   * After a failed calibration the server sets the instrument out of service.
   * The user is told explicitly, and warned that a later pass does not restore
   * service - that needs a reasoned PATCH.
   */
  function outOfServiceNotice(row, onDone) {
    U.modal({
      title: `${bilingual('设备已停用', 'Instrument taken out of service')} \u00b7 ${row.assetNo || ''}`,
      width: '620px',
      render: (close) => [
        el('div.warning-note', {}, [
          el('strong', {}, bilingual(
            '校准结果不合格：该设备已被自动置为「停用」，不得再用于 GxP 工作。',
            'The calibration failed: the instrument has been taken out of service automatically and must not be used for GxP work.'
          )),
          el('p', {}, t('equipment.calibrationWarning')),
          el('p.small.muted', {}, '21 CFR 211.160(b)(4) \u00b7 21 CFR 211.67(a)'),
        ]),
        el('p', {}, bilingual(
          '下一步通常包括：评估该设备此前产生的数据的影响、开具偏差记录、维修并重新校准；复校合格后仍需以一条有理由的变更记录把状态改回「在用」。',
          'Next steps normally include: assessing the impact on data the instrument already generated, raising a deviation, repairing and recalibrating. Even after a passing recalibration, returning it to service still requires a reasoned change record.'
        )),
        el('div.modal-actions', {}, [
          button(t('common.close'), { variant: 'ghost', onclick: () => { close(); if (onDone) onDone(); } }),
          window.App.can('deviation.manage')
            ? button(t('equipment.raiseRecord'), {
                variant: 'primary',
                onclick: () => { close(); raiseDeviationDialog(row, onDone); },
              })
            : null,
        ]),
      ],
    });
  }

  /** Return to service: a reasoned PATCH, never automatic. */
  async function returnToService(row, onDone) {
    const reason = await U.reasonDialog({
      title: bilingual('恢复在用状态', 'Return to service'),
      message: bilingual(
        `把 ${row.assetNo} 的状态由「停用」改回「在用」。复校或维修合格本身不会自动恢复使用，必须在此说明依据（例如校准证书编号、影响评估结论、批准人）。`,
        `Change ${row.assetNo} from out of service back to in service. A passing calibration or repair does not restore service by itself: state the basis here (e.g. certificate number, impact assessment conclusion, approver).`
      ),
      confirmLabel: bilingual('恢复在用', 'Return to service'),
      minLength: 10,
    });
    if (!reason) return;
    try {
      await window.Api.patch(`/api/equipment/${row.id}`, { status: 'in_service', reason });
      U.toast(`${t('toast.saved')}: ${t('equipment.inService')}`, 'ok');
      if (onDone) onDone();
    } catch (err) {
      U.toast(err.message || t('common.error'), 'bad', 9000);
    }
  }

  // ========================================================= maintenance ====

  function maintenanceDialog(row, onDone) {
    const form = U.buildForm([
      { key: 'performedAt', label: t('equipment.performedAt'), type: 'date', required: true },
      { key: 'performedBy', label: t('equipment.performedBy'), type: 'text', required: true },
      {
        key: 'maintenanceType',
        label: bilingual('维护类型', 'Maintenance type'),
        type: 'select',
        required: true,
        options: [
          { value: 'preventive', label: bilingual('预防性维护', 'Preventive') },
          { value: 'corrective', label: bilingual('纠正性维护', 'Corrective') },
        ],
      },
      { key: 'result', label: t('equipment.result'), type: 'select', required: true, options: resultOptions() },
      { key: 'workOrderNo', label: bilingual('工单号', 'Work order no.'), type: 'text' },
      { key: 'nextDueDate', label: t('equipment.nextMaintenance'), type: 'date' },
      { key: 'intervalDays', label: bilingual('维护周期（天）', 'Maintenance interval (days)'), type: 'number', min: 1 },
      { key: 'notes', label: bilingual('备注', 'Notes'), type: 'textarea' },
    ], {
      performedAt: todayInput(),
      performedBy: window.App.user ? (window.App.user.fullName || window.App.user.username) : null,
      maintenanceType: 'preventive',
      result: 'pass',
      intervalDays: row.maintenanceIntervalDays || null,
      nextDueDate: row.nextMaintenanceDate || null,
    });

    let signFlag = Boolean(row.gxpCritical);
    const warnHost = el('div');
    const refreshWarn = () => {
      clear(warnHost);
      if (normaliseResult(form.values().result) === 'fail') {
        warnHost.appendChild(el('div.warning-note', {}, [
          el('strong', {}, `${t('equipment.fail')} \u2192 ${t('equipment.outOfService')}`),
          el('p', {}, bilingual(
            '维护结果不合格的设备会被自动置为「停用」，并且不会因为后续维护合格而自动恢复在用。',
            'An instrument that fails maintenance is taken out of service automatically, and a later pass does not return it to service.'
          )),
        ]));
      }
    };
    if (form.controls.result) {
      form.controls.result.addEventListener('change', refreshWarn);
      form.controls.result.addEventListener('input', refreshWarn);
    }
    refreshWarn();

    U.modal({
      title: `${t('equipment.recordMaintenance')} \u00b7 ${row.assetNo}`,
      width: '720px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '维护记录写入设备台账与审计追踪，并据此重排下次维护日期（21 CFR 211.67）。',
          'The maintenance event is written to the register and the audit trail and reschedules the next due date (21 CFR 211.67).'
        )),
        form.node,
        warnHost,
        el('div.form-grid', {}, [
          field(bilingual('电子签名', 'Electronic signature'),
            U.checkbox('mnt-sign', signFlag, bilingual('应用电子签名', 'Apply electronic signature'), {
              onchange: (ev) => { signFlag = ev.target.checked; },
            }),
            { help: '21 CFR Part 11.200(a)(1)(i)' }),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) {
                U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                return;
              }
              const values = form.values();
              const result = normaliseResult(values.result);
              const interval = values.intervalDays === null ? null : Number(values.intervalDays);
              if (interval !== null && !(interval > 0)) {
                U.toast(bilingual('维护周期必须是大于 0 的天数。', 'The maintenance interval must be a positive number of days.'), 'warn');
                return;
              }

              let signatureId = null;
              if (signFlag) {
                const sig = await U.signatureDialog({
                  meaning: 'performed',
                  entityType: 'equipment',
                  entityId: row.id,
                  recordKey: row.recordKey,
                  reason: `${t('equipment.recordMaintenance')} ${row.assetNo} \u00b7 ${t('equipment.result')}: ${result}`,
                  secondFactorRequired: (window.App.boot.policy && window.App.boot.policy.signatureSecondFactor) !== false,
                });
                if (!sig) return;
                signatureId = sig.id;
              }

              try {
                const updated = await window.Api.post(`/api/equipment/${row.id}/maintenance`, {
                  performedAt: values.performedAt,
                  performedBy: values.performedBy,
                  maintenanceType: values.maintenanceType,
                  result,
                  workOrderNo: values.workOrderNo,
                  notes: values.notes,
                  nextDueDate: values.nextDueDate,
                  intervalDays: interval,
                  signatureId,
                });
                close();
                U.toast(`${t('toast.saved')}: ${t('equipment.recordMaintenance')}`, 'ok');
                if (result === 'fail') {
                  outOfServiceNotice(updated || row, onDone);
                } else if (onDone) {
                  onDone();
                }
              } catch (err) {
                U.toast(err.message || t('common.error'), 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  // ======================================================== qualification ===

  function qualificationDialog(row, onDone) {
    const form = U.buildForm([
      { key: 'iq', label: bilingual('安装确认 IQ 日期', 'IQ date'), type: 'date' },
      { key: 'oq', label: bilingual('运行确认 OQ 日期', 'OQ date'), type: 'date' },
      { key: 'pq', label: bilingual('性能确认 PQ 日期', 'PQ date'), type: 'date' },
      { key: 'status', label: t('equipment.qualification'), type: 'select', required: true, options: qualificationStatusOptions() },
    ], {
      iq: row.iqDate,
      oq: row.oqDate,
      pq: row.pqDate,
      status: row.qualificationStatus || 'not_qualified',
    });

    U.modal({
      title: `${bilingual('设置确认状态', 'Set qualification')} \u00b7 ${row.assetNo}`,
      width: '680px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          'IQ/OQ/PQ 日期与确认状态会写入设备台账。必须填写变更理由（至少 3 个字）。',
          'The IQ/OQ/PQ dates and the qualification status are written to the register. A reason of at least 3 characters is mandatory.'
        )),
        form.node,
        el('div.warning-note', {}, bilingual(
          '确认状态用于判断设备是否可以用于 GxP 工作：确认不完整的设备不得投入使用。',
          'The qualification status decides whether the instrument may be used for GxP work: an incompletely qualified instrument must not be used.'
        )),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) {
                U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                return;
              }
              const values = form.values();
              const reason = await U.reasonDialog({
                title: bilingual('设置确认状态', 'Set qualification'),
                message: bilingual(
                  `说明本次确认状态变更的依据（例如：IQ/OQ/PQ 报告编号、再确认到期、发现不符合项）。`,
                  'State the basis for this qualification change (e.g. IQ/OQ/PQ report numbers, requalification due, a non-conformity found).'
                ),
              });
              if (!reason) return;
              try {
                await window.Api.post(`/api/equipment/${row.id}/qualification`, {
                  iq: values.iq,
                  oq: values.oq,
                  pq: values.pq,
                  status: values.status,
                  reason,
                });
                close();
                U.toast(t('toast.saved'), 'ok');
                if (onDone) onDone();
              } catch (err) {
                U.toast(err.message || t('common.error'), 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  // =============================================================== edit =====

  function editEquipmentDialog(row, onDone) {
    const form = U.buildForm([
      { key: 'assetNo', label: t('equipment.assetNo'), type: 'text', required: true },
      { key: 'name', label: t('equipment.name'), type: 'text', required: true },
      { key: 'nameEn', label: bilingual('英文名称', 'Name (English)'), type: 'text' },
      { key: 'model', label: t('equipment.model'), type: 'text' },
      { key: 'manufacturer', label: t('equipment.manufacturer'), type: 'text' },
      { key: 'serialNo', label: bilingual('序列号', 'Serial no.'), type: 'text' },
      { key: 'location', label: t('equipment.location'), type: 'text' },
      { key: 'department', label: t('common.department'), type: 'text' },
      { key: 'status', label: t('common.status'), type: 'select', options: statusOptions() },
      { key: 'criticality', label: t('common.criticality'), type: 'select', options: criticalityOptions() },
      { key: 'qualificationStatus', label: t('equipment.qualification'), type: 'select', options: qualificationStatusOptions() },
      { key: 'calibrationIntervalDays', label: bilingual('校准周期（天）', 'Calibration interval (days)'), type: 'number', min: 1 },
      { key: 'lastCalibrationDate', label: t('equipment.lastCalibration'), type: 'date' },
      { key: 'nextCalibrationDate', label: t('equipment.nextCalibration'), type: 'date' },
      { key: 'maintenanceIntervalDays', label: bilingual('维护周期（天）', 'Maintenance interval (days)'), type: 'number', min: 1 },
      { key: 'lastMaintenanceDate', label: bilingual('上次维护', 'Last maintenance'), type: 'date' },
      { key: 'nextMaintenanceDate', label: t('equipment.nextMaintenance'), type: 'date' },
      { key: 'csvStatus', label: t('equipment.csvStatus'), type: 'select', options: csvStatusOptions() },
      { key: 'csvRef', label: bilingual('验证编号 / 引用', 'CSV reference'), type: 'text' },
      { key: 'notes', label: bilingual('备注', 'Notes'), type: 'textarea' },
    ], {
      assetNo: row.assetNo,
      name: row.name,
      nameEn: row.nameEn,
      model: row.model,
      manufacturer: row.manufacturer,
      serialNo: row.serialNo,
      location: row.location,
      department: row.department,
      status: row.status,
      criticality: row.criticality,
      qualificationStatus: row.qualificationStatus,
      calibrationIntervalDays: row.calibrationIntervalDays,
      lastCalibrationDate: row.lastCalibrationDate,
      nextCalibrationDate: row.nextCalibrationDate,
      maintenanceIntervalDays: row.maintenanceIntervalDays,
      lastMaintenanceDate: row.lastMaintenanceDate,
      nextMaintenanceDate: row.nextMaintenanceDate,
      csvStatus: row.csvStatus,
      csvRef: row.csvRef,
      notes: row.notes,
    });

    let calibrationRequired = Boolean(row.calibrationRequired);
    const areaGroup = checkGroup('eq-area', areaOptions(), row.gxpAreas || []);

    U.modal({
      title: `${t('common.edit')} \u00b7 ${row.assetNo}`,
      width: '780px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '每次修改都必须填写理由；理由与变更前后的值一同写入审计追踪（21 CFR Part 11.10(e)）。',
          'Every change requires a stated reason; the reason and both the before and after values are written to the audit trail (21 CFR Part 11.10(e)).'
        )),
        form.node,
        el('div.form-grid', {}, [
          field('GxP', areaGroup.node),
          field(t('equipment.calibration'), U.checkbox('eq-cal-req', calibrationRequired,
            bilingual('需要校准', 'Calibration required'), {
              onchange: (ev) => { calibrationRequired = ev.target.checked; },
            })),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) {
                U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                return;
              }
              const values = form.values();
              values.gxpAreas = areaGroup.values();
              values.calibrationRequired = calibrationRequired;

              const changed = {};
              for (const [key, value] of Object.entries(values)) {
                const before = row[key];
                if (key === 'gxpAreas') {
                  if (JSON.stringify(before || []) !== JSON.stringify(value || [])) changed[key] = value;
                  continue;
                }
                if (key === 'calibrationRequired') {
                  if (Boolean(before) !== Boolean(value)) changed[key] = value;
                  continue;
                }
                const a = before === null || before === undefined ? '' : String(before);
                const b = value === null || value === undefined ? '' : String(value);
                if (a !== b) changed[key] = value;
              }

              if (!Object.keys(changed).length) {
                U.toast(t('common.noData'), 'info');
                return;
              }
              const reason = await U.reasonDialog({
                title: t('common.edit'),
                message: `${Object.keys(changed).length} ${t('common.items')}: ${Object.keys(changed).join(', ')}`,
              });
              if (!reason) return;
              try {
                await window.Api.patch(`/api/equipment/${row.id}`, { ...changed, reason });
                close();
                U.toast(t('toast.saved'), 'ok');
                if (onDone) onDone();
              } catch (err) {
                U.toast(err.message || t('common.error'), 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  // ====================================================== raise deviation ==

  function raiseDeviationDialog(row, onDone) {
    const processSelect = select('dev-process', defaultProcessCode(), processOptions(), { placeholder: false });
    const titleInput = input('dev-title', '', {
      required: true,
      placeholder: bilingual('例如：天平校准超期期间产生的数据评估', 'e.g. Impact of data generated while the balance was out of calibration'),
    });

    U.modal({
      title: `${t('equipment.raiseRecord')} \u00b7 ${row.assetNo}`,
      width: '640px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '把设备问题转为受控的质量记录（偏差/CAPA）。设备信息、校准状态与到期日会自动带入记录。',
          'Turn the equipment problem into a controlled quality record (deviation/CAPA). The instrument details, calibration state and due date are carried into the record.'
        )),
        field(t('records.processType'), processSelect, { required: true }),
        field(t('common.detail'), titleInput, { required: true }),
        el('div.guidance-note', {}, [
          el('strong', {}, bilingual('提示', 'Note')),
          el('p', {}, bilingual(
            '记录生成后仍需按流程完成调查与审批；本操作只是建立关联，不会替你做任何判定。',
            'The record still has to be investigated and approved through its own workflow; this only creates the link - it makes no decision for you.'
          )),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('equipment.raiseRecord'), {
            variant: 'primary',
            onclick: async () => {
              const title = titleInput.value.trim();
              if (title.length < 3) {
                U.toast(`${t('common.required')}: ${t('common.detail')}`, 'warn');
                return;
              }
              try {
                const created = await window.Api.post(`/api/equipment/${row.id}/raise-record`, {
                  processCode: processSelect.value,
                  title,
                });
                close();
                resultNotice(created, onDone);
              } catch (err) {
                U.toast(err.message || t('common.error'), 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  function resultNotice(created, onDone) {
    const recordKey = (created && created.recordKey) || '';
    const id = created && created.id;
    U.toast(`${t('toast.created')}: ${recordKey}`, 'ok', 8000);
    U.modal({
      title: t('toast.created'),
      width: '520px',
      render: (close) => [
        el('p', {}, `${t('records.recordKey')}: `),
        el('p', {}, el('a.mono.strong', { href: id ? `#/records/${id}` : '#/records' }, recordKey || '\u2014')),
        el('div.modal-actions', {}, [
          button(t('common.close'), { variant: 'ghost', onclick: () => { close(); if (onDone) onDone(); } }),
          id
            ? button(t('common.detail'), {
                variant: 'primary',
                onclick: () => { close(); window.location.hash = `#/records/${id}`; },
              })
            : null,
        ]),
      ],
    });
  }

  // ========================================================== new record ====

  function newEquipmentDialog(onDone) {
    const form = U.buildForm([
      { key: 'assetNo', label: t('equipment.assetNo'), type: 'text', required: true },
      { key: 'name', label: t('equipment.name'), type: 'text', required: true },
      { key: 'nameEn', label: bilingual('英文名称', 'Name (English)'), type: 'text' },
      { key: 'model', label: t('equipment.model'), type: 'text' },
      { key: 'manufacturer', label: t('equipment.manufacturer'), type: 'text' },
      { key: 'serialNo', label: bilingual('序列号', 'Serial no.'), type: 'text' },
      { key: 'location', label: t('equipment.location'), type: 'text' },
      { key: 'department', label: t('common.department'), type: 'text' },
      { key: 'status', label: t('common.status'), type: 'select', options: statusOptions() },
      { key: 'criticality', label: t('common.criticality'), type: 'select', options: criticalityOptions() },
      { key: 'qualificationStatus', label: t('equipment.qualification'), type: 'select', options: qualificationStatusOptions() },
      { key: 'calibrationIntervalDays', label: bilingual('校准周期（天）', 'Calibration interval (days)'), type: 'number', min: 1 },
      { key: 'lastCalibrationDate', label: t('equipment.lastCalibration'), type: 'date' },
      { key: 'nextCalibrationDate', label: t('equipment.nextCalibration'), type: 'date' },
      { key: 'maintenanceIntervalDays', label: bilingual('维护周期（天）', 'Maintenance interval (days)'), type: 'number', min: 1 },
      { key: 'lastMaintenanceDate', label: bilingual('上次维护', 'Last maintenance'), type: 'date' },
      { key: 'csvStatus', label: t('equipment.csvStatus'), type: 'select', options: csvStatusOptions() },
      { key: 'csvRef', label: bilingual('验证编号 / 引用', 'CSV reference'), type: 'text' },
      { key: 'notes', label: bilingual('备注', 'Notes'), type: 'textarea' },
    ], {
      status: 'in_service',
      criticality: 'medium',
      qualificationStatus: 'not_qualified',
    });

    let calibrationRequired = true;
    const areaGroup = checkGroup('new-area', areaOptions(), []);

    U.modal({
      title: t('equipment.newEquipment'),
      width: '780px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '资产编号在场所内唯一，是所有校准证书、日志与偏差记录引用的标识。',
          'The asset number is unique site-wide: every calibration certificate, logbook and deviation will quote it.'
        )),
        form.node,
        el('div.form-grid', {}, [
          field('GxP', areaGroup.node),
          field(t('equipment.calibration'), U.checkbox('new-cal-req', calibrationRequired,
            bilingual('需要校准', 'Calibration required'), {
              onchange: (ev) => { calibrationRequired = ev.target.checked; },
            })),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) {
                U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                return;
              }
              const values = form.values();
              try {
                const created = await window.Api.post('/api/equipment', {
                  assetNo: values.assetNo,
                  name: values.name,
                  nameEn: values.nameEn,
                  model: values.model,
                  manufacturer: values.manufacturer,
                  serialNo: values.serialNo,
                  location: values.location,
                  department: values.department,
                  gxpAreas: areaGroup.values(),
                  qualificationStatus: values.qualificationStatus,
                  calibrationRequired,
                  calibrationIntervalDays: values.calibrationIntervalDays === null ? null : Number(values.calibrationIntervalDays),
                  lastCalibrationDate: values.lastCalibrationDate,
                  nextCalibrationDate: values.nextCalibrationDate,
                  maintenanceIntervalDays: values.maintenanceIntervalDays === null ? null : Number(values.maintenanceIntervalDays),
                  lastMaintenanceDate: values.lastMaintenanceDate,
                  criticality: values.criticality,
                  status: values.status,
                  csvStatus: values.csvStatus,
                  csvRef: values.csvRef,
                  notes: values.notes,
                });
                close();
                U.toast(`${t('toast.created')}: ${created.assetNo || values.assetNo}`, 'ok');
                if (onDone) onDone();
              } catch (err) {
                U.toast(err.message || t('common.error'), 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  window.Views.register('equipment', listView);
  window.Views.register('equipmentItem', itemView);
  window.EquipmentHelpers = {
    SCHEDULE_TONES,
    calibrationBadge,
    calibrationDialog,
    maintenanceDialog,
    qualificationDialog,
    returnToService,
  };
})();
