/* View: inbox - "what do I need to submit, approve, verify or perform?".
 *
 * This replaces the dashboard as the landing screen. The dashboard answers a
 * managerial question ("how is the site doing?"); this answers the individual's
 * question, which is the one that actually gets work done.
 *
 * Design decisions worth keeping:
 *   - Items are grouped by what the user must DO (submit / approve / verify /
 *     perform / review), not by which module they came from, because that is how
 *     a person thinks about their own work.
 *   - An item that is overdue says so in words as well as colour, and states how
 *     many days late it is. "3 days overdue" is actionable; a red dot is not.
 *   - Items requiring an electronic signature are marked, because those take
 *     longer and cannot be delegated.
 *   - A footer explains what this role cannot see, so a user never wonders
 *     whether the system is broken when approvals do not appear for them.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, badge, button, select, spinner, errorBox } = U;

  const ACTION_TABS = [
    { code: '', labelZh: '全部', labelEn: 'All', icon: '\u25a6' },
    { code: 'approve', labelZh: '待批复', labelEn: 'To approve', icon: '\u2713' },
    { code: 'submit', labelZh: '待提交', labelEn: 'To submit', icon: '\u270e' },
    { code: 'verify', labelZh: '待核实', labelEn: 'To verify', icon: '\u2299' },
    { code: 'perform', labelZh: '待执行', labelEn: 'To perform', icon: '\u2699' },
    { code: 'review', labelZh: '待审核', labelEn: 'To review', icon: '\u2261' },
    { code: 'read', labelZh: '通知', labelEn: 'Notifications', icon: '\u25cf' },
  ];

  const ACTION_LABELS = {
    submit: () => bilingual('待提交', 'Submit'),
    approve: () => bilingual('待批复', 'Approve'),
    verify: () => bilingual('待核实', 'Verify'),
    perform: () => bilingual('待执行', 'Perform'),
    retrain: () => bilingual('待再培训', 'Retrain'),
    investigate: () => bilingual('待调查', 'Investigate'),
    review: () => bilingual('待审核', 'Review'),
    witness: () => bilingual('待见证', 'Witness'),
    acknowledge: () => bilingual('待阅知', 'Acknowledge'),
    read: () => bilingual('通知', 'Notification'),
    unknown: () => bilingual('未知动作', 'Unknown action'),
  };

  const ACTION_TONES = {
    submit: 'info', approve: 'warn', verify: 'warn', perform: 'neutral',
    retrain: 'warn', investigate: 'bad', review: 'info',
    witness: 'neutral', acknowledge: 'muted', read: 'muted', unknown: 'bad',
  };

  let currentFilter = { action: '', overdueOnly: false, gxpArea: '' };

  function render(container, params) {
    const query = (params && params.query) || {};
    currentFilter = {
      action: query.action || '',
      overdueOnly: query.overdue === '1',
      gxpArea: query.gxpArea || '',
    };
    load(container);
  }

  function load(container) {
    clear(container);
    container.appendChild(spinner());
    window.Api.get('/api/inbox', {
      action: currentFilter.action || undefined,
      overdue: currentFilter.overdueOnly ? '1' : undefined,
      gxpArea: currentFilter.gxpArea || undefined,
      limit: 150,
    })
      .then((data) => paint(container, data))
      .catch((err) => {
        clear(container);
        container.appendChild(errorBox(err, () => load(container)));
      });
  }

  function setFilter(patch) {
    currentFilter = { ...currentFilter, ...patch };
    const usp = new URLSearchParams();
    if (currentFilter.action) usp.set('action', currentFilter.action);
    if (currentFilter.overdueOnly) usp.set('overdue', '1');
    if (currentFilter.gxpArea) usp.set('gxpArea', currentFilter.gxpArea);
    const qs = usp.toString();
    window.location.hash = qs ? `#/inbox?${qs}` : '#/inbox';
    load(document.getElementById('main-content'));
  }

  function paint(container, data) {
    clear(container);
    const user = data.user || {};
    const counts = data.counts || {};

    const view = el('div.view');

    view.appendChild(el('div.view-head', {}, [
      el('div', {}, [
        el('h1.view-title', {}, bilingual('我的待办', 'My work')),
        el('p.view-sub', {}, bilingual(
          `${user.fullName || ''}（${user.roleLabelZh || user.role}）—— 以下是等待你提交、批复、核实或执行的条目，按后果轻重排序。`,
          `${user.fullName || ''} (${user.roleLabel || user.role}) - items waiting on you, ranked by consequence rather than by date.`
        )),
      ]),
      el('div.view-head-actions', {}, [
        data.counts.unread > 0
          ? button(bilingual('全部标记已读', 'Mark all read'), {
              variant: 'ghost',
              onclick: async () => {
                try {
                  await window.Api.post('/api/notifications/read-all', {});
                  U.toast(t('toast.saved'), 'ok');
                  load(container);
                } catch (err) { U.toast(err.message, 'bad'); }
              },
            })
          : null,
        button(t('common.refresh'), { variant: 'ghost', onclick: () => load(container) }),
      ]),
    ]));

    // ---- headline numbers -------------------------------------------------
    view.appendChild(el('div.stat-strip', {}, [
      stat(bilingual('待办总数', 'Total pending'), counts.total, {
        tone: counts.total ? 'info' : 'ok',
      }),
      stat(bilingual('已超期', 'Overdue'), counts.overdue, {
        tone: counts.overdue ? 'bad' : 'ok',
        onclick: () => setFilter({ overdueOnly: !currentFilter.overdueOnly }),
      }),
      stat(bilingual('待我批复', 'To approve'), counts.toApprove, {
        tone: counts.toApprove ? 'warn' : null,
        onclick: () => setFilter({ action: 'approve' }),
      }),
      stat(bilingual('待我提交', 'To submit'), counts.toSubmit, {
        onclick: () => setFilter({ action: 'submit' }),
      }),
      stat(bilingual('需电子签名', 'Needs signature'), counts.requiresSignature, {
        tone: counts.requiresSignature ? 'warn' : null,
        title: bilingual('这些条目完成时必须应用电子签名', 'These require an electronic signature to complete'),
      }),
      counts.oversight
        ? stat(bilingual('监督项', 'Oversight'), counts.oversight, {
            tone: 'warn',
            title: bilingual('由其他岗位负责但按你的权限可以介入的严重条目', 'Critical items owned by others that your role may intervene on'),
          })
        : null,
    ].filter(Boolean)));

    // ---- filters ----------------------------------------------------------
    view.appendChild(el('div.inbox-tabs', {}, ACTION_TABS.map((tab) => {
      const active = currentFilter.action === tab.code;
      const n = tab.code ? (data.byAction[tab.code] || 0) : counts.total;
      return el(`button.tab${active ? '.active' : ''}`, {
        type: 'button',
        onclick: () => setFilter({ action: tab.code }),
      }, [
        el('span.tab-icon', {}, tab.icon),
        el('span', {}, getLocale() === 'en' ? tab.labelEn : tab.labelZh),
        n ? el('span.tab-count', {}, String(n)) : null,
      ]);
    })));

    // ---- the list ---------------------------------------------------------
    const items = data.items || [];
    if (!items.length) {
      view.appendChild(card(null, el('div.empty.ok', {}, [
        el('div.empty-big', {}, '\u2713'),
        el('div', {}, currentFilter.action || currentFilter.overdueOnly
          ? bilingual('当前筛选下没有待办', 'Nothing pending under this filter')
          : bilingual('当前没有需要你处理的事项', 'Nothing is waiting on you')),
      ])));
    } else {
      view.appendChild(card(null, el('div.inbox-list', {}, items.map((item) => renderItem(item, container))), {
        subtitle: bilingual(
          `共 ${items.length} 条（按后果轻重排序，非按时间）`,
          `${items.length} item(s), ranked by consequence rather than by date`
        ),
      }));
    }

    view.appendChild(capabilityFooter(data));

    container.appendChild(view);
  }

  function renderItem(item, container) {
    const overdueText = item.overdue && item.daysToDue !== null
      ? bilingual(`已超期 ${Math.abs(item.daysToDue)} 天`, `${Math.abs(item.daysToDue)} day(s) overdue`)
      : null;
    const dueText = !item.overdue && item.daysToDue !== null && item.daysToDue !== undefined
      ? bilingual(`还剩 ${item.daysToDue} 天`, `${item.daysToDue} day(s) left`)
      : null;

    return el('div.inbox-item', {
      class: [
        item.overdue ? 'item-overdue' : '',
        item.criticality === 'critical' ? 'item-critical' : '',
        item.isOversight ? 'item-oversight' : '',
      ].filter(Boolean).join(' '),
    }, [
      el('div.item-action-col', {}, [
        badge(ACTION_LABELS[item.action] ? ACTION_LABELS[item.action]() : item.action,
          ACTION_TONES[item.action] || 'neutral'),
      ]),
      el('div.item-body', {}, [
        el('div.item-title-row', {}, [
          el('span.item-title', {}, item.title),
          item.requiresSignature
            ? badge(`\u2712 ${U.meaningLabel(item.signatureMeaning)}`, 'warn',
                { title: bilingual('完成此条目需要电子签名', 'Completing this item requires an electronic signature') })
            : null,
          item.criticality === 'critical' ? badge(bilingual('严重', 'Critical'), 'bad') : null,
          item.isOversight ? badge(bilingual('监督', 'Oversight'), 'muted',
            { title: bilingual('由其他岗位负责，按你的权限可介入', 'Owned by another role; your permissions allow intervention') }) : null,
        ]),
        item.recordKey
          ? el('div.item-meta', {}, [
              el('span.mono.small', {}, item.recordKey),
              item.recordTitle ? el('span.item-sep', {}, ' \u00b7 ') : null,
              item.recordTitle ? el('span.small', {}, U.truncate(item.recordTitle, 90)) : null,
            ])
          : null,
        item.description ? el('div.item-desc', {}, U.truncate(item.description, 220)) : null,
        el('div.item-tags', {}, [
          ...(item.gxpAreas || []).map((a) => badge(a, 'info')),
          item.batchNumber ? badge(`${bilingual('批号', 'Batch')} ${item.batchNumber}`, 'muted') : null,
          item.product ? badge(U.truncate(item.product, 28), 'muted') : null,
        ]),
      ]),
      el('div.item-due-col', {}, [
        item.dueDate ? el('div.item-due', { class: item.overdue ? 'overdue' : '' }, U.fmtDate(item.dueDate)) : null,
        overdueText ? el('div.item-due-note.overdue', {}, overdueText) : null,
        dueText ? el('div.item-due-note', {}, dueText) : null,
        el('div.item-link', {}, el('a.btn.btn-primary', { href: item.link }, actionVerb(item))),
      ]),
    ]);
  }

  /** The verb on the button should match what the user is about to do. */
  function actionVerb(item) {
    if (item.kind === 'notification') return bilingual('查看', 'View');
    if (item.requiresSignature) return bilingual('签署并完成', 'Sign & complete');
    if (item.action === 'approve') return bilingual('前往批复', 'Review & approve');
    if (item.action === 'investigate') return bilingual('处理超期', 'Handle overdue');
    if (item.action === 'verify') return bilingual('执行核实', 'Perform verification');
    if (item.action === 'retrain') return bilingual('安排再培训', 'Arrange retraining');
    if (item.action === 'review') return bilingual('执行审核', 'Perform review');
    if (item.action === 'perform') return bilingual('前往执行', 'Go and perform');
    return bilingual('前往处理', 'Open');
  }

  /**
   * Tell the user what their role cannot do. Without this, an operator seeing an
   * empty "to approve" tab cannot tell whether the system is broken or whether
   * approving simply is not their job.
   */
  function capabilityFooter(data) {
    const c = data.roleCapabilities || {};
    const cannot = [];
    if (!c.canApproveRecords) cannot.push(bilingual('批复安全性记录', 'approve safety records'));
    if (!c.canProcessCases) cannot.push(bilingual('处理个例报告', 'process ICSRs'));
    if (!c.canAssessCausality) cannot.push(bilingual('因果关系评价', 'assess causality'));
    if (!c.canManageDeviations) cannot.push(bilingual('管理偏差', 'manage deviations'));
    if (!c.canManageSignals) cannot.push(bilingual('信号管理', 'manage signals'));
    if (!c.canManagePSUR) cannot.push(bilingual('定期报告管理', 'manage PSUR'));
    if (!c.canManageRMP) cannot.push(bilingual('风险管理计划', 'manage RMP'));
    if (!c.canSubmitReports) cannot.push(bilingual('递交监管报告', 'submit reports'));
    if (!c.canManageComplaints) cannot.push(bilingual('处理投诉', 'manage complaints'));
    if (!c.canApproveDocuments) cannot.push(bilingual('批准文件', 'approve documents'));
    if (!c.canViewAuditTrail) cannot.push(bilingual('查阅审计追踪', 'view the audit trail'));
    if (!c.canManageUsers) cannot.push(bilingual('管理用户', 'manage users'));
    if (!c.canRunInspections) cannot.push(bilingual('执行自查', 'run self-inspections'));

    const can = [];
    if (c.canApproveRecords) can.push(bilingual('批复安全性记录', 'approve safety records'));
    if (c.canProcessCases) can.push(bilingual('处理个例报告', 'process ICSRs'));
    if (c.canAssessCausality) can.push(bilingual('因果关系评价', 'assess causality'));
    if (c.canManageDeviations) can.push(bilingual('管理偏差', 'manage deviations'));
    if (c.canApproveDocuments) can.push(bilingual('批准文件', 'approve documents'));
    if (c.canViewAuditTrail) can.push(bilingual('查阅审计追踪', 'view the audit trail'));
    if (c.canVerifyAuditChain) can.push(bilingual('校验审计链', 'verify the audit chain'));
    if (c.canRunInspections) can.push(bilingual('执行自查', 'run self-inspections'));
    if (c.canManageTraining) can.push(bilingual('管理培训', 'manage training'));
    if (c.canManageSignals) can.push(bilingual('信号管理', 'manage signals'));
    if (c.canManagePSUR) can.push(bilingual('定期报告管理', 'manage PSUR'));
    if (c.canManageRMP) can.push(bilingual('风险管理计划', 'manage RMP'));
    if (c.canSubmitReports) can.push(bilingual('递交监管报告', 'submit reports'));
    if (c.canManageComplaints) can.push(bilingual('处理投诉', 'manage complaints'));

    if (!cannot.length && !can.length) return el('div');

    return card(bilingual('你的权限范围', 'What your role can do'), [
      can.length
        ? el('div.cap-row', {}, [
            el('span.cap-label', {}, bilingual('可以', 'Allowed')),
            el('span.cap-items', {}, can.join('、')),
          ])
        : null,
      cannot.length
        ? el('div.cap-row.cap-row-cannot', {}, [
            el('span.cap-label', {}, bilingual('不可以', 'Not allowed')),
            el('span.cap-items', {}, cannot.join('、')),
          ])
        : null,
      el('p.card-foot-note', {}, bilingual(
        '权限在服务端强制校验，界面不会显示你没有权限执行的操作。如需变更权限，请联系 QA 负责人。',
        'Permissions are enforced server-side; the interface never offers an action you may not perform. Contact the QA manager to change a role.'
      )),
    ], { bodyClass: 'cap-body' });
  }

  window.Views.register('inbox', { render });
})();
