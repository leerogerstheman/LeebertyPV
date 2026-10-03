/* LeebertyPV - application shell.
 *
 * Responsibilities:
 *   - bootstrap the client (instance config, PV areas, process types, roles)
 *   - authentication gate, including first-run setup and forced password change
 *   - hash routing with permission-aware navigation
 *   - global session-ended handling so an idle timeout is explained, not silent
 */
(function () {
  'use strict';

  const { tr, t, bilingual, toggleLocale, getLocale } = window.I18N;
  const { el, clear, button, toast } = window.UI;

  const App = {
    boot: null,
    user: null,
    permissions: [],
    session: null,
    view: null,
    viewParams: null,
    route: null,
    can(permission) {
      if (!permission) return true;
      if (this.permissions.includes('*')) return true;
      return this.permissions.includes(permission);
    },
    canAny(list) { return (list || []).some((p) => this.can(p)); },
    navigate(hash) { window.location.hash = hash; },
    refresh() { render(); },
  };
  window.App = App;

  // ------------------------------------------------------------- nav model --

  const NAV = [
    { id: 'inbox', hash: '#/inbox', icon: '\u2709', permission: null },
    { id: 'domains', hash: '#/domains', icon: '\u25a3', permission: null },
    { id: 'dashboard', hash: '#/dashboard', icon: '\u25a6', permission: null },
    { id: 'philosophy', hash: '#/philosophy', icon: '\u2605', permission: null },
    { id: 'records', hash: '#/records', icon: '\u25a4', permission: 'record.view' },
    { id: 'signal', hash: '#/signal', icon: '\u25b3', permission: 'signal.manage' },
    { id: 'documents', hash: '#/documents', icon: '\u2261', permission: 'doc.view' },
    { id: 'inspections', hash: '#/inspections', icon: '\u2713', permission: 'inspection.view' },
    { id: 'training', hash: '#/training', icon: '\u25ce', permission: 'training.view' },
    { id: 'audit', hash: '#/audit', icon: '\u26bf', permission: 'audit.view' },
    { id: 'compliance', hash: '#/compliance', icon: '\u2696', permission: 'compliance.view' },
    { id: 'users', hash: '#/users', icon: '\u263b', permission: 'user.view' },
    { id: 'settings', hash: '#/settings', icon: '\u2692', permission: 'settings.manage' },
  ];

  // ---------------------------------------------------------------- routes --

  const ROUTES = [
    // The inbox is the landing screen: it answers "what must I do today?", which
    // is the question that actually gets GxP work done. The dashboard remains
    // available for the managerial view.
    // The bare root is the domain picker when nobody is signed in, and the
    // inbox once they are: the first question is which GxP area you work in.
    { pattern: /^#?\/?$/, view: 'domains', params: () => ({}) },
    { pattern: /^#\/home$/, view: 'inbox', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/inbox$/, view: 'inbox', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/domains$/, view: 'domains', params: () => ({}) },
    { pattern: /^#\/philosophy$/, view: 'philosophy', params: () => ({}) },
    { pattern: /^#\/domain\/([^/]+)$/, view: 'domain', params: (m) => ({ code: decodeURIComponent(m[1]) }) },
    { pattern: /^#\/workflow\/([^/]+)$/, view: 'workflow', params: (m) => ({ code: decodeURIComponent(m[1]) }) },
    { pattern: /^#\/dashboard$/, view: 'dashboard', params: () => ({}) },
    { pattern: /^#\/records$/, view: 'records', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/records\/(\d+)$/, view: 'record', params: (m) => ({ id: m[1] }) },
    { pattern: /^#\/records\/new$/, view: 'recordNew', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/signal$/, view: 'signal', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/signal\/line-listing$/, view: 'signalLineListing', params: () => ({}) },
    { pattern: /^#\/documents$/, view: 'documents', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/documents\/(\d+)$/, view: 'document', params: (m) => ({ id: m[1] }) },
    { pattern: /^#\/inspections$/, view: 'inspections', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/inspections\/new$/, view: 'inspectionNew', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/inspections\/(\d+)$/, view: 'inspection', params: (m) => ({ id: m[1] }) },
    { pattern: /^#\/checklists$/, view: 'checklists', params: () => ({}) },
    { pattern: /^#\/checklists\/([^/]+)$/, view: 'checklist', params: (m) => ({ code: decodeURIComponent(m[1]) }) },
    { pattern: /^#\/training$/, view: 'training', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/training\/(\d+)$/, view: 'trainingPerson', params: (m) => ({ id: m[1] }) },
    { pattern: /^#\/equipment$/, view: 'equipment', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/equipment\/(\d+)$/, view: 'equipmentItem', params: (m) => ({ id: m[1] }) },
    { pattern: /^#\/audit$/, view: 'audit', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/compliance$/, view: 'compliance', params: () => ({}) },
    { pattern: /^#\/users$/, view: 'users', params: (m, q) => ({ query: q }) },
    { pattern: /^#\/settings$/, view: 'settings', params: () => ({}) },
    { pattern: /^#\/me$/, view: 'me', params: () => ({}) },
  ];

  const VIEWS = {};

  function resolveRoute(hash) {
    const raw = hash || '#/dashboard';
    const [path, queryString] = raw.split('?');
    const query = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString).entries()) query[k] = v;
    }
    for (const route of ROUTES) {
      const match = route.pattern.exec(path);
      if (match) {
        return { name: route.view, params: route.params(match, query), query, path: raw };
      }
    }
    return null;
  }

  // -------------------------------------------------------------- rendering --

  /**
   * Views that make sense before anybody has signed in.
   *
   * The application opens on the domain picker: a person knows they work in GLP
   * before they know which identity they want to demonstrate, so being stopped by
   * a credential screen first asked them a question they were not yet ready to
   * answer. Browsing a domain and its process flows needs no session - the
   * endpoints behind these views return the regulatory reference model and
   * withhold this instance's records and cast.
   *
   * Everything else still requires a session, and the view itself offers the
   * identity selection that establishes one.
   */
  const PUBLIC_VIEWS = new Set(['domains', 'domain', 'workflow', 'philosophy']);

  /** Sidebar entries that work without a session. */
  const PUBLIC_NAV = new Set(['domains', 'philosophy']);

  function render() {
    const root = document.getElementById('root');
    if (!root) return;

    const route = resolveRoute(window.location.hash);
    const unauthenticatedButPublic = !App.user && route && PUBLIC_VIEWS.has(route.name);

    if (!App.user && !unauthenticatedButPublic) {
      renderAuthGate(root);
      return;
    }

    const viewName = route ? route.name : 'dashboard';
    const view = VIEWS[viewName] || VIEWS.notFound;

    const main = el('main.main', { id: 'main-content' });
    root.replaceChildren(
      el('div.layout', {}, [
        renderSidebar(),
        el('div.content', {}, [renderTopbar(), main]),
      ])
    );

    // Give the view a container to fill; views may render asynchronously.
    main.appendChild(window.UI.spinner());
    Promise.resolve()
      .then(() => view.render(main, route ? route.params : {}, route))
      .catch((err) => {
        clear(main);
        main.appendChild(window.UI.errorBox(err, () => App.refresh()));
      });
  }

  function renderSidebar() {
    // The application opens on the public domain picker. Showing list items that
    // exist only behind a session made that screen look like a locked subset of
    // something else and, worse, clicking one ejected the visitor to a credential
    // form - the opposite of the domain-first entry the screen is meant to be.
    const publicOnly = !App.user;
    const items = NAV.filter((item) => {
      if (publicOnly) return PUBLIC_NAV.has(item.id);
      return App.can(item.permission);
    });
    return el('aside.sidebar', {}, [
      el('div.brand', {}, [
        el('div.brand-mark', {}, el('img.brand-logo', { src: '/favicon.png', alt: 'LeebertyPV' })),
        el('div.brand-text', {}, [
          el('div.brand-name', {}, t('app.name')),
          el('div.brand-sub', {}, 'PV \u00b7 ICSR \u00b7 SIGNAL \u00b7 PSUR \u00b7 RMP \u00b7 GVP'),
        ]),
      ]),
      el('nav.nav', {}, items.map((item) => {
        // The old truth was `location.hash.startsWith(item.hash)`. That failed
        // exactly where it mattered: `#/domain/GLP` does not start with
        // `#/domains` (the 7th char is '/' not 's'), so the moment somebody
        // drilled from the area list into a domain or a workflow, every sidebar
        // entry lost its highlight while the topbar kept saying "领域与流程".
        // currentNavId() already maps domain/workflow -> domains, record ->
        // records, checklist -> inspections, and so on; using it keeps the
        // highlight and the topbar title coming from the same decision.
        const active = currentNavId() === item.id;
        return el('a.nav-item', {
          href: item.hash,
          class: active ? 'active' : '',
        }, [
          el('span.nav-icon', {}, item.icon),
          el('span.nav-label', {}, t(`nav.${item.id}`)),
        ]);
      })),
      publicOnly
        ? el('div.sidebar-note', {}, bilingualSafe(
            '当前仅供浏览。进入任一领域后，可在该领域内选择身份，'
            + '以该身份的权限查看待办与执行操作。',
            'Browsing only. Enter a domain and choose an identity inside it '
            + 'to see that person\'s work list and act with their permissions.'
          ))
        : null,
      el('div.sidebar-foot', {}, [
        el('div.chain-status', { id: 'chain-status' }, [
          el('span.dot.dot-ok'),
          el('span', {}, t('dash.auditChain')),
        ]),
        el('div.sidebar-version', {}, `v${(App.boot && App.boot.app.version) || ''}`),
      ]),
    ]);
  }

  function renderTopbar() {
    const user = App.user || {};
    const route = resolveRoute(window.location.hash);
    // Inside a domain the two things a person wants are "go back to the list" and
    // "look at this as somebody else". Neither had a control, so entering a domain
    // was a one-way door: the only way out was signing out entirely and being
    // dropped on a credential screen.
    const inDomain = Boolean(route && (route.name === 'domain' || route.name === 'workflow'));
    const domainCode = route
      ? (route.name === 'workflow'
          ? String((route.params && route.params.code) || '').split('-')[0]
          : ((route.params && route.params.code) || null))
      : null;

    const exitToPicker = () => { window.location.hash = '#/domains'; render(); };
    const clearSession = async () => {
      try { await window.Api.post('/api/auth/logout'); } catch { /* sign out regardless */ }
      App.user = null;
      App.permissions = [];
      App.session = null;
    };

    return el('header.topbar', {}, [
      el('div.topbar-title', {}, t(`nav.${currentNavId()}`)),
      el('div.topbar-actions', {}, [
        inDomain
          ? el('span.role-chip.chip-domain', {
              title: bilingualSafe('当前所在领域', 'The domain you are in'),
            }, domainCode || bilingualSafe('领域', 'Domain'))
          : null,
        inDomain
          ? button(bilingualSafe('返回领域选择', 'Back to domains'), {
              variant: 'ghost', onclick: exitToPicker,
            })
          : null,
        el('span.role-chip', { title: user.roleLabel || '' }, user.roleLabel || user.role),
        user.trainingStatus && user.trainingStatus !== 'current' && user.trainingStatus !== 'not_required'
          ? el('span.role-chip.chip-warn', { title: t('training.notQualified') }, t('training.notQualified'))
          : null,
        inDomain
          ? button(bilingualSafe('切换身份', 'Switch identity'), {
              variant: 'ghost',
              title: bilingualSafe(
                '退出当前身份并回到领域选择，可换一个身份进入',
                'Sign out of this identity and return to the domain picker'
              ),
              onclick: async () => { await clearSession(); window.location.hash = '#/domains'; render(); },
            })
          : null,
        button(getLocale() === 'zh-CN' ? 'EN' : '中文', {
          variant: 'ghost', title: 'Switch language',
          onclick: () => { toggleLocale(); render(); },
        }),
        el('a.topbar-user', { href: '#/me' }, [
          el('span.user-name', {}, user.fullName || user.username),
          user.totpEnabled ? el('span.dot.dot-ok', { title: t('users.totpOn') }) : el('span.dot.dot-warn', { title: t('users.totpOff') }),
        ]),
        button(inDomain ? bilingualSafe('退出到登录', 'Sign out') : t('auth.signOut'), {
          variant: 'ghost',
          onclick: async () => {
            await clearSession();
            // Signing out from inside a domain returns to the picker rather than
            // to a bare credential form: the picker is where the journey starts
            // and it needs no session.
            window.location.hash = inDomain ? '#/domains' : '#/inbox';
            render();
          },
        }),
      ]),
    ]);
  }

  function currentNavId() {
    const route = resolveRoute(window.location.hash);
    if (!route) return 'inbox';
    const map = {
      inbox: 'inbox',
      domains: 'domains', domain: 'domains', workflow: 'domains',
      philosophy: 'philosophy',
      dashboard: 'dashboard', records: 'records', record: 'records', recordNew: 'records',
      documents: 'documents', document: 'documents',
      inspections: 'inspections', inspection: 'inspections', inspectionNew: 'inspections',
      checklists: 'inspections', checklist: 'inspections',
      training: 'training', trainingPerson: 'training',
      audit: 'audit', compliance: 'compliance', users: 'users', settings: 'settings', me: 'dashboard',
    };
    return map[route.name] || 'dashboard';
  }

  // -------------------------------------------------------------- auth gate --

  function renderAuthGate(root) {
    const setupNeeded = App.boot && App.boot.setupComplete === false;
    root.replaceChildren(el('div.auth-host', {}, [
      el('div.auth-card', {}, setupNeeded ? setupForm() : loginForm()),
      el('div.auth-foot', {}, [
        el('span', {}, t('app.tagline')),
        button(getLocale() === 'zh-CN' ? 'EN' : '中文', {
          variant: 'ghost', onclick: () => { toggleLocale(); render(); },
        }),
      ]),
    ]));
  }

    /**
     * Start-up screen.
     *
     * The first question is "which GxP area do you work in", not "who are you".
     * Someone opening this application knows they work in GLP long before they
     * think about which of nine job titles they should demonstrate, and a wall of
     * job titles gives them nothing to orient by. So:
     *
     *   step 1  pick a domain (GMP / GLP / GCP / ...)
     *   step 2  pick an identity from the people who actually work in that domain
     *
     * A production instance has neither personas nor a domain list in its
     * bootstrap payload, and falls back to the plain credential form.
     */
    function loginForm() {
      let usernameInput;
      let passwordInput;
      let totpInput;
      let totpVisible = false;
      let errorNode = null;
      let submitting = false;
      let manualMode = false;
      // null means "still choosing a domain"; a domain code means "choosing an
      // identity inside it".
      let chosenDomain = null;

      const builtin = (App.boot && App.boot.builtinAccounts) || { enabled: false, personas: [] };
      const personas = builtin.personas || [];
      const domains = builtin.domains || [];

      const container = el('div');

      const doLogin = async (username, password, totp, domainCode) => {
        if (submitting) return;
        submitting = true;
        if (errorNode) errorNode.textContent = '';
        // An instance seeded before the shared credential was unified still holds
        // the old value for some accounts. Try the published password first, then
        // the legacy one, so a click on an identity never fails in front of a
        // user because of a historical inconsistency.
        const candidates = [password, ...((builtin.passwordCandidates || [])
          .filter((c) => c !== password))];
        let res = null;
        let lastErr = null;
        try {
          for (const candidate of candidates) {
            try {
              const payload = { username, password: candidate };
              if (totp) payload.totp = totp;
              res = await window.Api.post('/api/auth/login', payload);
              break;
            } catch (err) {
              lastErr = err;
              if (err.code !== 'INVALID_CREDENTIALS') break;
            }
          }
          if (!res) throw lastErr || new Error('login failed');
          App.user = res.user;
          App.permissions = res.user.permissions || [];
          App.session = res.session;
          // Land in the domain the person chose, not on a generic inbox.
          if (domainCode) setLandingDomain(domainCode);
          if (await mustChangePassword()) return;
          window.location.hash = landingHash();
          render();
        } catch (err) {
          submitting = false;
          if (err.code === 'TOTP_REQUIRED' || err.code === 'TOTP_INVALID') {
            totpVisible = true;
            manualMode = true;
            rebuild();
            if (totpInput) totpInput.focus();
          }
          if (errorNode) errorNode.textContent = err.message || t('common.error');
          toast(err.message || t('common.error'), 'bad');
        }
      };

      const submitManual = async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (!username || !password) {
          toast(`${t('auth.username')} / ${t('auth.password')}`, 'warn');
          return;
        }
        await doLogin(username, password,
          totpVisible && totpInput ? totpInput.value.trim() : null, chosenDomain);
      };

      /** Personas that work in the chosen domain. */
      const personasFor = (code) => personas.filter((p) => (p.gxpAreas || []).includes(code));

      const rebuild = () => {
        clear(container);

        const header = el('div.auth-brand', {}, [
          el('div.brand-mark.brand-mark-lg', {}, el('img.brand-logo-lg', { src: '/logo-lg.png', alt: 'LeebertyPV' })),
          el('h1.auth-title', {}, t('app.name')),
          el('p.auth-sub', {}, t('app.tagline')),
        ]);

        const privacyNote = el('p.auth-note', {}, '21 CFR Part 11.10(d) \u00b7 EU GVP Module I \u00b7 81号令');

        const demoBanner = () => el('div.demo-banner', {}, [
          el('span.demo-dot'),
          el('div', {}, [
            el('div', {}, bilingualSafe('演示模式：点选即可进入', 'Demo mode: click to enter')),
            el('div.demo-note', {}, bilingualSafe(
              `统一密码 ${builtin.password}。账号与密码是公开的，请勿用于真实安全性记录。`,
              `Shared password ${builtin.password}. These credentials are public - not for real safety records.`
            )),
          ]),
        ]);

        // ---- step 1: choose the domain --------------------------------------
        if (builtin.enabled && domains.length && !manualMode && !chosenDomain) {
          const grid = el('div.domain-choice-grid', {}, domains.map((d) => {
            const count = personasFor(d.code).length;
            return el('button.domain-choice-card', {
              type: 'button',
              disabled: submitting,
              style: { borderTopColor: d.colour || 'var(--brand)' },
              onclick: () => {
                if (!count) {
                  toast(bilingualSafe('该领域暂无演示账号', 'No demo account covers this domain'), 'warn');
                  return;
                }
                chosenDomain = d.code;
                rebuild();
              },
            }, [
              el('div.dcc-head', {}, [
                el('span.dcc-code', { style: { color: d.colour || 'var(--brand)' } }, d.code),
                count
                  ? el('span.dcc-count', {}, `${count} ${bilingualSafe('个身份可选', 'identities')}`)
                  : el('span.dcc-count.dcc-count-off', {}, bilingualSafe('无账号', 'no account')),
              ]),
              el('div.dcc-full', {}, getLocale() === 'en' && d.fullNameEn ? d.fullNameEn : d.fullName),
              el('div.dcc-name', {}, getLocale() === 'en' && d.nameEn ? d.nameEn : d.name),
              el('div.dcc-stats', {}, [
                el('span', {}, `${d.processCount} ${bilingualSafe('条流程', 'processes')}`),
                el('span', {}, `${d.participantRoles.length} ${bilingualSafe('个岗位', 'roles')}`),
              ]),
              el('div.dcc-cta', {}, count
                ? bilingualSafe('进入该领域 \u2192', 'Enter this domain \u2192')
                : bilingualSafe('仅可通过其他账号登录', 'Sign in with another account only')),
            ]);
          }));

          container.appendChild(el('div.auth-form.auth-form-wide', {}, [
            header,
            demoBanner(),
            el('div.start-step', {}, [
              el('span.start-step-num', {}, '1'),
              el('span.start-step-label', {}, bilingualSafe('选择 PV 领域', 'Choose a PV domain')),
              el('span.start-step-hint', {}, bilingualSafe(
                '先确定工作在哪个领域，下一步再从该领域的岗位中选择身份。',
                'Pick the area you work in; the next step offers the identities that work in it.'
              )),
            ]),
            grid,
            el('div.auth-manual', {}, [
              button(bilingualSafe('跳过，使用其他账号登录', 'Skip - sign in with another account'), {
                variant: 'ghost',
                onclick: () => { manualMode = true; rebuild(); },
              }),
            ]),
            privacyNote,
          ]));
          return;
        }

        // ---- step 2: choose an identity inside that domain ------------------
        if (builtin.enabled && chosenDomain && !manualMode) {
          const domain = domains.find((d) => d.code === chosenDomain) || { code: chosenDomain, name: chosenDomain };
          // Rank by real involvement: the number of steps this role owns in the
          // chosen domain's processes, then whether the account carries a curated
          // demonstration narrative. Without ranking, GLP leads with a warehouse
          // keeper and buries the study director.
          const roster = personasFor(chosenDomain).slice().sort((a, b) => {
            const sa = (a.areaSteps && a.areaSteps[chosenDomain]) || 0;
            const sb = (b.areaSteps && b.areaSteps[chosenDomain]) || 0;
            if (sb !== sa) return sb - sa;
            if (a.curated !== b.curated) return a.curated ? -1 : 1;
            return String(a.roleLabelZh || a.role).localeCompare(String(b.roleLabelZh || b.role));
          });

          const card = (p) => {
            const steps = (p.areaSteps && p.areaSteps[chosenDomain]) || 0;
            // Curated personas carry a hand-written blurb in both languages.
            // Seeded accounts carry only the role's generic description, which
            // exists in English - so a Chinese screen showed an English sentence.
            // Fall back to the localised role label instead of the wrong language.
            const en = getLocale() === 'en';
            const blurb = p.curated
              ? (en && p.blurbEn ? p.blurbEn : p.blurb)
              : (en ? (p.roleLabel || p.role) : (p.roleLabelZh || p.role));
            return el('button.persona-card', {
              type: 'button',
              onclick: () => doLogin(p.username, builtin.password, null, chosenDomain),
              disabled: submitting,
            }, [
              el('div.persona-head', {}, [
                el('span.persona-role', {}, en
                  ? (p.roleLabel || p.role) : (p.roleLabelZh || p.roleLabel || p.role)),
                steps
                  ? el('span.persona-steps', {
                      title: bilingualSafe(
                        `在 ${chosenDomain} 的流程中负责 ${steps} 个步骤`,
                        `Owns ${steps} step(s) in ${chosenDomain} processes`
                      ),
                    }, `${steps} ${bilingualSafe('步骤', 'steps')}`)
                  : el('span.persona-pending.persona-pending-zero', {}, '—'),
              ]),
              el('div.persona-name', {}, en && p.fullNameEn ? p.fullNameEn : p.fullName),
              el('div.persona-job', {}, p.jobTitle || ''),
              el('div.persona-blurb', {}, blurb),
              p.highlight ? el('div.persona-highlight', {}, p.highlight) : null,
            ]);
          };

          // Split into the domain's own roles and the cross-cutting ones, so the
          // first row answers "who actually works in GLP here".
          const core = roster.filter((p) => ((p.areaSteps && p.areaSteps[chosenDomain]) || 0) > 0);
          const others = roster.filter((p) => !core.includes(p));

          container.appendChild(el('div.auth-form.auth-form-wide', {}, [
            header,
            demoBanner(),
            el('div.start-step', {}, [
              el('span.start-step-num', {}, '2'),
              el('span.start-step-label', {}, bilingualSafe(
                `选择进入 ${domain.code} 的身份`, `Choose who to enter ${domain.code} as`
              )),
              el('span.start-step-hint', {}, bilingualSafe(
                `下列 ${roster.length} 个身份可进入 ${domain.code}。选定后直接进入该领域的专属界面。`,
                `${roster.length} identities can enter ${domain.code}. Choosing one takes you straight to that domain interface.`
              )),
            ]),
            el('div.domain-chosen', {}, [
              el('span.domain-chosen-code', { style: { color: domain.colour || 'var(--brand)' } }, domain.code),
              el('span.domain-chosen-name', {}, getLocale() === 'en' && domain.fullNameEn ? domain.fullNameEn : domain.fullName),
              button(bilingualSafe('更换领域', 'Change domain'), {
                variant: 'ghost',
                onclick: () => { chosenDomain = null; rebuild(); },
              }),
            ]),
            core.length ? el('div.persona-section-title', {}, bilingualSafe(
              `在 ${domain.code} 中承担职责的岗位`, `Roles carrying responsibility in ${domain.code}`
            )) : null,
            core.length ? el('div.persona-grid', {}, core.map(card)) : null,
            others.length ? el('div.persona-section-title.persona-section-sub', {}, bilingualSafe(
              `其他可进入 ${domain.code} 的身份`, `Other identities that can enter ${domain.code}`
            )) : null,
            others.length ? el('div.persona-grid.persona-grid-sub', {}, others.map(card)) : null,
            roster.length ? null : el('p.auth-note', {}, bilingualSafe(
              '本领域暂无演示账号，请使用其他账号登录。',
              'No demonstration account covers this domain; sign in with another account.'
            )),
            el('div.auth-manual', {}, [
              button(bilingualSafe('返回领域选择', 'Back to domain selection'), {
                variant: 'ghost',
                onclick: () => { chosenDomain = null; rebuild(); },
              }),
            ]),
            privacyNote,
          ]));
          return;
        }

        // ---- plain credential form ------------------------------------------
        container.appendChild(el('div.auth-form', {}, [
          header,
          chosenDomain ? el('div.domain-chosen', {}, [
            el('span.domain-chosen-code', {}, chosenDomain),
            button(bilingualSafe('返回领域选择', 'Back to domain selection'), {
              variant: 'ghost',
              onclick: () => { chosenDomain = null; manualMode = false; rebuild(); },
            }),
          ]) : null,
          el('div.auth-fields', {}, [
            window.UI.field(t('auth.username'), (usernameInput = window.UI.input('username', '', {
              required: true, autocomplete: 'username',
            })), { required: true }),
            window.UI.field(t('auth.password'), (passwordInput = window.UI.input('password', '', {
              type: 'password', required: true, autocomplete: 'current-password',
            })), { required: true }),
            totpVisible ? window.UI.field(t('auth.totp'), (totpInput = window.UI.input('totp', '', {
              maxlength: 6, placeholder: '000000', autocomplete: 'one-time-code',
            })), { help: t('auth.totpHint') }) : null,
          ]),
          el('div.auth-error', { id: 'auth-error' }),
          button(t('auth.signIn'), { variant: 'primary', onclick: submitManual }),
          builtin.enabled && personas.length
            ? el('div.auth-manual', {}, [
                button(bilingualSafe('返回领域选择', 'Back to domain selection'), {
                  variant: 'ghost',
                  onclick: () => { manualMode = false; chosenDomain = null; rebuild(); },
                }),
              ])
            : null,
          privacyNote,
        ]));
        errorNode = container.querySelector('#auth-error');
      };

      rebuild();
      container.addEventListener('keydown', (ev) => {
        // Enter submits the credential form only. On the domain and identity
        // screens there is nothing to submit: the choice is the click.
        if (ev.key === 'Enter' && (!builtin.enabled || manualMode)) {
          ev.preventDefault();
          submitManual();
        }
      });
      return container;
    }

  /** Small local helper: the persona banner is demo-only copy, not a UI string. */
  function bilingualSafe(zh, en) {
    return window.I18N.getLocale() === 'en' ? en : zh;
  }

  function setupForm() {
    let siteInput; let userInput; let nameInput; let passInput; let pass2Input;
    let errorNode;

    const submit = async () => {
      const siteName = siteInput.value.trim() || 'Site';
      const username = userInput.value.trim();
      const fullName = nameInput.value.trim();
      const password = passInput.value;
      if (!username || username.length < 3) { toast(t('auth.username'), 'warn'); return; }
      if (!fullName) { toast(t('auth.setup.fullName'), 'warn'); return; }
      if (password !== pass2Input.value) { toast(t('auth.passwordMismatch'), 'bad'); return; }
      try {
        const res = await window.Api.post('/api/setup', { siteName, username, fullName, password });
        App.user = res.user;
        App.permissions = res.user.permissions || [];
        App.boot.setupComplete = true;
        toast(t('toast.created'), 'ok');
        window.location.hash = '#/dashboard';
        render();
      } catch (err) {
        errorNode.textContent = err.message;
        toast(err.message, 'bad');
      }
    };

    const node = el('div.auth-form', {}, [
      el('div.auth-brand', {}, [
        el('div.brand-mark.brand-mark-lg', {}, el('img.brand-logo-lg', { src: '/logo-lg.png', alt: 'LeebertyPV' })),
        el('h1.auth-title', {}, t('auth.setup.title')),
        el('p.auth-sub', {}, t('auth.setup.intro')),
      ]),
      el('div.auth-fields', {}, [
        window.UI.field(t('auth.setup.siteName'), (siteInput = window.UI.input('site', '', { placeholder: 'e.g. 上海工厂 / Shanghai Plant' }))),
        window.UI.field(t('auth.setup.fullName'), (nameInput = window.UI.input('fullname', '', { required: true })), { required: true }),
        window.UI.field(t('auth.username'), (userInput = window.UI.input('username', '', { required: true, autocomplete: 'username' })), { required: true }),
        window.UI.field(t('auth.newPassword'), (passInput = window.UI.input('password', '', { type: 'password', required: true })), {
          required: true,
          help: `${t('settings.passwordMinLength')}: ${(App.boot && App.boot.policy.passwordMinLength) || 10}`,
        }),
        window.UI.field(t('auth.confirmPassword'), (pass2Input = window.UI.input('password2', '', { type: 'password', required: true })), { required: true }),
      ]),
      el('div.auth-error', { id: 'setup-error' }),
      button(t('auth.setup.create'), { variant: 'primary', onclick: submit }),
    ]);
    errorNode = node.querySelector('#setup-error');
    return node;
  }

  /** Force a password change before any GxP work is possible. */
  async function mustChangePassword() {
    if (!App.user || !App.user.mustChangePassword) return false;
    return new Promise((resolve) => {
      let currentInput; let newInput; let confirmInput; let errorNode;
      window.UI.modal({
        title: t('auth.mustChangePassword'),
        width: '520px',
        dismissible: false,
        onClose: () => resolve(true),
        render: (close) => [
          el('p', {}, t('auth.mustChangePassword')),
          window.UI.field(t('auth.currentPassword'), (currentInput = window.UI.input('cur', '', { type: 'password', required: true })), { required: true }),
          window.UI.field(t('auth.newPassword'), (newInput = window.UI.input('new', '', { type: 'password', required: true })), {
            required: true,
            help: `${t('settings.passwordMinLength')}: ${(App.boot && App.boot.policy.passwordMinLength) || 10}`,
          }),
          window.UI.field(t('auth.confirmPassword'), (confirmInput = window.UI.input('new2', '', { type: 'password', required: true })), { required: true }),
          el('div.auth-error', { id: 'pw-error' }),
          el('div.modal-actions', {}, [
            button(t('auth.changePassword'), {
              variant: 'primary',
              onclick: async () => {
                if (newInput.value !== confirmInput.value) { toast(t('auth.passwordMismatch'), 'bad'); return; }
                try {
                  await window.Api.post('/api/auth/password', {
                    currentPassword: currentInput.value,
                    newPassword: newInput.value,
                  });
                  App.user.mustChangePassword = false;
                  toast(t('auth.passwordChanged'), 'ok');
                  close();
                  resolve(true);
                } catch (err) {
                  errorNode = document.getElementById('pw-error');
                  if (errorNode) errorNode.textContent = err.message;
                  toast(err.message, 'bad');
                }
              },
            }),
          ]),
        ],
      });
    });
  }

  // ---------------------------------------------------------------- boot ----

  /**
   * Where to land after signing in.
   *
   * The start-up screen asks for a GxP domain before it asks for an identity, so
   * signing in should deliver you to that domain's own interface rather than to a
   * generic inbox. A production instance has no domain picker and falls back to
   * the inbox, which is the right default when the user came in through a plain
   * credential form.
   */
  function landingHash() {
    try {
      const chosen = window.sessionStorage.getItem('pv.landingDomain');
      if (chosen) {
        window.sessionStorage.removeItem('pv.landingDomain');
        if (/^[A-Za-z0-9_-]+$/.test(chosen)) return `#/domain/${encodeURIComponent(chosen)}`;
      }
    } catch { /* storage unavailable: fall through */ }
    return '#/inbox';
  }
  function setLandingDomain(code) {
    try { window.sessionStorage.setItem('pv.landingDomain', code); } catch { /* ignore */ }
  }

  async function boot() {
    window.Api.onSessionEnded((code, message) => {
      if (!App.user) return;
      App.user = null;
      App.permissions = [];
      render();
      toast(message || t('toast.sessionExpired'), 'warn', 8000);
    });

    try {
      App.boot = await window.Api.get('/api/bootstrap');
    } catch (err) {
      document.getElementById('root').replaceChildren(
        window.UI.errorBox(err, () => boot())
      );
      return;
    }

    // Resume an existing session if the cookie is still valid.
    try {
      const me = await window.Api.get('/api/auth/me');
      App.user = me.user;
      App.permissions = me.user.permissions || [];
      App.session = me.session;
    } catch { /* no session: the auth gate is rendered */ }

    window.addEventListener('hashchange', render);
    window.I18N.onLocaleChange(() => render());
    if (App.user) await mustChangePassword();
    // The start-up screen asks who you are, not which area you want. A session has
    // already answered it, so a signed-in visitor keeps whatever destination their
    // identity implied; everyone else gets the identity list.
    if (!App.user && (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/')) {
      window.location.hash = '#/domains';
    }
    render();
  }

  // ----------------------------------------------------------- view registry --

  function register(name, view) { VIEWS[name] = view; }

  VIEWS.notFound = {
    render(container, params, route) {
      container.replaceChildren(el('div.empty', {}, [
        el('h2', {}, 'Not found'),
        el('p.mono', {}, route ? route.path : ''),
        el('a', { href: '#/dashboard' }, t('nav.dashboard')),
      ]));
    },
  };

  // Adopt any registrations the views queued before this file executed. The view
  // scripts are loaded before the shell so that their definitions exist when the
  // router needs them, which means they run while window.Views is still the stub
  // in index.html. Replacing window.Views without draining that queue would
  // silently discard every view and leave the app on the boot splash.
  const queued = (window.Views && window.Views.pending) || [];
  for (const [name, view] of queued) register(name, view);

  window.Views = { register, resolveRoute, render, NAV };
  // Keep the stub's entry point alive for any script that loads after this one.
  window.Views.pending = queued;
  document.addEventListener('DOMContentLoaded', boot);
})();
