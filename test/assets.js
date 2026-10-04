'use strict';

/**
 * Asset and endpoint check for the workflow explorer screen.
 *
 * The domain tests exercise the modules and the HTTP API; this one covers the
 * remaining gap - that the browser's own surface is intact. A view file that is
 * syntactically valid but not referenced by index.html, or a CSS class the view
 * relies on that was never written, produces a blank or broken screen with every
 * other test still green.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const PORT = 8931 + Math.floor(Math.random() * 60);
const DB = path.join(os.tmpdir(), `pv-assets-${Date.now()}.sqlite`);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); }
  else { failed += 1; process.stdout.write(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}\n`); }
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.status === 200 || res.status === 503) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bound a promise, so no single step can stall the suite forever.
 *
 * This exists because a page-side `Runtime.evaluate` with `awaitPromise: true`
 * whose promise never settles does not reject: the CDP reply simply never
 * arrives, and a plain `await` then waits for the lifetime of the process. The
 * suite must always terminate and report, even when the browser misbehaves - a
 * hung test run is indistinguishable from a crashed one to whoever is reading CI.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

/** Total wall-clock budget for one probe's browser session, including teardown. */
const PROBE_BUDGET_MS = 150000;

/**
 * Reap a browser process and everything it spawned.
 *
 * Headless Edge is a tree, not a single process. `child.kill()` on Windows sends
 * a termination signal to the launcher only; the renderer and GPU children are
 * normally cleaned up, but if the parent is already wedged they can outlive the
 * run. `taskkill /T` walks the tree, which is the reliable form on this platform.
 * Failure is ignored on purpose - teardown must never mask the real result.
 */
function reap(browser) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      browser.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/**
 * Run a function against a freshly launched headless browser.
 *
 * Returns null when no browser is available, so callers skip those checks rather
 * than reporting a false failure on a machine without Edge. Every DOM assertion
 * in this file goes through here; the alternative - trusting the payload - has
 * already let three real breakages through.
 */
async function withBrowser(fn) {
  const edge = findEdge();
  if (!edge) return null;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-probe-'));
  const debugPort = 9900 + Math.floor(Math.random() * 400);
  const browser = spawn(edge, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1500,1100', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
        break;
      } catch { await sleep(300); }
    }
    if (!version) return null;

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await withTimeout(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('websocket error')));
    }), 15000, 'websocket open');

    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception
          ? m.params.exceptionDetails.exception.description
          : m.params.exceptionDetails.text);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 25000);
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => send(m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await withTimeout(
        call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        30000, 'Runtime.evaluate');
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description
          : r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const goto = async (url) => { await call('Page.navigate', { url }); };

    const result = await withTimeout(fn({ evaluate, goto }), PROBE_BUDGET_MS, 'probe body');
    if (result && typeof result === 'object') result.errors = errors;
    return result;
  } finally {
    reap(browser);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Open the application and report the first screen, touching nothing.
 *
 * The design is identity-first: the opening screen asks who you are, and the area
 * reference model is reachable below it without a session. Asserting that needs a
 * browser - the claim is about what is rendered, which no API-level test can
 * observe.
 *
 * This probe previously looked for `.persona-card` and asserted there were none,
 * under the old domain-first design. `.persona-card` is now the DOMAIN page's
 * identity panel, so on the opening screen the count was always zero and the
 * assertion passed without testing anything. The identity cards are
 * `.identity-card`. The deeper journey - password, landing destination - is
 * covered by test/identity-flow.js.
 */
async function openProbe() {
  return withBrowser(async ({ evaluate, goto }) => {
    await goto(`http://127.0.0.1:${PORT}/`);
    await sleep(4000);

    // The flow diagram at the top loads lazily (domain payload plus one call per
    // dedicated process), so wait for it rather than racing it.
    for (let i = 0; i < 70; i += 1) {
      const ready = await evaluate(`document.querySelectorAll('.df-overview .flow-cascade').length > 0`).catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const base = JSON.parse(await evaluate(`JSON.stringify({
      hash: window.location.hash,
      identityCards: document.querySelectorAll('.identity-card').length,
      identitySections: document.querySelectorAll('.is-title').length,
      domainCards: document.querySelectorAll('.domain-card').length,
      loginForm: Boolean(document.querySelector('.auth-card')),
      signedIn: Boolean(window.App && window.App.user),
      flowOverview: Boolean(document.querySelector('.df-overview')),
      flowCascades: document.querySelectorAll('.df-overview .flow-cascade').length,
      flowFirstTitle: (() => {
        const t = document.querySelector('.df-overview .is-title');
        return t ? t.textContent.trim().split(' / ')[0] : null;
      })(),
      flowTop: Math.round((document.querySelector('.df-overview') || { getBoundingClientRect: () => ({ top: -1 }) })
        .getBoundingClientRect().top + scrollY),
      activeChip: (() => {
        const c = document.querySelector('.df-chip.active');
        return c ? c.dataset.code : null;
      })(),
      viewport: window.innerHeight,
    })`));

    // Switch the area chip and confirm the diagram changes in place.
    const switched = JSON.parse(await evaluate(`JSON.stringify((() => {
      const chip = [...document.querySelectorAll('.df-chip')].find((c) => c.dataset.code === 'GVP');
      if (!chip) return false;
      chip.click();
      return true;
    })())`));
    let gvpCascades = 0;
    let activeChip = null;
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      activeChip = await evaluate(`(() => {
        const c = document.querySelector('.df-chip.active');
        return c ? c.dataset.code : null;
      })()`).catch(() => null);
      gvpCascades = await evaluate(`document.querySelectorAll('.df-overview .flow-cascade').length`).catch(() => 0);
      if (activeChip === 'GVP' && gvpCascades > 0) break;
    }
    const gvp = { activeChip, gvpCascades };

    return { base, switched, gvp };
  });
}

/**
 * Click a domain once, report what its screen renders, then pick an identity and
 * report where that lands.
 *
 * This walks the whole path a first-time user takes: open, one click, read, pick
 * who to be. Each stage has been broken at least once while the payloads looked
 * right - a missing field emptied the identity panel, a shadowed helper reduced
 * it to a single stray tile, and two modules disagreeing about the shared
 * password made every identity on it unloggable.
 */
async function oneClickProbe(domainCode) {
  return withBrowser(async ({ evaluate, goto }) => {
    await goto(`http://127.0.0.1:${PORT}/`);
    await sleep(3400);

    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const target = cards.find((c) => c.textContent.includes(${JSON.stringify(domainCode)}));
      if (target) target.click();
      return true;
    })()`);
    await sleep(3800);

    const dom = JSON.parse(await evaluate(`JSON.stringify({
      hash: window.location.hash,
      signedIn: Boolean(window.App && window.App.user),
      title: document.querySelector('.view-title') ? document.querySelector('.view-title').textContent.trim() : null,
      processRows: document.querySelectorAll('.domain-flow-row').length,
      cascades: document.querySelectorAll('.flow-cascade').length,
      columns: document.querySelectorAll('.fc-col').length,
      dutiesOnFlow: document.querySelectorAll('.fc-card-duty').length,
      identityCards: document.querySelectorAll('.persona-card').length,
      identityNote: Boolean(document.querySelector('.identity-note')),
      firstIdentity: document.querySelector('.persona-card')
        ? document.querySelector('.persona-card').textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)
        : null,
    })`));

    const after = JSON.parse(await evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.persona-card')];
      if (!cards.length) return JSON.stringify({ ok: false });
      cards[0].click();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (window.App && window.App.user) break;
      }
      await new Promise((r) => setTimeout(r, 2600));
      return JSON.stringify({
        ok: Boolean(window.App && window.App.user),
        user: window.App.user ? window.App.user.username : null,
        hash: window.location.hash,
        identityCards: document.querySelectorAll('.persona-card').length,
        clickable: document.querySelectorAll('.participant-card.pc-clickable').length,
      });
    })()`));

    return { ...dom, after };
  });
}

