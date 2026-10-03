/* View: self-inspection. Checklist library plus running an inspection and
 * grading each requirement against objective evidence.
 *
 * The design point: a "gap" cannot be recorded without objective evidence, and
 * every gap can be turned into a tracked CAPA without retyping anything. That
 * is what turns an inspection from a document into a corrective action.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, statusBadge, button, field, input, textarea, select } = U;

  const GRADE_TONES = {
    compliant: 'ok', partial: 'warn', gap: 'bad',
    not_applicable: 'muted', not_assessed: 'muted',
  };

  function gradeLabel(g) {
    return t(`inspection.grade.${g}`);
  }

  function riskTone(level) {
    return level === 'critical' ? 'bad' : level === 'major' ? 'warn' : 'muted';
  }

  // ============================================================== list =======

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      clear(container);
      container.appendChild(U.spinner());

      const [data, readiness, templates] = await Promise.all([
        window.Api.get('/api/inspections', {
          status: query.status || '', inspectionType: query.inspectionType || '',
          gxpArea: query.gxpArea || '', search: query.search || '', limit: 100,
        }),
        window.App.can('compliance.view') ? window.Api.get('/api/readiness').catch(() => null) : Promise.resolve(null),
        window.Api.get('/api/checklists').catch(() => ({ rows: [] })),
      ]);
      clear(container);

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('inspection.title')),
            el('p.view-sub', {}, t('inspection.subtitle')),
          ]),
          el('div.view-head-actions', {}, [
            window.App.can('inspection.manage')
              ? button(t('inspection.newInspection'), {
                  variant: 'primary',
                  onclick: () => { window.location.hash = '#/inspections/new'; },
                })
              : null,
          ]),
        ]),

        readiness ? readinessStrip(readiness) : null,

        el('div.filter-bar', {}, [
          input('search', query.search || '', {
            placeholder: t('common.search'),
            oninput: debounce((v) => setQuery({ search: v || null }), 350),
          }),
          select('status', query.status || '', ['planned', 'in_progress', 'closed', 'closed_with_open_items'], {
            placeholder: `— ${t('common.status')} —`,
            onchange: (ev) => setQuery({ status: ev.target.value || null }),
          }),
          select('inspectionType', query.inspectionType || '',
            ['self_inspection', 'regulatory', 'supplier', 'study_audit', 'for_cause', 'follow_up'], {
              placeholder: `— ${t('common.filter')} —`,
              onchange: (ev) => setQuery({ inspectionType: ev.target.value || null }),
            }),
        ]),

        card(t('inspection.myInspections'), table([
          { key: 'code', label: t('records.recordKey'), render: (r) => el('a.mono.strong', { href: `#/inspections/${r.id}` }, r.code) },
          { key: 'title', label: t('common.detail'), render: (r) => U.truncate(r.title, 70) },
          { key: 'inspectionType', label: t('common.filter'), render: (r) => badge(U.humanise(r.inspectionType), 'neutral') },
          { key: 'gxpAreas', label: 'PV', render: (r) => el('span.gxp-chips', {}, (r.gxpAreas || []).map((a) => badge(a, 'info'))) },
          { key: 'status', label: t('common.status'), render: (r) => statusBadge(r.status) },
          {
            key: 'readinessScore',
            label: t('inspection.score'),
            align: 'right',
            render: (r) => (r.readinessScore === null || r.readinessScore === undefined
              ? el('span.muted', {}, '—')
              : el('span', { class: scoreClass(r.readinessScore) }, `${r.readinessScore}%`)),
          },
          {
            key: 'findingsOpen',
            label: t('inspection.findings'),
            align: 'right',
            render: (r) => el('span', {}, [
              r.findingsOpen ? badge(r.findingsOpen, 'warn') : el('span.muted', {}, '0'),
              r.criticalOpen ? badge(`${r.criticalOpen} critical`, 'bad') : null,
            ]),
          },
          { key: 'scheduledDate', label: t('common.createdAt'), render: (r) => U.fmtDate(r.scheduledDate) },
        ], data.rows, {
          emptyText: t('common.noData'),
          onRowClick: (r) => { window.location.hash = `#/inspections/${r.id}`; },
        }), { subtitle: `${data.total} ${t('common.items')}` }),

        templatesCard(templates.rows || []),
      ]));
    },
  };

  function scoreClass(score) {
    if (score >= 90) return 'score-ok';
    if (score >= 70) return 'score-warn';
    return 'score-bad';
  }

  function readinessStrip(readiness) {
    const tone = readiness.readinessScore >= 90 ? 'ok' : readiness.readinessScore >= 70 ? 'warn' : 'bad';
    return el('div.readiness-banner', { class: `rb-${tone}` }, [
      el('div.rb-score', {}, [
        el('span.rb-value', {}, String(readiness.readinessScore)),
        el('span.rb-max', {}, '/100'),
      ]),
      el('div.rb-body', {}, [
        el('div.rb-rating', {}, t(`rating.${readiness.rating}`)),
        el('div.rb-blockers', {}, readiness.blockers && readiness.blockers.length
          ? readiness.blockers.slice(0, 4).map((b) => el('div.rb-blocker', {}, [
              badge(b.severity === 'critical' ? bilingual('严重', 'Critical') : bilingual('主要', 'Major'), b.severity === 'critical' ? 'bad' : 'warn'),
              el('span', {}, b.message),
            ]))
          : el('span', {}, t('dash.noBlockers'))),
      ]),
    ]);
  }

  function templatesCard(templates) {
    if (!templates.length) return el('div');
    return card(t('inspection.templates'), table([
      { key: 'code', label: t('records.recordKey'), render: (r) => el('a.mono', { href: `#/checklists/${encodeURIComponent(r.code)}` }, r.code) },
      { key: 'title', label: t('common.detail'), render: (r) => el('div', {}, [
          el('div', {}, getLocale() === 'en' && r.titleEn ? r.titleEn : r.title),
          el('div.small.muted', {}, r.regulation || ''),
        ]) },
      { key: 'gxpAreas', label: 'PV', render: (r) => el('span.gxp-chips', {}, (r.gxpAreas || []).map((a) => badge(a, 'info'))) },
      { key: 'itemCount', label: t('inspection.itemCount'), align: 'right' },
      {
        key: 'riskCounts',
        label: t('inspection.riskSummary'),
        render: (r) => el('span.risk-counts', {}, [
          r.riskCounts && r.riskCounts.critical ? badge(`${r.riskCounts.critical} C`, 'bad') : null,
          r.riskCounts && r.riskCounts.major ? badge(`${r.riskCounts.major} M`, 'warn') : null,
          r.riskCounts && r.riskCounts.minor ? badge(`${r.riskCounts.minor} m`, 'muted') : null,
        ]),
      },
    ], templates, {
      onRowClick: (r) => { window.location.hash = `#/checklists/${encodeURIComponent(r.code)}`; },
    }), { subtitle: `${templates.length} ${t('common.items')}` });
  }

  function debounce(fn, ms) {
    let timer = null;
    return (value) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(value), ms);
    };
  }

  function setQuery(patch) {
    const route = window.Views.resolveRoute(window.location.hash);
    const query = { ...(route ? route.query : {}), ...patch };
    const base = (window.location.hash.split('?')[0]) || '#/inspections';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  // ============================================================== new ========

  const newView = {
    async render(container, params) {
      clear(container);
      const templates = await window.Api.get('/api/checklists');
      const preselect = (params.query && params.query.template) || '';

      let chosen = preselect ? (templates.rows || []).find((x) => x.code === preselect) : null;
      let titleInput; let siteInput; let scopeInput; let dateInput;
      const body = el('div');
      let form;

      const paint = () => {
        clear(body);
        if (!chosen) {
          body.appendChild(el('div.process-picker', {}, (templates.rows || []).map((tpl) => el('button.process-tile', {
            type: 'button',
            onclick: () => { chosen = tpl; paint(); },
          }, [
            el('div.tile-head', {}, [
              el('span.tile-name', {}, getLocale() === 'en' && tpl.titleEn ? tpl.titleEn : tpl.title),
              el('span.tile-code.mono', {}, tpl.code),
            ]),
            el('div.tile-areas', {}, (tpl.gxpAreas || []).map((a) => badge(a, 'info'))),
            el('div.tile-desc', {}, tpl.regulation || ''),
            el('div.tile-meta', {}, [
              el('span', {}, `${tpl.itemCount} ${t('inspection.itemCount')}`),
              tpl.riskCounts && tpl.riskCounts.critical ? badge(`${tpl.riskCounts.critical} critical`, 'bad') : null,
            ]),
          ]))));
          return;
        }

        form = U.buildForm([
          { key: 'title', label: bilingual('自查标题', 'Inspection title'), type: 'text', required: true },
          { key: 'site', label: bilingual('场所', 'Site'), type: 'text' },
          { key: 'scope', label: bilingual('自查范围', 'Scope'), type: 'textarea', required: true,
            help: bilingual('说明本次自查覆盖的部门、区域与时间段', 'State the departments, areas and period covered') },
          { key: 'scheduledDate', label: bilingual('自查日期', 'Inspection date'), type: 'date' },
        ], {
          title: getLocale() === 'en' && chosen.titleEn ? chosen.titleEn : chosen.title,
          scheduledDate: new Date().toISOString().slice(0, 10),
        });

        body.appendChild(el('div.create-form', {}, [
          el('div.create-head', {}, [
            el('div', {}, [
              el('h2', {}, getLocale() === 'en' && chosen.titleEn ? chosen.titleEn : chosen.title),
              el('p.view-sub', {}, chosen.regulation || ''),
            ]),
            button(bilingual('更换检查表', 'Change checklist'), { variant: 'ghost', onclick: () => { chosen = null; paint(); } }),
          ]),
          el('div.info-note', {}, bilingual(
            `将按该检查表生成 ${chosen.itemCount} 条检查项，逐条判定并填写客观证据。判定为「存在缺陷」的条目可一键转为 CAPA。`,
            `${chosen.itemCount} requirements will be generated. Grade each one with objective evidence; any gap can become a CAPA in one click.`
          )),
          form.node,
          el('div.create-actions', {}, [
            button(t('common.cancel'), { variant: 'ghost', onclick: () => { window.location.hash = '#/inspections'; } }),
            button(t('inspection.newInspection'), {
              variant: 'primary',
              onclick: async () => {
                const missing = form.missing();
                if (missing.length) { U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn'); return; }
                try {
                  const created = await window.Api.post('/api/inspections', {
                    templateCode: chosen.code,
                    gxpAreas: chosen.gxpAreas,
                    ...form.values(),
                  });
                  U.toast(`${t('toast.created')}: ${created.code}`, 'ok');
                  window.location.hash = `#/inspections/${created.id}`;
                } catch (err) { U.toast(err.message, 'bad', 8000); }
              },
            }),
          ]),
        ]));
      };

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('inspection.newInspection')),
            el('p.view-sub', {}, t('inspection.selectProcess') === t('inspection.selectProcess')
              ? bilingual('选择检查表后即可开始逐条评估。', 'Choose a checklist to begin assessing requirement by requirement.')
              : ''),
          ]),
        ]),
        body,
      ]));
      paint();
    },
  };

  // ============================================================= detail ======

  const detailView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());
      const insp = await window.Api.get(`/api/inspections/${params.id}`);
      clear(container);
      container.appendChild(paint(insp));
    },
  };

  function paint(insp) {
    const view = el('div.view');
    const p = insp.progress || {};

    view.appendChild(el('div.view-head', {}, [
      el('div', {}, [
        el('div.breadcrumb', {}, el('a', { href: '#/inspections' }, t('inspection.title'))),
        el('h1.view-title', {}, [el('span.mono', {}, insp.code), el('span.title-sep', {}, ' \u00b7 '), insp.title]),
        el('div.head-badges', {}, [
          statusBadge(insp.status),
          badge(U.humanise(insp.inspectionType), 'neutral'),
          ...(insp.gxpAreas || []).map((a) => badge(a, 'info')),
          insp.readinessScore !== null && insp.readinessScore !== undefined
            ? badge(`${t('inspection.score')}: ${insp.readinessScore}%`, insp.readinessScore >= 90 ? 'ok' : insp.readinessScore >= 70 ? 'warn' : 'bad')
            : null,
        ]),
        insp.scope ? el('p.view-sub', {}, insp.scope) : null,
      ]),
      el('div.view-head-actions', {}, [
        window.App.can('inspection.report')
          ? button(bilingual('导出 CSV', 'Export CSV'), {
              variant: 'ghost',
              onclick: () => exportFindings(insp),
            })
          : null,
        window.App.can('inspection.manage') && insp.status !== 'closed'
          ? button(t('inspection.closeInspection'), { variant: 'primary', onclick: () => closeInspection(insp) })
          : null,
      ]),
    ]));

    view.appendChild(el('div.stat-strip', {}, [
      stat(t('inspection.progress'), `${p.assessed || 0}/${p.total || 0}`, {
        hint: `${p.percentAssessed || 0}%`,
        tone: (p.percentAssessed || 0) === 100 ? 'ok' : 'info',
      }),
      stat(gradeLabel('compliant'), p.compliant || 0, { tone: 'ok' }),
      stat(gradeLabel('partial'), p.partial || 0, { tone: p.partial ? 'warn' : null }),
      stat(gradeLabel('gap'), p.gap || 0, { tone: p.gap ? 'bad' : 'ok' }),
      stat(t('inspection.criticalOpen'), (insp.riskBreakdown && insp.riskBreakdown.critical) || 0, {
        tone: (insp.riskBreakdown && insp.riskBreakdown.critical) ? 'bad' : 'ok',
      }),
      stat(bilingual('不适用', 'N/A'), p.notApplicable || 0, { tone: 'muted' }),
    ]));

    const notAssessed = (insp.findings || []).filter((f) => f.grade === 'not_assessed');
    const assessed = (insp.findings || []).filter((f) => f.grade !== 'not_assessed');

    if (notAssessed.length) {
      view.appendChild(findingsCard(insp, notAssessed, bilingual('待评估检查项', 'Requirements to assess'), true));
    }
    if (assessed.length) {
      view.appendChild(findingsCard(insp, assessed, t('inspection.findings'), false));
    }
    if (!notAssessed.length && !assessed.length) {
      view.appendChild(card(null, el('div.empty', {}, t('common.noData'))));
    }

    if (insp.completedAt) {
      view.appendChild(card(bilingual('自查结论', 'Conclusion'), [
        el('p', {}, insp.summary || '—'),
        el('div.meta-line', {}, `${U.fmtDateTime(insp.completedAt)} \u00b7 ${insp.leadAuditor || ''}`),
      ]));
    }

    return view;
  }

  function findingsCard(insp, findings, title, isPending) {
    return card(title, el('div.finding-list', {}, findings.map((f) => findingRow(insp, f))), {
      subtitle: `${findings.length} ${t('common.items')}`,
      bodyClass: isPending ? 'findings-pending' : '',
    });
  }

  function findingRow(insp, f) {
    const canAssess = window.App.can('inspection.manage') && insp.status !== 'closed';
    return el('div.finding', { class: `finding-${f.grade}` }, [
      el('div.finding-head', {}, [
        f.clauseRef ? el('span.finding-clause.mono', {}, f.clauseRef) : null,
        badge(gradeLabel(f.grade), GRADE_TONES[f.grade] || 'neutral'),
        badge(U.humanise(f.riskLevel), riskTone(f.riskLevel)),
        f.workflowId ? badge(t('inspection.escalated'), 'info') : null,
      ]),
      el('div.finding-req', {}, f.requirement),
      f.observation ? el('div.finding-obs', {}, [
        el('span.finding-label', {}, `${t('inspection.observation')}: `),
        f.observation,
      ]) : null,
      f.objectiveEvidence ? el('div.finding-evidence', {}, [
        el('span.finding-label', {}, `${t('inspection.objectiveEvidence')}: `),
        f.objectiveEvidence,
      ]) : null,
      f.dueDate ? el('div.finding-due', {}, `${t('common.dueDate')}: ${U.fmtDate(f.dueDate)}`) : null,
      (canAssess || (f.grade === 'gap' || f.grade === 'partial') && !f.workflowId)
        ? el('div.finding-actions', {}, [
            canAssess ? button(t('inspection.grade'), { variant: 'ghost', onclick: () => assessDialog(insp, f) }) : null,
            canAssess && (f.grade === 'gap' || f.grade === 'partial') && !f.workflowId && window.App.can('capa.manage')
              ? button(t('inspection.escalate'), { variant: 'primary', onclick: () => escalateDialog(insp, f) })
              : null,
          ])
        : null,
    ]);
  }

  function assessDialog(insp, finding) {
    let evidenceArea; let obsArea; let riskSelect; let typeSelect; let dueInput;
    const grades = (window.App.boot.inspectionGrades || []).map((g) => ({ value: g.code, label: `${g.labelZh || g.label} / ${g.label}` }));
    const riskLevels = ['critical', 'major', 'minor'];
    const types = (window.App.boot.findingTypes || []).map((x) => ({ value: x.code, label: `${x.labelZh || x.label} / ${x.label}` }));
    let gradeSelect;

    U.modal({
      title: t('inspection.grade'),
      width: '780px',
      render: (close) => [
        el('div.guidance-note', {}, [
          el('div.finding-clause.mono', {}, finding.clauseRef || ''),
          el('p', {}, finding.requirement),
        ]),
        el('div.form-grid', {}, [
          field(t('inspection.grade'), (gradeSelect = select('grade', finding.grade === 'not_assessed' ? '' : finding.grade, grades, {
            required: true, placeholder: `— ${t('common.required')} —`,
          })), { required: true }),
          field(t('common.criticality'), (riskSelect = select('riskLevel', finding.riskLevel, riskLevels, { placeholder: false }))),
          field(bilingual('缺陷分类', 'Finding type'), (typeSelect = select('findingType', finding.findingType, types, { placeholder: false }))),
          field(t('common.dueDate'), (dueInput = input('dueDate', finding.dueDate || '', { type: 'date' }))),
        ]),
        field(t('inspection.observation'), (obsArea = textarea('observation', finding.observation || '', { rows: 3 }))),
        field(t('inspection.objectiveEvidence'), (evidenceArea = textarea('objectiveEvidence', finding.objectiveEvidence || '', {
          rows: 4, placeholder: bilingual('如：抽查 2026-03 批记录 5 份，其中 2 份复核签名缺失', 'e.g. reviewed 5 batch records from March; 2 lacked a review signature'),
        })), { help: t('inspection.evidenceRequired') }),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const grade = gradeSelect.value;
              if (!grade) { U.toast(t('common.required'), 'warn'); return; }
              const evidence = evidenceArea.value.trim();
              // Enforce the evidence rule client-side too, so the user gets an
              // immediate explanation rather than a server 400.
              if ((grade === 'partial' || grade === 'gap') && evidence.length < 10) {
                U.toast(t('inspection.evidenceRequired'), 'warn', 7000);
                evidenceArea.focus();
                return;
              }
              try {
                await window.Api.post(`/api/findings/${finding.id}/assess`, {
                  grade,
                  observation: obsArea.value.trim() || null,
                  objectiveEvidence: evidence || null,
                  riskLevel: riskSelect.value,
                  findingType: typeSelect.value,
                  dueDate: dueInput.value || null,
                  notes: `${t('inspection.grade')}: ${grade}`,
                });
                close();
                U.toast(t('toast.saved'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  function escalateDialog(insp, finding) {
    let titleInput; let ownerInput; let dueInput; let summaryArea;
    const processes = (window.App.boot.processTypes || []).filter((x) => x.code === 'CAPA' || x.code === 'DEV' || x.code === 'CC');
    let procSelect;

    U.modal({
      title: t('inspection.escalate'),
      width: '680px',
      render: (close) => [
        el('p.modal-intro', {}, t('inspection.escalateIntro')),
        el('div.guidance-note', {}, [
          el('div.finding-clause.mono', {}, finding.clauseRef || ''),
          el('p', {}, finding.requirement),
          el('p.small', {}, `${t('inspection.objectiveEvidence')}: ${finding.objectiveEvidence || '—'}`),
        ]),
        field(t('records.processType'), (procSelect = select('processCode', 'CAPA',
          processes.map((x) => ({ value: x.code, label: `${x.name} / ${x.nameEn || x.code}` })), { placeholder: false }))),
        field(bilingual('CAPA 标题', 'CAPA title'), (titleInput = input('title',
          `CAPA for ${insp.code}: ${String(finding.requirement).slice(0, 90)}`, { required: true })), { required: true }),
        field(bilingual('问题描述', 'Problem statement'), (summaryArea = textarea('summary',
          finding.observation || finding.objectiveEvidence || '', { rows: 3 }))),
        el('div.form-grid', {}, [
          field(bilingual('责任人', 'Owner'), (ownerInput = input('ownerId', finding.ownerId || '', { placeholder: 'user id' }))),
          field(t('common.dueDate'), (dueInput = input('dueDate', finding.dueDate || '', { type: 'date' }))),
        ]),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('inspection.escalate'), {
            variant: 'primary',
            onclick: async () => {
              try {
                const result = await window.Api.post(`/api/findings/${finding.id}/escalate`, {
                  processCode: procSelect.value,
                  title: titleInput.value.trim(),
                  summary: summaryArea.value.trim() || null,
                  ownerId: ownerInput.value ? Number(ownerInput.value) : null,
                  dueDate: dueInput.value || null,
                });
                close();
                U.toast(`${t('toast.created')}: ${result.workflow.recordKey}`, 'ok');
                window.location.hash = `#/records/${result.workflow.id}`;
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  async function closeInspection(insp) {
    let summaryArea;
    const remaining = (insp.progress && insp.progress.total - insp.progress.assessed) || 0;
    const openCritical = (insp.findings || []).filter((f) => f.riskLevel === 'critical'
      && ['gap', 'partial'].includes(f.grade) && !f.workflowId && f.status !== 'closed').length;

    U.modal({
      title: t('inspection.closeInspection'),
      width: '620px',
      render: (close) => [
        remaining > 0
          ? el('div.warning-note', {}, `${remaining} ${t('inspection.itemCount')} ${t('inspection.grade.not_assessed')}`)
          : null,
        openCritical > 0
          ? el('div.warning-note.warn-strong', {}, bilingual(
              `仍有 ${openCritical} 项严重缺陷未转为 CAPA。建议先转为 CAPA 再关闭自查。`,
              `${openCritical} critical finding(s) have not been escalated to CAPA. Consider escalating before closing.`
            ))
          : null,
        field(bilingual('自查结论', 'Conclusion'), (summaryArea = textarea('summary', '', { rows: 5, required: true })),
          { required: true, help: bilingual('总结本次自查的整体符合性、主要缺陷与后续安排', 'Summarise overall compliance, main gaps and next steps') }),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('inspection.closeInspection'), {
            variant: 'primary',
            onclick: async () => {
              const summary = summaryArea.value.trim();
              if (summary.length < 10) { U.toast(t('common.required'), 'warn'); return; }
              try {
                await window.Api.post(`/api/inspections/${insp.id}/close`, { summary, force: false });
                close();
                U.toast(t('toast.saved'), 'ok');
                window.App.refresh();
              } catch (err) {
                // ASSESSMENT_INCOMPLETE / CRITICAL_GAPS_OPEN are intentional
                // gates; offer an explicit override that is itself recorded.
                if (['ASSESSMENT_INCOMPLETE', 'CRITICAL_GAPS_OPEN'].includes(err.code)) {
                  const ok = await U.confirmDialog({
                    title: t('inspection.closeInspection'),
                    message: `${err.message}\n\n${bilingual('仍然关闭将记录为「带未关闭项的关闭」，并写入审计追踪。', 'Closing anyway is recorded as a close with open items and written to the audit trail.')}`,
                    confirmLabel: t('common.confirm'),
                    variant: 'danger',
                  });
                  if (!ok) return;
                  try {
                    await window.Api.post(`/api/inspections/${insp.id}/close`, { summary, force: true });
                    close();
                    U.toast(t('toast.saved'), 'ok');
                    window.App.refresh();
                  } catch (err2) { U.toast(err2.message, 'bad', 8000); }
                  return;
                }
                U.toast(err.message, 'bad', 9000);
              }
            },
          }),
        ]),
      ],
    });
  }

  function exportFindings(insp) {
    const cols = ['clauseRef', 'grade', 'riskLevel', 'findingType', 'status', 'requirement', 'observation', 'objectiveEvidence', 'dueDate'];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ');
      return /[",]/.test(s) ? `"${s}"` : s;
    };
    const lines = [cols.join(',')];
    for (const f of insp.findings || []) lines.push(cols.map((c) => escape(f[c])).join(','));
    // BOM so Excel renders the Chinese text correctly.
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspection-${insp.code}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    U.toast(t('common.export'), 'ok');
  }

  // ========================================================== checklists =====

  const checklistLibrary = {
    async render(container) {
      clear(container);
      container.appendChild(U.spinner());
      const data = await window.Api.get('/api/checklists');
      clear(container);
      const rows = data.rows || [];
      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('inspection.templates')),
            el('p.view-sub', {}, bilingual(
              '每张检查表把一部法规的条款转成可判定的检查项，并注明检查时该看什么、需要准备哪些客观证据。',
              'Each checklist turns a regulation into assessable requirements, with what to look for and which objective evidence to prepare.'
            )),
          ]),
        ]),
        el('div.template-grid', {}, rows.map((tpl) => el('a.template-card', {
          href: `#/checklists/${encodeURIComponent(tpl.code)}`,
        }, [
          el('div.tc-head', {}, [
            el('span.tc-title', {}, getLocale() === 'en' && tpl.titleEn ? tpl.titleEn : tpl.title),
            el('span.tc-code.mono', {}, tpl.code),
          ]),
          el('div.tc-areas', {}, (tpl.gxpAreas || []).map((a) => badge(a, 'info'))),
          el('div.tc-regulation', {}, tpl.regulation || ''),
          tpl.authority ? el('div.tc-authority', {}, `${t('inspection.authority')}: ${tpl.authority}`) : null,
          el('div.tc-meta', {}, [
            el('span', {}, `${tpl.itemCount} ${t('inspection.itemCount')}`),
            tpl.riskCounts && tpl.riskCounts.critical ? badge(`${tpl.riskCounts.critical} critical`, 'bad') : null,
            tpl.riskCounts && tpl.riskCounts.major ? badge(`${tpl.riskCounts.major} major`, 'warn') : null,
          ]),
        ]))),
      ]));
    },
  };

  const checklistView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());
      const tpl = await window.Api.get(`/api/checklists/${encodeURIComponent(params.code)}`);
      clear(container);

      let currentFilter = 'all';
      const list = el('div.checklist-items');

      const paintList = () => {
        clear(list);
        const items = (tpl.items || []).filter((i) => currentFilter === 'all' || i.riskLevel === currentFilter);
        list.appendChild(el('div.checklist-body', {}, items.map((item) => el('div.checklist-item', {
          class: `cli-${item.riskLevel}`,
        }, [
          el('div.cli-head', {}, [
            el('span.cli-seq.mono', {}, `${item.seq}.`),
            item.clauseRef ? el('span.cli-clause.mono', {}, item.clauseRef) : null,
            badge(U.humanise(item.riskLevel), riskTone(item.riskLevel)),
          ]),
          el('div.cli-req', {}, item.requirement),
          item.requirementEn ? el('div.cli-req-en', {}, item.requirementEn) : null,
          item.guidance ? el('details.cli-guidance', {}, [
            el('summary', {}, t('inspection.guidance')),
            el('p', {}, item.guidance),
            item.guidanceEn ? el('p.small.muted', {}, item.guidanceEn) : null,
          ]) : null,
          item.evidenceHint ? el('div.cli-evidence', {}, [
            el('span.cli-ev-label', {}, `${t('inspection.evidenceHint')}: `),
            item.evidenceHint,
          ]) : null,
        ]))));
      };

      const filterBar = el('div.filter-bar', {}, [
        ...['all', 'critical', 'major', 'minor'].map((level) => el(`button.chip${currentFilter === level ? '.active' : ''}`, {
          type: 'button',
          onclick: () => { currentFilter = level; paintList(); redraw(); },
        }, level === 'all' ? t('common.all') : `${U.humanise(level)} (${(tpl.items || []).filter((i) => i.riskLevel === level).length})`)),
      ]);

      function redraw() {
        clear(container);
        container.appendChild(el('div.view', {}, [
          el('div.view-head', {}, [
            el('div', {}, [
              el('div.breadcrumb', {}, el('a', { href: '#/checklists' }, t('inspection.templates'))),
              el('h1.view-title', {}, getLocale() === 'en' && tpl.titleEn ? tpl.titleEn : tpl.title),
              el('div.head-badges', {}, [
                ...(tpl.gxpAreas || []).map((a) => badge(a, 'info')),
                badge(`${tpl.items.length} ${t('inspection.itemCount')}`, 'neutral'),
              ]),
              el('p.view-sub', {}, tpl.regulation || ''),
            ]),
            el('div.view-head-actions', {}, [
              window.App.can('inspection.manage')
                ? button(t('inspection.newInspection'), {
                    variant: 'primary',
                    onclick: () => { window.location.hash = `#/inspections/new?template=${encodeURIComponent(tpl.code)}`; },
                  })
                : null,
            ]),
          ]),
          filterBar,
          card(null, list),
        ]));
      }

      paintList();
      redraw();
    },
  };

  window.Views.register('inspections', listView);
  window.Views.register('inspectionNew', newView);
  window.Views.register('inspection', detailView);
  window.Views.register('checklists', checklistLibrary);
  window.Views.register('checklist', checklistView);
})();
