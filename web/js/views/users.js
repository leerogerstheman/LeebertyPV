/* View: users and access - unique accounts, roles and the permission matrix.
 *
 * The account list is presented as an access-control review artefact, because
 * that is how an auditor reads it: every row must map to exactly one person,
 * and every privileged role must be justified.
 */
(function () {
  'use strict';

  const { t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, table, badge, button, field, input, select, textarea } = U;

  const STATUS_TONES = { active: 'ok', locked: 'bad', disabled: 'muted', pending: 'warn' };

  const listView = {
    async render(container, params) {
      const query = params.query || {};
      clear(container);
      container.appendChild(U.spinner());

      const [data, roles, domainsData] = await Promise.all([
        window.Api.get('/api/users', {
          role: query.role || '', status: query.status || '',
          department: query.department || '', search: query.search || '',
        }),
        window.Api.get('/api/roles').catch(() => ({ rows: [] })),
        window.Api.get('/api/domains').catch(() => ({ domains: [] })),
      ]);
      clear(container);

      const rows = data.rows || [];
      const locked = rows.filter((r) => r.status === 'locked').length;
      const noTotp = rows.filter((r) => r.status === 'active' && !r.totpEnabled).length;
      const admins = rows.filter((r) => r.role === 'system_admin').length;

      let searchTimer = null;
      container.appendChild(el('div.view', {}, [
        el('div.view-head', {}, [
          el('div', {}, [
            el('h1.view-title', {}, t('users.title')),
            el('p.view-sub', {}, t('users.subtitle')),
          ]),
          el('div.view-head-actions', {}, [
            button(t('users.roleMatrix'), { variant: 'ghost', onclick: () => roleMatrix(roles) }),
            window.App.can('user.manage')
              ? button(t('users.newUser'), { variant: 'primary', onclick: () => newUserDialog(roles.rows || [], data.departments || [], domainsData.domains || []) })
              : null,
          ]),
        ]),

        el('div.stat-strip', {}, [
          stat(bilingual('账号总数', 'Total accounts'), rows.length),
          stat(bilingual('启用', 'Active'), rows.filter((r) => r.status === 'active').length, { tone: 'ok' }),
          stat(bilingual('已锁定', 'Locked'), locked, { tone: locked ? 'bad' : 'ok' }),
          stat(bilingual('未绑定第二要素', 'No second factor'), noTotp, {
            tone: noTotp ? 'warn' : 'ok',
            title: bilingual('未绑定验证器的用户签署时将使用一次性挑战码', 'Users without an authenticator sign using a single-use challenge'),
          }),
          stat(bilingual('管理员账号', 'Administrator accounts'), admins, { tone: admins > 2 ? 'warn' : null }),
        ]),

        el('div.warning-note', {}, t('users.noSharedWarning')),

        el('div.filter-bar', {}, [
          input('search', query.search || '', {
            placeholder: t('common.search'),
            oninput: (ev) => {
              clearTimeout(searchTimer);
              searchTimer = setTimeout(() => setQuery({ search: ev.target.value.trim() || null }), 350);
            },
          }),
          select('role', query.role || '', (roles.rows || []).map((r) => ({
            value: r.code, label: getLocale() === 'en' ? r.label : r.labelZh,
          })), {
            placeholder: `— ${t('users.role')} —`,
            onchange: (ev) => setQuery({ role: ev.target.value || null }),
          }),
          select('status', query.status || '', ['active', 'locked', 'disabled', 'pending'], {
            placeholder: `— ${t('users.accountStatus')} —`,
            onchange: (ev) => setQuery({ status: ev.target.value || null }),
          }),
          select('department', query.department || '', (data.departments || []).map((d) => ({ value: d, label: d })), {
            placeholder: `— ${t('common.department')} —`,
            onchange: (ev) => setQuery({ department: ev.target.value || null }),
          }),
        ]),

        card(null, table([
          { key: 'username', label: t('users.username'), render: (r) => el('span.mono.strong', {}, r.username) },
          {
            key: 'fullName',
            label: t('users.fullName'),
            render: (r) => el('div', {}, [
              el('div', {}, r.fullName || '—'),
              r.fullNameEn ? el('div.small.muted', {}, r.fullNameEn) : null,
            ]),
          },
          { key: 'department', label: t('common.department') },
          { key: 'jobTitle', label: t('users.jobTitle') },
          {
            key: 'role',
            label: t('users.role'),
            render: (r) => el('span', { title: r.role }, [
              badge(r.roleLabel || r.role, r.role === 'system_admin' ? 'warn' : 'neutral'),
              r.readOnly ? badge(bilingual('只读', 'Read-only'), 'muted') : null,
            ]),
          },
          { key: 'status', label: t('common.status'), render: (r) => badge(U.humanise(r.status), STATUS_TONES[r.status] || 'neutral') },
          {
            key: 'totpEnabled',
            label: t('users.totp'),
            render: (r) => (r.totpEnabled ? badge(t('users.totpOn'), 'ok') : badge(t('users.totpOff'), 'muted')),
          },
          {
            key: 'trainingStatus',
            label: bilingual('培训', 'Training'),
            render: (r) => badge(U.humanise(r.trainingStatus || 'unknown'),
              r.trainingStatus === 'current' ? 'ok' : (r.trainingStatus === 'not_required' ? 'muted' : 'warn')),
          },
          {
            key: 'passwordExpired',
            label: bilingual('密码', 'Password'),
            render: (r) => (r.passwordExpired
              ? badge(bilingual('已过期', 'Expired'), 'bad')
              : (r.mustChangePassword ? badge(bilingual('需修改', 'Must change'), 'warn') : badge('OK', 'ok'))),
          },
          { key: 'lastLoginAt', label: t('users.lastLogin'), render: (r) => (r.lastLoginAt ? U.fmtDateTime(r.lastLoginAt) : el('span.muted', {}, '—')) },
          {
            key: 'actions',
            label: t('common.actions'),
            render: (r) => (window.App.can('user.manage')
              ? el('span.btn-row', {}, [
                  button(t('common.edit'), { variant: 'ghost', onclick: () => editUser(r, roles.rows || []) }),
                  button(t('users.resetPassword'), { variant: 'ghost', onclick: () => resetPassword(r) }),
                ])
              : el('span.muted', {}, '—')),
          },
        ], rows, { emptyText: t('common.noData') }), { subtitle: `${data.total} ${t('common.items')}` }),
      ]));
    },
  };

  function setQuery(patch) {
    const route = window.Views.resolveRoute(window.location.hash);
    const query = { ...(route ? route.query : {}), ...patch };
    const base = (window.location.hash.split('?')[0]) || '#/users';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) usp.set(k, v);
    const qs = usp.toString();
    window.location.hash = qs ? `${base}?${qs}` : base;
  }

  function roleOptions(roles) {
    return roles.map((r) => ({ value: r.code, label: `${getLocale() === 'en' ? r.label : r.labelZh} (${r.code})` }));
  }

  function newUserDialog(roles, departments, domains) {
    const fields = [
      { key: 'username', label: t('users.username'), type: 'text', required: true, help: bilingual('必须唯一对应到人', 'Must map to exactly one person') },
      { key: 'fullName', label: t('users.fullName'), type: 'text', required: true },
      { key: 'fullNameEn', label: bilingual('英文姓名', 'Full name (English)'), type: 'text' },
      { key: 'role', label: t('users.role'), type: 'select', required: true, options: roles.map((r) => r.code) },
      { key: 'employeeNo', label: t('users.employeeNo'), type: 'text' },
      { key: 'department', label: t('common.department'), type: 'text' },
      { key: 'jobTitle', label: t('users.jobTitle'), type: 'text' },
      { key: 'email', label: t('users.email'), type: 'text' },
      { key: 'locale', label: bilingual('界面语言', 'UI language'), type: 'select', options: ['zh-CN', 'en'] },
    ];
    const form = U.buildForm(fields, { locale: getLocale() });
    let mustChangeToggle;
    let passwordInput;

    // Which GxP areas the new person works in. This is not decoration: it decides
    // where the account lands after sign-in, whether it appears on a domain's
    // roster and identity list, and what the visibility rules let it see. A new
    // QC analyst who is not told to work in GMP would silently never appear there.
    const chosenAreas = new Set();
    const areasHost = el('div.df-chips', {}, (domains || []).map((d) => el('button.df-chip', {
      type: 'button',
      'data-code': d.code,
      onclick: (ev) => {
        const btn = ev.currentTarget;
        if (chosenAreas.has(d.code)) { chosenAreas.delete(d.code); btn.classList.remove('active'); }
        else { chosenAreas.add(d.code); btn.classList.add('active'); }
      },
    }, d.code)));

    U.modal({
      title: t('users.newUser'),
      width: '720px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '每个账号必须唯一对应到一名人员。共用账号会使记录无法归属到人，属于严重缺陷。',
          'Each account must map to exactly one person. Shared accounts make records unattributable and are a critical finding.'
        )),
        form.node,
        field(bilingual('所属 PV 领域', 'PV areas'), areasHost, {
          help: bilingual(
            '声明该人员工作的领域：账号会出现在这些领域的身份名单中，并在登录后落入对应领域界面',
            'Declare where this person works: the account appears on those areas\' identity rosters and lands in the right area after sign-in'
          ),
        }),
        field(bilingual('初始密码', 'Initial password'), (passwordInput = input('password', '', {
          type: 'text', placeholder: bilingual('留空则创建后重置生成', 'Leave empty to generate via reset'),
        })), { help: bilingual('留空时账号无密码，需通过「重置密码」生成临时密码', 'If empty the account has no password; use Reset password to issue one') }),
        U.checkbox('mustChange', (mustChangeToggle = true), bilingual('首次登录必须修改密码', 'Must change password at first sign-in')),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const missing = form.missing();
              if (missing.length) { U.toast(`${t('common.required')}: ${missing.join(', ')}`, 'warn'); return; }
              try {
                const payload = form.values();
                if (chosenAreas.size) payload.gxpAreas = [...chosenAreas];
                if (passwordInput.value) payload.password = passwordInput.value;
                payload.mustChangePassword = true;
                const created = await window.Api.post('/api/users', payload);
                close();
                U.toast(`${t('toast.created')}: ${created.user.username}`, 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  function editUser(user, roles) {
    const fields = [
      { key: 'fullName', label: t('users.fullName'), type: 'text' },
      { key: 'fullNameEn', label: bilingual('英文姓名', 'Full name (English)'), type: 'text' },
      { key: 'role', label: t('users.role'), type: 'select', options: roles.map((r) => r.code) },
      { key: 'status', label: t('users.accountStatus'), type: 'select', options: ['active', 'locked', 'disabled', 'pending'] },
      { key: 'employeeNo', label: t('users.employeeNo'), type: 'text' },
      { key: 'department', label: t('common.department'), type: 'text' },
      { key: 'jobTitle', label: t('users.jobTitle'), type: 'text' },
      { key: 'email', label: t('users.email'), type: 'text' },
      { key: 'locale', label: bilingual('界面语言', 'UI language'), type: 'select', options: ['zh-CN', 'en'] },
    ];
    const initial = {};
    for (const f of fields) initial[f.key] = user[f.key];
    const form = U.buildForm(fields, initial);

    U.modal({
      title: `${t('common.edit')}: ${user.username}`,
      width: '680px',
      render: (close) => [
        user.status === 'locked'
          ? el('div.info-note', {}, bilingual('将状态设为「启用」会同时清除失败次数与锁定时间。', 'Setting the status to Active also clears the failed attempt counter and lockout.'))
          : null,
        form.node,
        el('div.warning-note', {}, bilingual(
          '变更角色或停用账号会立即终止该用户的所有会话。修改理由将记入审计追踪。',
          'Changing the role or disabling the account immediately ends all that user\'s sessions. The reason is written to the audit trail.'
        )),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('common.save'), {
            variant: 'primary',
            onclick: async () => {
              const values = form.values();
              const changed = {};
              for (const [k, v] of Object.entries(values)) {
                const before = user[k] === null || user[k] === undefined ? '' : String(user[k]);
                if (before !== String(v === null ? '' : v)) changed[k] = v;
              }
              if (!Object.keys(changed).length) { U.toast(t('common.noData'), 'info'); return; }
              close();
              const reason = await U.reasonDialog({
                title: `${t('common.edit')}: ${user.username}`,
                message: Object.keys(changed).map((k) => `${U.humanise(k)}: ${user[k]} → ${changed[k]}`).join('\n'),
              });
              if (!reason) return;
              try {
                await window.Api.patch(`/api/users/${user.id}`, { ...changed, reason });
                U.toast(t('toast.saved'), 'ok');
                window.App.refresh();
              } catch (err) { U.toast(err.message, 'bad', 8000); }
            },
          }),
        ]),
      ],
    });
  }

  function resetPassword(user) {
    const fields = [
      { key: 'newPassword', label: bilingual('新密码（留空自动生成）', 'New password (blank to generate)'), type: 'text' },
    ];
    const form = U.buildForm(fields, {});

    U.modal({
      title: `${t('users.resetPassword')}: ${user.username}`,
      width: '600px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '重置密码会立即终止该用户的所有会话，并要求其下次登录时修改密码。此操作将记入审计追踪。',
          'Resetting immediately ends all that user\'s sessions and forces a password change at next sign-in. This is written to the audit trail.'
        )),
        form.node,
        el('div.warning-note', {}, t('users.tempPasswordHint')),
        el('div.modal-actions', {}, [
          button(t('common.cancel'), { variant: 'ghost', onclick: close }),
          button(t('users.resetPassword'), {
            variant: 'danger',
            onclick: async () => {
              const reason = await U.reasonDialog({
                title: t('users.resetPassword'),
                message: user.username,
                minLength: 5,
              });
              if (!reason) return;
              try {
                const result = await window.Api.post(`/api/users/${user.id}/password`, {
                  newPassword: form.values().newPassword || undefined,
                  reason,
                });
                close();
                showTempPassword(user, result.temporaryPassword);
              } catch (err) { U.toast(err.message, 'bad', 9000); }
            },
          }),
        ]),
      ],
    });
  }

  function showTempPassword(user, password) {
    U.modal({
      title: t('users.tempPassword'),
      width: '520px',
      render: (close) => [
        el('p', {}, `${user.username} / ${user.fullName || ''}`),
        el('div.temp-password.mono', {}, password),
        el('p.card-foot-note', {}, t('users.tempPasswordHint')),
        el('div.modal-actions', {}, [
          button(bilingual('复制', 'Copy'), {
            variant: 'ghost',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(password);
                U.toast(t('toast.copied'), 'ok');
              } catch {
                // Clipboard access can be blocked; the password is visible to copy manually.
                U.toast(bilingual('请手动复制', 'Please copy manually'), 'warn');
              }
            },
          }),
          button(t('common.close'), { variant: 'primary', onclick: close }),
        ]),
      ],
    });
  }

  function roleMatrix(rolesData) {
    const roles = rolesData.rows || [];
    const groups = {};
    for (const perm of Object.values(rolesData.permissions || {})) {
      const group = perm.split('.')[0];
      if (!groups[group]) groups[group] = [];
      groups[group].push(perm);
    }

    const permGroups = Object.entries(groups);

    const matrixRows = [];
    for (const [group, perms] of permGroups) {
      matrixRows.push(el('tr.matrix-group', {}, [
        el('td', { colspan: roles.length + 1 }, el('strong', {}, U.humanise(group))),
      ]));
      for (const perm of perms) {
        matrixRows.push(el('tr', {}, [
          el('td.mono.small', {}, perm),
          ...roles.map((r) => el('td.matrix-cell', {}, (r.permissions.includes('*') || r.permissions.includes(perm))
            ? el('span.matrix-yes', { title: perm }, '\u2713')
            : el('span.matrix-no', {}, '\u00b7'))),
        ]));
      }
    }

    U.modal({
      title: t('users.roleMatrix'),
      width: '1000px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '角色权限矩阵是职责分离（GVP Module I / ICH Q10）的可审查证据。系统管理员不得作为安全性记录的唯一批准人。',
          'The role matrix is the reviewable evidence of separation of duties (GVP Module I / ICH Q10). A system administrator may not be the sole approver of a safety record.'
        )),
        el('div.matrix-wrap', {}, el('table.table.matrix-table', {}, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, t('users.permissions')),
            ...roles.map((r) => el('th.matrix-role', {}, [
              el('div', {}, getLocale() === 'en' ? r.label : r.labelZh),
              r.readOnly ? el('div.small.muted', {}, t('users.readOnlyRole')) : null,
            ])),
          ])),
          el('tbody', {}, matrixRows),
        ])),
        el('div.modal-actions', {}, [button(t('common.close'), { variant: 'primary', onclick: close })]),
      ],
    });
  }

  window.Views.register('users', listView);
})();