/**
 * Enter a domain as a visitor, pick an identity, then leave again.
 *
 * Entering a domain was a one-way door: once inside, the only controls were the
 * role chip and a sign-out that dropped the user on a credential screen. This
 * walks the way out - back to the picker with the session kept, and back to the
 * picker with the identity released - because a door that only opens inward is
 * a bug no amount of correct payloads will reveal.
 */
async function exitProbe(domainCode) {
  return withBrowser(async ({ evaluate, goto }) => {
    await goto(`http://127.0.0.1:${PORT}/`);
    await sleep(3400);

    const anonymousNav = JSON.parse(await evaluate(
      `JSON.stringify([...document.querySelectorAll('.nav-item .nav-label')].map((n) => n.textContent.trim()))`
    ));

    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const target = cards.find((c) => c.textContent.includes(${JSON.stringify(domainCode)}));
      if (target) target.click();
      return true;
    })()`);
    await sleep(3400);

    const asVisitor = JSON.parse(await evaluate(`JSON.stringify({
      hash: window.location.hash,
      headerButtons: [...document.querySelectorAll('.view-head-actions button')].map((b) => b.textContent.trim()),
    })`));

    // Choose an identity, then look for the way out.
    await evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.persona-card')];
      if (cards.length) cards[0].click();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (window.App && window.App.user) break;
      }
      await new Promise((r) => setTimeout(r, 2400));
      return true;
    })()`);

    const inside = JSON.parse(await evaluate(`JSON.stringify({
      user: window.App.user ? window.App.user.username : null,
      hash: window.location.hash,
      topbar: [...document.querySelectorAll('.topbar-actions > *')].map((n) => n.textContent.trim()).filter(Boolean),
      headerButtons: [...document.querySelectorAll('.view-head-actions button')].map((b) => b.textContent.trim()),
    })`));

    // Leave, keeping the session.
    const leftKeeping = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.view-head-actions button')];
      const target = buttons.find((b) => /返回领域选择|Back to domains/.test(b.textContent));
      if (!target) return 'no control';
      target.click();
      return 'clicked';
    })()`);
    await sleep(1800);
    const afterBack = JSON.parse(await evaluate(`JSON.stringify({
      hash: window.location.hash,
      stillSignedIn: Boolean(window.App && window.App.user),
      domainCards: document.querySelectorAll('.domain-card').length,
    })`));

    // Go back in, then release the identity from the topbar.
    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const target = cards.find((c) => c.textContent.includes(${JSON.stringify(domainCode)}));
      if (target) target.click();
      return true;
    })()`);
    await sleep(2800);
    const switched = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.topbar-actions button')];
      const target = buttons.find((b) => /切换身份|Switch identity/.test(b.textContent));
      if (!target) return 'no control';
      target.click();
      return 'clicked';
    })()`);
    await sleep(2600);
    const afterSwitch = JSON.parse(await evaluate(`JSON.stringify({
      hash: window.location.hash,
      signedIn: Boolean(window.App && window.App.user),
      domainCards: document.querySelectorAll('.domain-card').length,
      identityCards: document.querySelectorAll('.persona-card').length,
    })`));

    return { anonymousNav, asVisitor, inside, leftKeeping, afterBack, switched, afterSwitch };
  });
}

/**
 * Check the responsibility cascade on a domain screen.
 *
 * The shape is the requirement: steps left to right, and under each step the
 * people responsible, and under each person their permissions. Counting the
 * elements proves the cascade is nested rather than the flow, the role list and
 * the matrix sitting in three separate cards for the reader to join up.
 */
async function cascadeProbe(domainCode) {
  return withBrowser(async ({ evaluate, goto }) => {
    await goto(`http://127.0.0.1:${PORT}/`);
    await sleep(3400);

    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const target = cards.find((c) => c.textContent.includes(${JSON.stringify(domainCode)}));
      if (target) target.click();
      return true;
    })()`);
    await sleep(3200);

    // Sign in so the cards carry real names, then reopen the domain.
    await evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.persona-card')];
      if (cards.length) cards[0].click();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (window.App && window.App.user) break;
      }
      await new Promise((r) => setTimeout(r, 3200));
      return true;
    })()`);
    await sleep(1200);

    const shape = JSON.parse(await evaluate(`JSON.stringify({
      cascades: document.querySelectorAll('.flow-cascade').length,
      columns: document.querySelectorAll('.fc-col').length,
      steps: document.querySelectorAll('.fc-step').length,
      // Nesting: each step's people container must be inside the same column as
      // the step, not a sibling section elsewhere on the page.
      peopleInsideColumns: [...document.querySelectorAll('.fc-col')]
        .filter((c) => c.querySelector('.fc-col-inner > .fc-step') && c.querySelector('.fc-col-inner > .fc-people')).length,
      // The vertical order inside a column: step first, people second.
      firstColumnOrder: (() => {
        const inner = document.querySelector('.fc-col-inner');
        return inner ? [...inner.children].map((c) => c.className.split(' ')[0]) : [];
      })(),
      personCards: document.querySelectorAll('.fc-card').length,
      namedCards: [...document.querySelectorAll('.fc-card-name')]
        .filter((n) => n.textContent.trim() && !/选择身份|Choose an identity/.test(n.textContent)).length,
      duties: [...document.querySelectorAll('.fc-card-duty')].filter((n) => n.textContent.trim()).length,
      permToggles: document.querySelectorAll('.pcp-toggle').length,
      // One disclaimer per flow, not one per card.
      footNotes: document.querySelectorAll('.fc-foot-note').length,
    })`));

    // Open the first card's permissions and check the three-state split appears.
    const opened = JSON.parse(await evaluate(`(() => {
      const t = document.querySelector('.pcp-toggle');
      if (!t) return JSON.stringify({ ok: false });
      t.click();
      const body = t.parentElement.querySelector('.pc-perms-body');
      return JSON.stringify({
        ok: true,
        groups: body.querySelectorAll('.pcp-group').length,
        chips: body.querySelectorAll('.pcp-chip').length,
        conditional: body.querySelectorAll('.pcp-chip-cond').length,
        titles: [...body.querySelectorAll('.pcp-group-title')].map((x) => x.textContent.trim()),
      });
    })()`));

    return { shape, opened };
  });
}

