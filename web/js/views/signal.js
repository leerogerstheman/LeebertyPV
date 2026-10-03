/* View: signal detection - disproportionality analysis and the PSUR line listing.
 *
 * WHAT THIS SCREEN IS FOR
 * -----------------------
 * GVP 第五十六条 requires the holder to select appropriate, scientific and
 * effective signal detection methods, and names data mining among them. This is
 * that method, run over the cases this instance actually holds.
 *
 * The screen is deliberately built around one honest message: a statistical
 * result is a CLUE. So the layout puts the flagged pairs first, states which
 * statistic fired and why, and routes each finding into signal assessment rather
 * than presenting a verdict. A screen that let someone conclude "confirmed
 * signal" from a spreadsheet would be a worse control than no screen.
 *
 * Two further things the screen refuses to hide:
 *   - pairs whose frequentist statistics are NOT COMPUTABLE (no comparator),
 *     shown as such rather than as an empty cell that reads "nothing here";
 *   - terms that failed MedDRA coding, because a line listing assembled from
 *     uncoded data under-reports, and the reader has to know by how much.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, button } = U;

  /** Format a statistic, or say plainly that it could not be computed. */
  function metric(value, digits) {
    if (value === null || value === undefined) return el('span.muted', { title: t('signal.notComputable') }, '—');
    if (typeof value !== 'number') return String(value);
    return value.toFixed(digits === undefined ? 2 : digits);
  }

  function ci(pair) {
    if (!pair || pair.lower === null || pair.upper === null) {
      return el('span.muted', { title: t('signal.notComputable') }, '—');
    }
    return `${pair.lower} – ${pair.upper}`;
  }

  function rowFor(r) {
    const flagged = r.flagged;
    return {
      key: `${r.product}-${r.pt}`,
      product: r.product,
      term: el('div', {}, [
        el('div.strong', {}, r.ptName),
        el('div.small.muted', {}, `${r.pt} · ${r.socName}`),
      ]),
      count: r.count,
      prr: el('span', {}, [
        metric(r.prr),
        el('span.small.muted', {}, ` ${ci(r.prrCi)}`),
      ]),
      ror: el('span', {}, [
        metric(r.ror, 1),
        el('span.small.muted', {}, ` ${ci(r.rorCi)}`),
      ]),
      ic: metric(r.ic025),
      eb: metric(r.eb05),
      status: flagged
        ? badge(t('signal.flagged'), 'bad')
        : (r.frequentistUnavailable
          ? badge(t('signal.bayesOnly'), 'muted')
          : badge(t('signal.notFlagged'), 'ok')),
      verdict: flagged
        ? el('div', {}, [
          el('div.small', {}, r.methods.join(' + ')),
          el('div.small.muted', {}, r.frequentistUnavailable ? r.unavailableNote : r.recommendation),
        ])
        : el('div.small.muted', {}, r.frequentistUnavailable ? r.unavailableNote : r.recommendation),
    };
  }

  const signalView = {
    async render(container, params) {
      clear(container);
      container.appendChild(U.spinner());
      const product = (params && params.product) || null;
      const data = await window.Api.get('/api/signal/analysis'
        + (product ? `?product=${encodeURIComponent(product)}` : ''));
      clear(container);

      const results = data.results || [];
      const flagged = results.filter((r) => r.flagged);
      const uncovered = data.uncoveredTerms || [];

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('signal.title')),
            el('p.view-sub', {}, t('signal.subtitle')),
          ]),
        ]),

        // Counts first. A reader deciding whether to trust this screen needs to
        // know the size of the database it is computed over, and how much of
        // that database was actually coded.
        el('div.stat-strip', {}, [
          stat(t('signal.casesAnalysed'), data.totalCases || 0),
          stat(t('signal.flaggedPairs'), data.flaggedPairs || 0, { tone: data.flaggedPairs ? 'warn' : 'ok' }),
          stat(t('signal.pairsTested'), data.testedPairs || 0),
          stat(t('signal.untriaged'), data.untriagedCases || 0,
            { tone: data.untriagedCases ? 'warn' : null }),
          stat(t('signal.uncodedTerms'), uncovered.length,
            { tone: uncovered.length ? 'warn' : 'ok' }),
        ]),

        // The method and its limits, stated before the numbers rather than in a
        // tooltip nobody opens.
        el('div.callout', {}, [
          el('div', {}, [
            el('strong', {}, t('signal.methodTitle')),
            el('p.small', {}, getLocale() === 'en' ? data.methodNoteEn : data.methodNote),
          ]),
          el('p.small.muted', { style: 'margin-top:6px' }, data.regulation),
        ]),

        uncovered.length
          ? el('div.clock-warn.clock-warn-bad', {}, [
            el('strong', {}, t('signal.uncodedTitle')),
            el('p.small', { style: 'margin-top:4px' }, t('signal.uncodedBody')),
            el('p.small.mono', { style: 'margin-top:6px' },
              uncovered.slice(0, 12).map((u) => `${u.term} (${u.recordKey})`).join('、')),
            uncovered.length > 12
              ? el('p.small.muted', { style: 'margin-top:4px' },
                t('signal.uncodedMore', { n: uncovered.length - 12 }))
              : null,
          ])
          : null,

        card(t('signal.resultsTitle'), table([
          { key: 'product', label: t('signal.product') },
          { key: 'term', label: t('signal.reaction') },
          { key: 'count', label: t('signal.cases') },
          { key: 'prr', label: 'PRR (95% CI)' },
          { key: 'ror', label: 'ROR (95% CI)' },
          { key: 'ic', label: 'IC025' },
          { key: 'eb', label: 'EB05' },
          { key: 'status', label: t('common.status') },
          { key: 'verdict', label: t('signal.interpretation') },
        ], results.map(rowFor), {
          emptyText: t('signal.noResults'),
          onRowClick: () => {},
        }), { subtitle: t('signal.resultsSub', {
          n: results.length,
          flagged: flagged.length,
          total: data.totalCases,
        }) }),

        el('div.view-head-actions', { style: 'margin-top:14px' }, [
          button(t('signal.lineListing'), {
            variant: 'ghost',
            onclick: async () => { window.location.hash = '#/signal/line-listing'; },
          }),
          button(t('common.refresh'), { variant: 'ghost', onclick: () => window.App.refresh() }),
        ]),

        el('p.small.muted', { style: 'margin-top:10px' }, t('signal.thresholds', {
          n: data.thresholds.minCount, prr: data.thresholds.minPrr, chi: data.thresholds.minChiSq,
        })),
      ]));
    },
  };

  // ------------------------------------------------------------ line listing --

  const lineListingView = {
    async render(container) {
      clear(container);
      container.appendChild(U.spinner());
      const data = await window.Api.get('/api/signal/line-listing');
      clear(container);

      const products = data.products || [];
      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('signal.lineListingTitle')),
            el('p.view-sub', {}, t('signal.lineListingSub')),
          ]),
        ]),

        el('div.stat-strip', {}, [
          stat(t('signal.casesAnalysed'), data.caseCount || 0),
          stat(t('signal.codedPairs'), data.codedPairCount || 0, { tone: 'ok' }),
          stat(t('signal.uncodedTerms'), data.uncoveredCount || 0,
            { tone: data.uncoveredCount ? 'warn' : 'ok' }),
          stat(t('signal.coverage'), `${Math.round((data.coverage || 0) * 100)}%`,
            { tone: data.coverage >= 0.95 ? 'ok' : 'warn' }),
        ]),

        // Grouped the way a periodic report groups it: product, then SOC, then
        // PT. A reader should be able to lift a section straight into a PSUR
        // chapter rather than rebuild it.
        ...products.map((p) => card(p.product, [
          el('p.small.muted', { style: 'margin-bottom:8px' },
            t('signal.lineListingTotal', { n: p.total })),
          ...p.socs.map((soc) => el('div.ll-soc', {}, [
            el('div.ll-soc-head', {}, [
              el('strong', {}, soc.socName),
              el('span.small.muted', {}, `${soc.soc} · ${soc.total}`),
            ]),
            el('div.ll-pts', {}, soc.pts.map((pt) => el('span.ll-pt', {}, [
              el('span', {}, pt.ptName),
              el('span.small.mono', {}, ` ${pt.count}`),
            ]))),
          ])),
        ])),

        el('div.view-head-actions', { style: 'margin-top:14px' }, [
          button(t('signal.backToAnalysis'), {
            variant: 'ghost',
            onclick: () => { window.location.hash = '#/signal'; },
          }),
        ]),
      ]));
    },
  };

  window.Views.register('signal', signalView);
  window.Views.register('signalLineListing', lineListingView);
})();
