/* View: training and qualification - the matrix, the curricula register and the
 * compliance report, plus the per-person qualification answer.
 *
 * The matrix answers the question an inspector asks first: *can this named
 * person perform this named GxP task today?* Cells are coloured from the
 * server's own state machine and every cell is clickable, because a colour
 * nobody can explain is not evidence.
 *
 * Two rules the UI never relaxes:
 *   1. completing GxP-critical training requires an electronic signature, so the
 *      signature dialog is shown BEFORE the POST (the server answers
 *      428 SIGNATURE_REQUIRED when `signatureId` is missing);
 *   2. a score below the pass mark is not a pass - the server refuses it and the
 *      UI tells the user to record the outcome as "failed" instead.
 */
(function () {
  'use strict';

  const { t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, statusBadge, button, field, input, textarea, select } = U;

  /** Server state -> badge tone. Fixed mapping, do not "improve" it. */
  const STATE_TONES = {
    valid: 'ok',
    expired: 'bad',
    failed: 'bad',
    overdue: 'bad',
    assigned: 'info',
    in_progress: 'warn',
    not_assigned: 'muted',
  };

  /** Kept to one glyph per state so the grid stays readable at 60+ columns. */
  const STATE_GLYPHS = {
    valid: '\u2713',
    expired: '\u2715',
    failed: 'F',
    overdue: '!',
    assigned: 'A',
    in_progress: '\u2026',
    not_assigned: '\u00b7',
  };

  const TABS = ['matrix', 'curricula', 'compliance'];

  // Lazily fetched reference data. Both are invalidated after a mutation so a
  // newly created curriculum appears without a hard reload.
  let rosterPromise = null;
  let curriculaPromise = null;

  function roster() {
    if (!rosterPromise) {
      rosterPromise = window.Api.get('/api/training/matrix')
        .then((data) => data.users || [])
        .catch(() => []);
    }
    return rosterPromise;
  }

  function curriculaIndex() {
    if (!curriculaPromise) {
      curriculaPromise = window.Api.get('/api/curricula')
        .then((data) => data.rows || [])
        .catch(() => []);
    }
    return curriculaPromise;
  }

  function invalidateCaches() {
    rosterPromise = null;
    curriculaPromise = null;
  }

  function stateLabel(state) {
    const map = {
      valid: () => t('training.valid'),
      expired: () => t('training.expired'),
      failed: () => t('training.failed'),
      overdue: () => t('training.overdue'),
      assigned: () => t('training.assigned'),
      in_progress: () => t('training.inProgress'),
      not_assigned: () => t('training.notAssigned'),
    };
    return (map[state] || (() => U.humanise(state)))();
  }

  function stateTone(state) { return STATE_TONES[state] || 'neutral'; }

  function methodOptions() {
    const methods = (window.App.boot && window.App.boot.trainingMethods) || [];
    return methods.map((m) => ({ value: m.code, label: m.label }));
  }

  function roleOptions() {
    return ((window.App.boot && window.App.boot.roles) || []).map((r) => ({
      value: r.code,
      label: getLocale() === 'en' ? (r.label || r.code) : (r.labelZh || r.label || r.code),
    }));
  }

  function areaOptions() {
    return ((window.App.boot && window.App.boot.gxpAreas) || []).map((a) => ({
      value: a.code,
      label: `${a.code}${a.fullName ? ` \u00b7 ${a.fullName}` : ''}`,
    }));
  }

  function curriculumTitle(code) {
    return code || '';
  }

  function uniqueDepartments(users) {
    const seen = [];
    for (const u of users || []) {
      if (u.department && !seen.includes(u.department)) seen.push(u.department);
    }
    return seen;
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
    const base = (window.location.hash.split('?')[0]) || '#/training';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  function nowLocalInput() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function findByCode(code) {
    if (!code) return null;
    const rows = await curriculaIndex();
    let hit = rows.find((r) => r.code === code) || null;
    if (!hit) {
      try {
        const res = await window.Api.get('/api/curricula', { search: code });
        hit = (res.rows || []).find((r) => r.code === code) || null;
      } catch { hit = null; }
    }
    return hit;
  }

  // ============================================================== list ======

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      const active = TABS.includes(query.tab) ? query.tab : 'matrix';

      clear(container);
      const body = el('div');
      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('training.title')),
            el('p.view-sub', {}, t('training.subtitle')),
          ]),
          el('div.view-head-actions', {}, [
            button(t('common.refresh'), { variant: 'ghost', onclick: () => window.App.refresh() }),
          ]),
        ]),
        el('div.tab-bar', {}, TABS.map((id) => el('button.tab', {
          type: 'button',
          class: active === id ? 'active' : '',
          onclick: () => setQuery({ tab: id === 'matrix' ? null : id }),
        }, t(`training.${id}`)))),
        body,
      ]));

      body.appendChild(U.spinner());
      const paint = async () => {
        clear(body);
        body.appendChild(U.spinner());
        try {
          const node = active === 'curricula'
            ? await curriculaTab(query)
            : active === 'compliance'
              ? await complianceTab(query)
              : await matrixTab(query);
          clear(body);
          body.appendChild(node);
        } catch (err) {
          clear(body);
          body.appendChild(U.errorBox(err, () => paint()));
        }
      };
      await paint();
    },
  };

  // ------------------------------------------------------------- matrix -----

  async function matrixTab(query) {
    const filters = {
      department: query.department || '',
      role: query.role || '',
      gxpArea: query.gxpArea || '',
    };
    const data = await window.Api.get('/api/training/matrix', filters);
    if (!filters.department && !filters.role && !filters.gxpArea) rosterPromise = Promise.resolve(data.users || []);
    const users = (filters.department || filters.role) ? await roster() : (data.users || []);
    const departments = uniqueDepartments(users);

    const wrap = el('div');
    wrap.appendChild(el('div.filter-bar', {}, [
      select('department', filters.department, departments.map((d) => ({ value: d, label: d })), {
        placeholder: `\u2014 ${t('common.department')} \u2014`,
        onchange: (ev) => setQuery({ department: ev.target.value || null, tab: null }),
      }),
      select('role', filters.role, roleOptions(), {
        placeholder: `\u2014 ${t('training.role')} \u2014`,
        onchange: (ev) => setQuery({ role: ev.target.value || null, tab: null }),
      }),
      select('gxpArea', filters.gxpArea, areaOptions(), {
        placeholder: `\u2014 PV \u2014`,
        onchange: (ev) => setQuery({ gxpArea: ev.target.value || null, tab: null }),
      }),
    ]));

    const summary = data.summary || {};
    wrap.appendChild(el('div.stat-strip', {}, [
      stat(t('training.person'), U.fmtNumber(summary.users), { hint: t('training.role') }),
      stat(t('training.curricula'), U.fmtNumber(summary.curricula)),
      stat(t('training.isGxpCritical'), U.fmtNumber(summary.gxpCriticalCurricula), { tone: 'warn' }),
      stat(t('training.gaps'), U.fmtNumber(summary.gaps), {
        tone: summary.gaps ? 'bad' : 'ok',
        hint: t('training.missingRequired'),
      }),
      stat(bilingual('资质完全符合', 'Fully qualified'), U.fmtNumber(summary.personnelFullyQualified), {
        tone: summary.gaps ? 'warn' : 'ok',
      }),
    ]));

    wrap.appendChild(matrixCard(data));
    wrap.appendChild(gapsCard(data, filters));
    return wrap;
  }

  function matrixCard(data) {
    const users = data.users || [];
    const curricula = data.curricula || [];

    return card(t('training.matrix'), [
      legend(),
      (users.length && curricula.length)
        ? el('div.matrix-wrap', {}, el('div.matrix-scroll', {}, el('table.table.matrix-grid', {}, [
            el('thead', {}, el('tr', {}, [
              el('th.mx-corner', {}, `${t('training.person')} \\ ${t('training.curricula')}`),
              ...curricula.map((c) => el(`th.mx-col${c.isGxpCritical ? '.mx-gxp' : ''}`, {
                title: [c.title, c.isGxpCritical ? t('training.isGxpCritical') : null,
                  (c.gxpAreas || []).join(' / ')].filter(Boolean).join(' \u00b7 '),
              }, [
                el('span.mx-code', {}, c.code),
                c.isGxpCritical ? el('span.mx-star', { title: t('training.isGxpCritical') }, '\u2605') : null,
              ])),
            ])),
            el('tbody', {}, users.map((u) => el('tr.mx-row', {}, [
              el('th.mx-user', {}, [
                el('a.strong', { href: `#/training/${u.id}` }, u.fullName || u.username),
                el('div.mx-user-sub', {}, [u.department, u.role].filter(Boolean).join(' \u00b7 ')),
                u.trainingStatus && u.trainingStatus !== 'current' && u.trainingStatus !== 'not_required'
                  ? badge(t('training.notQualified'), 'bad', { title: U.humanise(u.trainingStatus) })
                  : null,
              ]),
              ...curricula.map((c) => {
                const cell = (data.cells && data.cells[`${u.id}:${c.id}`]) || { state: 'not_assigned' };
                return el('td.mx-cell', {}, cellButton(u, c, cell));
              }),
            ]))),
          ])))
        : el('div.empty', {}, t('common.noData')),
    ], {
      subtitle: data.generatedAt
        ? `${bilingual('生成时间', 'Generated')}: ${U.fmtDateTime(data.generatedAt)}`
        : null,
    });
  }

  function legend() {
    const order = ['valid', 'expired', 'failed', 'overdue', 'assigned', 'in_progress', 'not_assigned'];
    return el('div.matrix-legend', {}, order.map((s) => el('span.legend-item', {
      title: stateLabel(s),
    }, [badge(STATE_GLYPHS[s], stateTone(s), { title: stateLabel(s) }), el('span.legend-label', {}, stateLabel(s))])));
  }

  function cellTitle(user, curriculum, cell) {
    const parts = [`${user.fullName || user.username} \u00b7 ${curriculum.code}: ${stateLabel(cell.state)}`];
    if (cell.expiresAt) parts.push(`${t('training.expiresAt')} ${U.fmtDate(cell.expiresAt)}`);
    if (cell.score !== null && cell.score !== undefined) parts.push(`${t('training.score')} ${cell.score}`);
    if (curriculum.isGxpCritical) parts.push(t('training.isGxpCritical'));
    parts.push(cell.recordId ? `${t('training.recordCompletion')} #${cell.recordId}` : t('training.notAssigned'));
    parts.push(bilingual('点击查看详情', 'Click for detail'));
    return parts.join(' \u00b7 ');
  }

  function cellButton(user, curriculum, cell) {
    const title = cellTitle(user, curriculum, cell);
    return el('button.matrix-cell', {
      type: 'button',
      class: `mc-${stateTone(cell.state)}`,
      title,
      'aria-label': title,
      onclick: () => openCellDialog(user, curriculum, cell),
    }, badge(STATE_GLYPHS[cell.state] || '?', stateTone(cell.state), { title }));
  }

  /** Person + curriculum detail. Uses /api/training/matrix/<id> for the record. */
  function openCellDialog(user, curriculum, cell) {
    const holder = el('div');
    const dialog = U.modal({
      title: `${user.fullName || user.username} \u00b7 ${curriculum.code}`,
      width: '640px',
      render: () => holder,
    });

    const rows = [
      [t('training.person'), user.fullName || user.username],
      [t('common.department'), user.department || '\u2014'],
      [t('training.role'), user.role || '\u2014'],
      [t('training.curricula'), `${curriculum.code} \u00b7 ${curriculum.title}`],
      [t('training.isGxpCritical'), curriculum.isGxpCritical ? t('common.yes') : t('common.no')],
      [t('training.validityMonths'), curriculum.validityMonths ? `${curriculum.validityMonths} ${t('documents.months')}` : '\u2014'],
      [t('common.status'), stateLabel(cell.state)],
      [t('training.expiresAt'), cell.expiresAt ? `${U.fmtDate(cell.expiresAt)} (${U.fmtRelative(cell.expiresAt)})` : '\u2014'],
      [t('training.score'), cell.score === null || cell.score === undefined ? '\u2014' : String(cell.score)],
      [bilingual('培训记录', 'Training record'), cell.recordId ? `#${cell.recordId}` : t('training.notAssigned')],
    ];

    const actions = [];
    if (cell.recordId && window.App.can('training.assess')) {
      actions.push(button(t('training.recordCompletion'), {
        variant: 'primary',
        onclick: () => {
          dialog.close();
          recordCompletionFlow({
            id: cell.recordId,
            curriculumId: curriculum.id,
            curriculumCode: curriculum.code,
            curriculumTitle: curriculum.title,
            isGxpCritical: Boolean(curriculum.isGxpCritical),
            userName: user.fullName || user.username,
            score: cell.score,
          }, { onDone: () => window.App.refresh() });
        },
      }));
    }
    if (curriculum && curriculum.id && window.App.can('training.manage')) {
      actions.push(button(t('training.assign'), {
        variant: actions.length ? 'ghost' : 'primary',
        onclick: () => {
          dialog.close();
          assignFlow(curriculum, { userId: user.id, userName: user.fullName || user.username }, () => window.App.refresh());
        },
      }));
    }
    if (!actions.length) {
      actions.push(button(t('common.close'), { variant: 'ghost', onclick: () => dialog.close() }));
    }

    holder.appendChild(el('div', {}, [
      el('dl.field-list', {}, rows.map(([label, value]) => el('div.field-row', {}, [
        el('dt', {}, label),
        el('dd', {}, String(value)),
      ]))),
      cell.recordId ? recordDetail(user.id, cell.recordId) : null,
      el('div.modal-actions', {}, actions),
    ]));
  }

  /** Extra record detail, fetched lazily from the per-user matrix endpoint. */
  function recordDetail(userId, recordId) {
    const host = el('div.record-detail', {}, U.spinner());
    window.Api.get(`/api/training/matrix/${userId}`)
      .then((data) => {
        const rec = (data.records || []).find((r) => r.id === recordId);
        clear(host);
        if (!rec) {
          host.appendChild(el('p.muted', {}, t('common.noData')));
          return;
        }
        const rows = [
          [t('common.status'), U.humanise(rec.status)],
          [t('training.method'), rec.methodLabel || U.humanise(rec.method)],
          [t('training.trainer'), rec.trainerName || '\u2014'],
          [t('training.score'), rec.score === null || rec.score === undefined ? '\u2014' : `${rec.score}${rec.passMark != null ? ` / ${rec.passMark}` : ''}`],
          [bilingual('判定', 'Result'), rec.result ? U.humanise(rec.result) : '\u2014'],
          [bilingual('完成时间', 'Completed'), U.fmtDate(rec.completedAt)],
          [t('common.dueDate'), U.fmtDate(rec.dueDate)],
          [bilingual('客观证据', 'Evidence'), rec.evidence || '\u2014'],
          [bilingual('考核评语', 'Assessment notes'), rec.assessmentNotes || '\u2014'],
          [bilingual('电子签名', 'Signature'), rec.signatureId ? `#${rec.signatureId}` : '\u2014'],
        ];
        host.appendChild(el('h3.section-mini', {}, bilingual('培训记录明细', 'Training record detail')));
        host.appendChild(el('dl.field-list', {}, rows.map(([label, value]) => el('div.field-row', {}, [
          el('dt', {}, label),
          el('dd', {}, String(value)),
        ]))));
      })
      .catch((err) => {
        clear(host);
        host.appendChild(el('p.muted.small', {}, err.message));
      });
    return host;
  }

  function gapsCard(data, filters) {
    const gaps = data.gaps || [];
    const columns = [
      {
        key: 'userName',
        label: t('training.person'),
        render: (r) => el('a.strong', { href: `#/training/${r.userId}` }, r.userName || r.userId),
      },
      { key: 'department', label: t('common.department'), render: (r) => r.department || '\u2014' },
      { key: 'role', label: t('training.role'), render: (r) => r.role || '\u2014' },
      {
        key: 'curriculumCode',
        label: t('training.curricula'),
        render: (r) => el('span', { title: curriculumTitle(r.curriculumTitle) }, [
          el('span.mono.strong', {}, r.curriculumCode),
          el('span.small.muted', {}, ` \u00b7 ${U.truncate(r.curriculumTitle || '', 50)}`),
        ]),
      },
      { key: 'state', label: t('common.status'), render: (r) => badge(stateLabel(r.state), stateTone(r.state), { title: stateLabel(r.state) }) },
      {
        key: 'actions',
        label: t('common.actions'),
        render: (r) => (window.App.can('training.manage')
          ? button(t('training.assign'), {
              variant: 'ghost',
              onclick: async () => {
                const cur = await findByCode(r.curriculumCode);
                if (!cur) {
                  U.toast(`${t('training.curricula')}: ${r.curriculumCode} \u2014 ${t('common.noData')}`, 'warn');
                  return;
                }
                assignFlow(cur, { userId: r.userId, userName: r.userName }, () => window.App.refresh());
              },
            })
          : el('a', { href: `#/training/${r.userId}` }, t('common.detail'))),
      },
    ];

    return card(t('training.gaps'), table(columns, gaps, {
      emptyText: t('training.noGaps'),
      rowClass: () => 'row-gap',
    }), {
      subtitle: gaps.length ? `${gaps.length} ${t('common.items')}` : t('training.noGaps'),
      actions: filters && (filters.department || filters.role || filters.gxpArea)
        ? [badge(bilingual('已筛选', 'Filtered'), 'info')]
        : null,
    });
  }

  // ---------------------------------------------------------- curricula -----

  async function curriculaTab(query) {
    const filters = { gxpArea: query.gxpArea || '', search: query.search || '' };
    const data = await window.Api.get('/api/curricula', filters);
    const rows = data.rows || [];

    const commitSearch = debounced((v) => setQuery({ search: v || null, tab: 'curricula' }), 350);

    const wrap = el('div');
    wrap.appendChild(el('div.filter-bar', {}, [
      input('search', filters.search, {
        placeholder: t('common.search'),
        oninput: (ev) => commitSearch(ev.target.value.trim()),
      }),
      select('gxpArea', filters.gxpArea, areaOptions(), {
        placeholder: '\u2014 PV \u2014',
        onchange: (ev) => setQuery({ gxpArea: ev.target.value || null, tab: 'curricula' }),
      }),
      window.App.can('training.manage')
        ? button(t('training.newCurriculum'), {
            variant: 'primary',
            onclick: () => newCurriculumDialog(() => {
              invalidateCaches();
              window.App.refresh();
            }),
          })
        : null,
    ]));

    wrap.appendChild(el('div.stat-strip', {}, [
      stat(t('training.curricula'), U.fmtNumber(rows.length)),
      stat(t('training.isGxpCritical'), U.fmtNumber(rows.filter((r) => r.isGxpCritical).length), { tone: 'warn' }),
      stat(t('training.completed'), U.fmtNumber(rows.reduce((n, r) => n + ((r.stats && r.stats.byStatus && r.stats.byStatus.completed) || 0), 0)), { tone: 'ok' }),
      stat(t('training.expired'), U.fmtNumber(rows.reduce((n, r) => n + ((r.stats && r.stats.expired) || 0), 0)), {
        tone: rows.some((r) => r.stats && r.stats.expired) ? 'bad' : 'ok',
      }),
    ]));

    if (!rows.length) {
      wrap.appendChild(card(null, el('div.empty', {}, t('common.noData'))));
      return wrap;
    }

    wrap.appendChild(el('div.curriculum-grid', {}, rows.map(curriculumCard)));
    return wrap;
  }

  function curriculumCard(c) {
    const st = c.stats || {};
    const byStatus = st.byStatus || {};
    const compliance = st.compliancePercent;
    const tone = compliance === null || compliance === undefined ? 'muted' : compliance >= 90 ? 'ok' : compliance >= 70 ? 'warn' : 'bad';

    return card(null, [
      el('div.cur-head', {}, [
        el('span.mono.strong', {}, c.code),
        c.isGxpCritical ? badge(t('training.isGxpCritical'), 'warn') : badge(bilingual('非关键', 'Non-critical'), 'muted'),
        el('span.cur-compliance', { class: `cc-${tone}`, title: bilingual('合规率 = 已完成且未过期的比例', 'Compliance = completed and not expired') },
          compliance === null || compliance === undefined ? '\u2014' : `${compliance}%`),
      ]),
      el('div.cur-title', {}, c.title),
      c.titleEn ? el('div.cur-title-en.muted.small', {}, c.titleEn) : null,
      el('div.cur-areas', {}, (c.gxpAreas || []).map((a) => badge(a, 'info'))),
      el('div.cur-meta', {}, [
        el('span', {}, `${t('training.validityMonths')}: ${c.validityMonths || '\u2014'}`),
        el('span', {}, `${t('common.total')}: ${U.fmtNumber(st.total || 0)}`),
        st.expired ? el('span.overdue', {}, `${t('training.expired')}: ${st.expired}`) : null,
        byStatus.failed ? el('span.overdue', {}, `${t('training.failed')}: ${byStatus.failed}`) : null,
        byStatus.assigned ? el('span', {}, `${t('training.assigned')}: ${byStatus.assigned}`) : null,
      ]),
      el('div.cur-applies', {}, [
        el('span.cur-applies-label', {}, `${t('training.appliesTo')}:`),
        (c.appliesToRoles || []).length ? el('span.small', {}, `${t('training.role')} \u2014 ${(c.appliesToRoles || []).join(', ')}`) : null,
        (c.appliesToDepartments || []).length ? el('span.small', {}, `${t('common.department')} \u2014 ${(c.appliesToDepartments || []).join(', ')}`) : null,
        !(c.appliesToRoles || []).length && !(c.appliesToDepartments || []).length
          ? el('span.small.muted', {}, t('common.none'))
          : null,
      ]),
      c.description ? el('p.cur-desc.muted.small', {}, U.truncate(c.description, 160)) : null,
      window.App.can('training.manage')
        ? el('div.cur-actions', {}, [
            button(t('training.assign'), {
              variant: 'ghost',
              onclick: () => assignFlow(c, {}, () => window.App.refresh()),
            }),
          ])
        : null,
    ], { class: 'curriculum-card' });
  }

  // --------------------------------------------------------- compliance -----

  async function complianceTab(query) {
    const daysAhead = String(query.daysAhead || '90');
    const [data, curricula] = await Promise.all([
      window.Api.get('/api/training/compliance', { daysAhead }),
      curriculaIndex(),
    ]);
    const byCode = new Map((curricula || []).map((c) => [c.code, c]));

    const wrap = el('div');
    wrap.appendChild(el('div.filter-bar', {}, [
      select('daysAhead', daysAhead, ['30', '60', '90', '180', '365'], {
        placeholder: false,
        onchange: (ev) => setQuery({ daysAhead: ev.target.value === '90' ? null : ev.target.value, tab: 'compliance' }),
      }),
      el('span.field-help', {}, bilingual('统计范围：未来天数', 'Horizon: days ahead')),
      window.App.can('training.manage')
        ? button(t('training.assign'), {
            variant: 'ghost',
            onclick: () => pickCurriculumDialog({}, () => window.App.refresh()),
          })
        : null,
    ]));

    const counts = data.counts || {};
    wrap.appendChild(el('div.stat-strip', {}, [
      stat(t('training.expired'), U.fmtNumber(counts.expired), { tone: counts.expired ? 'bad' : 'ok' }),
      stat(t('training.expiringSoon'), U.fmtNumber(counts.expiring), { tone: counts.expiring ? 'warn' : 'ok' }),
      stat(t('training.overdue'), U.fmtNumber(counts.overdue), { tone: counts.overdue ? 'bad' : 'ok' }),
      stat(bilingual('未完成必修培训', 'Not training-current'), U.fmtNumber(counts.untrained), { tone: counts.untrained ? 'warn' : 'ok' }),
      stat(bilingual('统计范围', 'Horizon'), `${data.daysAhead}${t('common.days')}`, { hint: `${daysAhead} ${t('common.days')}` }),
    ]));

    wrap.appendChild(recordListCard({
      title: t('training.expired'),
      rows: data.expired || [],
      dateKey: 'expiresAt',
      dateLabel: t('training.expiresAt'),
      tone: 'bad',
      byCode,
      onDone: () => window.App.refresh(),
    }));

    wrap.appendChild(recordListCard({
      title: t('training.expiringSoon'),
      rows: data.expiring || [],
      dateKey: 'expiresAt',
      dateLabel: t('training.expiresAt'),
      tone: 'warn',
      byCode,
      onDone: () => window.App.refresh(),
    }));

    wrap.appendChild(recordListCard({
      title: t('training.overdue'),
      rows: data.overdue || [],
      dateKey: 'dueDate',
      dateLabel: t('common.dueDate'),
      tone: 'bad',
      byCode,
      onDone: () => window.App.refresh(),
    }));

    wrap.appendChild(untrainedCard(data.untrainedUsers || []));
    return wrap;
  }

  function recordListCard({ title, rows, dateKey, dateLabel, tone, byCode, onDone }) {
    const columns = [
      {
        key: 'userName',
        label: t('training.person'),
        render: (r) => (r.recordId
          ? el('span.strong', {}, r.userName)
          : el('span', {}, r.userName)),
      },
      { key: 'department', label: t('common.department'), render: (r) => r.department || '\u2014' },
      {
        key: 'curriculumCode',
        label: t('training.curricula'),
        render: (r) => el('span', { title: r.curriculumTitle || '' }, [
          el('span.mono.strong', {}, r.curriculumCode),
          el('span.small.muted', {}, ` \u00b7 ${U.truncate(r.curriculumTitle || '', 48)}`),
        ]),
      },
      {
        key: dateKey,
        label: dateLabel,
        render: (r) => (r[dateKey]
          ? el('span', { class: tone === 'bad' ? 'overdue' : '' }, `${U.fmtDate(r[dateKey])} (${U.fmtRelative(r[dateKey])})`)
          : '\u2014'),
      },
      gxpCriticalColumn(),
      {
        key: 'actions',
        label: t('common.actions'),
        render: (r) => {
          const cur = byCode.get(r.curriculumCode) || null;
          const actions = [];
          if (r.recordId && window.App.can('training.assess')) {
            actions.push(button(t('training.recordCompletion'), {
              variant: 'ghost',
              onclick: () => recordCompletionFlow({
                id: r.recordId,
                curriculumId: cur ? cur.id : null,
                curriculumCode: r.curriculumCode,
                curriculumTitle: r.curriculumTitle,
                isGxpCritical: cur ? Boolean(cur.isGxpCritical) : false,
                userName: r.userName,
              }, { onDone }),
            }));
          }
          if (cur && window.App.can('training.manage')) {
            actions.push(button(t('training.assign'), {
              variant: 'ghost',
              onclick: () => assignFlow(cur, { userName: r.userName }, onDone),
            }));
          }
          return actions.length ? el('div.btn-row', {}, actions) : el('span.muted', {}, '\u2014');
        },
      },
    ];

    return card(title, table(columns, rows, {
      emptyText: t('common.noData'),
    }), { subtitle: `${rows.length} ${t('common.items')}` });
  }

  function gxpCriticalColumn() {
    return {
      key: 'gxpCritical',
      label: t('training.isGxpCritical'),
      render: (r) => (r.gxpCritical === undefined || r.gxpCritical === null
        ? el('span.muted', {}, '\u2014')
        : (r.gxpCritical ? badge(t('common.yes'), 'warn') : badge(t('common.no'), 'muted'))),
    };
  }

  function untrainedCard(rows) {
    const columns = [
      {
        key: 'fullName',
        label: t('training.person'),
        render: (r) => el('a.strong', { href: `#/training/${r.id}` }, r.fullName || r.username),
      },
      { key: 'username', label: t('users.username'), render: (r) => el('span.mono', {}, r.username) },
      { key: 'department', label: t('common.department'), render: (r) => r.department || '\u2014' },
      { key: 'role', label: t('training.role'), render: (r) => r.role || '\u2014' },
      {
        key: 'actions',
        label: t('common.actions'),
        render: (r) => el('div.btn-row', {}, [
          el('a', { href: `#/training/${r.id}` }, t('common.detail')),
          window.App.can('training.manage')
            ? button(t('training.assign'), {
                variant: 'ghost',
                onclick: () => pickCurriculumDialog({ userId: r.id, userName: r.fullName || r.username }, () => window.App.refresh()),
              })
            : null,
        ]),
      },
    ];
    return card(bilingual('培训状态非「当前」的人员', 'Personnel not training-current'), table(columns, rows, {
      emptyText: bilingual('所有在职人员的必修培训均有效', 'Every active person is training-current'),
      onRowClick: (r) => { window.location.hash = `#/training/${r.id}`; },
    }), { subtitle: `${rows.length} ${t('common.items')}` });
  }

  // ============================================================ person ======

  const personView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());

      let matrix;
      try {
        matrix = await window.Api.get(`/api/training/matrix/${params.id}`);
      } catch (err) {
        clear(container);
        container.appendChild(U.errorBox(err, () => personView.render(container, params)));
        return;
      }

      const eligibility = await window.Api.get(`/api/training/eligibility/${params.id}`)
        .then((data) => ({ data }), (error) => ({ error }));

      clear(container);
      container.appendChild(paintPerson(matrix, eligibility, () => personView.render(container, params)));
    },
  };

  function paintPerson(matrix, eligibility, retry) {
    const user = matrix.user || {};
    const eligible = eligibility && eligibility.data ? eligibility.data : null;

    return el('div.view', {}, [
      el('div.view-head', {}, [
        el('div', {}, [
          el('div.breadcrumb', {}, el('a', { href: '#/training' }, t('training.title'))),
          el('h1.view-title', {}, user.fullName || user.username || t('training.person')),
          el('div.head-badges', {}, [
            user.username ? el('span.mono', {}, user.username) : null,
            user.department ? badge(user.department, 'neutral') : null,
            user.role ? badge(user.role, 'info') : null,
            user.jobTitle ? badge(user.jobTitle, 'muted') : null,
            user.trainingStatus ? statusBadge(user.trainingStatus) : null,
          ]),
        ]),
        el('div.view-head-actions', {}, [
          button(t('common.refresh'), { variant: 'ghost', onclick: () => window.App.refresh() }),
        ]),
      ]),

      verdictBanner(matrix, user),

      eligibilityBlock(eligibility, retry),

      el('div.stat-strip', {}, [
        stat(bilingual('持有有效培训', 'Valid records held'), U.fmtNumber(matrix.counts && matrix.counts.held), { tone: 'ok' }),
        stat(bilingual('应持有课程', 'Required curricula'), U.fmtNumber(matrix.counts && matrix.counts.required)),
        stat(t('training.missingRequired'), U.fmtNumber(matrix.counts && matrix.counts.missing), {
          tone: matrix.counts && matrix.counts.missing ? 'bad' : 'ok',
        }),
        stat(t('training.expired'), U.fmtNumber(matrix.counts && matrix.counts.expired), {
          tone: matrix.counts && matrix.counts.expired ? 'bad' : 'ok',
        }),
        stat(t('training.expiringSoon'), U.fmtNumber(matrix.counts && matrix.counts.dueSoon), {
          tone: matrix.counts && matrix.counts.dueSoon ? 'warn' : 'ok',
        }),
      ]),

      el('div.record-grid', {}, [
        el('div.record-main', {}, [
          recordsCard(matrix, user),
        ]),
        el('div.record-side', {}, [
          missingCard(matrix, user),
          expiringCard(matrix, user),
          qualificationCard(user),
        ]),
      ]),
    ]);
  }

  function verdictBanner(matrix, user) {
    const qualified = matrix.qualifiedForGxP === true;
    const tone = qualified ? 'ok' : 'bad';
    return el(`div.verdict-banner.vb-${tone}`, {}, [
      el('div.vb-icon', {}, qualified ? '\u2713' : '\u26a0'),
      el('div.vb-body', {}, [
        el('div.vb-title', {}, qualified ? t('training.qualified') : t('training.notQualified')),
        el('div.vb-sub', {}, qualified
          ? bilingual(
            '该人员已持有全部 PV 关键课程的当前有效培训记录，可以执行相应 PV 操作。',
            'This person holds current records for every PV-critical curriculum and may perform the corresponding PV tasks.'
          )
          : bilingual(
            '存在缺失或已过期的 PV 关键培训，不得执行相应 PV 操作，除非有经批准的例外并已记录理由。',
            'PV-critical training is missing or expired. This person must not perform the corresponding PV tasks without an approved, documented exception.'
          )),
        el('div.vb-meta', {}, [
          el('span', {}, `${t('training.person')}: ${user.fullName || user.username || '\u2014'}`),
          el('span', {}, `${t('training.gaps')}: ${U.fmtNumber(matrix.counts && matrix.counts.missing)}`),
          el('span', {}, `${t('training.expired')}: ${U.fmtNumber(matrix.counts && matrix.counts.expired)}`),
        ]),
        el('div.vb-ref.small', {}, 'GVP Module I \u00b7 21 CFR Part 11'),
      ]),
    ]);
  }

  function eligibilityBlock(eligibility, retry) {
    if (!eligibility) return null;
    if (eligibility.error) {
      return card(t('training.eligibility'), U.errorBox(eligibility.error, retry));
    }
    const data = eligibility.data || {};
    if (data.allowed) {
      return el('div.info-note', {}, [
        el('strong', {}, `${t('training.eligibility')}: ${t('common.yes')}`),
        el('p', {}, bilingual(
          '系统未发现阻止该人员执行 PV 操作的培训或账号原因。',
          'No training or account reason blocks this person from performing PV tasks.'
        )),
      ]);
    }
    return el('div.warning-note', {}, [
      el('strong', {}, `${t('training.eligibility')}: ${t('common.no')}`),
      el('p', {}, t('training.blockedBy')),
      el('ul.reason-list', {}, (data.reasons || []).map((r) => el('li.mono.small', {}, r))),
      el('p.small.muted', {}, '21 CFR Part 11.10(g) \u00b7 GVP Module I'),
    ]);
  }

  function recordsCard(matrix, user) {
    const records = matrix.records || [];
    const columns = [
      { key: 'curriculumCode', label: t('training.curricula'), render: (r) => el('span.mono.strong', {}, r.curriculumCode) },
      { key: 'curriculumTitle', label: t('common.detail'), render: (r) => el('span', { title: r.curriculumTitle || '' }, U.truncate(r.curriculumTitle || '', 56)) },
      { key: 'status', label: t('common.status'), render: (r) => statusBadge(r.status) },
      { key: 'completedAt', label: bilingual('完成时间', 'Completed'), render: (r) => U.fmtDate(r.completedAt) },
      {
        key: 'expiresAt',
        label: t('training.expiresAt'),
        render: (r) => (r.expiresAt
          ? el('span', { class: r.status === 'expired' ? 'overdue' : '' }, `${U.fmtDate(r.expiresAt)} (${U.fmtRelative(r.expiresAt)})`)
          : el('span.muted', {}, '\u2014')),
      },
      {
        key: 'score',
        label: t('training.score'),
        align: 'right',
        render: (r) => (r.score === null || r.score === undefined
          ? el('span.muted', {}, '\u2014')
          : `${r.score}${r.passMark != null ? ` / ${r.passMark}` : ''}`),
      },
      { key: 'method', label: t('training.method'), render: (r) => r.methodLabel || U.humanise(r.method) },
      { key: 'trainerName', label: t('training.trainer'), render: (r) => r.trainerName || '\u2014' },
      {
        key: 'actions',
        label: t('common.actions'),
        render: (r) => (window.App.can('training.assess')
          ? button(t('training.recordCompletion'), {
              variant: 'ghost',
              onclick: () => recordCompletionFlow({
                id: r.id,
                curriculumId: r.curriculumId,
                curriculumCode: r.curriculumCode,
                curriculumTitle: r.curriculumTitle,
                isGxpCritical: Boolean(r.isGxpCritical),
                userName: user.fullName || user.username,
                score: r.score,
              }, { onDone: () => window.App.refresh() }),
            })
          : el('span.muted', {}, '\u2014')),
      },
    ];

    return card(bilingual('培训记录', 'Training records'), table(columns, records, {
      emptyText: t('common.noData'),
      rowClass: (r) => (r.status === 'expired' || r.status === 'failed' ? 'row-gap' : ''),
    }), { subtitle: `${records.length} ${t('common.items')}` });
  }

  function missingCard(matrix, user) {
    const missing = matrix.missingRequired || [];
    return card(t('training.missingRequired'), [
      missing.length
        ? el('ul.missing-list', {}, missing.map((m) => el('li.missing-item', {}, [
            el('div', {}, [
              el('div', {}, [
                el('span.mono.strong', {}, m.code),
                m.isGxpCritical ? badge(t('training.isGxpCritical'), 'bad') : null,
              ]),
              el('div.small.muted', {}, m.title || ''),
            ]),
            window.App.can('training.manage')
              ? button(t('training.assign'), {
                  variant: 'ghost',
                  onclick: () => assignFlow(m, {
                    userId: user.id,
                    userName: user.fullName || user.username,
                  }, () => window.App.refresh()),
                })
              : null,
          ])))
        : el('div.empty.ok', {}, t('training.noGaps')),
    ], { subtitle: `${missing.length} ${t('common.items')}` });
  }

  function expiringCard(matrix, user) {
    const rows = matrix.expiringSoon || [];
    if (!rows.length) return card(t('training.expiringSoon'), el('div.empty.ok', {}, t('training.noGaps')));
    return card(t('training.expiringSoon'), el('ul.expiring-list', {}, rows.map((r) => el('li.expiring-item', {}, [
      el('div', {}, [
        el('div', {}, [
          el('span.mono.strong', {}, r.curriculumCode),
          statusBadge(r.status),
          r.isGxpCritical ? badge(t('training.isGxpCritical'), 'warn') : null,
        ]),
        el('div.small.muted', {}, `${t('training.expiresAt')}: ${U.fmtDate(r.expiresAt)} (${U.fmtRelative(r.expiresAt)})`),
      ]),
      window.App.can('training.assess') && r.id
        ? button(t('training.recordCompletion'), {
            variant: 'ghost',
            onclick: () => recordCompletionFlow({
              id: r.id,
              curriculumId: r.curriculumId,
              curriculumCode: r.curriculumCode,
              curriculumTitle: r.curriculumTitle,
              isGxpCritical: Boolean(r.isGxpCritical),
              userName: user.fullName || user.username,
            }, { onDone: () => window.App.refresh() }),
          })
        : null,
    ]))), { subtitle: `${rows.length} ${t('common.items')}` });
  }

  function qualificationCard(user) {
    const qualification = user.qualification && typeof user.qualification === 'object' ? user.qualification : {};
    const entries = Object.entries(qualification);
    return card(bilingual('资质声明', 'Declared qualification'), [
      entries.length
        ? el('div.qual-list', {}, entries.map(([area, ok]) => el('div.qual-row', {}, [
            el('span.mono', {}, area),
            badge(ok === false ? t('training.notQualified') : t('training.qualified'), ok === false ? 'bad' : 'ok'),
          ])))
        : el('div.empty', {}, t('common.noData')),
    ], {
      subtitle: user.jobTitle || null,
    });
  }

  // ================================================= record completion ======

  const SIGNATURE_MEANING = 'completed';

  function askSignature(record, payload) {
    const bits = [t('training.recordCompletion'), record.curriculumCode || ''].filter(Boolean).join(' \u00b7 ');
    const score = payload && payload.score !== null && payload.score !== undefined ? ` \u00b7 ${t('training.score')} ${payload.score}` : '';
    return U.signatureDialog({
      meaning: SIGNATURE_MEANING,
      entityType: 'training_records',
      entityId: record.id,
      reason: `${bits}${score}`,
      secondFactorRequired: (window.App.boot.policy && window.App.boot.policy.signatureSecondFactor) !== false,
    });
  }

  /**
   * POST the completion, resolving the signature requirement either up front
   * (GxP-critical curriculum) or in response to a 428 from the server.
   */
  async function submitCompletion(record, payload) {
    const body = { ...payload };
    let signatureId = body.signatureId || null;
    delete body.signatureId;
    let signatureAttempts = 0;

    for (;;) {
      try {
        const updated = await window.Api.post(`/api/training-records/${record.id}/complete`, {
          ...body,
          signatureId,
        });
        U.toast(`${t('toast.saved')}: ${U.humanise(updated && updated.status)}`, 'ok');
        invalidateCaches();
        return updated;
      } catch (err) {
        if (err.code === 'SIGNATURE_REQUIRED' && signatureAttempts < 3) {
          signatureAttempts += 1;
          U.toast(err.message || t('toast.signatureRequired'), 'warn', 9000);
          const sig = await askSignature(record, payload);
          if (!sig) return null;
          signatureId = sig.id;
          continue;
        }
        if (err.code === 'SCORE_BELOW_PASS_MARK') {
          U.toast(`${err.message} \u2014 ${t('training.failed')}`, 'bad', 12000);
          return null;
        }
        U.toast(err.message || t('common.error'), 'bad', 9000);
        return null;
      }
    }
  }

  function recordCompletionFlow(record, opts) {
    const options = opts || {};
    const gxpCritical = Boolean(record.isGxpCritical);
    const today = nowLocalInput();

    const form = U.buildForm([
      {
        key: 'status',
        label: t('common.status'),
        type: 'select',
        required: true,
        options: [
          { value: 'completed', label: t('training.completed') },
          { value: 'failed', label: t('training.failed') },
        ],
      },
      { key: 'method', label: t('training.method'), type: 'select', required: true, options: methodOptions() },
      { key: 'score', label: t('training.score'), type: 'number' },
      { key: 'passMark', label: t('training.passMark'), type: 'number' },
      {
        key: 'result',
        label: t('training.result', bilingual('判定', 'Result')),
        type: 'select',
        options: [
          { value: 'pass', label: t('training.pass', bilingual('通过', 'Pass')) },
          { value: 'fail', label: t('training.fail', bilingual('不通过', 'Fail')) },
        ],
      },
      { key: 'trainerName', label: t('training.trainer'), type: 'text' },
      { key: 'completedAt', label: t('training.completedAt', bilingual('完成时间', 'Completed at')), type: 'datetime' },
      { key: 'evidence', label: t('training.evidence', bilingual('客观证据', 'Evidence')), type: 'text' },
      { key: 'assessmentNotes', label: t('training.assessmentNotes', bilingual('考核评语', 'Assessment notes')), type: 'textarea' },
      { key: 'notes', label: t('training.notes', bilingual('备注', 'Notes')), type: 'textarea' },
    ], {
      status: 'completed',
      method: (methodOptions()[0] || {}).value || null,
      result: 'pass',
      trainerName: window.App.user ? (window.App.user.fullName || window.App.user.username) : null,
      completedAt: today,
    });

    const warnHost = el('div');
    const refreshWarn = () => {
      clear(warnHost);
      const values = form.values();
      if (values.status === 'completed' && values.score !== null && values.passMark !== null
        && Number(values.score) < Number(values.passMark)) {
        warnHost.appendChild(el('div.warning-note', {}, el('p', {}, bilingual(
          `成绩 ${values.score} 低于及格线 ${values.passMark}，不能记为「已完成」。请把状态改为「未通过」。`,
          `Score ${values.score} is below the pass mark ${values.passMark}; this cannot be recorded as completed. Record it as failed instead.`
        ))));
      }
    };
    ['status', 'score', 'passMark'].forEach((key) => {
      const control = form.controls[key];
      if (!control) return;
      control.addEventListener('change', refreshWarn);
      control.addEventListener('input', refreshWarn);
    });
    refreshWarn();

    U.modal({
      title: `${t('training.recordCompletion')} \u00b7 ${record.curriculumCode || ''}`,
      width: '720px',
      render: (close) => {
        return [
          el('p.modal-intro', {}, [
            el('span', {}, `${t('training.person')}: ${record.userName || ''}`),
            el('span', {}, ` \u00b7 ${record.curriculumTitle || record.curriculumCode || ''}`),
          ]),
          form.node,
          warnHost,
          gxpCritical
            ? el('div.signature-notice', {}, [
                el('span.sig-icon', {}, '\u2712'),
                el('div', {}, [
                  el('div', {}, `${t('records.stepRequiresSignature')}: ${U.meaningLabel(SIGNATURE_MEANING)}`),
                  el('div.small.muted', {}, 'GVP Module I \u00b7 21 CFR Part 11'),
                ]),
              ])
            : null,
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
                if (values.status === 'completed' && values.score !== null && values.passMark !== null
                  && Number(values.score) < Number(values.passMark)) {
                  U.toast(bilingual(
                    `成绩低于及格线，请记为「${t('training.failed')}」。`,
                    `Score below the pass mark - record the outcome as failed instead.`
                  ), 'warn', 9000);
                  refreshWarn();
                  return;
                }
                const payload = {
                  status: values.status || 'completed',
                  method: values.method,
                  score: values.score === null ? null : Number(values.score),
                  passMark: values.passMark === null ? null : Number(values.passMark),
                  result: values.result,
                  trainerName: values.trainerName,
                  completedAt: U.normaliseDateInput(values.completedAt),
                  evidence: values.evidence,
                  assessmentNotes: values.assessmentNotes,
                  notes: values.notes,
                };
                close();

                // A GxP-critical record is signed FIRST: the server answers
                // 428 SIGNATURE_REQUIRED without a signatureId.
                let signatureId = null;
                if (gxpCritical && payload.status === 'completed') {
                  const sig = await askSignature(record, payload);
                  if (!sig) return;
                  signatureId = sig.id;
                  U.toast(`${t('signature.success')}: ${sig.manifest}`, 'ok');
                }

                const updated = await submitCompletion(record, { ...payload, ...(signatureId ? { signatureId } : {}) });
                if (updated && options.onDone) options.onDone();
              },
            }),
          ]),
        ];
      },
    });
  }

  // ============================================================ assign ======

  async function assignFlow(curriculum, preset, onDone) {
    if (!curriculum || !curriculum.id) {
      U.toast(t('common.error'), 'bad');
      return;
    }
    const pre = preset || {};
    const users = await roster();
    const userGroup = checkGroup('assign-user', users.map((u) => ({
      value: String(u.id),
      label: `${u.fullName || u.username}${u.department ? ` \u00b7 ${u.department}` : ''}`,
    })), pre.userId ? [String(pre.userId)] : []);
    const roleGroup = checkGroup('assign-role', roleOptions(), pre.role ? [pre.role] : []);
    const deptGroup = checkGroup('assign-dept', uniqueDepartments(users).map((d) => ({ value: d, label: d })),
      pre.department ? [pre.department] : []);
    const dueInput = input('assign-due', '', { type: 'date' });

    U.modal({
      title: `${t('training.assign')} \u00b7 ${curriculum.code}`,
      width: '720px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '可同时按人员、岗位角色或部门分配；已存在进行中记录的人员会被跳过。',
          'Assign by person, role and/or department in one go; anyone who already has an open record is skipped.'
        )),
        pre.userName ? el('div.info-note', {}, `${t('training.person')}: ${pre.userName}`) : null,
        el('div.form-grid', {}, [
          field(t('training.person'), userGroup.node, { help: `${users.length} ${t('common.items')}` }),
          field(t('training.role'), roleGroup.node),
          field(t('common.department'), deptGroup.node),
          field(t('common.dueDate'), dueInput, { help: t('common.optionalNote') }),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('training.assign'), {
            variant: 'primary',
            onclick: async () => {
              const userIds = userGroup.values().map(Number);
              const roles = roleGroup.values();
              const departments = deptGroup.values();
              if (!userIds.length && !roles.length && !departments.length) {
                U.toast(bilingual('请至少选择一名人员、一个岗位角色或一个部门。',
                  'Select at least one person, role or department.'), 'warn');
                return;
              }
              try {
                const res = await window.Api.post(`/api/curricula/${curriculum.id}/assign`, {
                  userIds,
                  roles,
                  departments,
                  dueDate: dueInput.value || null,
                });
                close();
                U.toast(`${t('training.assign')}: ${res && res.assigned != null ? res.assigned : 0} ${t('common.items')}`, 'ok');
                invalidateCaches();
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

  /** Choose which curriculum to assign, used from the untrained list. */
  async function pickCurriculumDialog(preset, onDone) {
    const rows = await curriculaIndex();
    if (!rows.length) {
      U.toast(t('common.noData'), 'warn');
      return;
    }
    U.modal({
      title: t('training.assign'),
      width: '600px',
      render: (close) => [
        el('p.modal-intro', {}, preset && preset.userName
          ? `${t('training.person')}: ${preset.userName}`
          : bilingual('选择要分配的培训课程', 'Choose the curriculum to assign')),
        el('div.pick-list', {}, rows.map((c) => el('button.pick-row', {
          type: 'button',
          onclick: () => {
            close();
            assignFlow(c, preset || {}, onDone);
          },
        }, [
          el('span.mono.strong', {}, c.code),
          el('span.pick-title', {}, U.truncate(c.title || '', 60)),
          c.isGxpCritical ? badge(t('training.isGxpCritical'), 'warn') : null,
          badge(c.stats && c.stats.compliancePercent != null ? `${c.stats.compliancePercent}%` : '\u2014', 'info'),
        ]))),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
        ]),
      ],
    });
  }

  // ======================================================= new curriculum ===

  async function newCurriculumDialog(onDone) {
    const users = await roster();
    const areaGroup = checkGroup('cur-area', areaOptions(), []);
    const roleGroup = checkGroup('cur-role', roleOptions(), []);
    const deptGroup = checkGroup('cur-dept', uniqueDepartments(users).map((d) => ({ value: d, label: d })), []);
    let criticalFlag = true;

    const form = U.buildForm([
      { key: 'code', label: bilingual('课程编号', 'Curriculum code'), type: 'text', required: true },
      { key: 'title', label: bilingual('课程名称', 'Title'), type: 'text', required: true },
      { key: 'titleEn', label: bilingual('英文名称', 'Title (English)'), type: 'text' },
      { key: 'validityMonths', label: t('training.validityMonths'), type: 'number' },
      { key: 'description', label: bilingual('课程说明', 'Description'), type: 'textarea' },
    ], { validityMonths: 24 });

    U.modal({
      title: t('training.newCurriculum'),
      width: '760px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '培训课程定义「谁必须接受什么培训、多久复训一次」。PV 关键课程在完成登记时强制要求电子签名。',
          'A curriculum defines who must be trained in what and how often. Completing PV-critical training always requires an electronic signature.'
        )),
        form.node,
        el('div.form-grid', {}, [
          field('PV', areaGroup.node),
          field(t('training.appliesTo') + ` \u00b7 ${t('training.role')}`, roleGroup.node),
          field(t('training.appliesTo') + ` \u00b7 ${t('common.department')}`, deptGroup.node),
          field(t('training.isGxpCritical'), U.checkbox('cur-critical', true,
            t('training.isGxpCritical'), { onchange: (ev) => { criticalFlag = ev.target.checked; } })),
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
                const created = await window.Api.post('/api/curricula', {
                  code: String(values.code || '').toUpperCase(),
                  title: values.title,
                  titleEn: values.titleEn,
                  gxpAreas: areaGroup.values(),
                  appliesToRoles: roleGroup.values(),
                  appliesToDepartments: deptGroup.values(),
                  validityMonths: values.validityMonths === null ? null : Number(values.validityMonths),
                  isGxpCritical: criticalFlag === true,
                  description: values.description,
                });
                close();
                U.toast(`${t('toast.created')}: ${created.code || values.code}`, 'ok');
                invalidateCaches();
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

  window.Views.register('training', listView);
  window.Views.register('trainingPerson', personView);
  window.TrainingHelpers = { STATE_TONES, STATE_GLYPHS, stateLabel, askSignature, submitCompletion, assignFlow };
})();