/**
 * Check that the flow diagram is reachable without hunting for it.
 *
 * This exists because the answer to "I do not see the flow diagram" turned out to
 * be "you have to scroll four thousand pixels". The diagram rendered, and every
 * element assertion passed, because it was simply buried behind three other
 * sections. Only a check on the section order and its distance from the top
 * catches that class of problem.
 */
async function layoutProbe(domainCode) {
  return withBrowser(async ({ evaluate, goto }) => {
    await goto(`http://127.0.0.1:${PORT}/`);
    await sleep(3400);
    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const target = cards.find((c) => c.textContent.includes(${JSON.stringify(domainCode)}));
      if (target) target.click();
      return true;
    })()`);
    await sleep(3600);

    // Sign in, then reopen the domain. A signed-in visitor has no identity panel,
    // so the flow should be the first thing on the page; that is the layout being
    // asserted. The anonymous ordering is checked separately below.
    await evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.persona-card')];
      if (cards.length) cards[0].click();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (window.App && window.App.user) break;
      }
      await new Promise((r) => setTimeout(r, 3400));
      return true;
    })()`);
    await sleep(1200);

    const signedIn = JSON.parse(await evaluate(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.view .card')];
      const titles = cards.map((c) => (c.querySelector('.card-title')
        ? c.querySelector('.card-title').textContent.trim().split(' / ')[0] : ''));
      const flowIndex = titles.findIndex((t) => /工作流程与责任分工|workflows and who is responsible/i.test(t));
      const flowCard = flowIndex >= 0 ? cards[flowIndex] : null;
      return {
        sectionCount: cards.length,
        titles,
        flowIndex,
        topOfFlow: flowCard ? Math.round(flowCard.getBoundingClientRect().top + window.scrollY) : null,
        viewportHeight: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight,
        user: window.App.user ? window.App.user.username : null,
      };
    })())`));

    // And confirm that even as an anonymous visitor, whose identity panel sits
    // above everything, the flow is not pushed past the second section.
    await evaluate(`(async () => {
      await window.Api.post('/api/auth/logout').catch(() => {});
      window.App.user = null;
      window.App.permissions = [];
      window.App.session = null;
      window.App.refresh();
      await new Promise((r) => setTimeout(r, 2600));
      return true;
    })()`);
    await sleep(2600);
    const anonymous = JSON.parse(await evaluate(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.view .card')];
      const titles = cards.map((c) => (c.querySelector('.card-title')
        ? c.querySelector('.card-title').textContent.trim().split(' / ')[0] : ''));
      const flowIndex = titles.findIndex((t) => /工作流程与责任分工|workflows and who is responsible/i.test(t));
      return { flowIndex, titles, sectionCount: cards.length };
    })())`));

    return { signedIn, anonymous };
  });
}

/**
 * Check the restricted-card behaviour: greyed, still readable, and willing to
 * explain itself.
 *
 * The report writer is used as the viewer because the mismatch is real rather
 * than contrived: their own areas are GVP and PSUR, so opening the SIGNAL
 * domain puts every one of its roles outside their scope. A QA manager would
 * see everything and demonstrate nothing.
 *
 * They are signed in from the PSUR screen first, because the SIGNAL roster
 * correctly does not offer them - that is the rule working, and it means the
 * identity cannot be picked from the screen being tested.
 */
