/* View: dashboard - the "what do I do today / what is about to bite us" screen. */
(function () {
  'use strict';

  const { tr, t, bilingual } = window.I18N;
  const U = window.UI;
  const { el, card, stat, table, badge, statusBadge, criticalityBadge, button, clear } = U;

  function render(container, params) {
    const area = params.query && params.query.gxpArea ? params.query.gxpArea : null;
    container.replaceChildren(U.spinner());
    window.Api.get('/api/dashboard', area ? { gxpArea: area } : {})
      .then((data) => paint(container, data, area))
      .catch((err) => {
        clear(container);
        container.appendChild(U.errorBox(err, () => render(container, params)));
      });
  }

  function paint(container, data, area) {
    clear(container);

    if (data.alerts && data.alerts.counts && data.alerts.counts.critical > 0) {
      toastChainWarning(data);
    }

    const layout = el('div.dash');
    layout.appendChild(areaPicker(data, area));
    layout.appendChild(myWorkCard(data.myWork));
    layout.appendChild(readinessCard(data.readiness));
    layout.appendChild(statStrip(data));
    layout.appendChild(alertsCard(data.alerts));
    layout.appendChild(twoUp(
      recordsCard(data.workflow),
      coverageCard(data.coverage)
    ));
    layout.appendChild(twoUp(
      documentsCard(data.documents),
      trainingCard(data.training)
    ));
    layout.appendChild(twoUp(
      inspectionsCard(data.inspections),
      chainCard(data.readiness)
    ));

    container.appendChild(layout);
  }

  function toastChainWarning(data) {
    const broken = (data.alerts.items || []).find((a) => a.code === 'audit_chain_broken');
    if (broken) U.toast(t('toast.chainBroken'), 'bad', 0);
  }

  function areaPicker(data, current) {
    const areas = (window.App.boot && window.App.boot.gxpAreas) || [];
    if (data && data.coverage) {
      // nothing extra: coverage already lists areas
    }
    return el('div.area-bar', {}, [
      el('span.area-bar-label', {}, 'PV'),
      el('button.chip' + (!current ? '.active' : ''), {
        type: 'button',
        onclick: () => { window.location.hash = '#/dashboard'; },
      }, t('common.all')),
      ...areas.map((a) => el(`button.chip${current === a.code ? '.active' : ''}`, {
        type: 'button',
        style: current === a.code ? { borderColor: a.colour, color: a.colour } : null,
        title: a.fullName || a.name,
        onclick: () => { window.location.hash = `#/dashboard?gxpArea=${a.code}`; },
      }, a.code)),
    ]);
  }

  // ------------------------------------------------------------- my work ----

  function myWorkCard(myWork) {
    if (!myWork) return el('div');
    const items = myWork.items || [];
    return card(t('dash.myWork'), [
      items.length
        ? el('ul.worklist', {}, items.map((item) => el('li.work-item', {
            class: `work-${item.urgency}`,
          }, [
            el('a.work-main', {
              href: linkFor(item),
            }, [
              el('span.work-title', {}, item.title),
              el('span.work-sub', {}, item.subtitle || ''),
            ]),
            el('div.work-meta', {}, [
              item.requiresSignature ? badge(bilingual('需签名', 'Sign'), 'warn') : null,
              item.dueDate ? el('span.work-due', { class: item.urgency === 'overdue' ? 'overdue' : '' }, U.fmtDate(item.dueDate)) : null,
              urgencyDot(item.urgency),
            ]),
          ])))
        : el('div.empty', {}, t('dash.myWork.empty')),

      myWork.requiresSignature
        ? el('p.card-foot-note', {}, `${myWork.requiresSignature} ${t('dash.signaturePending')}`)
        : null,
    ], {
      subtitle: myWork.total ? `${myWork.total} ${t('common.items')}` : null,
    });
  }

  function urgencyDot(urgency) {
    const map = { overdue: 'dot-bad', high: 'dot-warn', normal: 'dot-ok', low: 'dot-muted' };
    return el(`span.dot.${map[urgency] || 'dot-muted'}`);
  }

  function linkFor(item) {
    if (!item.link) return '#/dashboard';
    const l = item.link;
    if (l.view === 'record') return `#/records/${l.id}`;
    if (l.view === 'document') return `#/documents/${l.id}`;
    if (l.view === 'equipment') return `#/equipment/${l.id}`;
    if (l.view === 'inspection-finding') return '#/inspections';
    if (l.view === 'my-training') return '#/training';
    return '#/dashboard';
  }

  // ------------------------------------------------------------ readiness ----

  function readinessCard(readiness) {
    if (!readiness) return el('div');
    const score = readiness.readinessScore;
    const tone = score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'bad';
    return card(t('dash.readiness'), [
      el('div.readiness-head', {}, [
        el(`div.score-ring.score-${tone}`, {}, [
          el('span.score-value', {}, String(score)),
          el('span.score-max', {}, '/100'),
        ]),
        el('div.readiness-summary', {}, [
          el('div.readiness-rating', {}, t(`rating.${readiness.rating}`)),
          el('p.readiness-note', {}, t('inspection.readinessIntro')),
          el('div.readiness-chips', {}, [
            readiness.openFindings.critical ? badge(`${readiness.openFindings.critical} ${bilingual('严重缺陷', 'critical')}`, 'bad') : null,
            readiness.openFindings.major ? badge(`${readiness.openFindings.major} ${bilingual('主要缺陷', 'major')}`, 'warn') : null,
            readiness.evidence.documentsPastReview ? badge(`${readiness.evidence.documentsPastReview} ${bilingual('文件审核超期', 'docs past review')}`, 'warn') : null,
            readiness.evidence.trainingExpired ? badge(`${readiness.evidence.trainingExpired} ${bilingual('培训过期', 'training expired')}`, 'warn') : null,
          ]),
        ]),
      ]),
      (readiness.blockers && readiness.blockers.length)
        ? el('div.blockers', {}, [
            el('h3.blockers-title', {}, t('dash.blockers')),
            ...readiness.blockers.map((b) => el(`div.blocker.blocker-${b.severity}`, {}, [
              el('div.blocker-head', {}, [
                badge(b.severity === 'critical' ? bilingual('严重', 'Critical') : b.severity === 'major' ? bilingual('主要', 'Major') : bilingual('次要', 'Minor'),
                  b.severity === 'critical' ? 'bad' : b.severity === 'major' ? 'warn' : 'muted'),
                el('span.blocker-msg', {}, b.message),
              ]),
              b.items && b.items.length
                ? el('ul.blocker-items', {}, b.items.slice(0, 4).map((i) => el('li', {}, i)))
                : null,
            ])),
          ])
        : el('div.empty.ok', {}, t('dash.noBlockers')),
    ], {
      subtitle: t('inspection.readinessIntro'),
      actions: [button(t('common.detail'), {
        variant: 'ghost',
        onclick: () => { window.location.hash = '#/compliance'; },
      })],
    });
  }

  // ---------------------------------------------------------------- stats ----

  function statStrip(data) {
    const wf = data.workflow || {};
    const openTotal = Object.values(wf.byStatus || {}).reduce((a, b) => a + b, 0)
      - (wf.byStatus.closed || 0) - (wf.byStatus.cancelled || 0) - (wf.byStatus.rejected || 0);
    const alerts = data.alerts || { counts: {} };
    return el('div.stat-strip', {}, [
      stat(bilingual('在办安全性记录', 'Open safety records'), openTotal, {
        onclick: () => { window.location.hash = '#/records?open=1'; },
        tone: openTotal > 0 ? 'info' : null,
      }),
      stat(bilingual('审计条目', 'Audit entries'), data.auditChain ? data.auditChain.checked : '—', {
        hint: data.auditChain && data.auditChain.ok ? t('dash.auditChainOk') : t('dash.auditChainBroken'),
        tone: data.auditChain && data.auditChain.ok ? 'ok' : 'bad',
        onclick: () => { window.location.hash = '#/audit'; },
      }),
      stat(bilingual('严重风险', 'Critical alerts'), alerts.counts.critical || 0, {
        tone: alerts.counts.critical ? 'bad' : 'ok',
      }),
      stat(bilingual('高风险', 'High alerts'), alerts.counts.high || 0, {
        tone: alerts.counts.high ? 'warn' : 'ok',
      }),
      stat(bilingual('需签名', 'Needs signature'), (data.myWork && data.myWork.requiresSignature) || 0, {
        tone: data.myWork && data.myWork.requiresSignature ? 'warn' : null,
      }),
      stat(bilingual('资质缺口', 'Qualification gaps'), (data.training && (data.training.expired + data.training.overdue)) || 0, {
        tone: data.training && (data.training.expired + data.training.overdue) ? 'warn' : 'ok',
        onclick: () => { window.location.hash = '#/training'; },
      }),
    ]);
  }

  // --------------------------------------------------------------- alerts ----

  function alertsCard(alerts) {
    if (!alerts) return el('div');
    const items = alerts.items || [];
    return card(t('dash.alerts'), [
      items.length
        ? el('div.alert-list', {}, items.map((a) => el(`div.alert.alert-${a.level}`, {}, [
            el('div.alert-head', {}, [
              el('span.alert-icon', {}, a.level === 'critical' ? '\u26a0' : a.level === 'high' ? '\u25b2' : '\u25cf'),
              el('div.alert-text', {}, [
                el('div.alert-title', {}, a.title),
                a.detail ? el('div.alert-detail', {}, a.detail) : null,
              ]),
            ]),
            a.items && a.items.length
              ? el('ul.alert-items', {}, a.items.slice(0, 5).map((i) => el('li', {},
                  i.link
                    ? el('a', { href: linkFor({ link: i.link }) }, i.label)
                    : el('span', {}, i.label),
                  i.meta ? el('span.alert-meta', {}, ` \u00b7 ${i.meta}`) : null)))
              : null,
          ])))
        : el('div.empty.ok', {}, t('dash.alerts.empty')),
    ], {
      subtitle: `${alerts.counts.critical || 0} critical \u00b7 ${alerts.counts.high || 0} high \u00b7 ${alerts.counts.normal || 0} normal`,
    });
  }

  // -------------------------------------------------------- records/trend ----

  function recordsCard(wf) {
    if (!wf) return el('div');
    const rows = wf.openByProcess || [];
    return card(t('dash.qualityRecords'), [
      rows.length
        ? table([
            { key: 'process_code', label: t('records.processType'), render: (r) => processLabel(r.process_code) },
            { key: 'n', label: t('common.total'), align: 'right' },
            { key: 'open', label: bilingual('在办', 'Open'), align: 'right' },
            { key: 'overdue', label: t('common.overdue'), align: 'right', render: (r) => (r.overdue ? badge(r.overdue, 'bad') : '0') },
          ], rows, {
            emptyText: t('records.noRecords'),
            onRowClick: (r) => { window.location.hash = `#/records?processCode=${r.process_code}`; },
          })
        : el('div.empty', {}, t('records.noRecords')),
      wf.ageing && wf.ageing.length ? ageTable(wf.ageing) : null,
    ], { subtitle: `${wf.rootCausePending || 0} ${bilingual('待定根本原因', 'awaiting root cause')} \u00b7 ${wf.effectivenessPending || 0} ${bilingual('待有效性检查', 'awaiting effectiveness')}` });
  }

  function ageTable(ageing) {
    return el('div.age-block', {}, [
      el('h3.section-mini', {}, t('dash.ageing')),
      table([
        { key: 'process_code', label: t('records.processType'), render: (r) => processLabel(r.process_code) },
        { key: 'd0_30', label: '\u226430d', align: 'right' },
        { key: 'd31_60', label: '31-60d', align: 'right' },
        { key: 'd61_90', label: '61-90d', align: 'right' },
        { key: 'd90_plus', label: '>90d', align: 'right', render: (r) => (r.d90_plus ? badge(r.d90_plus, 'warn') : '0') },
      ], ageing),
    ]);
  }

  function processLabel(code) {
    const def = (window.App.boot.processTypes || []).find((p) => p.code === code);
    if (!def) return code;
    return window.I18N.getLocale() === 'en' && def.nameEn ? `${def.nameEn}` : `${def.name} / ${def.nameEn || code}`;
  }

  function coverageCard(coverage) {
    const areas = coverage || [];
    return card(t('dash.coverage'), [
      el('div.coverage-grid', {}, areas.map((a) => el('div.coverage-item', {
        class: a.active ? 'coverage-active' : 'coverage-idle',
        title: a.fullName || '',
      }, [
        el('span.coverage-code', { style: { color: a.colour || 'inherit' } }, a.code),
        el('div.coverage-numbers', {}, [
          el('span', { title: t('documents.title') }, `${a.documents}\u00b7doc`),
          el('span', { title: t('records.title') }, `${a.records}\u00b7rec`),
          el('span', { title: t('training.title') }, `${a.curricula}\u00b7trn`),
          el('span', { title: t('inspection.templates') }, `${a.checklistTemplates}\u00b7chk`),
        ]),
      ]))),
      el('p.card-foot-note', {}, t('compliance.coverageHint')),
    ]);
  }

  // ---------------------------------------------------- documents/training ----

  function documentsCard(docs) {
    if (!docs) return el('div');
    return card(t('dash.documents'), [
      el('div.mini-stats', {}, [
        stat(bilingual('生效文件', 'Effective'), docs.effective, { onclick: () => { window.location.hash = '#/documents?status=effective'; } }),
        stat(bilingual('审核超期', 'Review overdue'), docs.reviewOverdue, { tone: docs.reviewOverdue ? 'warn' : 'ok' }),
        stat(bilingual('即将到期', 'Due soon'), docs.reviewDueSoon, { tone: docs.reviewDueSoon ? 'warn' : 'ok' }),
        stat(bilingual('滞留草稿', 'Stale drafts'), docs.staleDrafts, { tone: docs.staleDrafts ? 'warn' : 'ok' }),
      ]),
    ], { actions: [button(t('common.detail'), { variant: 'ghost', onclick: () => { window.location.hash = '#/documents'; } })] });
  }

  function trainingCard(training) {
    if (!training) return el('div');
    return card(t('dash.training'), [
      el('div.mini-stats', {}, [
        stat(bilingual('完成率', 'Completion'), training.completionRate === null ? '—' : `${training.completionRate}%`),
        stat(bilingual('已过期', 'Expired'), training.expired, { tone: training.expired ? 'bad' : 'ok' }),
        stat(bilingual('即将到期', 'Expiring soon'), training.expiringSoon, { tone: training.expiringSoon ? 'warn' : 'ok' }),
        stat(bilingual('超期未完成', 'Overdue'), training.overdue, { tone: training.overdue ? 'warn' : 'ok' }),
      ]),
    ], { actions: [button(t('common.detail'), { variant: 'ghost', onclick: () => { window.location.hash = '#/training'; } })] });
  }

  function inspectionsCard(insp) {
    if (!insp) return el('div');
    return card(t('dash.inspections'), [
      el('div.mini-stats', {}, [
        stat(bilingual('自查活动', 'Inspections'), insp.total),
        stat(bilingual('未关闭缺陷', 'Open findings'), insp.openFindings, { tone: insp.openFindings ? 'warn' : 'ok' }),
        stat(bilingual('严重缺陷', 'Critical'), insp.criticalOpen, { tone: insp.criticalOpen ? 'bad' : 'ok' }),
        stat(bilingual('平均就绪度', 'Avg readiness'), insp.averageReadinessScore === null ? '—' : insp.averageReadinessScore),
      ]),
    ], { actions: [button(t('common.detail'), { variant: 'ghost', onclick: () => { window.location.hash = '#/inspections'; } })] });
  }

  function chainCard(readiness) {
    const chain = readiness ? readiness.auditChain : null;
    return card(t('dash.auditChain'), [
      chain && chain.ok
        ? el('div.chain-ok', {}, [
            el('span.chain-big', {}, '\u2713'),
            el('div', {}, [
              el('div', {}, t('dash.auditChainOk')),
              el('div.mono.small', {}, `${chain.checked} entries`),
            ]),
          ])
        : el('div.chain-bad', {}, [
            el('span.chain-big', {}, '\u26a0'),
            el('div', {}, [
              el('div', {}, t('dash.auditChainBroken')),
              el('div.mono.small', {}, chain ? `seq ${chain.brokenAt}: ${chain.reason}` : 'unknown'),
            ]),
          ]),
      el('p.card-foot-note', {}, t('audit.explainer')),
    ], { actions: [button(t('audit.verify'), { variant: 'ghost', onclick: () => { window.location.hash = '#/audit'; } })] });
  }

  function twoUp(a, b) { return el('div.grid-2', {}, [a, b]); }

  window.Views.register('dashboard', { render });
})();
