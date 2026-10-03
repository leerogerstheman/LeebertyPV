/* Views: domain selection, a domain's own interface, and the process explorer.
 *
 * Three levels, because those are the three questions a person actually asks:
 *
 *   #/domains            "which GxP area do I work in?"        -> domain cards
 *   #/domain/GLP         "what does GLP involve here?"         -> the area's own
 *                          interface: its processes, its people, its permissions
 *   #/workflow/GLP-SPEC  "how does this one process run?"      -> flow diagram with
 *                          duties on it, participant cards, permission matrix
 *
 * Design decisions worth stating:
 *
 *  1. Duties appear ON the flow diagram, not only in a participant card. A duty
 *     kept in a title attribute is invisible in a screenshot or a printed copy,
 *     which is precisely where a process diagram gets used to explain a process.
 *
 *  2. The permission matrix has THREE states, not two. Permission alone does not
 *     determine capability: a QA manager holds `record.close` and the kernel still
 *     refuses to let them close a record they authored. Showing only
 *     allowed/denied would produce a screen that contradicts the running system
 *     the first time anyone tests it, so CONDITIONAL cells carry the reason and
 *     the regulatory basis.
 *
 *  3. Participant cards are clickable and open that person's view of the same
 *     record. Watching the work list change when the identity changes is what
 *     makes role separation legible; abstract role descriptions are not.
 *
 *  4. The demo credential is displayed WITH its compliance warning, never as a
 *     neutral convenience. Shared credentials violate 21 CFR Part 11.300(a), and a
 *     screen that presents them without saying so would teach the wrong thing.
 */
