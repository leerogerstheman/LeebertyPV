/* LeebertyPV - DOM and component helpers.
 *
 * Everything here is deliberately small and dependency free. The two
 * non-obvious components are:
 *
 *   UI.signatureDialog  - the only way to apply an electronic signature. It
 *                         collects both identification components required by
 *                         21 CFR Part 11.200(a)(1)(i) and never caches the
 *                         credential in the DOM longer than the request.
 *   UI.reasonDialog     - a mandatory reason prompt, because every GxP change
 *                         must state why it was made (Part 11.10(e)).
 */
(function () {
  'use strict';

  const { tr, bilingual, getLocale } = window.I18N;

  // ------------------------------------------------------------- elements ---

  /**
   * el('div.card', {onclick}, [child, 'text'])  ->  HTMLElement
   * The tag string supports `tag.class1.class2#id` and `tag[attr=value]`.
   */
  function el(spec, attrs, children) {
    let tag = 'div';
    let classes = [];
    let id = null;
    const attrsFromSpec = {};

    const main = String(spec || 'div');
    const bracket = /\[([^\]]*)\]/.exec(main);
    let head = main;
    if (bracket) {
      head = main.slice(0, bracket.index);
      for (const pair of bracket[1].split(',')) {
        const [k, v] = pair.split('=');
        if (k) attrsFromSpec[k.trim()] = v === undefined ? '' : v.trim();
      }
    }
    const hashIdx = head.indexOf('#');
    if (hashIdx !== -1) {
      id = head.slice(hashIdx + 1);
      head = head.slice(0, hashIdx);
    }
    const parts = head.split('.');
    if (parts[0]) tag = parts[0];
    classes = parts.slice(1).filter(Boolean);

    const node = document.createElement(tag);
    if (classes.length) node.className = classes.join(' ');
    if (id) node.id = id;
    for (const [k, v] of Object.entries(attrsFromSpec)) node.setAttribute(k, v);

    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !(attrs instanceof Node)) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class' || key === 'className') {
          node.className = [node.className, value].filter(Boolean).join(' ');
        } else if (key === 'style' && typeof value === 'object') {
          Object.assign(node.style, value);
        } else if (key === 'dataset' && typeof value === 'object') {
          Object.assign(node.dataset, value);
        } else if (key === 'html') {
          node.innerHTML = value;
        } else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'value' && 'value' in node) {
          node.value = value;
        } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'required') {
          if (value) node.setAttribute(key, '');
        } else {
          node.setAttribute(key, value);
        }
      }
    }

    append(node, Array.isArray(attrs) ? attrs : children);
    return node;
  }

  function append(parent, children) {
    if (children === undefined || children === null || children === false) return parent;
    if (Array.isArray(children)) {
      for (const child of children) append(parent, child);
      return parent;
    }
    if (children instanceof Node) { parent.appendChild(children); return parent; }
    parent.appendChild(document.createTextNode(String(children)));
    return parent;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  function frag(children) {
    const f = document.createDocumentFragment();
    append(f, children);
    return f;
  }

  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --------------------------------------------------------------- format ---

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function fmtRelative(value) {
    if (!value) return '';
    const days = Math.ceil((Date.parse(value) - Date.now()) / 86400000);
    if (Number.isNaN(days)) return '';
    if (days === 0) return tr('common.dueDate') + ': today';
    if (days > 0) return `${days}${tr('common.days')}`;
    return `${-days}${tr('common.days')} (${tr('common.overdue')})`;
  }

  function fmtNumber(n) {
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString();
  }

  function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = Number(bytes);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** Turn an UPPER_SNAKE enum value into readable text. */
  function humanise(value) {
    if (value === null || value === undefined || value === '') return '—';
    return String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ------------------------------------------------------------ components --

  function badge(text, tone, opts = {}) {
    return el(`span.badge.badge-${tone || 'neutral'}`, { title: opts.title || '' }, text);
  }

  const STATUS_TONES = {
    draft: 'neutral', reported: 'warn', in_assessment: 'info', qa_review: 'warn',
    capa_defined: 'info', closed: 'ok', cancelled: 'muted', rejected: 'bad',
    in_progress: 'info', pending: 'neutral', completed: 'ok', approved: 'ok',
    effective: 'ok', superseded: 'muted', obsolete: 'muted', retired: 'muted',
    in_review: 'warn', assigned: 'info', failed: 'bad', expired: 'bad', valid: 'ok',
    overdue: 'bad', due_soon: 'warn', compliant: 'ok', partial: 'warn', gap: 'bad',
    not_assessed: 'muted', not_applicable: 'muted', open: 'warn', qualified: 'ok',
    conditionally_qualified: 'warn', disqualified: 'bad', out_of_service: 'bad',
    in_service: 'ok', planned: 'info', executing: 'info', submitting: 'info',
    phase1_lab_investigation: 'warn', phase2_full_investigation: 'warn',
    impact_assessed: 'info', approved_with_conditions: 'warn',
    critical: 'bad', major: 'warn', minor: 'muted', high: 'warn',
    expiring_soon: 'warn', current: 'ok', not_scheduled: 'neutral',
    active: 'ok', locked: 'bad', disabled: 'muted',
  };

  function statusBadge(status) {
    const tone = STATUS_TONES[status] || 'neutral';
    return badge(humanise(status), tone);
  }

  function criticalityBadge(level) {
    const map = { critical: 'bad', major: 'warn', minor: 'muted', high: 'warn', low: 'muted' };
    return badge(humanise(level), map[level] || 'neutral');
  }

  function card(title, bodyChildren, opts = {}) {
    return el('section.card', { class: opts.class || '' }, [
      title ? el('header.card-head', {}, [
        el('h2.card-title', {}, title),
        opts.subtitle ? el('p.card-sub', {}, opts.subtitle) : null,
        opts.actions ? el('div.card-actions', {}, opts.actions) : null,
      ]) : null,
      el('div.card-body', { class: opts.bodyClass || '' }, bodyChildren),
    ]);
  }

  function stat(label, value, opts = {}) {
    return el(`div.stat${opts.tone ? `.stat-${opts.tone}` : ''}`, {
      class: opts.clickable ? 'stat-clickable' : '',
      onclick: opts.onclick || null,
      title: opts.title || '',
    }, [
      el('div.stat-value', {}, value === null || value === undefined ? '—' : String(value)),
      el('div.stat-label', {}, label),
      opts.hint ? el('div.stat-hint', {}, opts.hint) : null,
    ]);
  }

  function table(columns, rows, opts = {}) {
    if (!rows || !rows.length) {
      return el('div.empty', {}, opts.emptyText || tr('common.noData'));
    }
    const thead = el('thead', {}, el('tr', {}, columns.map((c) =>
      el('th', { class: c.align === 'right' ? 'ta-right' : '', style: c.width ? { width: c.width } : null }, c.label))));

    const tbody = el('tbody', {}, rows.map((row, index) => {
      const trEl = el('tr', {
        class: [
          opts.rowClass ? opts.rowClass(row, index) : '',
          opts.onRowClick ? 'row-clickable' : '',
        ].filter(Boolean).join(' '),
        onclick: opts.onRowClick ? (ev) => {
          // Ignore clicks that land on an interactive control inside the row.
          if (ev.target.closest('button, a, input, select, textarea, label')) return;
          opts.onRowClick(row, index);
        } : null,
      }, columns.map((c) => {
        const content = c.render ? c.render(row, index) : row[c.key];
        return el('td', { class: c.align === 'right' ? 'ta-right' : (c.class || '') },
          content === undefined || content === null ? '—' : content);
      }));
      return trEl;
    }));

    return el('div.table-wrap', {}, el('table.table', {}, [thead, tbody]));
  }

  function field(label, control, opts = {}) {
    return el(`div.field${opts.wide ? '.field-wide' : ''}`, {}, [
      el('label.field-label', { for: control && control.id ? control.id : null }, [
        label,
        opts.required ? el('span.req', { title: tr('common.required') }, ' *') : null,
      ]),
      control,
      opts.help ? el('p.field-help', {}, opts.help) : null,
    ]);
  }

  function input(name, value, opts = {}) {
    return el('input.input', {
      id: `f-${name}`,
      name,
      type: opts.type || 'text',
      value: value === null || value === undefined ? '' : value,
      placeholder: opts.placeholder || '',
      required: opts.required || false,
      min: opts.min, max: opts.max, step: opts.step,
      maxlength: opts.maxlength || 2000,
      autocomplete: opts.autocomplete || 'off',
      disabled: opts.disabled || false,
      oninput: opts.oninput || null,
    });
  }

  function textarea(name, value, opts = {}) {
    const node = el('textarea.textarea', {
      id: `f-${name}`,
      name,
      rows: opts.rows || 4,
      placeholder: opts.placeholder || '',
      required: opts.required || false,
      maxlength: opts.maxlength || 8000,
      disabled: opts.disabled || false,
    });
    node.value = value === null || value === undefined ? '' : String(value);
    return node;
  }

  function select(name, value, options, opts = {}) {
    const node = el('select.select', {
      id: `f-${name}`,
      name,
      required: opts.required || false,
      disabled: opts.disabled || false,
      onchange: opts.onchange || null,
    }, [
      opts.placeholder !== false ? el('option', { value: '' }, opts.placeholder || `— ${tr('common.filter')} —`) : null,
      ...options.map((opt) => {
        const isObj = opt && typeof opt === 'object';
        const v = isObj ? opt.value : opt;
        const label = isObj ? (opt.label || opt.value) : humanise(opt);
        return el('option', { value: v, selected: String(value) === String(v) }, label);
      }),
    ]);
    if (opts.placeholder === false) node.value = value === null || value === undefined ? '' : String(value);
    return node;
  }

  function checkbox(name, checked, label, opts = {}) {
    const id = `c-${name}-${Math.random().toString(36).slice(2, 8)}`;
    return el('label.checkbox', { for: id }, [
      el('input', {
        id, name, type: 'checkbox', checked: Boolean(checked),
        disabled: opts.disabled || false, onchange: opts.onchange || null,
      }),
      el('span', {}, label),
    ]);
  }

  function button(label, opts = {}) {
    return el(`button.btn${opts.variant ? `.btn-${opts.variant}` : ''}`, {
      type: opts.type || 'button',
      disabled: opts.disabled || false,
      title: opts.title || '',
      onclick: opts.onclick || null,
    }, label);
  }

  function spinner(label) {
    return el('div.loading', {}, [
      el('div.spinner'),
      el('span', {}, label || tr('common.loading')),
    ]);
  }

  function errorBox(err, onRetry) {
    const message = err && err.message ? err.message : String(err);
    const code = err && err.code ? err.code : null;
    return el('div.error-box', {}, [
      el('strong', {}, tr('common.error')),
      el('p', {}, message),
      code ? el('p.mono.small', {}, code) : null,
      err && err.payload && err.payload.details
        ? el('pre.error-details', {}, JSON.stringify(err.payload.details, null, 2)) : null,
      onRetry ? button(tr('common.retry'), { variant: 'ghost', onclick: onRetry }) : null,
    ]);
  }

  // ----------------------------------------------------------------- toast --

  let toastHost = null;
  function toast(message, tone = 'info', timeout = 4200) {
    if (!toastHost) {
      toastHost = el('div.toast-host');
      document.body.appendChild(toastHost);
    }
    const node = el(`div.toast.toast-${tone}`, {}, [
      el('span.toast-msg', {}, message),
      el('button.toast-x', {
        type: 'button', 'aria-label': 'close',
        onclick: () => node.remove(),
      }, '\u00d7'),
    ]);
    toastHost.appendChild(node);
    if (timeout > 0) setTimeout(() => node.remove(), timeout);
    return node;
  }

  // ----------------------------------------------------------------- modal --

  /**
   * Open a modal. Returns { close }. `render(close)` supplies the body.
   * Modals trap focus and close on Escape, and never close on backdrop click
   * when `dismissible` is false - important for the signature dialog, where an
   * accidental click must not discard a partly completed attestation.
   */
  function modal({ title, render, width = '560px', dismissible = true, onClose }) {
    const host = el('div.modal-host', { role: 'dialog', 'aria-modal': 'true' });
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      host.remove();
      if (!document.querySelector('.modal-host')) document.body.classList.remove('modal-open');
      if (onClose) onClose();
    };

    const onKey = (ev) => {
      if (ev.key === 'Escape' && dismissible) { ev.preventDefault(); close(); }
    };

    const panel = el('div.modal-panel', { style: { maxWidth: width } }, [
      el('header.modal-head', {}, [
        el('h3.modal-title', {}, title),
        dismissible ? el('button.modal-x', { type: 'button', onclick: close, 'aria-label': 'close' }, '\u00d7') : null,
      ]),
      el('div.modal-body', {}, render(close)),
    ]);

    host.appendChild(el('div.modal-backdrop', {
      onclick: dismissible ? close : null,
    }));
    host.appendChild(panel);
    document.body.appendChild(host);
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', onKey);

    // Focus the first meaningful control so keyboard users are not stranded.
    const focusable = panel.querySelector('input:not([type=hidden]), select, textarea, button.btn-primary');
    if (focusable) setTimeout(() => focusable.focus(), 30);

    return { close, panel };
  }

  function confirmDialog({ title, message, confirmLabel, variant = 'danger', requireReason = false, minReason = 3 }) {
    return new Promise((resolve) => {
      let reasonInput = null;
      modal({
        title: title || tr('common.confirm'),
        width: '480px',
        render: (close) => [
          el('p', {}, message),
          requireReason ? field(tr('common.reason'), (reasonInput = textarea('reason', '', {
            rows: 3, required: true, placeholder: tr('reason.hint'),
          })), { required: true }) : null,
          el('div.modal-actions', {}, [
            button(tr('common.cancel'), { variant: 'ghost', onclick: () => { close(); resolve(null); } }),
            button(confirmLabel || tr('common.confirm'), {
              variant,
              onclick: () => {
                if (requireReason) {
                  const value = reasonInput.value.trim();
                  if (value.length < minReason) {
                    toast(tr('toast.reasonRequired'), 'warn');
                    reasonInput.focus();
                    return;
                  }
                  close(); resolve({ reason: value });
                  return;
                }
                close(); resolve(true);
              },
            }),
          ]),
        ],
      });
    });
  }

  /**
   * Mandatory reason prompt. Used for every GxP field change so the audit trail
   * never contains a change without a stated justification.
   */
  function reasonDialog({ title, message, confirmLabel, minLength = 3 }) {
    return new Promise((resolve) => {
      let reasonInput = null;
      modal({
        title: title || tr('common.reason'),
        width: '500px',
        render: (close) => [
          message ? el('p', {}, message) : null,
          field(tr('common.reason'), (reasonInput = textarea('reason', '', {
            rows: 3, required: true, placeholder: tr('reason.hint'),
          })), { required: true, help: tr('reason.hint') }),
          el('p.hint-note', {}, '21 CFR Part 11.10(e) / EU GMP Annex 11 §9'),
          el('div.modal-actions', {}, [
            button(tr('common.cancel'), { variant: 'ghost', onclick: () => { close(); resolve(null); } }),
            button(confirmLabel || tr('common.confirm'), {
              variant: 'primary',
              onclick: () => {
                const value = reasonInput.value.trim();
                if (value.length < minLength) {
                  toast(tr('toast.reasonRequired'), 'warn');
                  reasonInput.focus();
                  return;
                }
                close();
                resolve(value);
              },
            }),
          ]),
        ],
      });
    });
  }

  /**
   * Electronic signature dialog.
   *
   * Collects the two distinct identification components required by
   * 21 CFR Part 11.200(a)(1)(i):
   *   component A - username + password, re-entered at signing time
   *   component B - authenticator code (TOTP) or a single-use server challenge
   *
   * Resolves to the created signature object, or null if cancelled.
   */
  function signatureDialog({ meaning, reason: presetReason, entityType, entityId, recordKey, recordVersion, stepCode, secondFactorRequired = true, allowCancel = true }) {
    return new Promise((resolve) => {
      let usernameInput;
      let passwordInput;
      let totpInput;
      let challengeInput;
      let reasonInput;
      let challengeInfo = null;
      let submitting = false;
      let mode = secondFactorRequired ? 'challenge' : 'none';

      const body = (close) => {
        const container = el('div');

        const render = () => {
          clear(container);
          append(container, [
            el('p.modal-intro', {}, tr('signature.intro')),
            el('div.signature-target', {}, [
              el('div.sig-row', {}, [el('span.sig-key', {}, tr('signature.meaning')), el('span.sig-val', {}, meaningLabel(meaning))]),
              entityType ? el('div.sig-row', {}, [el('span.sig-key', {}, 'Record'), el('span.sig-val.mono', {}, recordKey || `${entityType}#${entityId}`)]) : null,
              stepCode ? el('div.sig-row', {}, [el('span.sig-key', {}, 'Step'), el('span.sig-val.mono', {}, stepCode)]) : null,
            ]),

            field(tr('auth.username'), (usernameInput = input('sig-username', window.App && window.App.user ? window.App.user.username : '', {
              required: true, autocomplete: 'username',
            })), { required: true }),

            field(tr('auth.password'), (passwordInput = input('sig-password', '', {
              type: 'password', required: true, autocomplete: 'current-password',
            })), { required: true }),

            secondFactorRequired ? el('div.second-factor', {}, [
              el('div.sf-switch', {}, [
                el('button.btn.btn-tab' + (mode === 'totp' ? '.active' : ''), {
                  type: 'button', onclick: () => { mode = 'totp'; render(); },
                }, tr('signature.useTotp')),
                el('button.btn.btn-tab' + (mode === 'challenge' ? '.active' : ''), {
                  type: 'button', onclick: () => { mode = 'challenge'; render(); },
                }, tr('signature.useChallenge')),
              ]),
              mode === 'totp'
                ? field(tr('auth.totp'), (totpInput = input('sig-totp', '', {
                    required: true, maxlength: 6, placeholder: '000000', autocomplete: 'one-time-code',
                  })), { required: true })
                : el('div', {}, [
                    el('div.challenge-row', {}, [
                      button(tr('signature.requestChallenge'), {
                        variant: 'ghost',
                        onclick: async (ev) => {
                          try {
                            const res = await window.Api.post('/api/signatures/challenge', { meaning });
                            challengeInfo = res;
                            challengeInput.value = res.nonce;
                            toast(`${tr('signature.requestChallenge')}: ${res.ttlSeconds}s`, 'info', 3000);
                            render();
                          } catch (err) {
                            toast(err.message, 'bad');
                          }
                        },
                      }),
                      challengeInfo
                        ? el('span.challenge-value.mono', {}, challengeInfo.nonce.slice(0, 12) + '…')
                        : null,
                    ]),
                    field(tr('signature.secondComponent'), (challengeInput = input('sig-challenge', challengeInfo ? challengeInfo.nonce : '', {
                      required: true, placeholder: tr('signature.requestChallenge'),
                    })), { required: true, help: tr('signature.challengeHint') }),
                  ]),
            ]) : null,

            field(tr('signature.reasonLabel'), (reasonInput = textarea('sig-reason', presetReason || '', {
              rows: 3, required: true, placeholder: tr('signature.reasonHint'),
            })), { required: true }),

            el('div.warning-note', {}, tr('signature.warning')),

            el('div.modal-actions', {}, [
              allowCancel ? button(tr('common.cancel'), {
                variant: 'ghost',
                onclick: () => { close(); resolve(null); },
              }) : null,
              button(tr('signature.apply'), {
                variant: 'primary',
                onclick: submit,
              }),
            ]),
          ]);
        };

        const submit = async () => {
          if (submitting) return;
          const reason = reasonInput.value.trim();
          if (!usernameInput.value.trim() || !passwordInput.value) {
            toast(`${tr('auth.username')} / ${tr('auth.password')}`, 'warn');
            return;
          }
          if (secondFactorRequired && mode === 'totp' && !/^\d{6}$/.test(totpInput.value.trim())) {
            toast(tr('auth.totp'), 'warn');
            totpInput.focus();
            return;
          }
          if (secondFactorRequired && mode === 'challenge' && !challengeInput.value.trim()) {
            toast(tr('signature.requestChallenge'), 'warn');
            return;
          }
          if (reason.length < 3) {
            toast(tr('toast.reasonRequired'), 'warn');
            reasonInput.focus();
            return;
          }

          submitting = true;
          const payload = {
            username: usernameInput.value.trim(),
            password: passwordInput.value,
            meaning,
            reason,
            entityType,
            entityId,
            recordKey,
            recordVersion,
            stepCode,
          };
          if (secondFactorRequired) {
            if (mode === 'totp') payload.totp = totpInput.value.trim();
            else payload.nonce = challengeInput.value.trim();
          }

          try {
            const signature = await window.Api.post('/api/signatures', payload);
            // Scrub the credential from the DOM as soon as it is no longer needed.
            passwordInput.value = '';
            if (totpInput) totpInput.value = '';
            close();
            resolve(signature);
          } catch (err) {
            submitting = false;
            toast(err.message || tr('common.error'), 'bad');
            // A used or expired challenge cannot be retried; force a new one.
            if (['NONCE_ALREADY_USED', 'NONCE_EXPIRED', 'NONCE_INVALID'].includes(err.code)) {
              challengeInfo = null;
              if (challengeInput) challengeInput.value = '';
            }
            if (passwordInput) passwordInput.value = '';
          }
        };

        render();
        return container;
      };

      modal({
        title: tr('signature.title'),
        width: '620px',
        dismissible: allowCancel,
        render: body,
      });
    });
  }

  function meaningLabel(code) {
    const names = {
      authored: bilingual('起草', 'Authored'),
      reviewed: bilingual('审核', 'Reviewed'),
      approved: bilingual('批准', 'Approved'),
      rejected: bilingual('拒绝', 'Rejected'),
      verified: bilingual('核实', 'Verified'),
      performed: bilingual('执行', 'Performed'),
      witnessed: bilingual('见证', 'Witnessed'),
      released: bilingual('放行', 'Released'),
      closed: bilingual('关闭', 'Closed'),
      acknowledged: bilingual('已阅知', 'Acknowledged'),
      effectiveness_confirmed: bilingual('有效性已确认', 'Effectiveness confirmed'),
      disposition: bilingual('作出处置决定', 'Disposition decided'),
      completed: bilingual('完成', 'Completed'),
    };
    return names[code] || humanise(code);
  }

  // --------------------------------------------------------------- helpers --

  /**
   * Render a form definition array (from a process step or document type) into
   * controls and return { node, values() }.
   */
  function buildForm(fields, initial = {}) {
    const nodes = [];
    const controls = {};
    for (const f of fields || []) {
      const raw = initial[f.key];
      let control;
      const common = { required: f.required };
      switch (f.type) {
        case 'textarea':
          control = textarea(f.key, raw, { rows: 4, required: f.required, placeholder: f.help || '' });
          break;
        case 'select':
          control = select(f.key, raw, f.options || [], {
            required: f.required,
            placeholder: f.required ? `— ${tr('common.required')} —` : `— ${tr('common.none')} —`,
          });
          break;
        case 'date':
          control = input(f.key, raw ? String(raw).slice(0, 10) : '', { type: 'date', required: f.required });
          break;
        case 'datetime':
          control = input(f.key, raw ? String(raw).slice(0, 16) : '', { type: 'datetime-local', required: f.required });
          break;
        case 'number':
          control = input(f.key, raw, { type: 'number', required: f.required, min: f.min, max: f.max, step: f.step });
          break;
        case 'checkbox':
          control = checkbox(f.key, raw, f.label);
          break;
        case 'user':
          control = input(f.key, raw, { required: f.required, placeholder: f.help || '' });
          break;
        case 'computed':
          // A value the system decides, not the person. Rendered read-only and
          // still emitted by values() so the audit trail records what the
          // reviewer actually saw on screen when they signed the step.
          control = el('div.computed-value', { id: `f-${f.key}`, 'data-key': f.key },
            raw === null || raw === undefined || raw === '' ? tr('clock.notComputedYet') : String(raw));
          break;
        default:
          control = input(f.key, raw, { required: f.required, placeholder: f.help || '' });
      }
      controls[f.key] = control;
      nodes.push(field(pick(f, 'label'), control, {
        required: f.required,
        help: pick(f, 'help') || null,
        wide: f.type === 'textarea',
      }));
    }

    const node = el('div.form-grid', {}, nodes);

    function values() {
      const out = {};
      for (const f of fields || []) {
        const control = controls[f.key];
        if (!control) continue;
        let value;
        if (f.type === 'checkbox') value = control.checked;
        else if (f.type === 'computed') value = control.textContent;
        else value = control.value;
        if (typeof value === 'string') value = value.trim();
        if (value === '') value = null;
        out[f.key] = value;
      }
      return out;
    }

    /** Returns the list of missing required labels. */
    function missing() {
      const out = [];
      for (const f of fields || []) {
        if (!f.required) continue;
        const control = controls[f.key];
        if (!control) continue;
        const value = f.type === 'checkbox' ? control.checked : String(control.value || '').trim();
        if (!value) out.push(pick(f, 'label'));
      }
      return out;
    }

    return { node, values, missing, controls };
  }

  /**
   * The reporting-clock panel.
   *
   * Shows the deadline, the countdown, and - the part that actually matters in
   * an inspection - WHY that deadline is what it is: which rule applied, which
   * date the count started from, and whether the clock is genuinely running or
   * only provisionally calculated. A bare date invites the question "where did
   * this come from?"; answering it on screen is cheaper than answering it later.
   *
   * Returns null when the case has no clock at all, so callers can fall back to
   * the old due-date line.
   */
  function clockPanel(clock) {
    if (!clock || !clock.deadline) return null;
    const en = getLocale() === 'en';
    const left = clock.daysLeft;
    const stopped = clock.clockRunning === false;

    let tone = 'clock-ok';
    let countdown;
    if (stopped) {
      tone = 'clock-stopped';
      countdown = tr('clock.notRunning');
    } else if (left < 0) {
      tone = 'clock-overdue';
      countdown = tr('clock.daysOverdue', { n: Math.abs(left) });
    } else if (left === 0) {
      tone = 'clock-soon';
      countdown = tr('clock.dueToday');
    } else if (left <= 3) {
      tone = 'clock-soon';
      countdown = tr('clock.daysLeft', { n: left });
    } else {
      countdown = tr('clock.daysLeft', { n: left });
    }

    const basisLabel = clock.day0Basis === 'received_date_fallback'
      ? tr('clock.basisReceived')
      : (clock.day0Basis === 'new_information_date' ? tr('clock.basisNewInfo') : tr('clock.basisAwareness'));

    const ruleLabel = clock.rule
      ? (en ? (clock.rule.labelEn || clock.rule.label) : clock.rule.label)
      : (en ? 'Unclassified' : '未分类');

    const kids = [
      el('div.clock-head', {}, [
        el('span.clock-title', {}, tr('clock.title')),
        el('span.clock-countdown', {}, countdown),
      ]),
      el('dl.clock-grid', {}, [
        el('dt', {}, tr('clock.day0')),
        el('dd', {}, [
          clock.day0 || '—',
          el('span.clock-ref', {}, ` · ${basisLabel}`),
        ]),
        el('dt', {}, tr('clock.due')),
        el('dd', {}, [
          clock.deadline,
          clock.deadlineHours
            ? el('span.clock-ref', {}, ` · ${clock.deadlineHours} h`)
            : el('span.clock-ref', {}, ` · ${clock.deadlineDays} d`),
        ]),
        el('dt', {}, tr('clock.rule')),
        el('dd', {}, ruleLabel),
      ]),
    ];

    if (clock.rule && clock.rule.regulation) {
      kids.push(el('p.clock-ref', { style: 'margin-top:6px' }, clock.rule.regulation));
    }

    for (const w of clock.warnings || []) {
      kids.push(el('div', { class: `clock-warn${w.severity === 'high' ? ' clock-warn-bad' : ''}` }, [
        en ? (w.messageEn || w.message) : w.message,
        w.regulation ? el('span.clock-ref', {}, ` ${w.regulation}`) : null,
      ]));
    }
    if (stopped) kids.push(el('div.clock-warn', {}, tr('clock.notRunningWhy')));

    return el('div', { class: `clock-panel ${tone}` }, kids);
  }

  function pick(obj, base) {
    if (!obj) return '';
    const locale = window.I18N.getLocale();
    if (locale === 'en' && obj[`${base}En`]) return obj[`${base}En`];
    return obj[base] || obj[`${base}En`] || '';
  }

  /** Datetime-local inputs give "YYYY-MM-DDTHH:mm"; the API wants ISO or date. */
  function normaliseDateInput(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }

  /** Compress a JSON diff for display in the audit trail. */
  function renderJson(value, maxLength = 600) {
    if (value === null || value === undefined || value === '') return el('span.muted', {}, '—');
    let parsed = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); } catch { return el('span.mono.small', {}, truncate(value, maxLength)); }
    }
    const text = JSON.stringify(parsed, null, 1);
    return el('pre.json-view', {}, truncate(text, maxLength));
  }

  function truncate(text, max) {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  window.UI = {
    el, append, clear, frag, esc,
    fmtDate, fmtDateTime, fmtRelative, fmtNumber, fmtBytes, humanise,
    badge, statusBadge, criticalityBadge, card, stat, table, field,
    input, textarea, select, checkbox, button, spinner, errorBox,
    toast, modal, confirmDialog, reasonDialog, signatureDialog, meaningLabel,
    buildForm, normaliseDateInput, renderJson, truncate, pick, clockPanel,
  };
})();
