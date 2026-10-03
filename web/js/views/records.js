/* View: quality records - list, create and the step-by-step controlled record.
 *
 * The record detail screen is where the compliance kernel becomes visible to a
 * worker: steps are gated by role, some steps demand an electronic signature,
 * and every field edit demands a reason. The UI never invents its own rules -
 * it reads the process definition and the server enforces the same gates.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, statusBadge, criticalityBadge, button, field, input, textarea, select } = U;

  function processDef(code) {
    return ((window.App.boot && window.App.boot.processTypes) || []).find((p) => p.code === code);
  }

  function processName(code) {
    const def = processDef(code);
    if (!def) return code;
    return getLocale() === 'en' && def.nameEn ? def.nameEn : `${def.name} / ${def.nameEn || code}`;
  }

  function processOptions() {
    const defs = (window.App.boot && window.App.boot.processTypes) || [];
    const groups = {};
    for (const d of defs) {
      const cat = d.category || 'other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(d);
    }
    return defs.map((d) => ({
      value: d.code,
      label: `${getLocale() === 'en' && d.nameEn ? d.nameEn : d.name}${d.gxpAreas && d.gxpAreas.length ? ` \u00b7 ${d.gxpAreas.join('/')}` : ''}`,
    }));
  }

  // ============================================================== list =======

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      clear(container);
      container.appendChild(U.spinner());

      const filters = {
        processCode: query.processCode || '',
        status: query.status || '',
        criticality: query.criticality || '',
        search: query.search || '',
        open: query.open === '1' ? '1' : '',
        overdue: query.overdue === '1' ? '1' : '',
        gxpArea: query.gxpArea || '',
      };

      const data = await window.Api.get('/api/records', { ...filters, limit: 100 });
      clear(container);

      const bar = el('div.filter-bar', {}, [
        searchBox(filters.search, (v) => setQuery({ search: v || null })),
        select('processCode', filters.processCode, processOptions(), {
          placeholder: `— ${t('records.processType')} —`,
          onchange: (ev) => setQuery({ processCode: ev.target.value || null }),
        }),
        select('status', filters.status, [
          'draft', 'reported', 'in_assessment', 'qa_review', 'capa_defined', 'closed', 'cancelled', 'rejected',
        ], {
          placeholder: `— ${t('common.status')} —`,
          onchange: (ev) => setQuery({ status: ev.target.value || null }),
        }),
        select('criticality', filters.criticality, ['minor', 'major', 'critical'], {
          placeholder: `— ${t('common.criticality')} —`,
          onchange: (ev) => setQuery({ criticality: ev.target.value || null }),
        }),
        U.checkbox('open', filters.open === '1', t('records.openOnly'), {
          onchange: (ev) => setQuery({ open: ev.target.checked ? '1' : null }),
        }),
        U.checkbox('overdue', filters.overdue === '1', t('records.overdueOnly'), {
          onchange: (ev) => setQuery({ overdue: ev.target.checked ? '1' : null }),
        }),
        window.App.can('record.create')
          ? button(t('records.newRecord'), {
              variant: 'primary',
              onclick: () => { window.location.hash = '#/records/new'; },
            })
          : null,
      ]);

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('records.title')),
            el('p.view-sub', {}, t('records.subtitle')),
          ]),
        ]),
        bar,
        card(null, table([
          { key: 'recordKey', label: t('records.recordKey'), render: (r) => el('a.mono.strong', { href: `#/records/${r.id}` }, r.recordKey) },
          { key: 'processCode', label: t('records.processType'), render: (r) => processName(r.processCode) },
          { key: 'title', label: t('common.detail'), render: (r) => U.truncate(r.title, 70) },
          { key: 'criticality', label: t('common.criticality'), render: (r) => criticalityBadge(r.criticality) },
          { key: 'status', label: t('common.status'), render: (r) => statusBadge(r.status) },
          { key: 'currentStep', label: t('records.steps'), render: (r) => stepLabel(r.processCode, r.currentStep) },
          {
            key: 'dueDate',
            label: t('common.dueDate'),
            // The countdown is spelled out in words and the state is named, not
            // only coloured: this table is what gets pasted into a weekly
            // report and read aloud in a stand-up.
            render: (r) => {
              if (!r.dueDate) return el('span.muted', {}, '—');
              const left = r.daysToDue;
              const stopped = r.clockRunning === false;
              const label = stopped
                ? t('clock.notRunning')
                : (left === null || left === undefined
                  ? ''
                  : (left < 0 ? t('clock.daysOverdue', { n: Math.abs(left) })
                    : (left === 0 ? t('clock.dueToday') : t('clock.daysLeft', { n: left }))));
              const tone = stopped || (left !== null && left !== undefined && left <= 3)
                ? (left !== null && left !== undefined && left < 0 && !stopped ? 'overdue' : 'due-soon')
                : '';
              return el('span', {}, [
                el('span', { class: tone }, U.fmtDate(r.dueDate)),
                label ? el('span', { class: `small ${tone ? '' : 'muted'}` }, ` · ${label}`) : null,
              ]);
            },
          },
        ], data.rows, {
          emptyText: t('records.noRecords'),
          onRowClick: (r) => { window.location.hash = `#/records/${r.id}`; },
        }), { subtitle: `${data.total} ${t('common.items')}` }),
      ]));
    },
  };

  function stepLabel(processCode, stepCode) {
    if (!stepCode) return el('span.muted', {}, '—');
    const def = processDef(processCode);
    const step = def && def.steps ? def.steps.find((s) => s.code === stepCode) : null;
    if (!step) return el('span.mono.small', {}, stepCode);
    return getLocale() === 'en' && step.nameEn ? step.nameEn : step.name;
  }

  function searchBox(value, onCommit) {
    let timer = null;
    const node = input('search', value, {
      placeholder: t('common.search'),
      oninput: (ev) => {
        clearTimeout(timer);
        timer = setTimeout(() => onCommit(ev.target.value.trim()), 350);
      },
    });
    return node;
  }

  function setQuery(patch) {
    const route = window.Views.resolveRoute(window.location.hash);
    const query = { ...(route ? route.query : {}), ...patch };
    const base = (window.location.hash.split('?')[0]) || '#/records';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  // ============================================================ create =======

  const newView = {
    async render(container, params) {
      clear(container);
      const preselect = (params.query && params.query.processCode) || '';
      const defs = (window.App.boot && window.App.boot.processTypes) || [];
      if (!defs.length) {
        container.appendChild(el('div.empty', {}, 'No process types are loaded. Check the seed/workflows directory.'));
        return;
      }

      let current = preselect ? processDef(preselect) : null;
      const body = el('div');

      const paint = () => {
        clear(body);
        if (!current) {
          body.appendChild(el('div.process-picker', {}, defs.map((d) => el('button.process-tile', {
            type: 'button',
            onclick: () => { current = d; paint(); },
          }, [
            el('div.tile-head', {}, [
              el('span.tile-name', {}, getLocale() === 'en' && d.nameEn ? d.nameEn : d.name),
              el('span.tile-code.mono', {}, d.code),
            ]),
            el('div.tile-areas', {}, (d.gxpAreas || []).map((a) => badge(a, 'info'))),
            el('div.tile-desc', {}, getLocale() === 'en' && d.descriptionEn ? d.descriptionEn : (d.description || '')),
            el('div.tile-meta', {}, [
              el('span', {}, `${d.stepCount} ${t('records.steps')}`),
              el('span', {}, `${t('records.slaDays')}: ${d.slaDays || '—'}${t('common.days')}`),
              d.requiresRootCause ? badge(bilingual('需根本原因', 'Root cause'), 'warn') : null,
              d.requiresEffectivenessCheck ? badge(bilingual('需有效性检查', 'Effectiveness'), 'warn') : null,
            ]),
          ]))));
          return;
        }

        const coreFields = [
          { key: 'title', label: bilingual('标题', 'Title'), type: 'text', required: true },
          { key: 'summary', label: bilingual('描述', 'Description'), type: 'textarea', required: true },
          { key: 'site', label: bilingual('场所', 'Site'), type: 'text' },
          { key: 'department', label: bilingual('部门', 'Department'), type: 'text' },
          { key: 'batchNumber', label: bilingual('批号 / 研究编号', 'Batch / Study no.'), type: 'text' },
          { key: 'product', label: bilingual('产品 / 物料', 'Product / Material'), type: 'text' },
          { key: 'occurredAt', label: bilingual('发生时间', 'Occurred at'), type: 'datetime' },
          { key: 'dueDate', label: bilingual('期限', 'Due date'), type: 'date' },
        ];
        // Definition-declared fields that are not already covered above.
        const covered = new Set(coreFields.map((f) => f.key));
        const extra = (current.fields || []).filter((f) => !covered.has(f.key) && !['criticality'].includes(f.key));

        const formState = { criticality: current.criticalityLevels && current.criticalityLevels.includes('major') ? 'major' : (current.criticalityLevels || ['major'])[0] };
        const coreForm = U.buildForm(coreFields, {});
        const extraForm = extra.length ? U.buildForm(extra, {}) : null;

        body.appendChild(el('div.create-form', {}, [
          el('div.create-head', {}, [
            el('div', {}, [
              el('h2', {}, processName(current.code)),
              el('p.view-sub', {}, getLocale() === 'en' && current.descriptionEn ? current.descriptionEn : (current.description || '')),
            ]),
            button(bilingual('更换流程类型', 'Change type'), { variant: 'ghost', onclick: () => { current = null; paint(); } }),
          ]),
          (current.regulationRefs && current.regulationRefs.length)
            ? el('details.reg-refs', {}, [
                el('summary', {}, t('documents.regulationRefs')),
                el('ul', {}, current.regulationRefs.map((r) => el('li', {}, r))),
              ])
            : null,
          el('div.form-grid', {}, [
            field(t('common.criticality'), select('criticality', formState.criticality,
              current.criticalityLevels || ['minor', 'major', 'critical'], {
                placeholder: false, required: true,
                onchange: (ev) => { formState.criticality = ev.target.value; },
              }), { required: true }),
          ]),
          coreForm.node,
          extraForm ? el('div.form-section', {}, [
            el('h3.section-mini', {}, bilingual('流程专项字段', 'Process-specific fields')),
            extraForm.node,
          ]) : null,
          el('div.create-actions', {}, [
            button(t('common.cancel'), { variant: 'ghost', onclick: () => { window.location.hash = '#/records'; } }),
            button(t('records.newRecord'), {
              variant: 'primary',
              onclick: async () => {
                const missing = coreForm.missing().concat(extraForm ? extraForm.missing() : []);
                if (missing.length) {
                  U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                  return;
                }
                const payload = {
                  processCode: current.code,
                  criticality: formState.criticality,
                  gxpAreas: current.gxpAreas,
                  ...coreForm.values(),
                  ...(extraForm ? extraForm.values() : {}),
                  data: extraForm ? extraForm.values() : {},
                };
                try {
                  const created = await window.Api.post('/api/records', payload);
                  U.toast(`${t('toast.created')}: ${created.recordKey}`, 'ok');
                  window.location.hash = `#/records/${created.id}`;
                } catch (err) {
                  U.toast(err.message, 'bad', 8000);
                }
              },
            }),
          ]),
        ]));
      };

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('records.newRecord')),
            el('p.view-sub', {}, t('records.createIntro')),
          ]),
        ]),
        body,
      ]));
      paint();
    },
  };

  // ============================================================ detail =======

  const detailView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());
      const rec = await window.Api.get(`/api/records/${params.id}`);
      clear(container);
      container.appendChild(paint(rec));
    },
  };

  function paint(rec) {
    const def = processDef(rec.processCode);
    const view = el('div.view');

    view.appendChild(el('div.view-head', {}, [
      el('div', {}, [
        el('div.breadcrumb', {}, el('a', { href: '#/records' }, t('records.title'))),
        el('h1.view-title', {}, [
          el('span.mono', {}, rec.recordKey),
          el('span.title-sep', {}, ' \u00b7 '),
          rec.title,
        ]),
        el('div.head-badges', {}, [
          statusBadge(rec.status),
          criticalityBadge(rec.criticality),
          ...(rec.gxpAreas || []).map((a) => badge(a, 'info')),
          rec.overdue ? badge(t('common.overdue'), 'bad') : null,
          rec.dueDate ? el('span.head-due', {}, `${t('common.dueDate')}: ${U.fmtDate(rec.dueDate)}`) : null,
        ]),
      ]),
      el('div.view-head-actions', {}, [
        button(t('common.refresh'), { variant: 'ghost', onclick: () => window.App.refresh() }),
        window.App.can('record.edit') && !isTerminal(rec)
          ? button(bilingual('编辑字段', 'Edit fields'), {
              variant: 'ghost',
              onclick: () => editFields(rec),
            })
          : null,
      ]),
    ]));

    view.appendChild(el('div.record-grid', {}, [
      el('div.record-main', {}, [
        // The reporting clock sits above the steps because it governs them: a
        // PV officer's first question on opening a case is "how long have I got",
        // and the answer has to come with the reason it is that number.
        U.clockPanel(rec.clock),
        stepsCard(rec, def),
        fieldsCard(rec, def),
      ]),
      el('div.record-side', {}, [
        historyCard(rec),
        signaturesCard(rec),
        linksCard(rec),
      ]),
    ]));

    return view;
  }

  function isTerminal(rec) {
    const terminal = (rec.definition && rec.definition.terminalStates) || ['closed', 'cancelled', 'rejected'];
    return terminal.includes(rec.status);
  }

  // ---------------------------------------------------------------- steps ----

  function stepsCard(rec, def) {
    const steps = rec.steps || [];
    const done = steps.filter((s) => s.status === 'completed').length;
    const next = steps.find((s) => s.status !== 'completed');

    return card(t('records.steps'), [
      el('div.progress-bar', {}, el('div.progress-fill', { style: { width: `${steps.length ? (done / steps.length) * 100 : 0}%` } })),
      el('ol.step-list', {}, steps.map((step, index) => {
        const isNext = next && next.id === step.id;
        const stepDef = def && def.steps ? def.steps.find((s) => s.code === step.code) : null;
        return el('li.step', {
          class: [
            step.status === 'completed' ? 'step-done' : '',
            isNext ? 'step-next' : '',
          ].filter(Boolean).join(' '),
        }, [
          el('div.step-marker', {}, step.status === 'completed' ? '\u2713' : String(index + 1)),
          el('div.step-body', {}, [
            el('div.step-title-row', {}, [
              el('span.step-title', {}, getLocale() === 'en' && step.nameEn ? step.nameEn : step.name),
              step.signatureMeaning ? badge(`${bilingual('需签名', 'Sign')}: ${U.meaningLabel(step.signatureMeaning)}`, 'warn') : null,
              step.assigneeRole ? el('span.step-role.mono', {}, shortRoles(step.assigneeRole)) : null,
            ]),
            step.completedAt
              ? el('div.step-meta', {}, `${t('common.status')}: ${U.humanise(step.status)} \u00b7 ${U.fmtDateTime(step.completedAt)}`)
              : el('div.step-meta.muted', {}, U.humanise(step.status)),
            step.comment ? el('div.step-comment', {}, step.comment) : null,
            step.outcome ? el('div.step-outcome', {}, `${t('common.status')}: ${U.humanise(step.outcome)}`) : null,
            isNext && window.App.can('record.edit') && !isTerminal(rec)
              ? el('div.step-action', {}, button(t('records.completeStep'), {
                  variant: 'primary',
                  onclick: () => completeStepFlow(rec, step, stepDef),
                }))
              : null,
          ]),
        ]);
      })),
      !next ? el('div.empty.ok', {}, t('records.allStepsComplete')) : null,
      isTerminal(rec) && window.App.can('record.close')
        ? el('div.terminal-note', {}, [
            el('span', {}, `${t('common.status')}: ${U.humanise(rec.status)} \u00b7 ${U.fmtDateTime(rec.closedAt)}`),
          ])
        : null,
    ], {
      subtitle: `${done}/${steps.length}`,
      actions: [
        window.App.can('record.close') && !isTerminal(rec)
          ? button(t('records.cancelRecord'), { variant: 'ghost', onclick: () => cancelRecord(rec) })
          : null,
        window.App.can('record.edit') && !isTerminal(rec)
          ? button(t('records.linkChild'), { variant: 'ghost', onclick: () => linkRecord(rec) })
          : null,
      ].filter(Boolean),
    });
  }

  function shortRoles(role) {
    if (Array.isArray(role)) return role.map((r) => r.split('_')[0]).join('|');
    return String(role).split('_')[0];
  }

  /**
   * Step completion flow. If the step declares a signature meaning, a signature
   * must be applied FIRST (the server rejects a step completion without one),
   * then the step form is submitted with the resulting signature id.
   */
  async function completeStepFlow(rec, step, stepDef) {
    const formFields = (stepDef && stepDef.form) || [];
    // System-computed fields are shown with the value the server already holds,
    // so the person completing the step sees the deadline the system will
    // enforce rather than being asked to re-type it (and get it wrong).
    const computedInitial = {};
    for (const f of formFields) {
      if (f.type !== 'computed') continue;
      if (f.key === 'reportDeadline' || f.key === 'deadline') computedInitial[f.key] = rec.dueDate;
      else if (f.key === 'day0') computedInitial[f.key] = rec.clock ? rec.clock.day0 : null;
    }
    const form = U.buildForm(formFields, computedInitial);

    const collect = () => new Promise((resolve) => {
      U.modal({
        title: getLocale() === 'en' && step.nameEn ? step.nameEn : step.name,
        width: '680px',
        render: (close) => [
          stepDef && stepDef.guidance
            ? el('div.guidance-note', {}, [
                el('strong', {}, bilingual('操作指引', 'Guidance')),
                el('p', {}, stepDef.guidance),
              ])
            : null,
          formFields.length ? form.node : el('p.muted', {}, t('common.noData')),
          step.signatureMeaning
            ? el('div.signature-notice', {}, [
                el('span.sig-icon', {}, '\u2712'),
                el('div', {}, [
                  el('div', {}, `${t('records.stepRequiresSignature')}: ${U.meaningLabel(step.signatureMeaning)}`),
                  el('div.small.muted', {}, '21 CFR Part 11.200(a)(1)(i)'),
                ]),
              ])
            : null,
          field(bilingual('备注', 'Comment'), (() => {
            const ta = textarea('stepComment', '', { rows: 3 });
            form.controls.__comment = ta;
            return ta;
          })()),
          el('div.modal-actions', {}, [
            button(t('common.cancel'), { variant: 'ghost', onclick: () => { close(); resolve(null); } }),
            button(t('records.completeStep'), {
              variant: 'primary',
              onclick: async () => {
                const missing = form.missing();
                if (missing.length) {
                  U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn');
                  return;
                }
                close();
                resolve({
                  formData: form.values(),
                  comment: form.controls.__comment.value.trim(),
                });
              },
            }),
          ]),
        ],
      });
    });

    const collected = await collect();
    if (!collected) return;

    let signatureId = null;
    if (step.signatureMeaning) {
      const sig = await U.signatureDialog({
        meaning: step.signatureMeaning,
        entityType: 'workflow_instances',
        entityId: rec.id,
        recordKey: rec.recordKey,
        recordVersion: rec.recordVersion,
        stepCode: step.code,
        secondFactorRequired: (window.App.boot.policy && window.App.boot.policy.signatureSecondFactor) !== false,
      });
      if (!sig) return;
      signatureId = sig.id;
      U.toast(`${t('signature.success')}: ${sig.manifest}`, 'ok');
    }

    try {
      const updated = await window.Api.post(`/api/records/${rec.id}/steps/complete`, {
        stepCode: step.code,
        formData: collected.formData,
        comment: collected.comment || null,
        signatureId,
      });
      U.toast(`${t('common.save')}: ${U.humanise(updated.status)}`, 'ok');
      window.App.refresh();
    } catch (err) {
      U.toast(err.message, 'bad', 9000);
    }
  }

  function cancelRecord(rec) {
    U.reasonDialog({
      title: t('records.cancelRecord'),
      message: bilingual(
        '作废记录会保留在审计追踪中，但该记录不再继续流转。必须说明理由（至少 10 个字）。',
        'Cancelling keeps the record in the audit trail but stops its workflow. A justification of at least 10 characters is required.'
      ),
      confirmLabel: t('records.cancelRecord'),
      minLength: 10,
    }).then(async (reason) => {
      if (!reason) return;
      try {
        await window.Api.post(`/api/records/${rec.id}/cancel`, { reason });
        U.toast(t('common.save'), 'ok');
        window.App.refresh();
      } catch (err) { U.toast(err.message, 'bad'); }
    });
  }

  function linkRecord(rec) {
    let childInput; let typeInput;
    U.modal({
      title: t('records.linkChild'),
      render: (close) => [
        el('p', {}, bilingual(
          '输入下游记录编号（如 CAPA-2026-0001），将其与本记录关联。常用于：偏差 → CAPA、CAPA → 变更控制。',
          'Enter the downstream record key (e.g. CAPA-2026-0001) to link it to this record: deviation to CAPA, CAPA to change control.'
        )),
        field(t('records.recordKey'), (childInput = input('child', '', { placeholder: 'CAPA-2026-0001', required: true })), { required: true }),
        field(bilingual('关联类型', 'Link type'), (typeInput = input('linkType', 'derived_from')), { help: 'derived_from / capa_for / caused_by' }),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.confirm'), {
            variant: 'primary',
            onclick: async () => {
              const key = childInput.value.trim();
              if (!key) return;
              try {
                const target = await window.Api.get(`/api/records/${encodeURIComponent(key)}`);
                await window.Api.post(`/api/records/${target.id}/link`, {
                  childId: target.id, linkType: typeInput.value.trim() || 'related',
                });
                close();
                U.toast(t('common.save'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad'); }
            },
          }),
        ]),
      ],
    });
  }

  // --------------------------------------------------------------- fields ----

  function fieldsCard(rec, def) {
    const rows = [
      ['recordKey', t('records.recordKey'), rec.recordKey],
      ['processCode', t('records.processType'), processName(rec.processCode)],
      ['title', bilingual('标题', 'Title'), rec.title],
      ['summary', bilingual('描述', 'Description'), rec.summary],
      ['site', bilingual('场所', 'Site'), rec.site],
      ['department', bilingual('部门', 'Department'), rec.department],
      ['batchNumber', bilingual('批号 / 研究编号', 'Batch / Study no.'), rec.batchNumber],
      ['product', bilingual('产品 / 物料', 'Product / Material'), rec.product],
      ['studyCode', bilingual('研究编号', 'Study code'), rec.studyCode],
      ['protocolNumber', bilingual('方案编号', 'Protocol no.'), rec.protocolNumber],
      ['subjectId', bilingual('受试者编号', 'Subject ID'), rec.subjectId],
      ['occurredAt', bilingual('发生时间', 'Occurred at'), rec.occurredAt ? U.fmtDateTime(rec.occurredAt) : null],
      ['detectedAt', bilingual('发现时间', 'Detected at'), rec.detectedAt ? U.fmtDateTime(rec.detectedAt) : null],
      ['immediateAction', t('records.immediateAction'), rec.immediateAction],
      ['impactAssessment', t('records.impact'), rec.impactAssessment],
      ['rootCause', t('records.rootCause'), rec.rootCause],
      ['rootCauseMethod', bilingual('分析方法', 'Root cause method'), rec.rootCauseMethod],
      ['effectivenessCheck', t('records.effectiveness'), rec.effectivenessCheck],
      ['effectivenessResult', bilingual('有效性结论', 'Effectiveness result'), rec.effectivenessResult],
      ['recordVersion', bilingual('记录版本', 'Record version'), rec.recordVersion],
    ].filter((r) => r[2] !== null && r[2] !== undefined && r[2] !== '');

    // Definition-specific data captured in the JSON blob.
    const dataRows = Object.entries(rec.data || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
      .map(([k, v]) => [k, U.humanise(k), String(v)]);

    return card(t('records.fields'), [
      el('dl.field-list', {}, [...rows, ...dataRows].map(([, label, value]) =>
        el('div.field-row', {}, [
          el('dt', {}, label),
          el('dd', {}, String(value)),
        ]))),
    ], {
      subtitle: `${t('common.updatedAt')}: ${U.fmtDateTime(rec.updatedAt)}`,
      actions: window.App.can('record.edit') && !isTerminal(rec)
        ? [button(t('common.edit'), { variant: 'ghost', onclick: () => editFields(rec) })]
        : null,
    });
  }

  function editFields(rec) {
    const editable = [
      { key: 'title', label: bilingual('标题', 'Title'), type: 'text' },
      { key: 'summary', label: bilingual('描述', 'Description'), type: 'textarea' },
      { key: 'criticality', label: t('common.criticality'), type: 'select', options: ['minor', 'major', 'critical'] },
      { key: 'dueDate', label: t('common.dueDate'), type: 'date' },
      { key: 'site', label: bilingual('场所', 'Site'), type: 'text' },
      { key: 'batchNumber', label: bilingual('批号', 'Batch no.'), type: 'text' },
      { key: 'product', label: bilingual('产品', 'Product'), type: 'text' },
      { key: 'immediateAction', label: t('records.immediateAction'), type: 'textarea' },
      { key: 'impactAssessment', label: t('records.impact'), type: 'textarea' },
      { key: 'rootCause', label: t('records.rootCause'), type: 'textarea' },
      { key: 'rootCauseMethod', label: bilingual('分析方法', 'Root cause method'), type: 'select',
        options: ['5 Whys', 'Ishikawa / Fishbone', 'Fault Tree Analysis', 'FMEA', 'Is-Is Not', 'Human Error Assessment', 'Trend analysis'] },
      { key: 'effectivenessCheck', label: t('records.effectiveness'), type: 'textarea' },
      { key: 'effectivenessResult', label: bilingual('有效性结论', 'Effectiveness result'), type: 'select',
        options: ['effective', 'partially_effective', 'not_effective'] },
    ];
    const initial = {};
    for (const f of editable) initial[f.key] = rec[f.key];
    const form = U.buildForm(editable, initial);

    U.modal({
      title: t('common.edit'),
      width: '720px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '每次字段修改都必须填写理由，理由会与变更前后的值一同写入审计追踪。',
          'Every field change requires a stated reason; the reason and both the before and after values are written to the audit trail.'
        )),
        form.node,
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const values = form.values();
              const changed = {};
              for (const [k, v] of Object.entries(values)) {
                const before = rec[k] === undefined ? null : rec[k];
                if (String(before === null ? '' : before) !== String(v === null ? '' : v)) changed[k] = v;
              }
              if (!Object.keys(changed).length) {
                U.toast(t('common.noData'), 'info');
                return;
              }
              close();
              const reason = await U.reasonDialog({
                title: t('common.edit'),
                message: `${Object.keys(changed).length} ${t('common.items')}: ${Object.keys(changed).join(', ')}`,
              });
              if (!reason) return;
              try {
                await window.Api.patch(`/api/records/${rec.id}`, { ...changed, reason });
                U.toast(t('toast.saved'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  // -------------------------------------------------------- side panels ------

  function historyCard(rec) {
    const history = (rec.history || []).slice().reverse();
    return card(t('records.history'), [
      history.length
        ? el('ul.timeline', {}, history.map((h) => el('li.tl-item', {}, [
            el('div.tl-dot'),
            el('div.tl-body', {}, [
              el('div.tl-head', {}, [
                el('span.tl-action', {}, U.humanise(h.action)),
                h.stepCode ? el('span.tl-step.mono', {}, h.stepCode) : null,
              ]),
              el('div.tl-meta', {}, `${h.actor || 'system'} \u00b7 ${U.fmtDateTime(h.at)}`),
              h.fromStatus !== h.toStatus
                ? el('div.tl-transition', {}, `${U.humanise(h.fromStatus)} \u2192 ${U.humanise(h.toStatus)}`)
                : null,
              h.comment ? el('div.tl-comment', {}, h.comment) : null,
              h.signatureId ? el('div.tl-sig', {}, `\u2712 ${t('records.signatures')} #${h.signatureId}`) : null,
            ]),
          ])))
        : el('div.empty', {}, t('common.noData')),
    ]);
  }

  function signaturesCard(rec) {
    const sigs = rec.signatures || [];
    return card(t('records.signatures'), [
      sigs.length
        ? el('ul.signature-list', {}, sigs.map((s) => el('li.sig-item', { class: s.valid ? '' : 'sig-invalid' }, [
            el('div.sig-manifest', {}, s.manifest),
            el('div.sig-detail', {}, [
              el('span.sig-meaning', {}, s.meaning),
              el('span.sig-reason', {}, s.reason || ''),
            ]),
            !s.valid ? badge(bilingual('已失效', 'Invalidated'), 'bad') : null,
          ])))
        : el('div.empty', {}, t('common.noData')),
    ], {
      subtitle: `${sigs.length} ${t('common.items')}`,
    });
  }

  function linksCard(rec) {
    const children = rec.children || [];
    const parent = rec.parent;
    if (!children.length && !parent) return el('div');
    return card(t('records.linkedRecords'), [
      parent
        ? el('div.link-row', {}, [
            badge(bilingual('上游', 'Parent'), 'info'),
            el('a.mono', { href: `#/records/${parent.id}` }, parent.record_key),
            el('span.muted', {}, U.truncate(parent.title, 60)),
          ])
        : null,
      ...children.map((c) => el('div.link-row', {}, [
        badge(c.link_type || 'related', 'neutral'),
        el('a.mono', { href: `#/records/${c.id}` }, c.record_key),
        el('span.muted', {}, U.truncate(c.title, 60)),
        statusBadge(c.status),
      ])),
    ]);
  }

  window.Views.register('records', listView);
  window.Views.register('recordNew', newView);
  window.Views.register('record', detailView);
  window.RecordHelpers = { processName, processDef, processOptions, stepLabel };
})();