(function () {
  'use strict';

  const { t, bilingual, getLocale } = window.I18N;
  const U = window.UI;
  const { el, clear, card, stat, badge, button, spinner, errorBox } = U;

  /**
   * One language at a time.
   *
   * `bilingual()` deliberately prints "中文 / English" side by side, which is
   * right for a compliance term a worker must recognise in both forms. It is
   * wrong for the responsibility cascade: with three flows, fifteen steps and
   * thirty-eight cards, side-by-side labels turned every caption into visual
   * noise and made the disclaimer under each card repeat thirty-eight times. The
   * cascade reads in the interface language; the bilingual form is used where a
   * term genuinely needs both.
   */
  function L(zh, en) {
    return getLocale() === 'en' ? (en || zh) : zh;
  }

  const KIND_TONE = { initiate: 'info', execute: 'neutral', approve: 'warn', verify: 'warn' };
  const KIND_LABEL = {
    initiate: () => bilingual('发起', 'Initiate'),
    execute: () => bilingual('执行', 'Execute'),
    approve: () => bilingual('批准', 'Approve'),
    verify: () => bilingual('核实', 'Verify'),
  };

  /** The demonstration persona who can administer participants, by preference. */
  function actorForRole(role) {
    const p = state.workflow && state.workflow.participants
      ? state.workflow.participants.find((x) => x.role === role)
      : null;
    return p;
  }

  const state = {
    domains: null,      // /api/domains payload
    domain: null,       // /api/domain/:code payload
    workflow: null,     // /api/explorer/:code payload
    container: null,    // the element to re-render into
    params: null,
    choices: null,      // /api/login-choices: who can be entered as, when public
    // The domain whose flow diagram is shown at the top of the 领域与流程 screen.
    // Deliberately module state, not local: nobody wants their chosen domain to
    // reset every time they come back to the screen.
    flowOverviewDomain: 'ICSR',
  };

  function api(path) { return window.Api.get(path); }

  /**
   * The demonstration accounts, fetched only when nobody is signed in.
   *
   * The domain screen is reachable without a session and offers the identities
   * that work in that domain, so the choice of who to be happens inside the
   * domain rather than in front of it. Once a session exists this is not fetched
   * at all - the roster would be redundant and its usernames are not public.
   */
  async function loadChoices() {
    if (state.choices || window.App.user) return state.choices;
    try {
      const res = await api('/api/login-choices');
      state.choices = res && res.enabled ? res : null;
    } catch { state.choices = null; }
    return state.choices;
  }

  /** Accounts that work in a domain, ranked by how much of its work they own. */
  function rosterFor(areaCode) {
    if (!state.choices || !state.choices.personas) return [];
    return state.choices.personas
      .filter((p) => (p.gxpAreas || []).includes(areaCode))
      .sort((a, b) => {
        const sa = (a.areaSteps && a.areaSteps[areaCode]) || 0;
        const sb = (b.areaSteps && b.areaSteps[areaCode]) || 0;
        if (sb !== sa) return sb - sa;
        if (a.curated !== b.curated) return a.curated ? -1 : 1;
        return String(a.roleLabelZh || a.role).localeCompare(String(b.roleLabelZh || b.role));
      });
  }

  /**
   * A person's job title, unless it only repeats their role name.
   *
   * "主要研究者" printed directly beneath "主要研究者 (PI)" looks like a rendering
   * fault rather than information, so the line is dropped when the title adds
   * nothing to the role label.
   */
  function subtitleOf(persona) {
    const title = String(persona.jobTitle || '').trim();
    if (!title) return '';
    const labels = [persona.roleLabel, persona.roleLabelZh, persona.role]
      .filter(Boolean).map((x) => String(x).trim());
    const bare = labels.map((x) => x.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim());
    return (labels.includes(title) || bare.includes(title)) ? '' : title;
  }

  /**
   * One identity on the start-up screen.
   *
   * The card answers three questions before it is clicked, because after clicking
   * the reader is asked for a password and should already know why: who this is,
   * what they are responsible for, and where they will end up.
   *
   * "Where they will end up" is shown explicitly rather than discovered after
   * signing in. An identity that opens into GLP says so on the card, so the choice
   * is informed rather than a guess the reader has to undo.
   */
  function tenantCard(p) {
    const landing = p.landing || {};
    const landingLabel = landing.view === 'domain' && landing.domain
      ? bilingual(`进入 ${landing.domain}`, `Opens ${landing.domain}`)
      : bilingual('进入领域选择', 'Opens the area list');
    const more = (landing.others && landing.others.length)
      ? bilingual(`，兼 ${landing.others.join('、')}`, `, also ${landing.others.join(', ')}`)
      : '';

    return el('div.identity-card', {
      onclick: () => credentialDialog(p),
      title: bilingual('点击后输入密码进入', 'Click, then enter the password'),
    }, [
      el('div.ic-head', {}, [
        el('span.ic-role', {}, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
        p.curated ? badge(bilingual('示范', 'Curated'), 'ok') : null,
        p.readOnly ? badge(bilingual('只读', 'Read-only'), 'muted') : null,
      ]),
      el('div.ic-name', {}, p.fullName || p.username),
      subtitleOf(p) ? el('div.ic-job', {}, subtitleOf(p)) : null,
      el('div.ic-blurb', {}, getLocale() === 'en' ? (p.blurbEn || p.blurb) : p.blurb),
      el('div.ic-foot', {}, [
        el('span.ic-landing', {}, landingLabel + more),
        typeof p.pendingItems === 'number' && p.pendingItems
          ? el('span.ic-pending', {}, `${p.pendingItems} ${bilingual('项待办', 'pending')}`)
          : null,
      ]),
      el('div.ic-cta', {}, bilingual('输入密码进入 →', 'Enter password \u2192')),
    ]);
  }

  /**
   * Go to a destination after signing in, and make sure the screen actually
   * changes.
   *
   * WHY THIS EXISTS
   * ---------------
   * Assigning `location.hash` only triggers the router when the value differs from
   * the current one. Signing in as a whole-site role lands on `#/domains`, and the
   * sign-in screen IS `#/domains` - so the assignment was a no-op, no `hashchange`
   * fired, and the page kept showing the identity list after a successful login.
   * The report was "no response", which was accurate: the login worked and nothing
   * repainted.
   *
   * Setting the hash and rendering directly covers both cases. Rendering twice is
   * harmless: the views rebuild from the API rather than accumulating.
   */
  function navigateAfterSignIn(target) {
    if (window.location.hash !== target) window.location.hash = target;
    // `App.refresh()` is `render()`. Calling it unconditionally covers both cases:
    // when the hash changed, `hashchange` would have rendered on the next tick and
    // this only makes it immediate; when the hash did not change, this is the only
    // render that will happen.
    if (window.App && typeof window.App.refresh === 'function') window.App.refresh();
  }

  /**
   * Sign out and return to the identity list.
   *
   * Called "换一个身份" rather than "退出登录" because on this screen those are the
   * same action, and the second phrasing describes the mechanism instead of what
   * the reader wants to do.
   */
  async function exitToIdentityPicker() {
    try { await window.Api.post('/api/auth/logout'); } catch { /* already gone */ }
    window.App.user = null;
    window.App.permissions = [];
    window.App.session = null;
    state.choices = null;
    // The screen is already #/domains, so nothing would fire; render explicitly.
    if (window.App && typeof window.App.refresh === 'function') window.App.refresh();
    U.toast(bilingual('已退出，请重新选择身份', 'Signed out; choose an identity'), 'ok', 4000);
  }

  /**
   * Ask for the password, then sign in and go to where this identity works.
   *
   * WHY A PASSWORD IS ASKED FOR AT ALL, GIVEN IT IS SHARED
   * -----------------------------------------------------
   * A list of identities is not authentication. Letting somebody click a name and
   * be inside - which is what this screen used to do - demonstrates authorisation
   * with the authentication removed, and an authentication step that can be
   * skipped teaches a reader that it is optional. The password being shared across
   * the demonstration accounts is a labelled risk; it is not a reason to remove
   * the step that a real deployment depends on.
   *
   * The published credential is offered as a hint inside the dialog, because on a
   * demonstration instance the reader has to be able to get in. What they cannot
   * do is get in without typing it.
   */
  function credentialDialog(persona) {
    const choices = state.choices || {};
    const demo = choices.enabled ? choices.password : null;

    U.modal({
      title: bilingual('输入密码', 'Enter password'),
      width: '480px',
      render: (close) => {
        const input = el('input.input', {
          type: 'password',
          name: 'password',
          autocomplete: 'current-password',
          placeholder: bilingual('登录密码', 'Password'),
        });
        const error = el('div.form-error');
        error.style.display = 'none';

        const submit = async () => {
          const password = input.value;
          if (!password) {
            error.textContent = bilingual('请输入密码', 'Enter the password');
            error.style.display = '';
            input.focus();
            return;
          }
          error.style.display = 'none';
          const btn = submitBtn;
          btn.disabled = true;
          btn.textContent = bilingual('正在验证…', 'Verifying…');
          try {
            const res = await window.Api.post('/api/auth/login', {
              username: persona.username, password,
            });
            window.App.user = res.user;
            window.App.permissions = res.user.permissions || [];
            window.App.session = res.session;
            close();
            // Land where this identity actually works, rather than at a menu.
            // `navigateAfterSignIn` renders unconditionally, because a whole-site
            // role's destination IS this screen and an equal hash assignment fires
            // no event - the bug that made a successful sign-in look like nothing.
            const target = persona.landing && persona.landing.view === 'domain' && persona.landing.domain
              ? `#/domain/${encodeURIComponent(persona.landing.domain)}`
              : '#/domains';
            navigateAfterSignIn(target);
            U.toast(bilingual(
              `已进入：${persona.roleLabelZh}`,
              `Signed in as ${persona.roleLabel}`
            ), 'ok', 4000);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = bilingual('进入', 'Sign in');
            error.textContent = err.code === 'INVALID_CREDENTIALS'
              ? bilingual('密码不正确', 'Incorrect password')
              : (err.message || bilingual('登录失败', 'Sign-in failed'));
            error.style.display = '';
            input.select();
          }
        };

        const submitBtn = button(bilingual('进入', 'Sign in'), {
          variant: 'primary',
          onclick: submit,
        });

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        });
        setTimeout(() => input.focus(), 60);

        return [
          el('div.cred-who', {}, [
            el('div.cred-name', {}, persona.fullName || persona.username),
            el('div.cred-role', {}, getLocale() === 'en' ? persona.roleLabel : persona.roleLabelZh),
            // The job title is often just the role name again ("主要研究者" under
            // "主要研究者 (PI)"). Showing it twice reads as a rendering fault, so
            // it appears only when it says something the role label did not.
            subtitleOf(persona) ? el('div.cred-job', {}, subtitleOf(persona)) : null,
          ]),
          el('div.cred-field', {}, [
            el('label.field-label', {}, bilingual('登录密码', 'Password')),
            input,
            error,
          ]),
          demo
            ? el('div.cred-hint', {}, [
                el('span', {}, bilingual('演示实例的统一密码：', 'Shared password on this demonstration instance: ')),
                el('code.mono', {}, demo),
              ])
            : null,
          el('div.modal-actions', {}, [
            button(t('common.cancel'), { variant: 'ghost', onclick: close }),
            submitBtn,
          ]),
        ];
      },
    });
  }

  /**
   * Sign in as a demonstration account, trying the published credential first.
   *
   * The shared password was once written as two literals in two files, the same
   * words in a different order, so an instance seeded before that was unified
   * holds the old value for half its accounts. Falling back here means a click on
   * an identity never fails in front of the person who clicked it.
   */
  async function enterAs(username, domainCode) {
    const choices = state.choices;
    if (!choices) return;
    const candidates = choices.passwordCandidates && choices.passwordCandidates.length
      ? choices.passwordCandidates
      : [choices.password];
    const overlay = el('div.identity-overlay', {}, [
      el('div.identity-box', {}, [spinner(bilingual('正在进入…', 'Signing in…'))]),
    ]);
    document.body.appendChild(overlay);
    let lastErr = null;
    try {
      let res = null;
      for (const password of candidates) {
        try {
          res = await window.Api.post('/api/auth/login', { username, password });
          break;
        } catch (err) {
          lastErr = err;
          if (err.code !== 'INVALID_CREDENTIALS') break;
        }
      }
      if (!res) throw lastErr || new Error('login failed');
      window.App.user = res.user;
      window.App.permissions = res.user.permissions || [];
      window.App.session = res.session;
      overlay.remove();
      window.App.refresh();
      // `navigateAfterSignIn` rather than a bare hash assignment: assigning a hash
      // equal to the current one does not fire `hashchange`, so signing in as a
      // whole-site role while already on #/domains produced a successful sign-in
      // and a screen that never repainted. The user saw the identity list still
      // there and reasonably reported that nothing happened.
      navigateAfterSignIn(`#/domain/${encodeURIComponent(domainCode)}`);
      U.toast(bilingual(`已进入 ${domainCode}`, `Entered ${domainCode}`), 'ok', 4000);
    } catch (err) {
      overlay.remove();
      U.toast(err.message || bilingual('进入失败', 'Sign-in failed'), 'bad', 8000);
    }
  }

  function demoBanner(demo) {
    if (!demo || !demo.enabled) return null;
    return el('div.demo-warning', {}, [
      el('div.dw-icon', {}, '\u26a0'),
      el('div.dw-body', {}, [
        el('div.dw-title', {}, bilingual('演示模式：统一密码', 'Demonstration mode: shared password')),
        el('div.dw-credential', {}, [
          el('span', {}, bilingual('统一密码', 'Shared password')),
          el('code.mono', {}, demo.password),
        ]),
        el('div.dw-note', {}, getLocale() === 'en' ? demo.warningEn : demo.warning),
        el('div.dw-legal', {}, '21 CFR Part 11.300(a) · GVP Module I'),
      ]),
    ]);
  }

  // ============================================ the domain's workflows, drawn ==

  /**
   * The area's processes drawn as a responsibility cascade.
   *
   * The shape is the point. Reading a GxP process means answering three questions
   * in order, and the screen answers them stacked:
   *
   *     step  →  the people responsible for it  →  what each of them may do
   *
   * horizontally for the steps, vertically for the cascade underneath each one.
   * The previous layout put the flow in one card, the roles in a second and the
   * permission matrix in a third, which left the reader to join them by hand
   * across a screen and a half of scrolling.
   *
   * Only the dedicated processes are fetched on load. A shared process such as
   * CAPA is eleven steps across four areas and appears in every domain; pulling
   * all of them would be eight requests and the same diagram shown repeatedly.
   * Those are one click away, by name.
   */
  function flowsSection(area, processes, container, params, domainData) {
    const dedicated = processes.filter((p) => p.dedicated);
    const shared = processes.filter((p) => !p.dedicated);

    const host = el('div.domain-flows');
    const sharedHost = el('div.domain-flows');

    const loadInto = (target, list) => {
      clear(target);
      target.appendChild(spinner(bilingual('正在载入工作流…', 'Loading workflows…')));
      Promise.all(list.map((p) => api(`/api/explorer/${encodeURIComponent(p.code)}?includeAllRoles=0`)
        .then((wf) => ({ wf }))
        .catch(() => null)))
        .then((results) => {
          clear(target);
          const ok = results.filter(Boolean);
          if (!ok.length) {
            target.appendChild(el('p.card-foot-note', {}, bilingual('工作流载入失败。', 'Could not load the workflows.')));
            return;
          }
          for (const { wf } of ok) target.appendChild(flowCascade(wf, domainData));
        });
    };

    if (dedicated.length) loadInto(host, dedicated);

    const sharedButton = shared.length
      ? button(bilingual(
          `显示另外 ${shared.length} 条跨领域流程`,
          `Show the other ${shared.length} shared process(es)`
        ), {
          variant: 'ghost',
          onclick: (ev) => {
            ev.target.disabled = true;
            loadInto(sharedHost, shared);
          },
        })
      : null;

    return card(
      bilingual(`${area.code} 工作流程与责任分工`, `${area.code} workflows and who is responsible`),
      [host, sharedButton, sharedHost],
      {
        subtitle: dedicated.length
          ? bilingual(
              `本领域的 ${dedicated.length} 条专属流程。横向为流程步骤，每一步下方是该步骤负责人的名片与职责，`
              + '名片下方是这个人可以执行的各项权限。'
              + (shared.length ? `另有 ${shared.length} 条跨领域流程（如 CAPA、偏差）本领域也参与。` : ''),
              `The area's own ${dedicated.length} process(es). Steps run left to right; beneath each step are the cards of the`
              + ' people responsible for it, and beneath each card are the permissions that person holds.'
              + (shared.length ? ` Another ${shared.length} shared process(es) also involve this area.` : '')
            )
          : bilingual(
              '本领域没有专属流程，参与的是跨领域流程。',
              'This area has no dedicated processes; it takes part in shared ones.'
            ),
        actions: [button(bilingual('图例', 'Legend'), { variant: 'ghost', onclick: () => showLegendDialog() })],
      }
    );
  }

  /**
   * One process as a cascade: step columns, each holding its people and their
   * permissions.
   */
  function flowCascade(wf, domainData) {
    const proc = wf.process;
    const accounts = (domainData && domainData.roleAccounts) || {};

    return el('div.flow-cascade', {}, [
      el('div.fc-head', {}, [
        el('a.fc-title', { href: `#/workflow/${encodeURIComponent(proc.code)}` },
          getLocale() === 'en' && proc.nameEn ? proc.nameEn : proc.name),
        el('span.fc-code.mono', {}, proc.code),
        el('span.fc-meta', {}, [
          `${wf.summary.stepCount} ${bilingual('步', 'steps')}`,
          wf.summary.signedStepCount ? ` · ${wf.summary.signedStepCount} ${bilingual('需签名', 'signed')}` : '',
          wf.summary.independentStepCount ? ` · ${wf.summary.independentStepCount} ${bilingual('需独立', 'independent')}` : '',
          proc.slaDays ? ` · ${bilingual('时限', 'SLA')} ${proc.slaDays}${bilingual('天', 'd')}` : '',
        ].join('')),
      ]),
      el('div.fc-track', {}, wf.steps.map((step, i) => {
        const column = el('div.fc-col', {
          class: [
            step.signatureMeaning ? 'fc-signed' : '',
            step.independentOfAuthor ? 'fc-independent' : '',
          ].filter(Boolean).join(' '),
        }, [
          // ---- the step, in a stretching inner column ------------------------
          // The inner column spans the full height of the tallest cascade beside
          // it, and centres the step box within that span. Without it, a step with
          // one owner sat at the top while a neighbour with three pushed its arrow
          // into the middle of the flow and the steps stopped reading as a row.
          el('div.fc-col-inner', {}, [
            el('div.fc-step', {}, [
              el('div.fc-step-head', {}, [
                el('span.fc-seq', {}, String(step.seq)),
                badge(KIND_LABEL[step.participationKind] ? KIND_LABEL[step.participationKind]() : step.participationKind,
                  KIND_TONE[step.participationKind] || 'neutral'),
              ]),
              el('div.fc-step-name', {}, getLocale() === 'en' && step.nameEn ? step.nameEn : step.name),
              el('div.fc-step-flags', {}, [
                step.signatureMeaning
                  ? el('span.fc-flag.fc-flag-sig', {}, `\u2712 ${U.meaningLabel(step.signatureMeaning)}`)
                  : null,
                step.independentOfAuthor
                  ? el('span.fc-flag.fc-flag-ind', {}, L('独立性', 'Independent'))
                  : null,
                step.optional ? el('span.fc-flag.fc-flag-opt', {}, L('可选', 'Optional')) : null,
              ]),
            ]),
            // ---- the people responsible, each with duties and permissions ----
            el('div.fc-people', {}, step.roles.map((r) => personCascade(r, wf, accounts))),
          ]),
        ]);
        if (i < wf.steps.length - 1) column.appendChild(el('div.fc-arrow', {}, '\u25b6'));
        return column;
      })),
      el('div.fc-foot', {}, [
        el('a.fc-more', { href: `#/workflow/${encodeURIComponent(proc.code)}` },
          bilingual('打开完整流程页 →', 'Open the full process page \u2192')),
        el('span.fc-foot-note', {}, L(
          '每张名片下方的权限均由服务端强制校验：列出的是这个人实际可以执行的操作，未列出的一律无权执行。',
          'Every permission shown under a card is enforced server-side: these are the actions that person can actually take, and nothing else.'
        )),
      ]),
    ]);
  }

  /**
   * One responsible role: the person's card, then their permissions.
   *
   * The card carries the person's name and job title because a slide with a job
   * title and no name is an org chart, not a responsibility assignment. The
   * permissions are collapsed behind a count so the flow stays readable, and open
   * into three groups - what the role may do, what it may do subject to a
   * constraint, and nothing else. Showing only the first group would repeat the
   * mistake the whole system avoids: claiming a capability the kernel will refuse.
   */
  function personCascade(role, wf, accounts) {
    const participant = (wf.participants || []).find((p) => p.role === role) || {};
    const info = accounts[role] || {};
    const account = (info.accounts && info.accounts[0]) || (participant.accounts && participant.accounts[0]) || null;
    const en = getLocale() === 'en';
    // Every field falls back through the domain's role table, because an
    // anonymous visitor's workflow payload carries no accounts and a card with no
    // name at all is worse than one showing the role.
    const roleLabel = en
      ? (participant.roleLabel || info.roleLabel || role)
      : (participant.roleLabelZh || info.roleLabelZh || role);
    const duty = en
      ? (info.dutyEn || participant.dutyEn || '')
      : (info.duty || participant.duty || '');
    const perms = (wf.permissionsByRole || {})[role] || { allowed: [], conditional: [], total: 0 };
    const colour = roleColour(role);

    const body = el('div.pc-perms-body');
    let opened = false;
    const openPerms = () => {
      opened = !opened;
      clear(body);
      if (!opened) return;
      if (perms.allowed.length) {
        body.appendChild(el('div.pcp-group', {}, [
          el('div.pcp-group-title.pcp-ok', {}, L(`✓ 可执行（${perms.allowed.length}）`, `✓ May do (${perms.allowed.length})`)),
          el('div.pcp-list', {}, perms.allowed.map((r) => el('span.pcp-chip', {}, getLocale() === 'en' ? r.labelEn : r.label))),
        ]));
      }
      if (perms.conditional.length) {
        body.appendChild(el('div.pcp-group', {}, [
          el('div.pcp-group-title.pcp-warn', {}, L(
            `⚠ 有约束（${perms.conditional.length}）`, `⚠ Conditional (${perms.conditional.length})`
          )),
          el('div.pcp-list', {}, perms.conditional.map((r) => el('span.pcp-chip.pcp-chip-cond', {
            title: (r.constraintIds || []).length
              ? L(`${r.constraintIds.length} 项代码强制约束`, `${r.constraintIds.length} code-enforced constraint(s)`)
              : '',
          }, getLocale() === 'en' ? r.labelEn : r.label))),
        ]));
      }
      body.appendChild(el('p.pcp-note', {}, L(
        '未列出的操作该岗位无权执行。',
        'Actions not listed are not available to this role.'
      )));
    };

    return el('div.fc-person', {}, [
      // ---- the person's card ------------------------------------------------
      el('div.fc-card', {
        style: { borderLeftColor: colour },
        onclick: () => openParticipantSheet(Object.assign({}, participant, { role })),
      }, [
        el('div.fc-card-role', { style: { color: colour } }, roleLabel),
        el('div.fc-card-name', {}, account
          ? `${account.fullName}${account.jobTitle ? ` · ${account.jobTitle}` : ''}`
          // With no session the payload carries no account holders. Say so rather
          // than leaving a blank line that reads like a rendering fault.
          : L('选择身份后可看到具体人员', 'Choose an identity to see who holds this')),
        duty ? el('div.fc-card-duty', {}, duty) : null,
        el('div.fc-card-stats', {}, [
          participant.stepCount ? el('span', {}, `${participant.stepCount} ${L('步', 'steps')}`) : null,
          participant.approvalCount
            ? el('span.fc-card-approve', {}, `${participant.approvalCount} ${L('项审批', 'approvals')}`)
            : null,
        ].filter(Boolean)),
      ]),
      // ---- their permissions -------------------------------------------------
      el('div.pc-perms', {}, [
        el('button.pcp-toggle', {
          type: 'button',
          onclick: openPerms,
        }, L(`各项权限 ${perms.total} 项 ▾`, `${perms.total} permissions ▾`)),
        body,
      ]),
    ]);
  }

  /** @deprecated kept only so an older call site cannot break the bundle. */
  function flowPreview(wf) {
    return flowCascade(wf, state.domain);
  }

  // ================================================== identity inside a domain ==
  /**
   * Who to enter the domain as.
   *
   * This sits INSIDE the domain screen, after the process list and the flow, not
   * in front of it. That ordering matches how somebody actually arrives: they
   * know they work in GLP, they want to see what GLP involves, and only then do
   * they have an opinion about which of its roles to look through. Being asked to
   * pick a job title before seeing any of the work asked the question backwards.
   */
  function identityPanel(area, roster) {
    if (!roster.length) return el('div');

    const core = roster.filter((p) => ((p.areaSteps && p.areaSteps[area.code]) || 0) > 0);
    const others = roster.filter((p) => !core.includes(p));

    // Named personaCard, not `card`: a local `card` shadowed the imported
    // card() helper and silently turned the panel into a single stray tile.
    const personaCard = (p) => {
      const steps = (p.areaSteps && p.areaSteps[area.code]) || 0;
      const en = getLocale() === 'en';
      return el('button.persona-card', {
        type: 'button',
        onclick: () => enterAs(p.username, area.code),
      }, [
        el('div.persona-head', {}, [
          el('span.persona-role', {}, en ? (p.roleLabel || p.role) : (p.roleLabelZh || p.roleLabel || p.role)),
          steps
            ? el('span.persona-steps', {
                title: bilingual(
                  `在 ${area.code} 的流程中负责 ${steps} 个步骤`,
                  `Owns ${steps} step(s) in ${area.code} processes`
                ),
              }, `${steps} ${bilingual('步骤', 'steps')}`)
            : el('span.persona-pending.persona-pending-zero', {}, '—'),
        ]),
        el('div.persona-name', {}, en && p.fullNameEn ? p.fullNameEn : p.fullName),
        el('div.persona-job', {}, p.jobTitle || ''),
        el('div.persona-blurb', {}, en && p.blurbEn ? p.blurbEn : p.blurb),
        p.highlight ? el('div.persona-highlight', {}, p.highlight) : null,
      ]);
    };

    return card(
      bilingual('选择身份进入 ' + area.code, 'Choose an identity to enter ' + area.code),
      [
        el('div.identity-note', {}, bilingual(
          `以上是 ${area.code} 的全部公开信息：流程、岗位、职责与权限对应表。`
          + '选择一个身份后，你看到的就是这个人在该领域中的待办、可执行操作与界面——'
          + '权限由服务端强制，不同身份看到的内容不同。',
          `Everything above is ${area.code}'s public reference material: its processes, roles, duties and permission matrix. `
          + 'Choose an identity to see the work list, available actions and interface that person has in this domain. '
          + 'Permissions are enforced server-side, so different identities genuinely see different things.'
        )),
        core.length ? el('div.persona-section-title', {}, bilingual(
          `在 ${area.code} 中承担职责的岗位`, `Roles carrying responsibility in ${area.code}`
        )) : null,
        core.length ? el('div.persona-grid', {}, core.map(personaCard)) : null,
        others.length ? el('div.persona-section-title.persona-section-sub', {}, bilingual(
          `其他可进入 ${area.code} 的身份`, `Other identities that can enter ${area.code}`
        )) : null,
        others.length ? el('div.persona-grid.persona-grid-sub', {}, others.map(personaCard)) : null,
        state.choices && state.choices.password
          ? el('div.warning-note', {}, bilingual(
              `演示用统一密码 ${state.choices.password}，点击身份即可进入，无需输入。`
              + '共用密码违反 21 CFR Part 11.300(a)「账号唯一」的要求，真实部署必须为每人签发独立凭证。',
              `Demonstration shared password ${state.choices.password} - clicking an identity enters directly. `
              + 'A shared password violates the unique-account requirement of 21 CFR Part 11.300(a); a real deployment must issue individual credentials.'
            ))
          : null,
      ],
      {
        subtitle: bilingual(
          `${roster.length} 个身份可进入本领域，按在本领域流程中承担的步骤数排序。`,
          `${roster.length} identities can enter this area, ranked by the number of steps they own in its processes.`
        ),
      }
    );
  }

  // ============================================================ domain picker ==

  /**
 * The flow diagram block at the very top of the 领域与流程 screen.
 *
 * WHY IT EXISTS AT TOP, NOT BEHIND A CLICK
 * ----------------------------------------
 * The screen used to offer area cards and nothing else, and the flow diagrams
 * lived one navigation deeper. The net effect was "area and workflows" with no
 * workflow in sight: the thing the item is named after was hiding behind a click
 * into a card. This block shows a workflow diagram as soon as the screen opens -
 * a strip of area chips, and under it the cascades of the chosen area, fetched
 * lazily. Nothing about it needs a session: a process diagram is reference
 * material, and reference material is public.
 */
function flowOverviewSection(domains) {
  const selected = state.flowOverviewDomain || (domains[0] && domains[0].code) || 'ICSR';

  const chips = el('div.df-chips');
  const body = el('div.df-body');

  const render = async (code) => {
    state.flowOverviewDomain = code;
    for (const chip of chips.children) {
      chip.classList.toggle('active', chip.getAttribute('data-code') === code);
    }
    clear(body);
    body.appendChild(spinner(bilingual('正在载入流程图…', 'Loading the flow diagram…')));
    try {
      const payload = await api(`/api/domain/${encodeURIComponent(code)}`);
      // The domain payload carries no top-level `code`; build the area from the
      // chip's code, or the flows Section header would read "undefined …".
      const area = { code, name: payload.name, nameEn: payload.nameEn };
      clear(body);
      body.appendChild(flowsSection(area, payload.processes || [], body, {}, payload));
    } catch (err) {
      clear(body);
      body.appendChild(errorBox(err, () => render(code)));
    }
  };

  for (const d of domains) {
    chips.appendChild(el('button.df-chip', {
      type: 'button',
      'data-code': d.code,
      class: d.code === selected ? 'active' : '',
      onclick: () => render(d.code),
    }, d.code));
  }

  render(selected);

  return el('section.df-overview', {}, [
    el('div.is-head', {}, [
      el('h2.is-title', {}, bilingual('工作流程图', 'Workflow diagram')),
      el('span.is-note', {}, bilingual(
        '切换到任意领域，其流程图的横向步骤、责任人与权限立即显示',
        'Switch to any area to see its workflow steps, the people responsible and their permissions'
      )),
    ]),
    chips,
    body,
  ]);
}

async function renderDomains(container) {
    clear(container);
    container.appendChild(spinner());
    let data;
    try {
      data = await api('/api/domains');
    } catch (err) {
      clear(container);
      container.appendChild(errorBox(err, () => renderDomains(container)));
      return;
    }
    state.container = container;
    clear(container);

    // The choices are fetched once and cached: they are what the identity cards
    // are built from, and re-fetching them per render would rebuild the whole
    // cast on every navigation.
    if (!state.choices) {
      try { state.choices = await api('/api/login-choices'); } catch { state.choices = null; }
    }
    const choices = state.choices;

    const view = el('div.view');
    const banner = demoBanner(data.demoLogin);
    if (banner) view.appendChild(banner);

    // ---- the flow diagram, at the very top ----------------------------------
    // The item is named "领域与流程"; it opens with a workflow diagram, not only
    // with cards. Placed above the page head deliberately: this is the one thing
    // somebody who clicked "领域与流程" came to see.
    view.appendChild(flowOverviewSection(data.domains));

    // The order of the two blocks depends on whether anybody has signed in. That
    // order is a real requirement, not a preference. This screen asks "who are
    // you"; once the answer exists, asking again is noise. A signed-in whole-site
    // identity (QA, internal audit, the QP - people who genuinely have to choose)
    // therefore gets the AREA list first and the identity cards below as a
    // switching drawer. An anonymous visitor gets the identity list first, because
    // for them the question is live.
    const signedIn = Boolean(window.App.user);

    // ---- head ----------------------------------------------------------------
    view.appendChild(el('div.view-head', {}, [
      el('div', {}, [
        signedIn
          ? el('h1.view-title', {}, bilingual('选择领域工作', 'Choose an area to work in'))
          : el('h1.view-title', {}, bilingual('选择身份进入', 'Choose an identity to enter')),
        el('p.view-sub', {}, signedIn
          ? bilingual(
              '你的身份已确认。选择一个领域查看它的工作流、岗位职责与权限矩阵；身份卡在下方，用于切换身份。',
              'Your identity is confirmed. Pick an area to see its workflows, role duties and permission matrix; '
              + 'the identity cards below are for switching.'
            )
          : bilingual(
              '选择一个身份并输入密码，系统会带你进入该身份的专属界面——你负责的领域、待你处理的事项、'
              + '以及你在这个领域里能看到和能做的事情。',
              'Pick an identity and enter its password. The system opens the interface that belongs to it: the area you '
              + 'are responsible for, the work waiting on you, and what you can see and do there.'
            )),
      ]),
    ]));

    if (signedIn) {
      // A whole-site identity lands back on this very screen, because the area
      // list IS its interface. Without a block that says so, a successful sign-in
      // looks identical to a failed one: the same grid of cards is on screen. So
      // the current identity is stated at the top, with the way into the instance
      // spelled out, rather than leaving the reader to infer it from a sign-out
      // button in the corner.
      const u = window.App.user;
      const home = choices && choices.personas ? choices.personas.find((p) => p.username === u.username) : null;
      const landing = (home && home.landing) || { view: 'domains' };
      view.appendChild(el('div.signed-in-banner', {}, [
        el('div.sib-who', {}, [
          el('div.sib-label', {}, bilingual('当前身份', 'Signed in as')),
          el('div.sib-name', {}, u.fullName || u.username),
          el('div.sib-role', {}, u.roleLabel || u.role),
        ]),
        el('div.sib-actions', {}, [
          landing.view === 'domain' && landing.domain
            ? button(bilingual(`返回我的界面（${landing.domain}）`, `Back to my interface (${landing.domain})`), {
                variant: 'primary',
                onclick: () => { window.location.hash = `#/domain/${encodeURIComponent(landing.domain)}`; },
              })
            : button(bilingual('进入系统', 'Enter the system'), {
                variant: 'primary',
                onclick: () => { window.location.hash = '#/inbox'; },
              }),
          button(bilingual('换一个身份', 'Switch identity'), {
            variant: 'ghost',
            onclick: () => { exitToIdentityPicker(); },
          }),
        ]),
      ]));
    }

    // ---- the areas, with their workflows one click away ----------------------
    // The reference material - every area's processes, its roles and the
    // permission matrix - is deliberately public. What needs an identity is the
    // instance state: records, people and pending work.
    const domainsCard = card(
      bilingual('选择领域', 'Choose an area'),
      [
        el('p.card-foot-note', {}, bilingual(
          signedIn
            ? '选择一个领域进入它的专属界面：工作流级联图、岗位职责与你的信息权限对应表。'
            : '不必登录即可查看每个领域的流程、岗位职责与权限矩阵——这些是参考模型，不是受控记录。'
              + '记录内容、人员信息与待办事项需要选择身份后才能看到。',
          signedIn
            ? 'Pick an area to open its dedicated interface: the workflow cascade, role duties, and the permission matrix.'
            : 'The processes, role duties and permission matrices of every area are readable without signing in: they are '
              + 'reference material, not controlled records. Record contents, people and pending work require an identity.'
        )),
        el('div.domain-card-grid', {}, data.domains.map((d) => {
          const colour = d.colour || 'var(--brand)';
          return el('a.domain-card', {
            href: `#/domain/${encodeURIComponent(d.code)}`,
            style: { borderTopColor: colour },
          }, [
            el('div.dc-head', {}, [
              el('span.dc-code', { style: { color: colour } }, d.code),
              d.ready
                ? badge(bilingual('完整', 'Complete'), 'ok')
                : badge(bilingual('部分', 'Partial'), 'muted'),
            ]),
            el('div.dc-full', {}, d.fullName),
            el('div.dc-name', {}, d.name),
            el('div.dc-desc', {}, U.truncate(d.description || '', 120)),
            el('div.dc-stats', {}, [
              el('span.dc-stat', {}, el('strong', {}, String(d.processCount)), bilingual(' 条流程', ' processes')),
              el('span.dc-stat', {}, el('strong', {}, String(d.dedicatedProcessCount)), bilingual(' 条专属', ' dedicated')),
              el('span.dc-stat', {}, el('strong', {}, String(d.participantCount)), bilingual(' 个岗位', ' roles')),
              el('span.dc-stat', {}, el('strong', {}, String(d.recordCount)), bilingual(' 条记录', ' records')),
            ]),
            el('div.dc-cta', {}, bilingual('进入该领域 →', 'Enter this domain \u2192')),
          ]);
        })),
        el('p.card-foot-note', {}, bilingual(
          '「完整」指该领域同时具备专属流程、专属检查表和至少一条真实记录。'
          + '标记为「部分」的领域是横切主题（如数据完整性），其内容分散在各自的检查表中，'
          + '而不是拥有独立的流程——这是刻意的，因为给它们编造专属流程才是错的。',
          '"Complete" means the domain has dedicated processes, a dedicated checklist and at least one real record. '
          + 'Domains marked "partial" are cross-cutting topics (data integrity) whose content lives in their own '
          + 'checklists rather than in dedicated processes - deliberately so, since inventing processes for them would be wrong.'
        )),
      ],
      {
        subtitle: signedIn
          ? bilingual(
              `${data.domains.length} 个 PV 领域；进入后即见该领域的工作流程图。`,
              `${data.domains.length} PV areas; opening one shows its workflow diagram first.`
            )
          : bilingual(
              `${data.domains.length} 个 PV 领域，参考模型对所有人公开。`,
              `${data.domains.length} PV areas, whose reference material is public.`
            ),
      }
    );

    // ---- who are you (for switching / for signing in) ------------------------
    // Grouped by how far each identity reaches. The first group is the one that
    // covers the whole site, because those are the people who genuinely have to
    // choose an area; the second is everybody who already knows theirs.
    const identityBlocks = [];
    if (choices && choices.personas && choices.personas.length) {
      const wholeSystem = choices.personas.filter((p) => p.scope === 'whole_system');
      const domainRoles = choices.personas.filter((p) => p.scope === 'domain');
      const otherRoles = choices.personas.filter((p) => p.scope !== 'whole_system' && p.scope !== 'domain');
      const section = (title, note, cards) => el('section.identity-section', {}, [
        el('div.is-head', {}, [
          el('h2.is-title', {}, title),
          el('span.is-note', {}, note),
        ]),
        el('div.identity-grid', {}, cards),
      ]);

      if (wholeSystem.length) {
        identityBlocks.push(section(
          bilingual('全域职责', 'Whole-site responsibility'),
          signedIn
            ? bilingual('你的职责覆盖全部领域，先在下方选择要查看的领域', 'Your role spans every area; pick one above to begin')
            : bilingual('职责覆盖全部 PV 领域，登录后需要先选择要查看的领域', 'Spans every PV area; after signing in these choose which area to view'),
          wholeSystem.map((p) => tenantCard(p))
        ));
      }
      if (domainRoles.length) {
        identityBlocks.push(section(
          bilingual('各领域负责人', 'Area responsibilities'),
          bilingual(
            '登录后直接进入该身份的专属界面',
            'Signing in opens that identity\'s own interface directly'
          ),
          domainRoles.map((p) => tenantCard(p))
        ));
      }
      if (otherRoles.length) {
        identityBlocks.push(section(
          bilingual('其他身份', 'Other identities'),
          bilingual('未承担具体领域的流程职责', 'No process responsibility in any one area'),
          otherRoles.map((p) => tenantCard(p))
        ));
      }
    }

    // ---- assemble ------------------------------------------------------------
    if (signedIn) {
      // Identity is already known: the areas come first, the cards become a
      // switching drawer below them.
      view.appendChild(domainsCard);
      for (const block of identityBlocks) view.appendChild(block);
    } else {
      for (const block of identityBlocks) view.appendChild(block);
      view.appendChild(domainsCard);
    }

    container.appendChild(view);
  }

  // ========================================================== domain interface ==

  async function renderDomain(container, params) {
    clear(container);
    container.appendChild(spinner());
    let data;
    try {
      // Fetch the roster alongside the domain so the identity panel is ready when
      // the reference material has rendered. loadChoices() is a no-op once a
      // session exists.
      const [domainData] = await Promise.all([
        api(`/api/domain/${encodeURIComponent(params.code)}`),
        loadChoices(),
      ]);
      data = domainData;
    } catch (err) {
      clear(container);
      container.appendChild(errorBox(err, () => renderDomain(container, params)));
      return;
    }
    state.container = container;
    state.params = params;
    state.domain = data;
    clear(container);

    const area = data.area;
    const colour = area.colour || 'var(--brand)';
    const signedIn = Boolean(window.App.user);
    const roster = rosterFor(area.code);

    const view = el('div.view', {}, [
      el('div.view-head', {}, [
        el('div', {}, [
          el('div.breadcrumb', {}, [
            el('a', { href: '#/domains' }, bilingual('全部领域', 'All domains')),
          ]),
          el('h1.view-title', {}, [
            el('span.domain-code-lg', { style: { color: colour } }, area.code),
            el('span.title-sep', {}, ' · '),
            area.name,
          ]),
          el('p.view-sub', {}, area.fullName + (area.description ? ` — ${area.description}` : '')),
        ]),
        el('div.view-head-actions', {}, [
          // The topbar carries the same controls, but a person who has just
          // entered a domain looks at this header, not at the far corner of the
          // screen. Entering a domain used to be a one-way door.
          signedIn
            ? button(bilingual('切换身份', 'Switch identity'), {
                variant: 'ghost',
                title: bilingual('退出当前身份并回到领域选择', 'Sign out of this identity and return to the domain picker'),
                onclick: async () => {
                  try { await window.Api.post('/api/auth/logout'); } catch { /* sign out regardless */ }
                  window.App.user = null;
                  window.App.permissions = [];
                  window.App.session = null;
                  window.location.hash = '#/domains';
                  window.App.refresh();
                },
              })
            : null,
          button(bilingual('返回领域选择', 'Back to domains'), {
            variant: signedIn ? 'ghost' : 'primary',
            onclick: () => { window.location.hash = '#/domains'; },
          }),
          button(bilingual('刷新', 'Refresh'), { variant: 'ghost', onclick: () => renderDomain(container, params) }),
        ]),
      ]),
    ]);

    // ---- the identity choice, in the domain rather than in front of it -------
    if (!signedIn) {
      view.appendChild(identityPanel(area, roster));
    }

    if (signedIn) {
      const banner = demoBanner(data.demoLogin);
      if (banner) view.appendChild(banner);
    }

    view.appendChild(el('div.stat-strip', {}, [
      stat(bilingual('本领域流程', 'Processes here'), data.summary.processCount, {
        title: bilingual('含本领域参与的通用流程', 'Including shared processes this area takes part in'),
      }),
      stat(bilingual('专属流程', 'Dedicated'), data.summary.dedicatedProcessCount, { tone: 'ok' }),
      stat(bilingual('参与岗位', 'Roles involved'), data.summary.participantCount),
      stat(bilingual('未关闭记录', 'Open records'), data.summary.openRecords, {
        tone: data.summary.openRecords ? 'warn' : 'ok',
      }),
      stat(bilingual('记录总数', 'Records'), data.summary.totalRecords),
    ]));

    // ---- the workflows, first ----------------------------------------------
    // The flow is what somebody came here to see, so it comes first. It used to
    // sit behind the identity panel, the process list and the role grid, which
    // put it roughly four thousand pixels down a six-and-a-half-thousand-pixel
    // page - and prompted the fair question of whether it existed at all.
    //
    // The order inside each flow answers three questions in the order they are
    // asked: this is the step, this is who owns it, these are their permissions.
    view.appendChild(flowsSection(area, data.processes, container, params, data));

    // ---- this domain's processes -------------------------------------------
    view.appendChild(processListCard(area, data));

    // ---- this domain's participants ----------------------------------------
    view.appendChild(card(
      bilingual(`${area.code} 的参与岗位与职责`, `${area.code} roles and duties`),
      [
        el('p.card-foot-note', {}, bilingual(
          '以下岗位在 ' + area.code + ' 的流程中承担职责。点击岗位可查看其完整权限与约束，并可切换为该身份进入系统。',
          `The roles below carry responsibility in ${area.code} processes. Click one to see its full permissions and constraints, and to enter the system as that person.`
        )),
        el('div.participant-grid', {}, data.participants.map((p) => participantCard(p))),
      ],
      {
        subtitle: bilingual(
          `${data.participants.length} 个岗位参与本领域的流程，全部可切换身份进入。`,
          `${data.participants.length} roles take part in this area's processes, all of which can be signed in as.`
        ),
      }
    ));

    /** The area's processes as a list, with live record counts. */
  function processListCard(area, data) {
        return card(
      bilingual(`${area.code} 的流程`, `${area.code} processes`),
      [
        el('div.domain-flow-list', {}, data.processes.map((p) => el('a.domain-flow-row', {
          href: `#/workflow/${encodeURIComponent(p.code)}`,
        }, [
          el('div.dfr-main', {}, [
            el('div.dfr-title', {}, [
              el('span.dfr-name', {}, getLocale() === 'en' && p.nameEn ? p.nameEn : p.name),
              el('span.dfr-code.mono', {}, p.code),
              p.dedicated
                ? badge(bilingual('专属', 'Dedicated'), 'ok')
                : badge(bilingual('跨领域', 'Shared'), 'muted'),
            ]),
            el('div.dfr-desc', {}, U.truncate(getLocale() === 'en' && p.descriptionEn ? p.descriptionEn : p.description, 150)),
            el('div.dfr-meta', {}, [
              el('span', {}, `${p.stepCount} ${bilingual('步骤', 'steps')}`),
              el('span', {}, `${p.participantCount} ${bilingual('个岗位', 'roles')}`),
              p.signedStepCount ? el('span.dfr-sig', {}, `${p.signedStepCount} ${bilingual('需签名', 'signed')}`) : null,
              p.independentStepCount ? el('span.dfr-ind', {}, `${p.independentStepCount} ${bilingual('需独立性', 'independent')}`) : null,
              p.slaDays ? el('span', {}, `${bilingual('时限', 'SLA')} ${p.slaDays}${bilingual('天', 'd')}`) : null,
            ]),
          ]),
          el('div.dfr-counts', {}, [
            el('div.dfr-count', {}, [
              el('strong', {}, String(p.instanceCount)),
              el('span', {}, bilingual('记录', 'records')),
            ]),
            p.openCount
              ? el('div.dfr-count.dfr-open', {}, [
                  el('strong', {}, String(p.openCount)),
                  el('span', {}, bilingual('未关闭', 'open')),
                ])
              : null,
          ]),
          el('div.dfr-cta', {}, bilingual('查看工作流 →', 'View workflow \u2192')),
        ]))),
      ],
      {
        subtitle: bilingual(
          `${data.summary.dedicatedProcessCount} 条为本领域专属流程，其余为本领域参与的跨领域流程。点击任意一条查看工作流示意图、各参与者职责与权限。`,
          `${data.summary.dedicatedProcessCount} are dedicated to this area; the rest are shared processes this area takes part in. `
          + 'Open any one to see its flow diagram, the duties of each participant, and their permissions.'
        ),
      }
    );
  }

    // ---- the matrix for this domain ---------------------------------------
    view.appendChild(matrixCard(data.matrix, {
      title: bilingual(`${area.code} 信息权限对应表`, `${area.code} permission matrix`),
      roles: data.participants.map((p) => p.role),
      subtitle: bilingual(
        `${data.participants.length} 个岗位 × ${data.matrix.permissionTotal} 项权限 × ${data.matrix.constraintCount} 项代码强制约束。`
        + '⚠ 表示该岗位持有此权限，但另有代码强制规则可能拒绝该操作。',
        `${data.participants.length} roles across ${data.matrix.permissionTotal} permissions and ${data.matrix.constraintCount} code-enforced constraints. `
        + '⚠ means the role holds the permission but a code-enforced rule may still refuse the action.'
      ),
    }));

    // ---- the inspection side of the same domain ---------------------------
    if (data.checklists.length) {
      view.appendChild(card(
        bilingual(`${area.code} 的法规自查表`, `${area.code} checklists`),
        [
          el('div.process-grid', {}, data.checklists.map((c) => el('a.process-card', {
            href: `#/checklists/${encodeURIComponent(c.code)}`,
          }, [
            el('div.process-head', {}, [
              el('span.process-name', {}, c.title),
              el('span.process-code.mono', {}, c.code),
            ]),
            el('div.process-meta', {}, [
              el('span', {}, `${c.itemCount} ${bilingual('项要求', 'requirements')}`),
            ]),
            el('div.process-cta', {}, bilingual('打开自查表 →', 'Open the checklist \u2192')),
          ]))),
        ],
        {
          subtitle: bilingual(
            '这些检查表覆盖本领域。自查发现的缺陷可直接转为受控 CAPA。',
            'These checklists cover this area. A finding raised during self-inspection converts into a controlled CAPA.'
          ),
        }
      ));
    }

    container.appendChild(view);
  }

  // ==================================================== participant card/shared ==

  /**
   * The demo credential for whichever level is on screen.
   *
   * Reading only `state.workflow` was a real bug: on the domain page that value
   * is null, so every participant card rendered as "no account" and none of them
   * were clickable - on the very page whose purpose is to show who is involved
   * and let you enter as them. It also survived an API-level test that checked
   * `loginable` on the payload, because the payload was right; only the view was
   * wrong. The browser check in test/assets.js now asserts the rendered cards.
   */
  function currentDemoLogin() {
    return (state.workflow && state.workflow.demoLogin)
      || (state.domain && state.domain.demoLogin)
      || null;
  }

  /**
   * Show why a card cannot be opened.
   *
   * A greyed card that says nothing teaches the reader nothing and invites them
   * to look for a way around it. The same card with the reason attached is an
   * instruction: it states what the rule is, why it exists, and what would change
   * the answer. The reason comes from the server with the payload, so the screen
   * cannot invent a justification the enforcement layer would not agree with.
   */
  function showVisibilityRefusal(p, decision) {
    U.modal({
      title: bilingual(
        `无权查看该岗位人员信息`,
        'Not permitted to view this role\'s holder'
      ),
      width: '600px',
      render: (close) => [
        el('div.refusal-head', {}, [
          el('div.refusal-role', {}, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
          el('div.refusal-duty', {}, getLocale() === 'en' ? p.dutyEn : p.duty),
        ]),
        el('div.refusal-reason', {}, [
          el('div.refusal-label', {}, bilingual('拒绝理由', 'Reason')),
          el('p', {}, getLocale() === 'en' ? decision.reasonEn : decision.reason),
        ]),
        el('div.refusal-public', {}, [
          el('div.refusal-label', {}, bilingual('以下内容仍然公开', 'What remains public')),
          el('ul.refusal-list', {}, [
            el('li', {}, bilingual('岗位名称与所属领域', 'The role name and its area')),
            el('li', {}, bilingual('该岗位的职责说明', 'What the role is responsible for')),
            el('li', {}, bilingual('该岗位的权限清单与约束', 'Its permissions and the constraints on them')),
          ]),
        ]),
        el('div.warning-note', {}, bilingual(
          '可见性按职能关系判定，不按行政级别：你所在领域之外的人员信息，'
          + '只有承担跨领域职能的岗位（质量保证、内审、质量受权人、培训）才能查看。',
          'Visibility follows functional relationship, not seniority: people outside your own area are visible only to '
          + 'roles whose function spans areas - quality assurance, internal audit, the qualified person and training.'
        )),
        el('div.modal-actions', {}, [
          button(t('common.close'), { variant: 'ghost', onclick: close }),
        ]),
      ],
    });
  }

  function participantCard(p, options = {}) {
    const demo = currentDemoLogin();
    const anonymous = !window.App.user;
    // The server decides. The screen only renders the answer, so a change to the
    // rule cannot leave the interface claiming a capability the API refuses.
    const vis = (state.domain && state.domain.visibility) || null;
    const decision = vis && vis.decisions ? vis.decisions[p.role] : null;
    const hidden = Boolean(decision && !decision.allowed);

    const clickable = Boolean(p.loginable && demo && demo.enabled) && !hidden;
    const account = p.accounts && p.accounts.length ? p.accounts[0] : null;

    const onClick = hidden
      ? () => showVisibilityRefusal(p, decision)
      : (clickable ? () => openParticipantSheet(p) : null);

    return el(`div.participant-card${clickable ? '.pc-clickable' : ''}${hidden ? '.pc-hidden' : '.pc-viewable'}`, {
      onclick: onClick,
      title: hidden
        ? bilingual('无权查看该岗位人员信息——点击查看理由', 'Not permitted to view this role holder - click for the reason')
        : (anonymous
            ? bilingual('选择身份后可切换为该岗位', 'Choose an identity to enter as this role')
            : (clickable
                ? bilingual('点击查看权限并可以该身份进入', 'Click to see permissions and enter as this participant')
                : bilingual('该岗位暂无账号', 'No account exists for this role'))),
    }, [
      el('div.pc-head', {}, [
        el('span.pc-role', {}, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
        hidden ? badge(bilingual('无权查看', 'Restricted'), 'muted') : null,
        p.readOnly ? badge(bilingual('只读', 'Read-only'), 'muted') : null,
        options.showPending && typeof p.pendingItems === 'number'
          ? el('span.pc-pending', {}, String(p.pendingItems))
          : null,
        options.showProcesses
          ? el('span.pc-pending.pc-pending-zero', {}, `${p.processCount} ${bilingual('流程', 'proc')}`)
          : null,
      ]),
      // The person is withheld, the role is not. Hiding the duty as well would
      // leave a card that says nothing at all, which is worse than no card.
      hidden
        ? el('div.pc-name.pc-name-hidden', {}, bilingual('无权查看该岗位人员', 'Role holder not visible to you'))
        : (account
          ? el('div.pc-name', {}, account.fullName || account.username)
          : (anonymous ? null : el('div.pc-name', {}, bilingual('（无账号）', '(no account)')))),
      !hidden && account && account.jobTitle ? el('div.pc-job', {}, account.jobTitle) : null,
      el('div.pc-duty', {}, getLocale() === 'en' ? p.dutyEn : p.duty),
      el('div.pc-stats', {}, [
        el('span.pc-stat', {}, `${p.stepCount} ${bilingual('步骤', 'steps')}`),
        p.approvalCount ? el('span.pc-stat.pc-approve', {}, `${p.approvalCount} ${bilingual('审批', 'approvals')}`) : null,
        el('span.pc-stat', {}, p.permissionCount === 'all'
          ? bilingual('全部权限', 'all permissions')
          : `${p.permissionCount} ${bilingual('项权限', 'permissions')}`),
      ]),
      el('div.pc-cta', {}, hidden
        ? bilingual('点击查看拒绝理由', 'Click for the reason')
        : (anonymous
            ? bilingual('选择身份后可切换为该岗位', 'Choose an identity to enter as this role')
            : (clickable
                ? bilingual('查看权限 / 以此身份进入 →', 'Permissions / enter as them \u2192')
                : bilingual('无账号', 'No account')))),
    ]);
  }

  // ========================================================= the process view ==

  let wfData = null;
  const colourCache = {};

  async function renderWorkflow(container, params) {
    clear(container);
    container.appendChild(spinner());
    let data;
    try {
      // includeAllRoles=0 keeps the matrix to the roles this process involves.
      // The participant-management dialog reads /api/assignable-roles instead.
      data = await api(`/api/explorer/${encodeURIComponent(params.code)}?includeAllRoles=0`);
    } catch (err) {
      clear(container);
      container.appendChild(errorBox(err, () => renderWorkflow(container, params)));
      return;
    }
    wfData = data;
    // The domain view reads the workflow payload for its persona cards, so keep
    // both in one place rather than fetching twice.
    state.workflow = data;
    state.container = container;
    state.params = params;
    clear(container);

    const proc = data.process;
    const view = el('div.view', {}, [
      el('div.view-head', {}, [
        el('div', {}, [
          el('div.breadcrumb', {}, [
            el('a', { href: '#/domains' }, bilingual('全部领域', 'All domains')),
            el('span.bc-sep', {}, ' / '),
            el('a', { href: `#/domain/${encodeURIComponent((proc.gxpAreas || [])[0] || '')}` },
              (proc.gxpAreas || []).join(' · ')),
          ]),
          el('h1.view-title', {}, [
            el('span.mono', {}, proc.code),
            el('span.title-sep', {}, ' · '),
            getLocale() === 'en' && proc.nameEn ? proc.nameEn : proc.name,
          ]),
          el('p.view-sub', {}, getLocale() === 'en' && proc.descriptionEn ? proc.descriptionEn : proc.description),
          el('div.head-badges', {}, [
            ...(proc.gxpAreas || []).map((a) => badge(a, 'info')),
            proc.slaDays ? badge(`${bilingual('时限', 'SLA')} ${proc.slaDays}${bilingual(' 天', ' d')}`, 'neutral') : null,
            proc.requiresRootCause ? badge(bilingual('需根本原因', 'Root cause'), 'warn') : null,
            proc.requiresEffectivenessCheck ? badge(bilingual('需有效性检查', 'Effectiveness'), 'warn') : null,
            proc.requiresQaApproval ? badge(bilingual('需 QA 批准', 'QA approval'), 'warn') : null,
          ]),
        ]),
        el('div.view-head-actions', {}, [
          button(bilingual('返回领域选择', 'Back to domains'), {
            variant: 'ghost',
            onclick: () => { window.location.hash = '#/domains'; },
          }),
          button(bilingual('刷新', 'Refresh'), { variant: 'ghost', onclick: () => renderWorkflow(container, params) }),
          window.App.can('record.create')
            ? button(bilingual('按此流程新建记录', 'Create a record'), {
                variant: 'primary',
                onclick: () => { window.location.hash = `#/records/new?processCode=${encodeURIComponent(proc.code)}`; },
              })
            : null,
        ]),
      ]),
    ]);

    const banner = demoBanner(data.demoLogin);
    if (banner) view.appendChild(banner);

    view.appendChild(el('div.stat-strip', {}, [
      stat(bilingual('流程步骤', 'Steps'), data.summary.stepCount),
      stat(bilingual('参与岗位', 'Participants'), data.summary.participantCount),
      stat(bilingual('需签名步骤', 'Signed steps'), data.summary.signedStepCount, {
        tone: data.summary.signedStepCount ? 'warn' : null,
        title: bilingual('未提供有效电子签名时无法完成', 'Cannot be completed without a valid signature'),
      }),
      stat(bilingual('职责分离步骤', 'SoD steps'), data.summary.independentStepCount, {
        tone: data.summary.independentStepCount ? 'warn' : null,
        title: bilingual('记录作者本人不得执行', 'The record author may not perform these'),
      }),
      stat(bilingual('代码强制约束', 'Constraints'), (data.matrix && data.matrix.constraintCount) || 0, {
        tone: 'info',
        clickable: true,
        onclick: () => showConstraintsDialog(),
      }),
    ]));

    view.appendChild(flowDiagram());

    // Responsibilities per participant, stated under the diagram as a table so
    // the mapping is explicit rather than inferred from the chips above.
    view.appendChild(responsibilityTable());

    view.appendChild(card(
      bilingual('参与者与信息权限', 'Participants and permissions'),
      [
        el('div.participant-grid', {}, data.participants.map((p) => participantCard(p, { showPending: true }))),
      ],
      {
        subtitle: bilingual(
          '点击名片查看该岗位的完整权限、约束原因，并可切换为该身份进入系统——进入后看到的就是他/她能看到的待办与界面。',
          'Click a card for that role\'s full permissions and constraint reasons, and to enter as that person: '
          + 'you then see exactly the work list and interface they see.'
        ),
        actions: window.App.can('explorer.manage')
          ? [
              button(bilingual('管理参与者', 'Manage participants'), {
                variant: 'ghost', onclick: () => manageParticipantsDialog(),
              }),
              button(bilingual('添加参与者', 'Add participant'), {
                variant: 'primary', onclick: () => addParticipantDialog(),
              }),
            ]
          : null,
      }
    ));

    view.appendChild(matrixCard(data.matrix, {
      title: bilingual('信息权限对应表（三态）', 'Permission matrix (three states)'),
      roles: data.participants.map((p) => p.role),
      subtitle: bilingual(
        `本流程的 ${data.participants.length} 个岗位 × ${data.matrix.permissionTotal} 项权限 × ${data.matrix.constraintCount} 项代码强制约束。`,
        `${data.participants.length} roles in this process across ${data.matrix.permissionTotal} permissions and ${data.matrix.constraintCount} code-enforced constraints.`
      ),
    }));

    view.appendChild(constraintsCard());
    container.appendChild(view);
  }

  // ------------------------------------------------------------- flow diagram --

  function roleColour(role) {
    if (!colourCache[role]) {
      const palette = ['#0f766e', '#1d4ed8', '#b45309', '#7c3aed', '#0891b2', '#be123c', '#15803d', '#475569', '#a16207', '#0e7490'];
      const n = Object.keys(colourCache).length;
      colourCache[role] = palette[n % palette.length];
    }
    return colourCache[role];
  }

  function flowDiagram() {
    const steps = wfData.steps || [];
    const participants = wfData.participants || [];
    const body = el('div.flow-wrap');

    const realHandoffs = (wfData.handoffs || []).filter((h) => !h.sameRole);
    if (realHandoffs.length) {
      body.appendChild(el('div.flow-handoffs', {}, [
        el('span.flow-handoff-label', {}, bilingual('责任移交', 'Hand-offs')),
        ...realHandoffs.map((h) => el('span.flow-handoff', {}, [
          el('span.ho-step', {}, h.fromStepName),
          el('span.ho-arrow', {}, '\u2192'),
          el('span.ho-step', {}, h.toStepName),
          h.requiresSignature ? el('span.ho-sig', { title: bilingual('接收方需电子签名', 'The receiving step requires a signature') }, '\u2712') : null,
        ])),
      ]));
    }

    body.appendChild(el('div.flow-track', {}, steps.map((step, i) => {
      const node = el('div.flow-node', {
        class: [
          step.signatureMeaning ? 'fn-signed' : '',
          step.independentOfAuthor ? 'fn-independent' : '',
          step.optional ? 'fn-optional' : '',
        ].filter(Boolean).join(' '),
      }, [
        el('div.fn-head', {}, [
          el('span.fn-seq', {}, String(step.seq)),
          badge(KIND_LABEL[step.participationKind] ? KIND_LABEL[step.participationKind]() : step.participationKind,
            KIND_TONE[step.participationKind] || 'neutral'),
        ]),
        el('div.fn-name', {}, getLocale() === 'en' && step.nameEn ? step.nameEn : step.name),
        // Responsibilities written out on the diagram. This is the part that used
        // to be a title attribute only, invisible in a screenshot or a printout.
        el('div.fn-roles', {}, step.roles.map((r) => {
          const p = participants.find((x) => x.role === r);
          const label = p ? (getLocale() === 'en' ? p.roleLabel : p.roleLabelZh) : r;
          const duty = p ? (getLocale() === 'en' ? p.dutyEn : p.duty) : '';
          return el('div.fn-role-block', {
            title: duty ? `${label}：${duty}` : label,
            onclick: p ? () => openParticipantSheet(p) : null,
            style: { borderLeftColor: roleColour(r), cursor: p ? 'pointer' : 'default' },
          }, [
            el('span.fn-role-name', { style: { color: roleColour(r) } }, label),
            duty ? el('span.fn-role-duty', {}, duty) : null,
          ]);
        })),
        el('div.fn-flags', {}, [
          step.signatureMeaning ? el('span.fn-flag.fn-flag-sig', {
            title: `${bilingual('完成此步骤需要电子签名', 'Completing this step requires a signature')}: ${U.meaningLabel(step.signatureMeaning)}`,
          }, `\u2712 ${U.meaningLabel(step.signatureMeaning)}`) : null,
          step.independentOfAuthor ? el('span.fn-flag.fn-flag-ind', {
            title: bilingual('记录作者本人不得执行此步骤（职责分离）', 'The record author may not perform this step (separation of duties)'),
          }, bilingual('独立性', 'Independent')) : null,
          step.optional ? el('span.fn-flag.fn-flag-opt', {}, bilingual('可选', 'Optional')) : null,
          step.fieldCount ? el('span.fn-flag', {}, `${step.fieldCount} ${bilingual('项表单', 'fields')}`) : null,
        ]),
        step.guidance ? el('details.fn-guidance', {}, [
          el('summary', {}, bilingual('操作指引', 'Guidance')),
          el('p', {}, step.guidance),
        ]) : null,
      ]);
      const wrapper = el('div.flow-cell', {}, [node]);
      if (i < steps.length - 1) wrapper.appendChild(el('div.flow-connector', {}, '\u25b6'));
      return wrapper;
    })));

    return card(bilingual('工作流示意图与各参与者职责', 'Process flow and each participant\'s responsibility'), [body], {
      subtitle: bilingual(
        `${steps.length} 个步骤，${realHandoffs.length} 次责任移交。每个步骤下列出负责岗位及其职责；点击岗位可打开其信息权限面板。`,
        `${steps.length} steps and ${realHandoffs.length} hand-off(s). Each step lists the responsible roles with their duties; click a role to open its permission panel.`
      ),
      actions: [button(bilingual('图例', 'Legend'), { variant: 'ghost', onclick: () => showLegendDialog() })],
    });
  }

  // --------------------------------------------------- responsibility table --

  /**
   * The same mapping as the diagram, but as a table.
   *
   * The diagram answers "who does what at each step". This answers the reverse
   * question - "what is this person on the hook for across the whole process" -
   * and it is the table a QA trainer hands out.
   */
  function responsibilityTable() {
    const rows = (wfData.participants || []).map((p) => {
      const mine = (p.steps || []).slice().sort((a, b) => a.seq - b.seq);
      return el('tr', {}, [
        el('td', {}, [
          el('div.rt-role', { style: { color: roleColour(p.role) } }, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
          p.accounts.length ? el('div.rt-person', {}, p.accounts[0].fullName || p.accounts[0].username) : null,
        ]),
        el('td.rt-duty', {}, getLocale() === 'en' ? p.dutyEn : p.duty),
        el('td', {}, mine.length
          ? el('div.rt-steps', {}, mine.map((s) => el('span.rt-step', {
              class: s.signatureMeaning ? 'rt-step-sig' : '',
              title: s.signatureMeaning
                ? `${bilingual('需签名', 'Requires signature')}: ${U.meaningLabel(s.signatureMeaning)}`
                : undefined,
            }, `${s.seq}. ${s.name}${s.signatureMeaning ? ' \u2712' : ''}`)))
          : el('span.muted', {}, bilingual('未直接执行步骤', 'No direct step')),
        ),
        el('td.rt-count', {}, p.approvalCount
          ? badge(`${p.approvalCount} ${bilingual('项审批', 'approvals')}`, 'warn')
          : badge(bilingual('无审批', 'No approval'), 'muted')),
        el('td.rt-count', {}, el('span.pc-stat', {}, p.permissionCount === 'all'
          ? bilingual('全部', 'all')
          : `${p.permissionCount} ${bilingual('项', 'perms')}`)),
      ]);
    });

    return card(bilingual('各参与者职责一览', 'Responsibility summary'), [
      el('div.table-wrap', {}, el('table.table.responsibility-table', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, bilingual('岗位', 'Role')),
          el('th', {}, bilingual('职责', 'Responsibility')),
          el('th', {}, bilingual('在本流程中负责的步骤', 'Steps owned in this process')),
          el('th', {}, bilingual('审批权限', 'Approval')),
          el('th', {}, bilingual('权限总数', 'Permissions')),
        ])),
        el('tbody', {}, rows),
      ])),
      el('p.card-foot-note', {}, bilingual(
        '✒ 标记的步骤需要电子签名（两个识别要素）才能完成。审批权限多不等于权限大——'
        + '每一项都受下方的代码强制约束限制。',
        'Steps marked \u2712 require an electronic signature (two identification components) to complete. '
        + 'More approvals does not mean more power: every one is limited by the code-enforced constraints below.'
      )),
    ], {
      subtitle: bilingual(
        '按岗位汇总：每个岗位在整条流程中承担什么责任、负责哪些步骤。',
        'Grouped by role: what each participant is accountable for, and which steps they own.'
      ),
    });
  }

  // --------------------------------------------------------- permission matrix --

  let expandedCells = new Set();

  function cellConstraints(matrix, cell) {
    const index = (matrix && matrix.constraintIndex) || {};
    return (cell.constraintIds || []).map((id) => index[id]).filter(Boolean);
  }

  function matrixCard(matrix, opts) {
    const roles = matrix.roles.filter((r) => (opts.roles || []).includes(r.code));
    if (!roles.length) return el('div');

    const header = el('tr', {}, [
      el('th.mx-perm-col', {}, bilingual('权限', 'Permission')),
      ...roles.map((r) => el('th.mx-role-col', { title: r.label }, [
        el('div.mx-role-name', { style: { color: roleColour(r.code) } }, getLocale() === 'en' ? r.label : r.labelZh),
        el('div.mx-role-sub', {}, `${matrix.totals[r.code].allowed} \u2713 / ${matrix.totals[r.code].conditional} \u26a0`),
      ])),
    ]);

    const body = [];
    for (const group of matrix.groups) {
      const relevant = group.rows.filter((row) => row.cells.some(
        (c) => roles.some((r) => r.code === c.role) && c.state !== 'denied'
      ));
      if (!relevant.length) continue;
      body.push(el('tr.mx-group-row', {}, el('td', { colspan: roles.length + 1 },
        el('strong', {}, getLocale() === 'en' ? group.labelEn : group.labelZh))));
      for (const row of relevant) {
        body.push(el('tr', {}, [
          el('td.mx-perm-col', {}, [
            el('div', {}, getLocale() === 'en' ? row.labelEn : row.label),
            row.constraintCount ? el('div.mx-perm-flag', {}, bilingual(`${row.constraintCount} 项约束`, `${row.constraintCount} constraint(s)`)) : null,
          ]),
          ...roles.map((r) => {
            const cell = row.cells.find((c) => c.role === r.code) || { state: 'denied', constraintIds: [] };
            return matrixCell(matrix, row, cell);
          }),
        ]));
      }
    }

    return card(opts.title, [
      el('div.mx-legend', {}, [
        el('span.mx-key', {}, el('span.mx-mark.mx-ok', {}, '\u2713'), bilingual('允许', 'Allowed')),
        el('span.mx-key', {}, el('span.mx-mark.mx-cond', {}, '\u26a0'), bilingual('有约束（点开看原因）', 'Conditional (open for the reason)')),
        el('span.mx-key', {}, el('span.mx-mark.mx-no', {}, '\u00b7'), bilingual('不允许', 'Not allowed')),
      ]),
      el('div.matrix-wrap', {}, el('table.table.matrix-table.permission-matrix', {}, [
        el('thead', {}, header),
        el('tbody', {}, body),
      ])),
      el('p.card-foot-note', {}, bilingual(
        '⚠ 表示该岗位持有此项权限，但代码中另有强制规则可能拒绝该操作——例如记录作者不能关闭自己的记录、'
        + '系统管理员不能作为唯一批准人。只显示「允许/不允许」会让界面与运行中的系统相互矛盾。',
        '⚠ means the role holds the permission but a code-enforced rule may still refuse the action - for example the record author cannot close their own record. '
        + 'Showing only allowed/denied would make this screen contradict the running system.'
      )),
    ], { subtitle: opts.subtitle });
  }

  function matrixCell(matrix, row, cell) {
    const mark = cell.state === 'allowed' ? '\u2713' : (cell.state === 'conditional' ? '\u26a0' : '\u00b7');
    const cls = cell.state === 'allowed' ? 'mx-ok' : (cell.state === 'conditional' ? 'mx-cond' : 'mx-no');
    const cons = cellConstraints(matrix, cell);
    return el('td.mx-cell', {}, el(`span.mx-mark.${cls}`, {
      title: cell.state === 'denied'
        ? bilingual('该岗位不持有此权限', 'This role does not hold this permission')
        : cons.map((c) => (getLocale() === 'en' ? c.labelEn : c.label)).join('\n'),
      onclick: cons.length ? (ev) => { ev.stopPropagation(); showConstraintDialog(row, cons); } : null,
      style: cons.length ? { cursor: 'pointer' } : null,
    }, mark));
  }

  function showConstraintDialog(row, cons) {
    U.modal({
      title: getLocale() === 'en' ? row.labelEn : row.label,
      width: '640px',
      render: (close) => [
        el('p.modal-intro', {}, bilingual(
          '该岗位持有此权限，但以下代码强制规则可能拒绝该操作：',
          'The role holds this permission, but the following code-enforced rules may still refuse the action:'
        )),
        ...cons.map((c) => el(`div.constraint-block.constraint-${c.kind || 'conditional'}`, {}, [
          el('div.cb-head', {}, [
            badge(c.kind === 'warning' ? bilingual('提示性', 'Advisory') : bilingual('可拒绝', 'Blocking'),
              c.kind === 'warning' ? 'info' : 'warn'),
            el('span.cb-title', {}, getLocale() === 'en' ? c.labelEn : c.label),
          ]),
          el('p.cb-reason', {}, getLocale() === 'en' ? c.reasonEn : c.reason),
          el('div.cb-basis', {}, c.basis || ''),
          c.enforcedAt ? el('div.cb-where', {}, `${bilingual('强制位置', 'Enforced in')}: ${c.enforcedAt}`) : null,
        ])),
        el('div.modal-actions', {}, [button(t('common.close'), { variant: 'ghost', onclick: close })]),
      ],
    });
  }

  function constraintsCard() {
    const list = (wfData.matrix && wfData.matrix.constraints) || [];
    if (!list.length) return el('div');
    return card(bilingual('代码强制约束清单', 'Code-enforced constraints'), [
      el('p.card-foot-note', {}, bilingual(
        '这些规则与角色配置无关，任何角色都无法绕过。它们的存在意味着权限表必须显示第三种状态。',
        'These rules are independent of role configuration and cannot be bypassed by any role. '
        + 'They are why the matrix needs a third state.'
      )),
      el('div.constraint-grid', {}, list.map((c) => el('div.constraint-item', {
        class: c.kind === 'warning' ? 'ci-warn' : 'ci-block',
      }, [
        el('div.ci-head', {}, [
          badge(c.kind === 'warning' ? bilingual('提示', 'Advisory') : bilingual('强制', 'Enforced'),
            c.kind === 'warning' ? 'info' : 'warn'),
          el('span.ci-title', {}, getLocale() === 'en' ? c.labelEn : c.label),
        ]),
        el('div.ci-reason', {}, getLocale() === 'en' ? c.reasonEn : c.reason),
        el('div.ci-basis', {}, c.basis || ''),
        c.enforcedAt ? el('div.ci-where', {}, c.enforcedAt) : null,
      ]))),
    ]);
  }

  function showConstraintsDialog() { /* the card below the matrix is the full list */ }

  function showLegendDialog() {
    const rows = [
      { mark: () => badge(bilingual('发起', 'Initiate'), 'info'),
        text: () => bilingual('流程的第一步，通常由一线人员发起', 'The first step, typically initiated by front-line staff') },
      { mark: () => badge(bilingual('执行', 'Execute'), 'neutral'),
        text: () => bilingual('按指令执行并同步记录，一般无需签名', 'Performs and records contemporaneously, usually without a signature') },
      { mark: () => badge(bilingual('批准', 'Approve'), 'warn'),
        text: () => bilingual('带签名的批准步骤，未签名无法完成', 'A signed approval step that cannot be completed without a signature') },
      { mark: () => badge('\u2712', 'warn'),
        text: () => bilingual('该步骤需要电子签名（两个识别要素）', 'This step requires an electronic signature (two identification components)') },
      { mark: () => badge(bilingual('独立性', 'Independent'), 'warn'),
        text: () => bilingual('记录作者本人不得执行此步骤（职责分离）', 'The record author may not perform this step (separation of duties)') },
      { mark: () => badge(bilingual('可选', 'Optional'), 'muted'),
        text: () => bilingual('可跳过，不影响流程关闭', 'May be skipped without blocking closure') },
      { mark: () => el('span.mi-arrow', {}, '\u25b6'),
        text: () => bilingual('步骤顺序，箭头方向为流转方向', 'Step order; the arrow shows the direction of flow') },
      { mark: () => el('span.mi-stripe'),
        text: () => bilingual('琥珀色左边框表示带签名的批准步骤', 'An amber left border marks a signed approval step') },
      { mark: () => el('span.mi-arrow', {}, '\u2192'),
        text: () => bilingual('责任移交：工作从一个岗位转到另一个岗位', 'Hand-off: work passes from one role to another') },
    ];
    U.modal({
      title: bilingual('图例', 'Legend'),
      width: '620px',
      render: (close) => [
        el('div.legend-list', {}, rows.map((r) => el('div.legend-row', {}, [r.mark(), el('span', {}, r.text())]))),
        el('div.modal-actions', {}, [button(t('common.close'), { variant: 'ghost', onclick: close })]),
      ],
    });
  }

  // ------------------------------------------------------- participant sheet --

  function openParticipantSheet(p) {
    const matrix = (state.workflow && state.workflow.matrix) || (state.domain && state.domain.matrix);
    const rows = [];
    for (const g of (matrix ? matrix.groups : [])) {
      for (const row of g.rows) {
        const cell = row.cells.find((c) => c.role === p.role);
        if (cell) rows.push({ group: g, row, cell });
      }
    }
    const allowed = rows.filter((r) => r.cell.state === 'allowed');
    const conditional = rows.filter((r) => r.cell.state === 'conditional');
    const denied = rows.filter((r) => r.cell.state === 'denied');
    const demo = currentDemoLogin();

    U.modal({
      title: `${getLocale() === 'en' ? p.roleLabel : p.roleLabelZh}${p.accounts.length ? ` · ${p.accounts[0].fullName}` : ''}`,
      width: '940px',
      render: (close) => [
        el('div.sheet-head', {}, [
          el('div', {}, [
            el('div.sheet-role', {}, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
            el('div.sheet-duty', {}, getLocale() === 'en' ? p.dutyEn : p.duty),
            el('div.sheet-acct', {}, p.accounts.length
              ? `${p.accounts.map((a) => a.fullName).join('、')} · ${p.accounts[0].department || ''}`
              : bilingual('该岗位暂无对应账号', 'No account exists for this role')),
          ]),
          el('div.sheet-numbers', {}, [
            stat(bilingual('负责步骤', 'Steps'), p.stepCount),
            stat(bilingual('审批步骤', 'Approvals'), p.approvalCount),
            typeof p.pendingItems === 'number'
              ? stat(bilingual('当前待办', 'Pending'), p.pendingItems, { tone: p.pendingItems ? 'warn' : 'ok' })
              : stat(bilingual('涉及流程', 'Processes'), p.processCount || 0),
          ]),
        ]),

        p.steps ? el('div.sheet-section', {}, [
          el('h4', {}, bilingual('在本流程中的职责', 'Responsibilities in this process')),
          el('ul.sheet-steps', {}, p.steps.map((s) => el('li', {}, [
            el('span.sheet-step-seq', {}, `第 ${s.seq} 步`),
            el('span.sheet-step-name', {}, s.name),
            badge(KIND_LABEL[s.participationKind] ? KIND_LABEL[s.participationKind]() : s.participationKind,
              KIND_TONE[s.participationKind] || 'neutral'),
            s.signatureMeaning ? badge(`\u2712 ${U.meaningLabel(s.signatureMeaning)}`, 'warn') : null,
            s.independentOfAuthor ? badge(bilingual('需独立于作者', 'Independent of author'), 'warn') : null,
          ]))),
        ]) : null,

        p.processes ? el('div.sheet-section', {}, [
          el('h4', {}, bilingual(`参与本领域的 ${p.processCount} 条流程`, `Involved in ${p.processCount} processes`)),
          el('div.sheet-perm-list', {}, p.processes.map((c) => el('span.sheet-perm-chip', {}, c))),
        ]) : null,

        el('div.sheet-section', {}, [
          el('h4', {}, [
            bilingual('信息权限对应表', 'Permission matrix'),
            el('span.sheet-count', {}, ` ${bilingual('允许', 'allowed')} ${allowed.length} · `
              + `${bilingual('有约束', 'conditional')} ${conditional.length} · `
              + `${bilingual('不允许', 'denied')} ${denied.length}`),
          ]),
          conditional.length ? el('div.sheet-subsection', {}, [
            el('div.sheet-subtitle.sheet-sub-warn', {}, bilingual('⚠ 有约束的权限（点开看原因）', '⚠ Conditional permissions (open for the reason)')),
            ...conditional.map(({ row, cell }) => el('div.sheet-perm.sheet-perm-cond', {}, [
              el('div.sp-name', {}, getLocale() === 'en' ? row.labelEn : row.label),
              ...cellConstraints(matrix, cell).map((c) => el('details.sp-constraint', {}, [
                el('summary', {}, getLocale() === 'en' ? c.labelEn : c.label),
                el('p', {}, getLocale() === 'en' ? c.reasonEn : c.reason),
                el('div.sp-basis', {}, c.basis),
                c.enforcedAt ? el('div.sp-where', {}, c.enforcedAt) : null,
                c.kind === 'warning' ? el('div.sp-kind', {}, bilingual('提示性约束：系统会预警但不阻止', 'Advisory: warns but does not block')) : null,
              ])),
            ])),
          ]) : null,
          el('div.sheet-subsection', {}, [
            el('div.sheet-subtitle.sheet-sub-ok', {}, bilingual('✓ 允许', '✓ Allowed')),
            el('div.sheet-perm-list', {}, allowed.map(({ row }) => el('span.sheet-perm-chip', {}, getLocale() === 'en' ? row.labelEn : row.label))),
          ]),
          denied.length ? el('details.sheet-subsection', {}, [
            el('summary.sheet-subtitle.sheet-sub-deny', {}, bilingual(`✗ 不允许（${denied.length} 项）`, `✗ Not allowed (${denied.length})`)),
            el('div.sheet-perm-list', {}, denied.map(({ row }) => el('span.sheet-perm-chip.sheet-perm-off', {}, getLocale() === 'en' ? row.labelEn : row.label))),
          ]) : null,
        ]),

        el('div.warning-note', {}, bilingual(
          '权限由服务端强制校验，界面不会显示你没有权限执行的操作。「有约束」表示权限存在但会被其他规则限制。',
          'Permissions are enforced server-side; the interface never offers an action you may not perform. '
          + '"Conditional" means the permission exists but another rule can restrict it.'
        )),

        el('div.modal-actions', {}, [
          button(bilingual('关闭', 'Close'), { variant: 'ghost', onclick: close }),
          p.loginable && demo && demo.enabled
            ? button(bilingual('以此身份进入系统', 'Enter as this participant'), {
                variant: 'primary', onclick: () => { close(); switchToParticipant(p, demo); },
              })
            : null,
        ]),
      ],
    });
  }

  // -------------------------------------------------------- identity switching --

  function switchToParticipant(p, demo) {
    if (!p.accounts.length) return;
    const account = p.accounts[0];

    const proceed = () => {
      const overlay = el('div.identity-overlay', {}, [
        el('div.identity-box', {}, [spinner(bilingual(`正在以 ${account.fullName} 的身份进入…`, `Signing in as ${account.fullName}…`))]),
      ]);
      document.body.appendChild(overlay);
      window.Api.post('/api/auth/login', { username: account.username, password: demo.password })
        .then((res) => {
          window.App.user = res.user;
          window.App.permissions = res.user.permissions || [];
          window.App.session = res.session;
          overlay.remove();
          U.toast(bilingual(
            `已切换为 ${account.fullName}（${getLocale() === 'en' ? p.roleLabel : p.roleLabelZh}）`,
            `Now signed in as ${account.fullName} (${p.roleLabel})`
          ), 'ok', 6000);
          // Re-render first, then navigate: if the hash is already #/inbox,
          // assigning it again fires no hashchange, and the previous person's
          // view would stay on screen.
          window.App.refresh();
          window.location.hash = '#/inbox';
        })
        .catch((err) => { overlay.remove(); U.toast(err.message, 'bad', 8000); });
    };

    U.modal({
      title: bilingual('以该参与者身份进入', 'Enter as this participant'),
      width: '520px',
      render: (close) => [
        el('div.identity-target', {}, [
          el('div.it-role', {}, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
          el('div.it-name', {}, `${account.fullName} · ${account.jobTitle || ''}`),
          el('div.it-account.mono', {}, account.username),
        ]),
        el('div.identity-password', {}, [
          el('label.ip-label', {}, bilingual('密码', 'Password')),
          el('input.input', { type: 'text', value: demo.password, readonly: true, onfocus: (e) => e.target.select() }),
          el('div.ip-hint', {}, bilingual('演示用统一密码，已自动填入', 'Demonstration shared password, pre-filled')),
        ]),
        el('div.warning-note', {}, bilingual(
          '共用密码违反 21 CFR Part 11.300(a)「账号唯一」的要求，会使审计追踪无法归属到具体个人。'
          + '真实部署必须为每位使用者签发独立凭证。',
          'A shared password violates the unique-account requirement of 21 CFR Part 11.300(a) and makes audit trail entries unattributable to an individual. '
          + 'A real deployment must issue individual credentials.'
        )),
        el('div.modal-actions', {}, [
          button(bilingual('取消', 'Cancel'), { variant: 'ghost', onclick: close }),
          button(bilingual('确认进入', 'Enter'), { variant: 'primary', onclick: () => { close(); proceed(); } }),
        ]),
      ],
    });
  }

  // --------------------------------------------------- participant management --

  function addParticipantDialog() {
    api('/api/assignable-roles').then((res) => {
      const already = new Set((wfData.participants || []).map((p) => p.role));
      const available = res.roles.filter((r) => !already.has(r.code));
      if (!available.length) { U.toast(bilingual('全部岗位都已在本流程中', 'Every role is already in this process'), 'info'); return; }
      let selected = null;
      let reasonInput = null;

      U.modal({
        title: bilingual('添加参与者', 'Add a participant'),
        width: '780px',
        render: (close) => {
          const listNode = el('div.pick-list');
          const paint = () => {
            clear(listNode);
            for (const r of available) {
              listNode.appendChild(el(`button.pick-row${selected === r.code ? '.pick-row-active' : ''}`, {
                type: 'button',
                onclick: () => { selected = r.code; paint(); },
              }, [
                el('span.pick-role', {}, getLocale() === 'en' ? r.label : r.labelZh),
                el('span.pick-duty', {}, getLocale() === 'en' ? r.dutyEn : r.duty),
                el('span.pick-meta', {}, r.accountCount ? `${r.accountCount} ${bilingual('个账号', 'account(s)')}` : bilingual('无账号', 'no account')),
              ]));
            }
          };
          paint();
          return [
            el('p.modal-intro', {}, bilingual(
              '参与者只能从系统已有的岗位中选择。岗位及其权限由应用程序定义，不能在界面中创建——'
              + '否则界面就能声称一项服务端随后会拒绝的能力，演示会与实际系统矛盾。',
              'A participant can only be chosen from the roles the system already defines. Roles and their permissions are defined in the application and cannot be created here - '
              + 'otherwise the interface could claim a capability the server then refuses.'
            )),
            listNode,
            U.field(bilingual('添加理由（记录到审计追踪）', 'Reason (written to the audit trail)'),
              (reasonInput = U.textarea('reason', '', { rows: 2 }))),
            el('div.modal-actions', {}, [
              button(t('common.cancel'), { variant: 'ghost', onclick: close }),
              button(bilingual('添加', 'Add'), {
                variant: 'primary',
                onclick: async () => {
                  if (!selected) { U.toast(bilingual('请先选择一个岗位', 'Select a role first'), 'warn'); return; }
                  try {
                    await window.Api.post(`/api/explorer/${encodeURIComponent(wfData.process.code)}/participants`, {
                      role: selected, reason: reasonInput.value.trim() || null,
                    });
                    close();
                    U.toast(bilingual('参与者已添加', 'Participant added'), 'ok');
                    renderWorkflow(state.container, { code: wfData.process.code });
                  } catch (err) { U.toast(err.message, 'bad', 7000); }
                },
              }),
            ]),
          ];
        },
      });
    }).catch((err) => U.toast(err.message, 'bad'));
  }

  function manageParticipantsDialog() {
    let reasonInput = null;
    U.modal({
      title: bilingual('管理参与者', 'Manage participants'),
      width: '720px',
      render: (close) => {
        const listNode = el('div.manage-list');
        for (const p of wfData.participants) {
          listNode.appendChild(el('div.manage-row', {}, [
            el('div.mr-info', {}, [
              el('div.mr-role', {}, getLocale() === 'en' ? p.roleLabel : p.roleLabelZh),
              el('div.mr-duty', {}, getLocale() === 'en' ? p.dutyEn : p.duty),
            ]),
            el('div.mr-meta', {}, [
              badge(`${p.stepCount} ${bilingual('步骤', 'steps')}`, 'neutral'),
              p.accounts.length ? badge(bilingual('有账号', 'has account'), 'ok') : badge(bilingual('无账号', 'no account'), 'muted'),
            ]),
            button(bilingual('移除', 'Remove'), {
              variant: 'ghost',
              onclick: async () => {
                try {
                  await window.Api.del(
                    `/api/explorer/${encodeURIComponent(wfData.process.code)}/participants/${encodeURIComponent(p.role)}`,
                    { reason: reasonInput ? reasonInput.value.trim() : null }
                  );
                  U.toast(bilingual('已从本流程视图中移除', 'Removed from this workflow view'), 'ok');
                  close();
                  renderWorkflow(state.container, { code: wfData.process.code });
                } catch (err) { U.toast(err.message, 'bad', 7000); }
              },
            }),
          ]));
        }
        return [
          el('p.modal-intro', {}, bilingual(
            '移除只是把这个岗位从当前流程视图中隐藏，不会删除账号、不会改变岗位权限，也不会修改任何安全性记录。'
            + '该操作会记入审计追踪，并明确标注为「仅演示视图」。',
            'Removing only hides this role from the current workflow view. It does not delete an account, change role permissions, or modify any safety record. '
            + 'The action is written to the audit trail and marked as a demonstration-view change only.'
          )),
          listNode,
          U.field(bilingual('操作理由（记录到审计追踪）', 'Reason (written to the audit trail)'),
            (reasonInput = U.textarea('reason', '', { rows: 2 }))),
          el('div.modal-actions', {}, [button(t('common.close'), { variant: 'ghost', onclick: close })]),
        ];
      },
    });
  }

  // ------------------------------------------------------------------ register --

  window.Views.register('domains', { render: (container) => renderDomains(container) });
  window.Views.register('domain', { render: (container, params) => renderDomain(container, params) });
  window.Views.register('workflow', { render: (container, params) => renderWorkflow(container, params) });
})();
