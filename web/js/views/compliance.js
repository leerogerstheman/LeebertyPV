/* View: compliance posture - the system auditing itself against Part 11 / Annex 11.
 *
 * Two panels: a clause-by-clause self-assessment of the platform's own controls
 * (useful as the starting evidence pack for a CSV review), and a coverage view
 * showing which GxP areas have real activity versus which are registered but
 * empty.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, button } = U;

  const STATUS_TONES = { met: 'ok', partial: 'warn', not_met: 'bad' };
  const STATUS_LABELS = {
    met: () => t('compliance.met'),
    partial: () => t('compliance.partial'),
    not_met: () => t('compliance.notMet'),
  };

  const cliView = {
    async render(container) {
      clear(container);
      container.appendChild(U.spinner());
      const data = await window.Api.get('/api/compliance/posture');
      clear(container);

      const checks = data.checks || [];
      const s = data.summary || {};

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('compliance.title')),
            el('p.view-sub', {}, t('compliance.subtitle')),
          ]),
        ]),

        el('div.stat-strip', {}, [
          stat(t('compliance.met'), s.met || 0, { tone: 'ok' }),
          stat(t('compliance.partial'), s.partial || 0, { tone: s.partial ? 'warn' : null }),
          stat(t('compliance.notMet'), s.notMet || 0, { tone: s.notMet ? 'bad' : 'ok' }),
          stat(bilingual('检查项总数', 'Total checks'), s.total || 0),
          stat(bilingual('符合率', 'Conformance'), s.total ? `${Math.round(((s.met || 0) / s.total) * 100)}%` : '—'),
        ]),

        card(t('compliance.checks'), el('div.compliance-list', {}, checks.map((c) => el('div.compliance-item', {
          class: `ci-${c.status}`,
        }, [
          el('div.ci-head', {}, [
            badge(STATUS_LABELS[c.status] ? STATUS_LABELS[c.status]() : c.status, STATUS_TONES[c.status] || 'neutral'),
            el('span.ci-clause.mono', {}, c.clause),
          ]),
          el('div.ci-req', {}, c.requirement),
          el('div.ci-evidence', {}, [
            el('span.ci-ev-label', {}, `${t('compliance.evidence')}: `),
            c.evidence,
          ]),
        ])))),

        coverageSection(),
      ]));
    },
  };

  function coverageSection() {
    const holder = el('div');
    window.Api.get('/api/compliance/coverage').then((data) => {
      const areas = data.areas || [];
      holder.replaceChildren(card(t('compliance.coverage'), [
        el('div.coverage-table', {}, table([
          {
            key: 'code',
            label: 'PV',
            render: (a) => el('span.coverage-code', { style: { color: a.colour || 'inherit' } }, a.code),
          },
          {
            key: 'name',
            label: t('common.detail'),
            render: (a) => el('div', {}, [
              el('div', {}, getLocale() === 'en' && a.nameEn ? a.nameEn : a.name),
              el('div.small.muted', {}, a.fullName || ''),
            ]),
          },
          {
            key: 'active',
            label: t('common.status'),
            render: (a) => (a.active
              ? badge(bilingual('已启用', 'In use'), 'ok')
              : badge(bilingual('无活动', 'No activity'), 'muted')),
          },
          { key: 'documents', label: t('documents.title'), align: 'right' },
          { key: 'records', label: t('records.title'), align: 'right' },
          { key: 'openRecords', label: bilingual('在办', 'Open'), align: 'right' },
          { key: 'curricula', label: t('training.curricula'), align: 'right' },
          { key: 'checklistTemplates', label: t('inspection.templates'), align: 'right' },
          { key: 'processTypes', label: t('records.processType'), align: 'right' },
        ], areas)),
        el('p.card-foot-note', {}, t('compliance.coverageHint')),
      ]));
    }).catch((err) => {
      holder.replaceChildren(U.errorBox(err));
    });
    return holder;
  }
  /**
   * A short runnable checklist for the validation file: these are the things a
   * CSV reviewer or an inspector will ask to be shown, in order.
   */
  const READINESS_CHECKS = [
    ['21 CFR Part 11.10(a)', () => bilingual('本系统的验证文档（URS/IQ/OQ/PQ）已完成并获批准', 'This system has approved validation documentation (URS/IQ/OQ/PQ)'), () => bilingual('使用「审计追踪」页面导出完整性校验结果作为证据，并将本页合规态势导出附于验证报告', 'Export the integrity verification from the Audit Trail screen and attach this compliance posture to the validation report')],
    ['21 CFR Part 11.10(i)', () => bilingual('所有使用本系统的用户已完成系统操作与数据完整性培训', 'All users have completed system and data integrity training'), () => bilingual('使用「培训与资质」创建课程并分配，留存考核记录', 'Create a curriculum in Training and assign it, retaining assessment records')],
    ['Annex 11 §12.1', () => bilingual('账号唯一、职责分离、无共用账号', 'Accounts are unique with separated duties and no shared logins'), () => bilingual('使用「用户与权限」核查账号列表与角色分配', 'Review the account list and role assignment in Users & Access')],
    ['Annex 11 §7.2', () => bilingual('备份与恢复经过实际演练并留有记录', 'Backup and restore have been rehearsed with records retained'), () => bilingual('运行 scripts/backup.js，并记录一次恢复演练的结果', 'Run scripts/backup.js and document the result of a restore rehearsal')],
    ['Annex 11 §9', () => bilingual('审计追踪可查阅、可导出、不可修改', 'The audit trail is reviewable, exportable and not modifiable'), () => bilingual('本系统以哈希链实现；运行 npm run verify-audit 或使用审计追踪页面的校验功能', 'Implemented as a hash chain; run npm run verify-audit or use the Audit Trail verification')],
    ['Annex 11 §4.4', () => bilingual('供应商评估已完成（本系统为零依赖，评估范围极小）', 'Supplier assessment is complete (this system has zero dependencies, so scope is minimal)'), () => bilingual('记录运行时版本（Node 版本见系统设置）作为环境基线', 'Record the runtime version (Node version, see Settings) as the environment baseline')],
    ['GAMP 5', () => bilingual('系统已按风险确定周期性回顾周期', 'A risk-based periodic review interval is defined'), () => bilingual('建议年度回顾，输入包括变更历史、事件、权限复核与合规态势', 'An annual review is recommended, covering change history, incidents, access review and compliance posture')],
  ];

  const readyView = {
    async render(container) {
      clear(container);
      const boot = window.App.boot || {};
      const chainOk = boot.auditChain && boot.auditChain.ok;

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, bilingual('验证与就绪清单', 'Validation & readiness pack')),
            el('p.view-sub', {}, bilingual(
              '把本系统纳入计算机化系统清单时需要准备的材料与对应操作。零依赖设计使供应商评估范围极小，这是本系统在验证上的先天优势。',
              'What to prepare when adding this system to your computerised system inventory. The zero-dependency design keeps supplier assessment minimal, which is a genuine validation advantage.'
            )),
          ]),
        ]),
        el('div.stat-strip', {}, [
          stat(bilingual('零第三方依赖', 'Third-party dependencies'), 0, { tone: 'ok', hint: bilingual('无需逐个做供应商评估', 'No per-package supplier assessment needed') }),
          stat(bilingual('运行环境', 'Runtime'), boot.app ? `Node ${''}` : '—', { hint: bilingual('见系统设置页', 'See Settings') }),
          stat(bilingual('审计追踪', 'Audit trail'), chainOk ? bilingual('完整', 'Intact') : bilingual('异常', 'Failed'), { tone: chainOk ? 'ok' : 'bad' }),
          stat(bilingual('数据存储', 'Data store'), 'SQLite', { hint: bilingual('单文件，便于备份与归档', 'Single file, easy to back up and archive') }),
        ]),
        card(bilingual('检查员会要求出示的内容', 'What an inspector will ask to see'), el('ol.ready-list', {}, READINESS_CHECKS.map(([clause, requirement, how]) => el('li.ready-item', {}, [
          el('div.ready-clause.mono', {}, clause),
          el('div.ready-req', {}, requirement()),
          el('div.ready-how', {}, [el('span.ready-how-label', {}, `${bilingual('如何满足', 'How')}: `), how()]),
        ])))),
        card(bilingual('关键技术控制', 'Key technical controls'), el('dl.field-list', {}, [
          ['Audit trail', bilingual('追加写入 + HMAC-SHA256 哈希链，密钥存于数据库之外；直接改库文件会在断点处暴露', 'Append-only with an HMAC-SHA256 hash chain; the key lives outside the database so editing the file shows up as a break')],
          ['E-signatures', bilingual('两个识别要素（密码 + 动态口令/一次性挑战码），签名含姓名、时间、含义与理由，并与记录永久关联', 'Two identification components (password plus TOTP or a single-use challenge), with printed name, time, meaning and reason linked permanently to the record')],
          ['Access control', bilingual(`${(boot.roles || []).length} 个角色、${Object.keys(boot.permissions || {}).length} 项权限，职责分离在服务端强制`, `${(boot.roles || []).length} roles and ${Object.keys(boot.permissions || {}).length} permissions, with separation of duties enforced server-side`)],
          ['Session control', bilingual(`空闲超时 ${boot.policy ? boot.policy.idleTimeoutMinutes : '—'} 分钟，会话上限 ${boot.policy ? boot.policy.sessionAbsoluteHours : '—'} 小时`, `Idle timeout ${boot.policy ? boot.policy.idleTimeoutMinutes : '—'} min, absolute limit ${boot.policy ? boot.policy.sessionAbsoluteHours : '—'} h`)],
          ['Reason for change', bilingual('所有安全性记录修改强制填写理由，记入审计追踪', 'Every safety record change requires a stated reason, recorded in the audit trail')],
          ['Record reconstruction', bilingual('任一记录的历史版本可从审计追踪单独重建，证明变更不掩盖先前信息', 'Any historical version can be rebuilt from the audit trail alone, proving changes never obscure prior information')],
        ].map(([k, v]) => el('div.field-row', {}, [el('dt', {}, k), el('dd', {}, v)])))),
      ]));
    },
  };

  window.Views.register('compliance', cliView);
  window.Views.register('readinessPack', readyView);
})();
