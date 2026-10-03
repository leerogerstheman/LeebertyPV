/* View: document control - master list, version lifecycle and acknowledgement. */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, statusBadge, button, field, input, textarea, select } = U;

  const STATUS_FLOW = {
    draft: ['in_review'],
    in_review: ['approved', 'draft'],
    approved: ['effective', 'draft'],
    effective: ['superseded', 'obsolete'],
  };

  function statusLabel(s) {
    const map = {
      draft: bilingual('草稿', 'Draft'),
      in_review: bilingual('审核中', 'In review'),
      approved: bilingual('已批准', 'Approved'),
      effective: bilingual('已生效', 'Effective'),
      superseded: bilingual('已被替代', 'Superseded'),
      obsolete: bilingual('已作废', 'Obsolete'),
      retired: bilingual('已退役', 'Retired'),
    };
    return map[s] || U.humanise(s);
  }

  // ============================================================== list =======

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      clear(container);
      container.appendChild(U.spinner());

      const filters = {
        status: query.status || '',
        docType: query.docType || '',
        gxpArea: query.gxpArea || '',
        search: query.search || '',
        reviewOverdue: query.reviewOverdue === '1' ? '1' : '',
      };

      const [data, report] = await Promise.all([
        window.Api.get('/api/documents', { ...filters, limit: 200 }),
        window.Api.get('/api/reports/document-review').catch(() => null),
      ]);
      clear(container);

      const docTypes = (window.App.boot.documentTypes || []).map((d) => ({
        value: d.code,
        label: `${getLocale() === 'en' ? d.label : d.labelZh} (${d.code})`,
      }));

      let searchTimer = null;
      const bar = el('div.filter-bar', {}, [
        input('search', filters.search, {
          placeholder: t('common.search'),
          oninput: (ev) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => setQuery({ search: ev.target.value.trim() || null }), 350);
          },
        }),
        select('docType', filters.docType, docTypes, {
          placeholder: `— ${t('documents.docType')} —`,
          onchange: (ev) => setQuery({ docType: ev.target.value || null }),
        }),
        select('status', filters.status, Object.keys(STATUS_FLOW).concat(['superseded', 'obsolete', 'retired']), {
          placeholder: `— ${t('common.status')} —`,
          onchange: (ev) => setQuery({ status: ev.target.value || null }),
        }),
        U.checkbox('reviewOverdue', filters.reviewOverdue === '1', t('documents.reviewOverdue'), {
          onchange: (ev) => setQuery({ reviewOverdue: ev.target.checked ? '1' : null }),
        }),
        window.App.can('doc.create')
          ? button(t('documents.newDocument'), { variant: 'primary', onclick: () => newDocumentDialog() })
          : null,
      ]);

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('documents.title')),
            el('p.view-sub', {}, t('documents.subtitle')),
          ]),
        ]),
        report ? reviewSummary(report) : null,
        bar,
        card(null, table([
          { key: 'docNumber', label: t('documents.docNumber'), render: (r) => el('a.mono.strong', { href: `#/documents/${r.id}` }, r.docNumber) },
          { key: 'title', label: t('common.detail'), render: (r) => el('div', {}, [
              el('div', {}, U.truncate(r.title, 80)),
              r.titleEn ? el('div.small.muted', {}, r.titleEn) : null,
            ]) },
          { key: 'docType', label: t('documents.docType'), render: (r) => badge(getLocale() === 'en' ? r.docTypeLabel : (r.docTypeLabelZh || r.docTypeLabel), 'neutral') },
          { key: 'gxpAreas', label: 'PV', render: (r) => el('span.gxp-chips', {}, (r.gxpAreas || []).map((a) => badge(a, 'info'))) },
          { key: 'currentVersion', label: t('documents.currentVersion'), render: (r) => el('span.mono', {}, `v${r.currentVersion || '—'}`) },
          { key: 'status', label: t('common.status'), render: (r) => statusBadge(r.status) },
          {
            key: 'nextReviewDate',
            label: t('documents.nextReview'),
            render: (r) => el('span', { class: r.reviewStatus === 'overdue' ? 'overdue' : (r.reviewStatus === 'due_soon' ? 'due-soon' : '') }, [
              U.fmtDate(r.nextReviewDate),
              r.reviewStatus && r.reviewStatus !== 'current' && r.reviewStatus !== 'not_scheduled'
                ? el('span.small', {}, ` (${U.humanise(r.reviewStatus)})`)
                : null,
            ]),
          },
        ], data.rows, {
          emptyText: t('common.noData'),
          onRowClick: (r) => { window.location.hash = `#/documents/${r.id}`; },
        }), { subtitle: `${data.total} ${t('common.items')}` }),
      ]));
    },
  };

  function reviewSummary(report) {
    const c = report.counts || {};
    return el('div.stat-strip', {}, [
      stat(t('documents.reviewOverdue'), c.overdue || 0, {
        tone: c.overdue ? 'bad' : 'ok',
        onclick: () => setQuery({ reviewOverdue: '1' }),
      }),
      stat(t('documents.reviewDueSoon'), c.dueSoon || 0, { tone: c.dueSoon ? 'warn' : 'ok' }),
      stat(bilingual('无责任人', 'No owner'), c.withoutOwner || 0, { tone: c.withoutOwner ? 'warn' : 'ok' }),
      stat(bilingual('滞留草稿 >90d', 'Stale drafts >90d'), c.staleDrafts || 0, { tone: c.staleDrafts ? 'warn' : 'ok' }),
    ]);
  }

  function setQuery(patch) {
    const route = window.Views.resolveRoute(window.location.hash);
    const query = { ...(route ? route.query : {}), ...patch };
    const base = (window.location.hash.split('?')[0]) || '#/documents';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  // ============================================================ create =======

  function newDocumentDialog() {
    const docTypes = (window.App.boot.documentTypes || []).map((d) => ({
      value: d.code,
      label: `${getLocale() === 'en' ? d.label : d.labelZh} (${d.code})`,
    }));
    const fields = [
      { key: 'docNumber', label: bilingual('文件编号', 'Document number'), type: 'text', required: true, help: '如 SOP-QA-001、SPEC-2026-014' },
      { key: 'title', label: bilingual('标题', 'Title'), type: 'text', required: true },
      { key: 'titleEn', label: bilingual('英文标题', 'English title'), type: 'text' },
      { key: 'docType', label: t('documents.docType'), type: 'select', required: true, options: docTypes.map((d) => d.value) },
      { key: 'version', label: bilingual('初始版本', 'Initial version'), type: 'text' },
      { key: 'department', label: bilingual('归口部门', 'Department'), type: 'text' },
      { key: 'site', label: bilingual('场所', 'Site'), type: 'text' },
      { key: 'processArea', label: bilingual('工艺区域', 'Process area'), type: 'text' },
      { key: 'reviewPeriodMonths', label: t('documents.reviewPeriod'), type: 'select', options: ['6', '12', '24', '36', '60'] },
      { key: 'retentionYears', label: bilingual('保存年限', 'Retention years'), type: 'number' },
      { key: 'summary', label: bilingual('摘要', 'Summary'), type: 'textarea' },
      { key: 'changeReason', label: t('documents.changeReason'), type: 'textarea', required: true, help: bilingual('新建文件的理由', 'Why this document is being created') },
    ];
    const form = U.buildForm(fields, { version: '1.0', reviewPeriodMonths: '24' });

    U.modal({
      title: t('documents.newDocument'),
      width: '760px',
      render: (close) => [
        form.node,
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) { U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn'); return; }
              const values = form.values();
              try {
                const created = await window.Api.post('/api/documents', {
                  ...values,
                  reviewPeriodMonths: values.reviewPeriodMonths ? Number(values.reviewPeriodMonths) : 24,
                  retentionYears: values.retentionYears ? Number(values.retentionYears) : null,
                });
                close();
                U.toast(`${t('toast.created')}: ${created.docNumber}`, 'ok');
                window.location.hash = `#/documents/${created.id}`;
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  // ============================================================ detail =======

  const detailView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());
      const doc = await window.Api.get(`/api/documents/${params.id}`);
      clear(container);
      container.appendChild(paint(doc));
    },
  };

  function paint(doc) {
    const view = el('div.view');
    const effectiveVersion = (doc.versions || []).find((v) => v.status === 'effective');

    view.appendChild(el('div.view-head', {}, [
      el('div', {}, [
        el('div.breadcrumb', {}, el('a', { href: '#/documents' }, t('documents.title'))),
        el('h1.view-title', {}, [el('span.mono', {}, doc.docNumber), el('span.title-sep', {}, ' \u00b7 '), doc.title]),
        doc.titleEn ? el('p.view-sub', {}, doc.titleEn) : null,
        el('div.head-badges', {}, [
          statusBadge(doc.status),
          badge(getLocale() === 'en' ? doc.docTypeLabel : (doc.docTypeLabelZh || doc.docTypeLabel), 'neutral'),
          ...(doc.gxpAreas || []).map((a) => badge(a, 'info')),
          doc.reviewStatus === 'overdue' ? badge(t('documents.reviewOverdue'), 'bad') : null,
          doc.reviewStatus === 'due_soon' ? badge(t('documents.reviewDueSoon'), 'warn') : null,
        ]),
      ]),
      el('div.view-head-actions', {}, [
        doc.status === 'effective' && window.App.can('doc.view')
          ? button(t('documents.acknowledge'), { variant: 'primary', onclick: () => acknowledge(doc) })
          : null,
        window.App.can('doc.edit') && !['retired', 'obsolete'].includes(doc.status)
          ? button(t('documents.addVersion'), { variant: 'ghost', onclick: () => newVersionDialog(doc) })
          : null,
        window.App.can('doc.edit')
          ? button(bilingual('编辑', 'Edit'), { variant: 'ghost', onclick: () => editDocument(doc) })
          : null,
      ]),
    ]));

    view.appendChild(el('div.record-grid', {}, [
      el('div.record-main', {}, [
        versionsCard(doc),
        metaCard(doc),
      ]),
      el('div.record-side', {}, [
        signaturesCard(doc),
        readCard(doc),
      ]),
    ]));

    return view;
  }

  function versionsCard(doc) {
    return card(t('documents.versions'), el('div.version-list', {}, (doc.versions || []).map((v) => el('div.version-item', {
      class: v.status === 'effective' ? 'version-effective' : '',
    }, [
      el('div.version-head', {}, [
        el('span.version-no.mono', {}, `v${v.version}`),
        statusBadge(v.status),
        v.effectiveDate ? el('span.version-date', {}, `${t('documents.effectiveDate')}: ${U.fmtDate(v.effectiveDate)}`) : null,
        v.reviewDueDate ? el('span.version-date', {}, `${t('documents.nextReview')}: ${U.fmtDate(v.reviewDueDate)}`) : null,
        v.trainingRequired ? badge(bilingual('需培训', 'Training required'), 'warn') : null,
      ]),
      v.changeSummary ? el('div.version-summary', {}, v.changeSummary) : null,
      v.changeReason ? el('div.version-reason', {}, `${t('documents.changeReason')}: ${v.changeReason}`) : null,
      el('div.version-actions', {}, transitionButtons(doc, v)),
    ]))), {
      subtitle: `${(doc.versions || []).length} ${t('common.items')}`,
    });
  }

  function transitionButtons(doc, version) {
    const allowed = STATUS_FLOW[version.status] || [];
    if (!allowed.length) return el('span.muted', {}, '—');
    return el('div.btn-row', {}, allowed.map((target) => {
      const requiresSig = target === 'approved' || target === 'effective';
      const permNeeded = requiresSig ? ['doc.approve', 'doc.review'] : ['doc.review'];
      if (!window.App.canAny(permNeeded)) return null;
      return button(`${t('documents.transition')} → ${statusLabel(target)}`, {
        variant: requiresSig ? 'primary' : 'ghost',
        onclick: () => transition(doc, version, target, requiresSig),
      });
    }).filter(Boolean));
  }

  async function transition(doc, version, target, requiresSignature) {
    let effectiveDateInput = null;
    if (target === 'effective') {
      const proceed = await new Promise((resolve) => {
        U.modal({
          title: `${t('documents.transition')}: v${version.version} → ${statusLabel(target)}`,
          width: '560px',
          render: (close) => [
            el('p', {}, bilingual(
              '文件生效后，该文件的上一个生效版本将自动变为「已被替代」。此操作需要电子签名。',
              'On release, the previously effective version becomes "superseded" automatically. This action requires an electronic signature.'
            )),
            field(t('documents.effectiveDate'), (effectiveDateInput = input('effectiveDate', new Date().toISOString().slice(0, 10), { type: 'date' }))),
            el('div.modal-actions', {}, [
              button(t('common.cancel'), { variant: 'ghost', onclick: () => { close(); resolve(false); } }),
              button(t('common.confirm'), { variant: 'primary', onclick: () => { close(); resolve(true); } }),
            ]),
          ],
        });
      });
      if (!proceed) return;
    }

    let signatureId = null;
    if (requiresSignature) {
      const meaning = target === 'approved' ? 'approved' : 'released';
      const sig = await U.signatureDialog({
        meaning,
        entityType: 'documents',
        entityId: doc.id,
        recordKey: `doc:${doc.docNumber}`,
        reason: `${t('documents.transition')} → ${statusLabel(target)} (v${version.version})`,
        secondFactorRequired: (window.App.boot.policy && window.App.boot.policy.signatureSecondFactor) !== false,
      });
      if (!sig) return;
      signatureId = sig.id;
    }

    try {
      await window.Api.post(`/api/documents/${doc.id}/versions/${encodeURIComponent(version.version)}/transition`, {
        targetStatus: target,
        signatureId,
        effectiveDate: effectiveDateInput ? effectiveDateInput.value : null,
        reason: `${t('documents.transition')}: ${statusLabel(version.status)} → ${statusLabel(target)}`,
      });
      U.toast(`${t('toast.saved')}: v${version.version} ${statusLabel(target)}`, 'ok');
      window.App.refresh();
    } catch (err) {
      U.toast(err.message, 'bad', 9000);
    }
  }

  function newVersionDialog(doc) {
    const fields = [
      { key: 'version', label: bilingual('新版本号', 'New version'), type: 'text', required: true, help: '如 2.0 或 1.1' },
      { key: 'changeSummary', label: t('documents.changeSummary'), type: 'textarea' },
      { key: 'changeReason', label: t('documents.changeReason'), type: 'textarea', required: true, help: bilingual('至少 5 个字', 'At least 5 characters') },
    ];
    const form = U.buildForm(fields, {});

    U.modal({
      title: t('documents.addVersion'),
      width: '640px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '新版本以草稿状态建立，必须经审核、批准后方可生效。变更理由是强制项（GVP Module I / ICH Q10）。',
          'A new version starts as a draft and must be reviewed and approved before it becomes effective. A change reason is mandatory (GVP Module I / ICH Q10).'
        )),
        form.node,
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) { U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn'); return; }
              try {
                await window.Api.post(`/api/documents/${doc.id}/versions`, form.values());
                close();
                U.toast(t('toast.created'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  function editDocument(doc) {
    const fields = [
      { key: 'title', label: bilingual('标题', 'Title'), type: 'text' },
      { key: 'titleEn', label: bilingual('英文标题', 'English title'), type: 'text' },
      { key: 'department', label: bilingual('归口部门', 'Department'), type: 'text' },
      { key: 'site', label: bilingual('场所', 'Site'), type: 'text' },
      { key: 'processArea', label: bilingual('工艺区域', 'Process area'), type: 'text' },
      { key: 'reviewPeriodMonths', label: t('documents.reviewPeriod'), type: 'select', options: ['6', '12', '24', '36', '60'] },
      { key: 'retentionYears', label: bilingual('保存年限', 'Retention years'), type: 'number' },
      { key: 'summary', label: bilingual('摘要', 'Summary'), type: 'textarea' },
    ];
    const initial = {};
    for (const f of fields) initial[f.key] = doc[f.key];
    const form = U.buildForm(fields, initial);

    U.modal({
      title: t('common.edit'),
      width: '720px',
      render: (close) => [
        form.node,
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const values = form.values();
              const changed = {};
              for (const [k, v] of Object.entries(values)) {
                if (String(doc[k] === null || doc[k] === undefined ? '' : doc[k]) !== String(v === null ? '' : v)) changed[k] = v;
              }
              if (!Object.keys(changed).length) { U.toast(t('common.noData'), 'info'); return; }
              close();
              const reason = await U.reasonDialog({
                title: t('common.edit'),
                message: Object.keys(changed).join(', '),
              });
              if (!reason) return;
              try {
                await window.Api.patch(`/api/documents/${doc.id}`, { ...changed, reason });
                U.toast(t('toast.saved'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  function metaCard(doc) {
    const rows = [
      [t('documents.docNumber'), doc.docNumber],
      [t('documents.docType'), getLocale() === 'en' ? doc.docTypeLabel : (doc.docTypeLabelZh || doc.docTypeLabel)],
      [t('documents.currentVersion'), doc.currentVersion ? `v${doc.currentVersion}` : null],
      [t('documents.effectiveDate'), doc.effectiveDate ? U.fmtDate(doc.effectiveDate) : null],
      [t('documents.nextReview'), doc.nextReviewDate ? `${U.fmtDate(doc.nextReviewDate)} (${U.humanise(doc.reviewStatus)})` : null],
      [t('documents.reviewPeriod'), doc.reviewPeriodMonths ? `${doc.reviewPeriodMonths}${t('documents.months')}` : null],
      [bilingual('保存年限', 'Retention'), doc.retentionYears ? `${doc.retentionYears}${t('common.days')}`.replace(t('common.days'), ' y') : null],
      [bilingual('归口部门', 'Department'), doc.department],
      [bilingual('场所', 'Site'), doc.site],
      [bilingual('工艺区域', 'Process area'), doc.processArea],
      [t('documents.owner'), doc.owner ? `${doc.owner.full_name} (${doc.owner.username})` : null],
      [bilingual('密级', 'Classification'), doc.classification],
      [bilingual('摘要', 'Summary'), doc.summary],
      [t('common.createdAt'), U.fmtDateTime(doc.createdAt)],
      [t('common.updatedAt'), U.fmtDateTime(doc.updatedAt)],
    ].filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== '');

    return card(bilingual('文件信息', 'Document information'), [
      el('dl.field-list', {}, rows.map(([label, value]) => el('div.field-row', {}, [
        el('dt', {}, label),
        el('dd', {}, String(value)),
      ]))),
      (doc.regulationRefs && doc.regulationRefs.length)
        ? el('details.reg-refs', {}, [
            el('summary', {}, t('documents.regulationRefs')),
            el('ul', {}, doc.regulationRefs.map((r) => el('li', {}, r))),
          ])
        : null,
    ]);
  }

  function signaturesCard(doc) {
    const sigs = doc.signatures || [];
    return card(t('records.signatures'), [
      sigs.length
        ? el('ul.signature-list', {}, sigs.map((s) => el('li.sig-item', { class: s.valid ? '' : 'sig-invalid' }, [
            el('div.sig-manifest', {}, s.manifest),
            el('div.sig-detail', {}, [
              el('span.sig-meaning', {}, s.meaning),
              el('span.sig-reason', {}, s.reason || ''),
            ]),
          ])))
        : el('div.empty', {}, t('common.noData')),
    ]);
  }

  function readCard(doc) {
    const reads = doc.readAcknowledgements || [];
    return card(t('documents.readRecords'), [
      reads.length
        ? table([
            { key: 'fullName', label: t('users.fullName') },
            { key: 'username', label: t('users.username'), render: (r) => el('span.mono.small', {}, r.username) },
            { key: 'department', label: t('common.department') },
            { key: 'readAt', label: t('common.createdAt'), render: (r) => U.fmtDateTime(r.readAt) },
            { key: 'acknowledged', label: t('documents.acknowledge'), render: (r) => (r.acknowledged ? badge('✓', 'ok') : badge('—', 'muted')) },
          ], reads)
        : el('div.empty', {}, t('common.noData')),
    ], { subtitle: `${reads.length} ${t('common.items')}` });
  }

  async function acknowledge(doc) {
    const sig = await U.signatureDialog({
      meaning: 'acknowledged',
      entityType: 'documents',
      entityId: doc.id,
      recordKey: `doc:${doc.docNumber}`,
      reason: `${t('documents.acknowledge')}: ${doc.docNumber} v${doc.currentVersion}`,
      secondFactorRequired: (window.App.boot.policy && window.App.boot.policy.signatureSecondFactor) !== false,
    });
    if (!sig) return;
    try {
      await window.Api.post(`/api/documents/${doc.id}/acknowledge`, { acknowledged: true, signatureId: sig.id });
      U.toast(t('documents.acknowledged'), 'ok');
      window.App.refresh();
    } catch (err) { U.toast(err.message, 'bad'); }
  }

  window.Views.register('documents', listView);
  window.Views.register('document', detailView);
})();
