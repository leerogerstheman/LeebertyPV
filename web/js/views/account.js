/* View: account (self-service) and system settings.
 *
 * The account screen covers the two Part 11 obligations that fall on the user
 * rather than the administrator: keeping the password current, and enrolling a
 * second identification component for e-signatures.
 */
(function () {
  'use strict';

  const { tr, t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, button, field, input, textarea, select } = U;

  // ============================================================== account ====

  const accountView = {
    async render(container) {
      clear(container);
      container.appendChild(U.spinner());
      const me = await window.Api.get('/api/auth/me');
      const policy = (window.App.boot && window.App.boot.policy) || {};
      clear(container);

      const u = me.user;
      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, bilingual('我的账号', 'My account')),
            el('p.view-sub', {}, bilingual(
              '密码有效性与电子签名第二要素是 21 CFR Part 11.300(b) 与 11.200(a)(1)(i) 对个人使用者的直接要求。',
              'Password currency and a second signature component are direct obligations on the individual user under 21 CFR Part 11.300(b) and 11.200(a)(1)(i).'
            )),
          ]),
        ]),

        el('div.grid-2', {}, [
          card(bilingual('账号信息', 'Account'), el('dl.field-list', {}, [
            [t('users.username'), el('span.mono', {}, u.username)],
            [t('users.fullName'), u.fullName || '—'],
            [t('users.role'), `${u.roleLabel || u.role} (${u.role})`],
            [t('common.department'), u.department || '—'],
            [t('users.jobTitle'), u.jobTitle || '—'],
            [t('users.email'), u.email || '—'],
            [t('users.lastLogin'), u.lastLoginAt ? U.fmtDateTime(u.lastLoginAt) : '—'],
            [t('auth.changePassword'), u.passwordChangedAt ? U.fmtDateTime(u.passwordChangedAt) : '—'],
            [bilingual('培训状态', 'Training status'), badge(U.humanise(u.trainingStatus || 'unknown'),
              u.trainingStatus === 'current' ? 'ok' : (u.trainingStatus === 'not_required' ? 'muted' : 'warn'))],
            [bilingual('会话结束时间', 'Session expires'), me.session ? U.fmtDateTime(me.session.expiresAt) : '—'],
          ].map(([k, v]) => el('div.field-row', {}, [el('dt', {}, k), el('dd', {}, v)])))),

          el('div', {}, [
            card(bilingual('修改密码', 'Change password'), [
              passwordForm(policy, u),
              el('p.card-foot-note', {}, bilingual(
                `密码最长有效期 ${policy.passwordMaxAgeDays || 90} 天；修改后其他所有会话将立即失效。`,
                `Passwords expire after ${policy.passwordMaxAgeDays || 90} days; changing yours immediately ends all other sessions.`
              )),
            ]),
            card(bilingual('电子签名第二要素', 'Signature second component'), [
              el('div.totp-status', {}, [
                u.totpEnabled ? badge(bilingual('已绑定验证器', 'Authenticator enrolled'), 'ok') : badge(bilingual('未绑定', 'Not enrolled'), 'warn'),
              ]),
              el('p', {}, u.totpEnabled
                ? bilingual(
                    '已绑定验证器。签署时需输入密码 + 6 位动态口令。如更换设备，请重新绑定。',
                    'Enrolled. Signing requires your password plus a 6-digit code. Re-enrol if you change device.'
                  )
                : bilingual(
                    '未绑定验证器时，签署需使用系统签发的一次性挑战码，同样满足「两个识别要素」的要求，但绑定验证器更安全也更方便。',
                    'Without an authenticator, signing uses a single-use server challenge, which still satisfies the two-component requirement, but enrolling an authenticator is both safer and faster.'
                  )),
              u.totpEnabled ? null : button(t('auth.enrolTotp'), { variant: 'primary', onclick: () => enrolTotp() }),
              el('p.card-foot-note', {}, '21 CFR Part 11.200(a)(1)(i)'),
            ]),
          ]),
        ]),
      ]));
    },
  };

  function passwordForm(policy, u) {
    let currentInput; let newInput; let confirmInput;
    const errorNode = el('div.form-error');

    return el('div', {}, [
      field(t('auth.currentPassword'), (currentInput = input('current', '', { type: 'password', required: true })), { required: true }),
      field(t('auth.newPassword'), (newInput = input('new', '', { type: 'password', required: true })), {
        required: true,
        help: bilingual(
          `至少 ${policy.passwordMinLength || 10} 位，需包含大小写字母、数字、符号中的 ${policy.passwordRequireClasses || 3} 类；不得使用最近 ${policy.passwordHistoryDepth || 5} 次用过的密码`,
          `At least ${policy.passwordMinLength || 10} characters using ${policy.passwordRequireClasses || 3} of lowercase/uppercase/digit/symbol; the last ${policy.passwordHistoryDepth || 5} passwords cannot be reused`
        ),
      }),
      field(t('auth.confirmPassword'), (confirmInput = input('confirm', '', { type: 'password', required: true })), { required: true }),
      errorNode,
      button(t('auth.changePassword'), {
        variant: 'primary',
        onclick: async () => {
          clear(errorNode);
          if (newInput.value !== confirmInput.value) {
            U.toast(t('auth.passwordMismatch'), 'bad');
            return;
          }
          try {
            await window.Api.post('/api/auth/password', {
              currentPassword: currentInput.value,
              newPassword: newInput.value,
            });
            U.toast(t('auth.passwordChanged'), 'ok', 7000);
            window.App.refresh();
          } catch (err) {
            errorNode.appendChild(el('p', {}, err.message));
            U.toast(err.message, 'bad', 9000);
          }
        },
      }),
    ]);
  }

  function enrolTotp() {
    let secret = null;
    let codeInput;
    const qrArea = el('div.totp-area');

    U.modal({
      title: t('auth.enrolTotp'),
      width: '560px',
      render: (close) => [
        el('p', {}, bilingual(
          '在手机验证器应用中添加账户，然后输入应用显示的 6 位动态口令以完成绑定。',
          'Add the account to your authenticator app, then enter the 6-digit code it shows to finish enrolment.'
        )),
        qrArea,
        field('6-digit code', (codeInput = input('code', '', { maxlength: 6, placeholder: '000000', required: true })), { required: true }),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.confirm'), {
            variant: 'primary',
            onclick: async () => {
              if (!/^\d{6}$/.test(codeInput.value.trim())) { U.toast('000000', 'warn'); return; }
              try {
                await window.Api.post('/api/auth/totp/confirm', { code: codeInput.value.trim() });
                close();
                U.toast(t('auth.totpEnrolled'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 7000); }
            },
          }),
        ]),
      ],
    });

    // Step 1 happens after the modal is open so the secret is never shown twice.
    window.Api.post('/api/auth/totp/enrol', {}).then((data) => {
      secret = data.secret;
      clear(qrArea);
      qrArea.appendChild(el('div.totp-secret', {}, [
        el('div.totp-label', {}, bilingual('密钥（手动输入用）', 'Secret (for manual entry)')),
        el('div.totp-value.mono', {}, formatSecret(secret)),
        el('div.totp-uri', {}, [
          el('div.small.muted', {}, bilingual('或使用此链接', 'Or use this URI')),
          el('div.mono.tiny.break', {}, data.uri),
        ]),
      ]));
    }).catch((err) => {
      clear(qrArea);
      qrArea.appendChild(el('div.error-box', {}, err.message));
    });
  }

  /** Group a base32 secret in fours; it is far easier to type correctly. */
  function formatSecret(secret) {
    return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
  }

  // ============================================================= settings ====

  const settingsView = {
    async render(container) {
      clear(container);
      container.appendChild(U.spinner());
      const [info, settings] = await Promise.all([
        window.Api.get('/api/system/info').catch((e) => ({ error: e.message })),
        window.Api.get('/api/system/settings').catch((e) => ({ error: e.message })),
      ]);
      clear(container);

      const policy = (settings && settings.policy) || (window.App.boot && window.App.boot.policy) || {};

      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('settings.title')),
            el('p.view-sub', {}, t('settings.subtitle')),
          ]),
        ]),

        el('div.stat-strip', {}, info.error ? [] : [
          stat(bilingual('数据库大小', 'Database size'), U.fmtBytes(info.database && info.database.sizeBytes)),
          stat(bilingual('审计条目', 'Audit entries'), (info.counts && info.counts.auditEntries) || 0),
          stat(bilingual('电子签名', 'Signatures'), (info.counts && info.counts.signatures) || 0),
          stat(bilingual('运行时长', 'Uptime'), info.startedAt ? U.fmtRelative(info.startedAt) : '—'),
        ]),

        el('div.grid-2', {}, [
          card(t('settings.policy'), [policyForm(policy)], {
            subtitle: bilingual('修改安全策略需要填写理由并写入审计追踪', 'Changing the security policy requires a reason and is written to the audit trail'),
          }),
          el('div', {}, [
            card(t('settings.systemInfo'), info.error
              ? el('div.error-box', {}, info.error)
              : el('dl.field-list', {}, [
                  [bilingual('应用版本', 'App version'), `${info.app.name} v${info.app.version}`],
                  [bilingual('数据库模式版本', 'Schema version'), String(info.app.schemaVersion)],
                  [t('settings.node'), info.node],
                  [t('settings.platform'), info.platform],
                  [bilingual('主机名', 'Hostname'), info.hostname],
                  [t('settings.database'), el('span.mono.break', {}, info.database.file)],
                  [bilingual('数据目录', 'Data directory'), el('span.mono.break', {}, info.dataDir)],
                  [bilingual('审计链密钥文件', 'Audit chain key'), el('span.mono.break', {}, info.tokens && info.tokens.auditKeyFile)],
                  [bilingual('启动时间', 'Started at'), U.fmtDateTime(info.startedAt)],
                ].map(([k, v]) => el('div.field-row', {}, [el('dt', {}, k), el('dd', {}, v)])))),
            card(t('settings.counts'), info.error ? el('div.empty', {}, '—') : table([
              { key: 'label', label: '' },
              { key: 'value', label: '', align: 'right' },
            ], Object.entries(info.counts || {}).map(([label, value]) => ({ label: U.humanise(label), value: U.fmtNumber(value) })))),
            card(t('settings.features'), info.error ? el('div.empty', {}, '—') : el('dl.field-list', {},
              Object.entries(info.features || {}).map(([k, v]) => el('div.field-row', {}, [
                el('dt', {}, U.humanise(k)),
                el('dd', {}, v ? badge(bilingual('已启用', 'Enabled'), 'ok') : badge(bilingual('已关闭', 'Disabled'), 'muted')),
              ])))),
          ]),
        ]),
      ]));
    },
  };

  function policyForm(policy) {
    const defs = [
      { key: 'passwordMinLength', label: t('settings.passwordMinLength'), type: 'number', min: 8, max: 128 },
      { key: 'passwordMaxAgeDays', label: t('settings.passwordMaxAgeDays'), type: 'number', min: 0, max: 3650 },
      { key: 'passwordHistoryDepth', label: t('settings.passwordHistoryDepth'), type: 'number', min: 0, max: 50 },
      { key: 'passwordRequireClasses', label: bilingual('密码复杂度类别数', 'Password character classes'), type: 'number', min: 1, max: 4 },
      { key: 'maxFailedLogins', label: t('settings.maxFailedLogins'), type: 'number', min: 1, max: 100 },
      { key: 'lockoutMinutes', label: t('settings.lockoutMinutes'), type: 'number', min: 1, max: 1440 },
      { key: 'idleTimeoutMinutes', label: t('settings.idleTimeout'), type: 'number', min: 1, max: 480 },
      { key: 'sessionAbsoluteHours', label: t('settings.sessionAbsolute'), type: 'number', min: 1, max: 168 },
      { key: 'signatureTtlMinutes', label: bilingual('签名有效窗口（分钟）', 'Signature TTL (min)'), type: 'number', min: 1, max: 60 },
    ];
    const form = U.buildForm(defs, policy);
    let secondFactorToggle;

    const node = el('div', {}, [
      form.node,
      el('div.form-grid', {}, [
        field(t('settings.signatureSecondFactor'), (secondFactorToggle = U.checkbox('signatureSecondFactor',
          policy.signatureSecondFactor !== false, bilingual('启用（推荐）', 'Enabled (recommended)'))), {
          help: bilingual(
            '关闭后签名只需密码，将不满足 21 CFR Part 11.200(a)(1)(i) 的两个识别要素要求。关闭前请评估法规影响。',
            'Disabling this reduces signing to a single component, which no longer satisfies 21 CFR Part 11.200(a)(1)(i). Assess the regulatory impact first.'
          ),
        }),
      ]),
      el('div.warning-note', {}, bilingual(
        '安全策略变更属于 PV 相关变更，需要填写理由。建议同时评估是否需纳入变更控制并通知用户。',
        'A security policy change is a PV-relevant change and requires a reason. Consider raising a change control and notifying users.'
      )),
      button(t('settings.changePolicy'), {
        variant: 'primary',
        onclick: async () => {
          const values = form.values();
          const patch = {};
          for (const d of defs) {
            if (values[d.key] !== null && values[d.key] !== undefined) patch[d.key] = Number(values[d.key]);
          }
          patch.signatureSecondFactor = secondFactorToggle.checked;
          const reason = await U.reasonDialog({
            title: t('settings.changePolicy'),
            message: Object.entries(patch).map(([k, v]) => `${U.humanise(k)} = ${v}`).join('\n'),
            minLength: 5,
          });
          if (!reason) return;
          try {
            await window.Api.put('/api/system/policy', { ...patch, reason });
            U.toast(t('toast.saved'), 'ok');
            window.App.refresh();
          } catch (err) { U.toast(err.message, 'bad', 8000); }
        },
      }),
    ]);
    return node;
  }

  window.Views.register('me', accountView);
  window.Views.register('settings', settingsView);
})();