async function restrictedCardProbe(domainCode) {
  return withBrowser(async ({ evaluate, goto }) => {
    await goto(`http://127.0.0.1:${PORT}/`);
    await sleep(3400);

    // Sign in from PSUR, where the report writer belongs.
    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const psur = cards.find((c) => c.textContent.includes('PSUR'));
      if (psur) psur.click();
      return true;
    })()`);
    await sleep(3600);

    const signedIn = await evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.persona-card')];
      const writer = cards.find((c) => /定期报告撰写员|PV Report Writer/.test(c.textContent)) || null;
      if (!writer) {
        return { ok: false, reason: 'not on the PSUR roster either',
          seen: cards.slice(0, 8).map((c) => c.textContent.trim().slice(0, 24)) };
      }
      writer.click();
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (window.App && window.App.user) {
          return { ok: true, role: window.App.user.role, username: window.App.user.username };
        }
      }
      return { ok: false, reason: 'sign-in did not complete' };
    })()`);
    await sleep(2500);

    return { signedIn, ...(await inspectDomain(domainCode, evaluate)) };
  });
}

/** Navigate to a domain and report how its participant cards rendered. */
async function inspectDomain(domainCode, evaluate) {
  await evaluate(`(() => {
    window.location.hash = '#/domain/${domainCode}';
    return true;
  })()`);
  await sleep(4200);

  const dom = JSON.parse(await evaluate(`JSON.stringify({
    cards: document.querySelectorAll('.participant-card').length,
    restricted: document.querySelectorAll('.participant-card.pc-hidden').length,
    viewable: document.querySelectorAll('.participant-card.pc-viewable').length,
    restrictedBadges: document.querySelectorAll('.pc-hidden .badge').length,
    nameHidden: document.querySelectorAll('.pc-name-hidden').length,
    // The reference material must survive the restriction: a greyed card that
    // also hides the duty leaves nothing behind.
    dutiesOnRestricted: [...document.querySelectorAll('.pc-hidden .pc-duty')]
      .filter((n) => n.textContent.trim().length > 0).length,
    // No real name may appear on a restricted card.
    leakedNames: [...document.querySelectorAll('.pc-hidden .pc-name')]
      .filter((n) => !/无权查看|not visible/.test(n.textContent)).length,
  })`));

  // Clicking a restricted card must explain the refusal, not do nothing.
  const refusal = JSON.parse(await evaluate(`(() => {
    const card = document.querySelector('.participant-card.pc-hidden');
    if (!card) return JSON.stringify({ clicked: false });
    card.click();
    return JSON.stringify({ clicked: true });
  })()`));
  await sleep(1200);
  const dialog = JSON.parse(await evaluate(`JSON.stringify((() => {
    const panel = document.querySelector('.modal-panel');
    if (!panel) return { opened: false };
    const text = panel.textContent;
    return {
      opened: true,
      hasReasonLabel: Boolean(panel.querySelector('.refusal-reason')),
      hasPublicList: Boolean(panel.querySelector('.refusal-list')),
      mentionsArea: /领域|area/i.test(text),
      reasonText: panel.querySelector('.refusal-reason p')
        ? panel.querySelector('.refusal-reason p').textContent.trim().slice(0, 90) : null,
    };
  })())`));

  return { dom, refusal, dialog };
}

/**
 * Drive a real browser to a hash route and count what rendered.
 *
 * This exists because API-level assertions are not enough: the domain page once
 * shipped with every participant card reading "no account" and none of them
 * clickable, while every payload check passed. Only reading the DOM catches that.
 *
 * Returns null when no browser is available, and the caller skips those checks
 * rather than reporting a false failure.
 */
