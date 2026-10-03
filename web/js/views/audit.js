/* View: audit trail viewer.
 *
 * This screen is the system's own evidence that its controls work. It offers
 * three things an inspector actually asks for:
 *   1. a filtered, exportable listing of every action;
 *   2. an on-demand integrity verification of the hash chain;
 *   3. reconstruction of any historical version of a record from the trail
 *      alone, which demonstrates that changes never obscure prior information.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, button, field, input, select, textarea } = U;

  const SEVERITY_TONES = { info: 'neutral', warning: 'warn', critical: 'bad' };

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      clear(container);

      const filters = {
        search: query.search || '',
        action: query.action || '',
        entityType: query.entityType || '',
        severity: query.severity || '',
        from: query.from || '',
        to: query.to || '',
      };
      const limit = Number(query.limit) || 100;

      const data = await window.Api.get('/api/audit', filters);
      clear(container);

      const actions = ['create', 'update', 'delete', 'sign', 'step_complete', 'release', 'close',
        'login_success', 'login_failure', 'view', 'export', 'policy_change', 'access_denied',
        'training_completion', 'assess', 'escalate', 'password_change', 'cancel', 'link'];

      let searchTimer = null;
      const bar = el('div.filter-bar', {}, [
        input('search', filters.search, {
          placeholder: t('audit.search'),
          oninput: (ev) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => setQuery({ search: ev.target.value.trim() || null }), 350);
          },
        }),
        select('action', filters.action, actions, {
          placeholder: `— ${t('audit.action')} —`,
          onchange: (ev) => setQuery({ action: ev.target.value || null }),
        }),
        select('severity', filters.severity, ['info', 'warning', 'critical'], {
          placeholder: `— ${t('audit.severity')} —`,
          onchange: (ev) => setQuery({ severity: ev.target.value || null }),
        }),
        field(t('common.createdAt'), input('from', filters.from, {
          type: 'date', onchange: (ev) => setQuery({ from: ev.target.value || null }),
        })),
        field('—', input('to', filters.to, {
          type: 'date', onchange: (ev) => setQuery({ to: ev.target.value || null }),
        })),
        select('limit', String(limit), ['50', '100', '250', '500'], {
          placeholder: false,
          onchange: (ev) => setQuery({ limit: ev.target.value }),
        }),
      ]);

      const view = el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('audit.title')),
            el('p.view-sub', {}, t('audit.subtitle')),
          ]),
          el('div.view-head-actions', {}, [
            button(t('audit.verify'), { variant: 'primary', onclick: () => verifyChain() }),
            window.App.can('audit.export')
              ? button(t('audit.exportCsv'), {
                  variant: 'ghost',
                  onclick: async () => {
                    try {
                      const name = await window.Api.download('/api/audit/export?format=csv'
                        + (filters.search ? `&search=${encodeURIComponent(filters.search)}` : ''));
                      U.toast(`${t('common.export')}: ${name}`, 'ok');
                    } catch (err) { U.toast(err.message, 'bad'); }
                  },
                })
              : null,
            window.App.can('audit.verify')
              ? button(t('audit.seal'), {
                  variant: 'ghost',
                  onclick: async () => {
                    const label = await U.reasonDialog({
                      title: t('audit.seal'),
                      message: bilingual(
                        '生成封印会记录当前审计追踪的末尾哈希，用于日后证明此时间点之后未发生未授权修改。理由将记入审计追踪。',
                        'A seal records the current head hash so you can later prove nothing changed after this point. The reason is written to the audit trail.'
                      ),
                      confirmLabel: t('audit.seal'),
                    });
                    if (!label) return;
                    try {
                      const seal = await window.Api.post('/api/audit/seal', { label });
                      U.toast(`${t('audit.sealed')}: seq ${seal.lastSeq}`, 'ok', 6000);
                    } catch (err) { U.toast(err.message, 'bad'); }
                  },
                })
              : null,
            window.App.can('audit.view')
              ? button(t('audit.reconstruct'), { variant: 'ghost', onclick: () => reconstructDialog() })
              : null,
          ]),
        ]),
        bar,
        summaryStrip(data),
        card(null, auditTable(data.rows), { subtitle: `${data.total} ${t('common.items')} · ${data.rows.length} shown` }),
        el('p.card-foot-note', {}, t('audit.explainer')),
      ]);

      container.appendChild(view);

      // Show the pager only when there is more than one page.
      if (data.total > limit) {
        const pages = Math.ceil(data.total / limit);
        const current = Math.floor((data.offset || 0) / limit) + 1;
        view.insertBefore(el('div.pager', {}, [
          button('←', {
            variant: 'ghost', disabled: current <= 1,
            onclick: () => setQuery({ offset: String(Math.max(0, (current - 2) * limit)) }),
          }),
          el('span', {}, `${current} / ${pages}`),
          button('→', {
            variant: 'ghost', disabled: current >= pages,
            onclick: () => setQuery({ offset: String(current * limit) }),
          }),
        ]), view.lastChild);
      }
    },
  };

  function summaryStrip(data) {
    const rows = data.rows || [];
    const critical = rows.filter((r) => r.severity === 'critical').length;
    const signed = rows.filter((r) => r.signature_id).length;
    const actors = new Set(rows.map((r) => r.actor_username)).size;
    return el('div.stat-strip', {}, [
      stat(bilingual('匹配条目', 'Matching entries'), data.total),
      stat(bilingual('本页签名操作', 'Signed actions (page)'), signed, { tone: signed ? 'ok' : null }),
      stat(bilingual('本页严重操作', 'Critical actions (page)'), critical, { tone: critical ? 'warn' : 'ok' }),
      stat(bilingual('涉及操作人', 'Distinct actors (page)'), actors),
    ]);
  }

  function auditTable(rows) {
    return table([
      { key: 'seq', label: t('audit.seq'), render: (r) => el('span.mono.small', {}, String(r.seq)) },
      { key: 'at', label: t('audit.time'), render: (r) => el('span.small', {}, U.fmtDateTime(r.at)) },
      {
        key: 'actor',
        label: t('audit.actor'),
        render: (r) => el('div', {}, [
          el('div', {}, r.actor_name || r.actor_username || 'system'),
          el('div.small.muted.mono', {}, r.actor_username || ''),
        ]),
      },
      {
        key: 'action',
        label: t('audit.action'),
        render: (r) => el('span.audit-action', {}, [
          badge(U.humanise(r.action), r.severity === 'critical' ? 'bad' : 'neutral'),
          r.signature_id ? el('span.sig-mark', { title: t('records.signatures') }, '\u2712') : null,
        ]),
      },
      {
        key: 'entity',
        label: t('audit.entity'),
        render: (r) => el('div', {}, [
          el('div.mono.small', {}, r.entity_type || ''),
          r.entity_id ? el('div.small.muted', {}, `#${r.entity_id}`) : null,
        ]),
      },
      {
        key: 'recordKey',
        label: t('audit.recordKey'),
        render: (r) => (r.record_key
          ? el('a.mono.small', { href: recordLink(r) }, r.record_key)
          : el('span.muted', {}, '—')),
      },
      { key: 'reason', label: t('common.reason'), render: (r) => el('span.small', {}, U.truncate(r.reason || '', 90)) },
      {
        key: 'changes',
        label: bilingual('变更', 'Changes'),
        render: (r) => ((r.old_value || r.new_value)
          ? button(bilingual('查看', 'View'), { variant: 'ghost', onclick: () => diffDialog(r) })
          : el('span.muted', {}, '—')),
      },
      {
        key: 'chain',
        label: t('audit.hashChain'),
        render: (r) => el('span.mono.tiny', { title: `prev ${r.prev_hash}\nthis ${r.chain_hash}` },
          String(r.chain_hash || '').slice(0, 10)),
      },
    ], rows, { emptyText: t('common.noData') });
  }

  /** Map an audit entity back to its screen where one exists. */
  function recordLink(r) {
    if (r.entity_type === 'documents' && r.entity_id) return `#/documents/${r.entity_id}`;
    if (r.entity_type === 'workflow_instances' && r.entity_id) return `#/records/${r.entity_id}`;
    if (r.entity_type === 'inspections' && r.entity_id) return `#/inspections/${r.entity_id}`;
    if (r.entity_type === 'equipment' && r.entity_id) return `#/equipment/${r.entity_id}`;
    if (r.entity_type === 'training_records' && r.entity_id) return '#/training';
    return `#/audit?search=${encodeURIComponent(r.record_key || r.entity_id || '')}`;
  }

  function diffDialog(row) {
    U.modal({
      title: `${t('audit.action')}: ${U.humanise(row.action)}`,
      width: '760px',
      render: (close) => [
        el('dl.field-list', {}, [
          el('div.field-row', {}, [el('dt', {}, t('audit.seq')), el('dd.mono', {}, String(row.seq))]),
          el('div.field-row', {}, [el('dt', {}, t('audit.time')), el('dd', {}, U.fmtDateTime(row.at))]),
          el('div.field-row', {}, [el('dt', {}, t('audit.actor')), el('dd', {}, `${row.actor_name || ''} (${row.actor_username || 'system'}) · ${row.actor_role || ''}`)]),
          el('div.field-row', {}, [el('dt', {}, t('audit.entity')), el('dd.mono', {}, `${row.entity_type}#${row.entity_id || ''}`)]),
          el('div.field-row', {}, [el('dt', {}, t('audit.recordKey')), el('dd.mono', {}, row.record_key || '—')]),
          row.record_version ? el('div.field-row', {}, [el('dt', {}, bilingual('记录版本', 'Record version')), el('dd.mono', {}, String(row.record_version))]) : null,
          el('div.field-row', {}, [el('dt', {}, t('common.reason')), el('dd', {}, row.reason || '—')]),
          row.ip ? el('div.field-row', {}, [el('dt', {}, 'IP'), el('dd.mono', {}, row.ip)]) : null,
          row.signature_id ? el('div.field-row', {}, [el('dt', {}, t('records.signatures')), el('dd.mono', {}, `#${row.signature_id}`)]) : null,
          el('div.field-row', {}, [el('dt', {}, t('audit.hashChain')), el('dd', {}, el('div.mono.tiny', {}, [
            el('div', {}, `prev: ${row.prev_hash}`),
            el('div', {}, `this: ${row.chain_hash}`),
          ]))]),
        ]),
        el('div.diff-grid', {}, [
          el('div.diff-col', {}, [el('h4', {}, t('audit.oldValue')), U.renderJson(row.old_value, 2000)]),
          el('div.diff-col', {}, [el('h4', {}, t('audit.newValue')), U.renderJson(row.new_value, 2000)]),
        ]),
        el('div.modal-actions', {}, [button(t('common.close'), { variant: 'ghost', onclick: close })]),
      ],
    });
  }

  async function verifyChain() {
    U.toast(U.t('common.loading'), 'info', 1200);
    try {
      const result = await window.Api.get('/api/audit/verify');
      U.modal({
        title: t('audit.verify'),
        width: '640px',
        render: (close) => [
          el(`div.chain-result.${result.ok ? 'chain-good' : 'chain-broken'}`, {}, [
            el('div.cr-icon', {}, result.ok ? '\u2713' : '\u26a0'),
            el('div', {}, [
              el('div.cr-title', {}, result.ok ? t('audit.verifyOk') : t('audit.verifyFail')),
              el('div.cr-detail', {}, result.ok
                ? `${result.checked} ${t('common.items')} · ${t('audit.chainEntries')}: ${result.entries}`
                : `seq ${result.brokenAt}: ${result.reason}`),
            ]),
          ]),
          result.lastEntry ? el('dl.field-list', {}, [
            el('div.field-row', {}, [el('dt', {}, bilingual('末尾序号', 'Last sequence')), el('dd.mono', {}, String(result.lastEntry.seq))]),
            el('div.field-row', {}, [el('dt', {}, bilingual('末尾时间', 'Last entry at')), el('dd', {}, U.fmtDateTime(result.lastEntry.at))]),
            el('div.field-row', {}, [el('dt', {}, bilingual('末尾哈希', 'Head hash')), el('dd.mono.tiny', {}, result.lastEntry.chain_hash)]),
          ]) : null,
          el('p.card-foot-note', {}, t('audit.explainer')),
          el('div.modal-actions', {}, [button(t('common.close'), { variant: 'ghost', onclick: close })]),
        ],
      });
      if (!result.ok) U.toast(t('toast.chainBroken'), 'bad', 0);
    } catch (err) {
      U.toast(err.message, 'bad');
    }
  }

  function reconstructDialog() {
    let keyInput; let versionInput;
    const resultArea = el('div.reconstruct-result');

    U.modal({
      title: t('audit.reconstruct'),
      width: '760px',
      render: (close) => [
        el('p.modal-intro', {}, t('audit.reconstructHint')),
        el('div.form-grid', {}, [
          field(t('audit.recordKey'), (keyInput = input('key', '', {
            placeholder: 'DEV-2026-0001 / doc:SOP-QA-001 / users:1', required: true,
          })), { required: true }),
          field(bilingual('到版本号为止', 'Up to version'), (versionInput = input('version', '', {
            type: 'number', placeholder: bilingual('留空表示最新', 'Leave empty for latest'),
          }))),
        ]),
        button(bilingual('重建', 'Reconstruct'), {
          variant: 'primary',
          onclick: async () => {
            const key = keyInput.value.trim();
            if (!key) return;
            try {
              const params = {};
              if (versionInput.value) params.version = versionInput.value;
              const data = await window.Api.get(`/api/audit/reconstruct/${encodeURIComponent(key)}`, params);
              clear(resultArea);
              resultArea.appendChild(el('h4', {}, t('audit.reconstructed')));
              resultArea.appendChild(U.renderJson(data.state, 4000));
            } catch (err) {
              clear(resultArea);
              resultArea.appendChild(el('div.error-box', {}, err.message));
            }
          },
        }),
        resultArea,
        el('div.modal-actions', {}, [button(t('common.close'), { variant: 'ghost', onclick: close })]),
      ],
    });
  }

  function setQuery(patch) {
    const route = window.Views.resolveRoute(window.location.hash);
    const query = { ...(route ? route.query : {}), ...patch };
    const base = (window.location.hash.split('?')[0]) || '#/audit';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  window.Views.register('audit', listView);
})();