async function renderProbe(hash) {
  const edge = findEdge();
  if (!edge) return null;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-probe-'));
  const debugPort = 9900 + Math.floor(Math.random() * 90);
  const browser = spawn(edge, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1500,1100', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
        break;
      } catch { await sleep(300); }
    }
    if (!version) return null;

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await withTimeout(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('websocket error')));
    }), 15000, 'websocket open');

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 20000);
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => send(m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await withTimeout(
        call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        30000, 'Runtime.evaluate');
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description
          : r.exceptionDetails.text);
      }
      return r.result.value;
    };

    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3200);

    // Walk the real flow: the session cookie is HttpOnly and the SPA keeps its
    // user in memory, so injecting state from outside does not work. ICSR is used
    // because it involves every role, so later assertions about a specific role's
    // presence hold whichever identity the roster leads with.
    const signedIn = await evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.domain-card')];
      const icsr = cards.find(c => c.textContent.includes('ICSR')) || cards[0];
      if (!icsr) return false;
      icsr.click();
      await new Promise(r => setTimeout(r, 3600));
      const identities = [...document.querySelectorAll('.persona-card')];
      if (!identities.length) return false;
      const qa = identities.find(c => /药物警戒质量负责人/.test(c.textContent)) || identities[0];
      qa.click();
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (window.App && window.App.user) return true;
      }
      return false;
    })()`);
    if (!signedIn) throw new Error('could not sign in through the one-click flow');

    await evaluate(`window.location.hash = ${JSON.stringify(hash)}; null`);
    await sleep(2600);

    return await withTimeout(evaluate(`JSON.stringify({
      cards: document.querySelectorAll('.participant-card').length,
      clickable: document.querySelectorAll('.participant-card.pc-clickable').length,
      sample: [...document.querySelectorAll('.participant-card')].slice(0, 3).map(c => ({
        name: c.querySelector('.pc-name') ? c.querySelector('.pc-name').textContent.trim() : null,
        duty: c.querySelector('.pc-duty') ? c.querySelector('.pc-duty').textContent.trim() : null,
      })),
      flowNodes: document.querySelectorAll('.flow-node').length,
      roleBlocks: document.querySelectorAll('.fn-role-block').length,
      dutyTexts: [...document.querySelectorAll('.fn-role-duty')].filter(e => e.textContent.trim().length > 0).length,
      responsibilityRows: document.querySelectorAll('.responsibility-table tbody tr').length,
      participantCards: document.querySelectorAll('.participant-card').length,
      matrixRows: document.querySelectorAll('.permission-matrix tbody tr').length,
      conditionalMarks: document.querySelectorAll('.mx-cond').length,
      activeNav: (() => {
        const a = document.querySelector('.nav-item.active .nav-label');
        return a ? a.textContent.trim() : null;
      })(),
      activeNavCount: document.querySelectorAll('.nav-item.active').length,
    })`).then(JSON.parse), PROBE_BUDGET_MS, 'render probe');
  } finally {
    reap(browser);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function main() {
  process.stdout.write('\n  LeebertyPV -  explorer asset and endpoint check\n\n');

  const env = {
    ...process.env,
    PV_DB_FILE: DB, PV_PORT: String(PORT), PV_HOST: '127.0.0.1',
    PV_MONITOR: '0', PV_SEED: '1', PV_BUILTIN_ACCOUNTS: '1',
  };
  const runNode = (script) => new Promise((resolve, reject) => {
    const c = spawn(NODE, [path.join(ROOT, script)], { cwd: ROOT, env, stdio: 'ignore' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
  await runNode(path.join('scripts', 'seed.js'));
  await runNode(path.join('scripts', 'seed-demo.js'));

  const child = spawn(NODE, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  try {
    check('server is up', await waitForHealth(), out.slice(-300));

    // ---- static assets the explorer screen needs --------------------------
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    check('index.html is served', html.includes('<html'));

    const viewFile = '/js/views/explorer.js';
    check('index.html loads the explorer view', html.includes(viewFile),
      'the view file exists but is not referenced, so it would never execute');

    const viewJs = await fetch(`http://127.0.0.1:${PORT}${viewFile}`);
    const viewBody = await viewJs.text();
    check('the explorer view is served', viewJs.status === 200 && viewBody.length > 10000,
      `status ${viewJs.status}, ${viewBody.length} bytes`);

    const css = await (await fetch(`http://127.0.0.1:${PORT}/css/app.css`)).text();
    check('app.css is served', css.length > 10000);

    // ---- every CSS class the view uses must exist -------------------------
    // A missing class does not throw; it silently renders an unstyled block.
    // Element selectors ('div', 'span', 'input.sig-x') carry no class, so the
    // first segment of a dotted selector is only counted when it is not a tag.
    const HTML_TAGS = new Set(['div', 'span', 'code', 'button', 'details', 'summary',
      'label', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'li', 'p', 'h4', 'a', 'table',
      'section', 'input', 'select', 'textarea', 'strong', 'em', 'header', 'footer', 'ol']);
    const used = new Set();
    for (const m of viewBody.matchAll(/el\(\s*'([^']+)'/g)) {
      const parts = m[1].split('.');
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!part || part.includes('$')) continue;
        if (i === 0 && HTML_TAGS.has(part)) continue;
        used.add(part);
      }
    }
    for (const m of viewBody.matchAll(/`([a-z][a-z0-9-]*)\.\$\{/g)) {
      if (!HTML_TAGS.has(m[1])) used.add(m[1]);
    }
    for (const m of viewBody.matchAll(/class:\s*'([a-z][a-z0-9- ]*)'/g)) {
      for (const part of m[1].split(/\s+/)) if (part && !HTML_TAGS.has(part)) used.add(part);
    }
    const missing = [...used].filter((c) => c.length > 2 && !css.includes(`.${c}`));
    check('every class the view uses is defined in the stylesheet', missing.length === 0,
      missing.join(', '));

    // ---- the explorer API is public, but withholds instance state ----------
    // The reference model is readable before anyone signs in: the area list, the
    // domain's flows, its roles and the permission matrix are all public by
    // design, because a process diagram that hides its own roles is useless. What
    // must NOT reach an anonymous caller is anything about this organisation: how
    // many records exist, who holds each role, or the demonstration credential.
    const anonExplorer = await fetch(`http://127.0.0.1:${PORT}/api/explorer/PV-DEV`);
    const anonBody = anonExplorer.status === 200 ? await anonExplorer.json() : {};
    check('an anonymous caller can read the process reference model',
      anonExplorer.status === 200 && anonBody.steps && anonBody.steps.length > 0,
      `status ${anonExplorer.status}`);
    check('an anonymous caller learns nothing about this instance records or cast',
      anonBody.demoLogin === null
        && (anonBody.participants || []).every((p) => p.accounts.length === 0
          && p.loginable === false && p.pendingItems === 0),
      `demoLogin=${JSON.stringify(anonBody.demoLogin)} accounts=${(anonBody.participants || []).map((p) => p.accounts.length).join(',')}`);

    const anonDomain = await fetch(`http://127.0.0.1:${PORT}/api/domain/ICSR`);
    const anonDomainBody = anonDomain.status === 200 ? await anonDomain.json() : {};
    check('an anonymous caller sees the domain reference model',
      anonDomain.status === 200 && (anonDomainBody.processes || []).length > 0
        && (anonDomainBody.matrix || {}).roles,
      `status ${anonDomain.status}`);
    check('an anonymous caller does not see domain record totals',
      anonDomainBody.summary && anonDomainBody.summary.totalRecords === 0
        && (anonDomainBody.participants || []).every((p) => p.accounts.length === 0),
      `totalRecords=${anonDomainBody.summary && anonDomainBody.summary.totalRecords}`);

    // Changing the cast is configuration, so it still needs a session.
    const anonWrite = await fetch(`http://127.0.0.1:${PORT}/api/explorer/PV-DEV/participants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'trainer', reason: 'anonymous attempt' }),
    });
    check('managing the cast still requires a session', anonWrite.status === 401,
      `status ${anonWrite.status}`);

    // ---- sign in as a persona and walk the screen's own call sequence -----
    const choices = await (await fetch(`http://127.0.0.1:${PORT}/api/login-choices`)).json();
    const manager = choices.personas.find((p) => p.role === 'qa_manager');
    const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: manager.username, password: choices.password }),
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    const authed = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { cookie } });

    const boot = await (await authed('/api/bootstrap')).json();
    check('bootstrap returns the GxP areas', Array.isArray(boot.gxpAreas) && boot.gxpAreas.length >= 8,
      `${boot.gxpAreas && boot.gxpAreas.length}`);

    const pt = await (await authed('/api/process-types')).json();
    check('process types load for the domain picker', pt.rows && pt.rows.length === 12,
      `${pt.rows && pt.rows.length}`);

    // The exact call the view makes, with the parameter it now passes.
    const exp = await (await authed('/api/explorer/ICSR-EXP?includeAllRoles=0')).json();
    check('the explorer call the view makes succeeds', Boolean(exp.process));
    check('the matrix is limited to the cast', exp.matrix.roles.length === exp.participants.length,
      `${exp.matrix.roles.length} roles vs ${exp.participants.length} participants`);
    check('the constraint index travels with the matrix',
      Boolean(exp.matrix.constraintIndex) && Object.keys(exp.matrix.constraintIndex).length >= 15);

    // Every conditional cell must resolve against the index the UI uses.
    const index = exp.matrix.constraintIndex;
    let dangling = 0;
    let conditional = 0;
    for (const g of exp.matrix.groups) {
      for (const r of g.rows) {
        for (const c of r.cells) {
          if (c.state !== 'conditional') continue;
          conditional += 1;
          for (const id of c.constraintIds) if (!index[id]) dangling += 1;
        }
      }
    }
    check('conditional cells resolve against the constraint index',
      conditional > 0 && dangling === 0, `${conditional} conditional, ${dangling} dangling`);

    const roles = await (await authed('/api/assignable-roles')).json();
    check('the add-participant dialog has roles to offer', roles.roles.length === 15);

    // A participant card click leads here.
    const asOperator = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo.intake', password: choices.password }),
    });
    check('a participant card can actually be signed in as', asOperator.status === 200,
      `status ${asOperator.status}`);

    // ---- the personas the cards point at all exist ------------------------
    let allPersonas = true;
    const bad = [];
    for (const persona of choices.personas) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: persona.username, password: choices.password }),
      });
      if (r.status !== 200) { allPersonas = false; bad.push(`${persona.username}:${r.status}`); }
    }
    check(`all ${choices.personas.length} published personas can sign in`, allPersonas, bad.join(', '));

    // ---- the view file declares the routes the app maps -------------------
    check('the view registers the domains route', /Views\.register\('domains'/.test(viewBody));
    check('the view registers the domain route', /Views\.register\('domain'/.test(viewBody));
    check('the view registers the workflow route', /Views\.register\('workflow'/.test(viewBody));

    // ---- the three levels an operator walks through ------------------------
    const domains = await (await authed('/api/domains')).json();
    check('GET /api/domains lists the GxP areas',
      Array.isArray(domains.domains) && domains.domains.length >= 6,
      `${domains.domains && domains.domains.length}`);
    check('each domain reports its own processes and roles',
      domains.domains.every((d) => d.processCount > 0 && d.participantCount > 0 && Array.isArray(d.processCodes)));
    check('each domain states whether it is complete',
      domains.domains.every((d) => typeof d.ready === 'boolean'));

    for (const code of ['ICSR', 'SIGNAL', 'PSUR', 'RMP', 'LIT', 'AEFI', 'COMPLAINT', 'GVP']) {
      const d = await (await authed(`/api/domain/${code}`)).json();
      const ok = d.area && d.area.code === code
        && Array.isArray(d.processes) && d.processes.length > 0
        && Array.isArray(d.participants) && d.participants.length > 0
        && d.matrix && d.matrix.roles.length === d.participants.length
        && d.participants.every((p) => p.duty && p.dutyEn && p.loginable);
      check(`${code} has its own domain interface`, ok,
        `${d.processes && d.processes.length} processes, ${d.participants && d.participants.length} roles, `
        + `${d.matrix && d.matrix.roles.length} matrix columns`);
    }

    const unknownDomain = await fetch(`http://127.0.0.1:${PORT}/api/domain/NOT-A-DOMAIN`,
      { headers: { cookie } });
    check('an unknown domain returns 404', unknownDomain.status === 404, `status ${unknownDomain.status}`);

    // ---- responsibilities must be resolvable from the diagram payload -----
    // The view prints each step's duty by looking the step's role codes up in the
    // participant list. If a code does not resolve, the duty silently disappears.
    const dev = await (await authed('/api/explorer/PV-DEV?includeAllRoles=0')).json();
    check('every step names the roles responsible for it',
      dev.steps.every((s) => Array.isArray(s.roles) && s.roles.length > 0));
    check('each participant carries a duty in both languages',
      dev.participants.every((p) => p.duty && p.dutyEn));
    check('each participant lists the steps it owns',
      dev.participants.every((p) => Array.isArray(p.steps) && p.steps.length > 0));
    const castRoles = new Set(dev.participants.map((p) => p.role));
    const unresolved = [];
    for (const s of dev.steps) for (const r of s.roles) if (!castRoles.has(r)) unresolved.push(`${s.code}:${r}`);
    check('every role a step names resolves to a participant with a duty',
      unresolved.length === 0, unresolved.join(', '));

    // ---- the browser must actually RENDER what the payload promises --------
    // The checks above all passed while the domain page was showing every
    // participant card as "no account" and making none of them clickable: the
    // payload was correct and only the view was wrong. These assertions read the
    // live DOM so that class of bug cannot pass again.
    const dom = await renderProbe('#/domain/ICSR');
    if (dom) {
      check('the domain page renders the participant cards',
        dom.cards === 6, `${dom.cards} cards`);
      check('every participant card on the domain page is clickable',
        dom.clickable === dom.cards && dom.cards > 0,
        `${dom.clickable}/${dom.cards} clickable`);
      check('the domain page shows a real name and duty per card',
        dom.sample.length > 0 && dom.sample.every((c) => c.name && c.duty && /[\u4e00-\u9fff]/.test(c.name)),
        JSON.stringify(dom.sample.slice(0, 2)));
      check('the domain page renders its permission matrix',
        dom.matrixRows > 10, `${dom.matrixRows} matrix rows`);
      check('the sidebar keeps 领域与流程 lit inside a domain',
        dom.activeNav === '领域与流程' && dom.activeNavCount === 1,
        `active=${dom.activeNav} count=${dom.activeNavCount}`);
    } else {
      process.stdout.write('  (skipped DOM checks: no Edge available)\n');
    }

    const wfDom = await renderProbe('#/workflow/PV-DEV');
    if (wfDom) {
      check('the workflow page renders one node per step',
        wfDom.flowNodes === 6, `${wfDom.flowNodes} nodes for 6 steps`);
      check('responsibilities are rendered ON the diagram, not only in a tooltip',
        wfDom.roleBlocks >= wfDom.flowNodes && wfDom.dutyTexts > 0,
        `${wfDom.roleBlocks} role blocks, ${wfDom.dutyTexts} duties`);
      check('the workflow page renders the responsibility summary table',
        wfDom.responsibilityRows === wfDom.participantCards && wfDom.responsibilityRows > 0,
        `${wfDom.responsibilityRows} rows vs ${wfDom.participantCards} cards`);
      check('the workflow page renders the three-state matrix',
        wfDom.matrixRows > 10 && wfDom.conditionalMarks > 0,
        `${wfDom.matrixRows} rows, ${wfDom.conditionalMarks} conditional marks`);
      check('the sidebar keeps 领域与流程 lit inside a workflow',
        wfDom.activeNav === '领域与流程' && wfDom.activeNavCount === 1,
        `active=${wfDom.activeNav} count=${wfDom.activeNavCount}`);
    }

    // ---- opening the application: identity first, no credential gate --------
    // The design changed here. It used to open on a grid of GxP areas and ask who
    // you were later, which meant answering a question about your own job before
    // saying who you were. It now opens on the identity list, with the area
    // reference model below it. The three assertions that used to live here
    // described the old order, and two of them passed without testing anything -
    // one because the area cards are still present (lower down), one because it
    // queried `.persona-card`, which is the domain page's identity panel and is
    // therefore always absent from this screen.
    const open = await openProbe();
    if (open) {
      const b = open.base;
      check('the application opens on the identity list',
        b.hash === '#/domains' && b.identityCards > 0 && !b.signedIn,
        `hash "${b.hash}", ${b.identityCards} identity cards, signed in: ${b.signedIn}`);
      check('no credential form stands in front of the identity list',
        !b.loginForm, 'a login form was rendered on load');
      check('the identities are grouped by how far they reach',
        b.identitySections >= 2, `${b.identitySections} sections`);
      check('the area reference model is reachable on the same screen',
        b.domainCards === 8, `${b.domainCards} area cards`);
      check('the 领域与流程 screen opens with a workflow diagram at the very top',
        b.flowOverview && b.flowCascades > 0 && b.flowFirstTitle === '工作流程图'
          && b.flowTop < b.viewport && b.activeChip === 'ICSR',
        `cascades ${b.flowCascades}, title "${b.flowFirstTitle}", top ${b.flowTop}px of ${b.viewport}px viewport`);
      check('the area chips switch the diagram in place',
        open.switched && open.gvp && open.gvp.activeChip === 'GVP' && open.gvp.gvpCascades > 0,
        JSON.stringify(open.gvp));
    } else {
      process.stdout.write('  (skipped opening-screen checks: no Edge available)\n');
    }

    // ---- ONE click into a domain, which shows the workflow, then identity ----
    const once = await oneClickProbe('ICSR');
    if (once) {
      check('a single click on a domain opens that domain',
        once.hash === '#/domain/ICSR' && /ICSR/.test(once.title || ''),
        `hash "${once.hash}" title "${once.title}"`);
      check('the domain screen shows its processes',
        once.processRows > 0, `${once.processRows} process rows`);
      check('the domain screen draws its workflows with a cascade per process',
        once.cascades > 0 && once.columns > 0,
        `${once.cascades} cascades, ${once.columns} step columns`);
      check('the workflows show who owns each step',
        once.dutiesOnFlow > 0, `${once.dutiesOnFlow} duties on the cascades`);
      check('the domain screen offers the identities that work in it',
        once.identityCards > 0 && once.identityNote,
        `${once.identityCards} identity cards`);
      check('the identity roster leads with a role that works in that domain',
        Boolean(once.firstIdentity) && /步骤|steps/.test(once.firstIdentity),
        once.firstIdentity);
      check('no session is required to browse the domain reference model',
        once.signedIn === false, 'a session was established without being asked for');
      check('picking an identity signs in and stays in the domain',
        once.after.ok && once.after.hash === '#/domain/ICSR' && once.after.clickable > 0,
        `${once.after.user} -> ${once.after.hash}, ${once.after.clickable} clickable cards`);
      check('the identity panel disappears once somebody has been chosen',
        once.after.identityCards === 0, `${once.after.identityCards} still shown`);
      check('browsing and entering raise no console exception',
        once.errors.length === 0, once.errors.join(' | ').slice(0, 240));
    } else {
      process.stdout.write('  (skipped one-click flow checks: no Edge available)\n');
    }

    // ---- getting back out of a domain --------------------------------------
    const exit = await exitProbe('ICSR');
    if (exit) {
      check('an anonymous visitor is offered only the public entry',
        exit.anonymousNav.length >= 1
          && exit.anonymousNav.every((n) => /领域|Domain|设计|Design/.test(n)),
        exit.anonymousNav.join(', '));
      check('the domain screen shows a way back before anybody signs in',
        exit.asVisitor.hash === '#/domain/ICSR'
          && exit.asVisitor.headerButtons.some((b) => /返回领域选择|Back to domains/.test(b)),
        exit.asVisitor.headerButtons.join(' | '));
      check('the topbar offers a way back and a way to change identity',
        exit.inside.topbar.some((b) => /返回领域选择|Back to domains/.test(b))
          && exit.inside.topbar.some((b) => /切换身份|Switch identity/.test(b))
          && exit.inside.topbar.some((b) => /退出|Sign out/.test(b)),
        exit.inside.topbar.join(' | '));
      check('the domain header offers the same two controls',
        exit.inside.headerButtons.some((b) => /返回领域选择|Back to domains/.test(b))
          && exit.inside.headerButtons.some((b) => /切换身份|Switch identity/.test(b)),
        exit.inside.headerButtons.join(' | '));
      check('leaving a domain returns to the picker and keeps the session',
        exit.leftKeeping === 'clicked' && exit.afterBack.hash === '#/domains'
          && exit.afterBack.stillSignedIn && exit.afterBack.domainCards === 8,
        `${exit.leftKeeping} -> ${exit.afterBack.hash}, signed in ${exit.afterBack.stillSignedIn}, `
        + `${exit.afterBack.domainCards} cards`);
      check('switching identity releases the session and lands on the picker',
        exit.switched === 'clicked' && exit.afterSwitch.hash === '#/domains'
          && exit.afterSwitch.signedIn === false && exit.afterSwitch.domainCards === 8,
        `${exit.switched} -> ${exit.afterSwitch.hash}, signed in ${exit.afterSwitch.signedIn}`);
      check('leaving a domain raises no console exception',
        exit.errors.length === 0, exit.errors.join(' | ').slice(0, 240));
    } else {
      process.stdout.write('  (skipped exit-path checks: no Edge available)\n');
    }

    // ---- the responsibility cascade on the domain screen -------------------
    const cascade = await cascadeProbe('ICSR');
    if (cascade) {
      const s = cascade.shape;
      check('the domain screen draws a cascade per dedicated process',
        s.cascades > 0 && s.steps > 0, `${s.cascades} cascades, ${s.steps} steps`);
      check('each step carries its own people underneath it',
        s.peopleInsideColumns === s.columns && s.columns === s.steps,
        `${s.peopleInsideColumns}/${s.columns} columns nested, ${s.steps} steps`);
      check('the order inside a step column is step then people',
        s.firstColumnOrder[0] === 'fc-step' && s.firstColumnOrder[1] === 'fc-people',
        s.firstColumnOrder.join(' > '));
      check('the people are named, not left as bare job titles',
        s.personCards > 0 && s.namedCards === s.personCards,
        `${s.namedCards}/${s.personCards} cards named`);
      check('each person card states what they are responsible for',
        s.duties === s.personCards, `${s.duties}/${s.personCards} cards with a duty`);
      check('each person card offers their own permissions',
        s.permToggles === s.personCards, `${s.permToggles}/${s.personCards} toggles`);
      check('the enforcement note appears once per flow, not once per card',
        s.footNotes === s.cascades, `${s.footNotes} notes for ${s.cascades} cascades`);
      check('opening a card lists what the person may do and what is constrained',
        cascade.opened.ok && cascade.opened.groups === 2
          && cascade.opened.chips > 0
          && cascade.opened.titles.some((t) => /可执行|May do/.test(t))
          && cascade.opened.titles.some((t) => /有约束|Conditional/.test(t)),
        JSON.stringify(cascade.opened).slice(0, 220));
    } else {
      process.stdout.write('  (skipped cascade checks: no Edge available)\n');
    }

    // ---- the flow diagram must be findable without hunting ------------------
    const layout = await layoutProbe('ICSR');
    if (layout) {
      check('the flow diagram is the first content section once signed in',
        layout.signedIn.flowIndex === 0,
        `sections: ${layout.signedIn.titles.join(' | ')}`);
      check('the flow diagram starts within the first screenful',
        layout.signedIn.topOfFlow !== null && layout.signedIn.topOfFlow < layout.signedIn.viewportHeight,
        `flow at ${layout.signedIn.topOfFlow}px, viewport ${layout.signedIn.viewportHeight}px, `
        + `page ${layout.signedIn.pageHeight}px`);
      check('an anonymous visitor still reaches the flow in the first two sections',
        layout.anonymous.flowIndex >= 0 && layout.anonymous.flowIndex <= 1,
        `sections: ${layout.anonymous.titles.join(' | ')}`);
    } else {
      process.stdout.write('  (skipped layout checks: no Edge available)\n');
    }

    // ---- a card the viewer may not open -------------------------------------
    const restricted = await restrictedCardProbe('SIGNAL');
    if (restricted) {
      check('the restricted-card probe signed in',
        restricted.signedIn && restricted.signedIn.ok, JSON.stringify(restricted.signedIn));
      if (restricted.signedIn && restricted.signedIn.ok) {
        const d = restricted.dom;
        // Not "everything is restricted": a SIGNAL roster legitimately contains
        // people this viewer does share an area with and cross-domain functions
        // they may always see. What the check requires is that the restriction
        // actually bites - some cards open and some do not - and that the split
        // is not accidental.
        check('a viewer outside the domain finds some cards restricted and some open',
          d.restricted > 0 && d.viewable > 0 && d.restricted + d.viewable === d.cards,
          `${d.restricted} restricted, ${d.viewable} viewable of ${d.cards}`);
        check('a restricted card is marked as such',
          d.restrictedBadges > 0, `${d.restrictedBadges} badges`);
        check('an inaccessible person is never named on the card',
          d.leakedNames === 0 && d.nameHidden === d.restricted,
          `${d.leakedNames} leaked names, ${d.nameHidden} placeholders for ${d.restricted} cards`);
        check('the role and its duty stay readable on a restricted card',
          d.dutiesOnRestricted === d.restricted,
          `${d.dutiesOnRestricted}/${d.restricted} cards kept their duty`);
        check('clicking a restricted card opens the refusal dialog',
          restricted.dialog && restricted.dialog.opened === true,
          JSON.stringify(restricted.refusal));
        check('the refusal dialog states the reason',
          restricted.dialog.hasReasonLabel && Boolean(restricted.dialog.reasonText),
          restricted.dialog.reasonText);
        check('the refusal dialog names the area rule the reader must satisfy',
          restricted.dialog.mentionsArea === true, 'no area mentioned');
        check('the refusal dialog lists what remains public',
          restricted.dialog.hasPublicList === true);
      }
    } else {
      process.stdout.write('  (skipped restricted-card checks: no Edge available)\n');
    }
    
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 600));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch { /* gone */ } }
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n  Asset check crashed: ${err.stack}\n\n`);
  process.exit(1);
});
