'use strict';

/**
 * Checks for the start-up flow: identity first, password, then your own interface.
 *
 * WHY THIS IS A SEPARATE SUITE
 * ----------------------------
 * The flow this replaces went domain-first: the application opened on a grid of
 * GxP areas, and who you were came later. That ordering asked the reader to answer
 * a question about their job before saying who they were, and then asked it again
 * on the next screen.
 *
 * The assertions below exist because the properties that matter here are invisible
 * to an element count. That the password is actually verified, that a wrong one is
 * refused, that each identity lands in its OWN interface rather than a shared menu
 * - none of these raise an error when they break. A screen that signs anybody in
 * on a click looks identical to a screen that checks.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const EDGE = process.env.PV_EDGE
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  \u2713 ${name}\n`); }
  else { failed += 1; process.stdout.write(`  \u2717 ${name}${detail ? ` - ${detail}` : ''}\n`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(code, dbFile) {
  const { execFileSync } = require('node:child_process');
  try {
    return {
      ok: true,
      out: execFileSync(NODE, ['-e', code], {
        cwd: ROOT,
        env: { ...process.env, PV_DB_FILE: dbFile, PV_BUILTIN_ACCOUNTS: '1' },
        encoding: 'utf8', timeout: 60000,
      }).trim(),
    };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}${err.message}` };
  }
}

/** Drive a real browser through the start-up flow. */
async function withBrowser(fn) {
  if (!fs.existsSync(EDGE)) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-identity-'));
  const port = 9300 + Math.floor(Math.random() * 300);
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch { await sleep(300); }
    }
    if (!version) return null;

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });

    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description
          || m.params.exceptionDetails.text);
      }
    });
    const send = (method, params = {}, session) => new Promise((res, rej) => {
      id += 1;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, sessionId: session }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); }
      }, 30000);
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => send(m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');

    const evaluate = async (expr) => {
      const r = await call('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      return r.exceptionDetails
        ? { __error: r.exceptionDetails.exception?.description }
        : r.result.value;
    };

    return await fn({ evaluate, call, errors, goto: async (url) => call('Page.navigate', { url }) });
  } finally {
    try { child.kill(); } catch { /* gone */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function main() {
  process.stdout.write('\n  LeebertyPV -  identity-first start-up flow\n\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-idflow-'));
  const dbFile = path.join(dataDir, 'pv.db');
  const port = 8840 + Math.floor(Math.random() * 40);
  let server = null;

  try {
    run("const d=require('./src/core/db');const s=require('./src/seed');d.open();s.run({silent:true});d.close();", dbFile);
    const { execFileSync } = require('node:child_process');
    execFileSync(NODE, [path.join(ROOT, 'scripts', 'seed-demo.js')], {
      cwd: ROOT, env: { ...process.env, PV_DB_FILE: dbFile, PV_BUILTIN_ACCOUNTS: '1' },
      stdio: 'ignore', timeout: 120000,
    });
    run("require('./src/domain/accounts').provision(null,{ip:'127.0.0.1',userAgent:'t'});", dbFile);

    // ---- the server's answer: scope and landing per identity ---------------
    const shape = run(`
      const a = require('./src/domain/accounts');
      const db = require('./src/core/db'); db.open();
      const all = a.loginChoices();
      const byRole = {};
      for (const p of all) byRole[p.role] = { scope: p.scope, landing: p.landing };
      const bad = all.filter((p) => !p.scope || !p.landing || !p.landing.view);
      db.close();
      process.stdout.write(JSON.stringify({
        total: all.length,
        scopes: all.reduce((m, p) => { m[p.scope] = (m[p.scope] || 0) + 1; return m; }, {}),
        bad: bad.length,
        qaManager: byRole.qa_manager,
        studyDirector: byRole.pv_writer,
        pi: byRole.pv_medical,
        admin: byRole.system_admin,
      }));
    `, dbFile);
    check('every identity declares a scope and a landing destination',
      shape.ok && JSON.parse(shape.out).bad === 0, shape.out.slice(-300));
    if (shape.ok) {
      const d = JSON.parse(shape.out);
      check('a whole-site function lands on the area list',
        d.qaManager && d.qaManager.scope === 'whole_system' && d.qaManager.landing.view === 'domains',
        JSON.stringify(d.qaManager));
      check('a single-area function lands in that area',
        d.studyDirector && d.studyDirector.scope === 'domain'
          && d.studyDirector.landing.view === 'domain'
          && Boolean(d.studyDirector.landing.domain),
        JSON.stringify(d.studyDirector));
      check('a multi-area function lands in its heaviest area, not a chooser',
        d.pi && d.pi.landing.view === 'domain' && d.pi.landing.domain === 'ICSR',
        JSON.stringify(d.pi));
      check('the administrator lands on the area list',
        d.admin && d.admin.landing.view === 'domains', JSON.stringify(d.admin));
      check('the identities are split across scopes, not all in one group',
        Object.keys(d.scopes).length >= 2, JSON.stringify(d.scopes));
    }

    // ---- the interface -----------------------------------------------------
    server = spawn(NODE, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env, PV_DB_FILE: dbFile, PV_BUILTIN_ACCOUNTS: '1',
        PV_PORT: String(port), PV_HOST: '127.0.0.1', PV_MONITOR: '0',
      },
      stdio: 'ignore',
    });
    let up = false;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.status === 200) { up = true; break; }
      } catch { /* not yet */ }
      await sleep(400);
    }
    check('the instance serves', up);
    const BASE = `http://127.0.0.1:${port}/`;

    const flow = up ? await withBrowser(async ({ evaluate, goto, errors }) => {
      await goto(BASE);
      await sleep(4400);

      const landing = await evaluate(`JSON.stringify({
        hash: window.location.hash,
        sections: [...document.querySelectorAll('.is-title')].map((x) => x.textContent.trim().split(' / ')[0]),
        identityCards: document.querySelectorAll('.identity-card').length,
        passwordlessLogin: document.querySelectorAll('.persona-card').length,
        domainCardsBelow: document.querySelectorAll('.domain-card').length,
        signedIn: Boolean(window.App.user),
        landings: [...document.querySelectorAll('.ic-landing')].map((x) => x.textContent.trim().split(' / ')[0]),
      })`);

      // Pick the identity whose own area is unambiguous.
      const clicked = await evaluate(`(() => {
        const c = [...document.querySelectorAll('.identity-card')]
          .find((x) => /医学评价员|Medical Assessor/.test(x.textContent));
        if (!c) return false;
        c.click();
        return true;
      })()`);
      await sleep(1300);
      const dialog = await evaluate(`JSON.stringify((() => {
        const p = document.querySelector('.modal-panel');
        if (!p) return { found: false };
        return {
          found: true,
          passwordField: Boolean(p.querySelector('input[type="password"]')),
          namesWho: Boolean(p.querySelector('.cred-who')),
          signedInBeforeTyping: Boolean(window.App.user),
        };
      })())`);

      // A wrong password must be refused.
      await evaluate(`(() => {
        const i = document.querySelector('.modal-panel input[type="password"]');
        i.value = 'definitely-not-the-password';
        i.dispatchEvent(new Event('input'));
        const b = [...document.querySelectorAll('.modal-panel button')]
          .find((x) => /进入|Sign in/.test(x.textContent));
        b.click();
        return true;
      })()`);
      await sleep(2600);
      const wrong = await evaluate(`JSON.stringify({
        signedIn: Boolean(window.App.user),
        stillOnStart: window.location.hash === '#/domains' || window.location.hash === '',
        message: (() => {
          const e = document.querySelector('.modal-panel .form-error');
          return e && e.style.display !== 'none' ? e.textContent.trim() : null;
        })(),
      })`);

      // The correct password must sign in and land in that identity's interface.
      // The password is read from the API rather than hard-coded, because the
      // demonstration credential has changed once already (two files held the same
      // words in a different order) and a test pinned to the literal would have
      // failed for the wrong reason.
      const password = await evaluate(`(async () => {
        const r = await fetch('/api/login-choices');
        const d = await r.json();
        return d.password;
      })()`);
      await evaluate(`(() => {
        const i = document.querySelector('.modal-panel input[type="password"]');
        i.value = ${JSON.stringify(password)};
        i.dispatchEvent(new Event('input'));
        const b = [...document.querySelectorAll('.modal-panel button')]
          .find((x) => /进入|Sign in/.test(x.textContent));
        b.click();
        return true;
      })()`);
      await sleep(5600);
      const correct = await evaluate(`JSON.stringify({
        role: window.App.user ? window.App.user.role : null,
        hash: window.location.hash,
        title: (() => {
          const h = document.querySelector('.view-title');
          return h ? h.textContent.trim().split(' / ')[0] : null;
        })(),
      })`);

      return {
        landing: JSON.parse(landing), clicked,
        dialog: JSON.parse(dialog), wrong: JSON.parse(wrong), correct: JSON.parse(correct),
        errors,
      };
    }) : null;

    // ---- a whole-site identity must visibly arrive -------------------------
    // This is the regression the user reported, and it was invisible to every
    // other assertion: signing in as a whole-site role succeeds, and the screen it
    // lands on is the sign-in screen itself. Assigning `location.hash` a value
    // equal to the current one fires no `hashchange`, so nothing repainted and a
    // successful login looked exactly like a failed one.
    const wholeSite = up ? await withBrowser(async ({ evaluate, goto, errors }) => {
      await goto(BASE);
      await sleep(4400);

      const signedIn = await evaluate(`(async () => {
        const card = [...document.querySelectorAll('.identity-card')]
          .find((x) => /药物警戒质量负责人|QA Manager/.test(x.textContent));
        if (!card) return { ok: false, reason: 'no whole-site identity on the roster' };
        card.click();
        await new Promise((r) => setTimeout(r, 1200));
        const field = document.querySelector('.modal-panel input[type="password"]');
        if (!field) return { ok: false, reason: 'no password field' };
        field.focus();
        return { ok: true };
      })()`);
      if (!signedIn || !signedIn.ok) return { signedIn, errors };

      const password = await evaluate(`(async () => (await (await fetch('/api/login-choices')).json()).password)()`);
      await evaluate(`(() => {
        const field = document.querySelector('.modal-panel input[type="password"]');
        field.value = ${JSON.stringify(password)};
        field.dispatchEvent(new Event('input'));
        const btn = [...document.querySelectorAll('.modal-panel button')]
          .find((x) => /进入|Sign in/.test(x.textContent));
        btn.click();
        return true;
      })()`);
      await sleep(5400);

      // This snapshot is taken WHILE STILL ON #/domains: the banner, the entry
      // button and the ordering are all properties of the signed-in area list.
      const after = JSON.parse(await evaluate(`JSON.stringify({
        role: window.App.user ? window.App.user.role : null,
        hash: window.location.hash,
        dialogClosed: !document.querySelector('.modal-panel'),
        // The screen must SAY who is signed in. Without it, landing back on the
        // identity list after a successful login is indistinguishable from the
        // login not having happened.
        bannerShown: Boolean(document.querySelector('.signed-in-banner')),
        bannerNamesUser: (() => {
          const n = document.querySelector('.sib-name');
          return n ? n.textContent.trim() : null;
        })(),
        hasEntryButton: [...document.querySelectorAll('.sib-actions button')]
          .some((b) => /进入系统|Enter the system|返回我的界面|Back to my interface/.test(b.textContent)),
      })`));

      // Once signed in, the area list must come FIRST and the identity cards must
      // drop below it. A signed-in visitor has already answered "who are you"; for
      // a whole-site role the area list IS their interface, and burying it under a
      // wall of identity cards was precisely how the flow diagram became "missing"
      // - it was there, 2,500 pixels below the fold, behind a scroll and a click.
      // The first `.card` is now the flow-overview block's workflow card (the
      // screen opens with a diagram, by design), so the ordering that matters is
      // the AREA LIST before the identity cards, not a particular first title.
      const order = JSON.parse(await evaluate(`JSON.stringify((() => {
        const dc = document.querySelector('.domain-card');
        const ic = document.querySelector('.identity-card');
        const cards = [...document.querySelectorAll('.view .card')];
        const firstTitle = cards[0] && cards[0].querySelector('.card-title')
          ? cards[0].querySelector('.card-title').textContent.trim().split(' / ')[0] : null;
        return {
          domainTop: dc ? Math.round(dc.getBoundingClientRect().top + scrollY) : null,
          identityTop: ic ? Math.round(ic.getBoundingClientRect().top + scrollY) : null,
          domainsBeforeIdentities: dc && ic
            ? (dc.getBoundingClientRect().top + scrollY) < (ic.getBoundingClientRect().top + scrollY) : null,
          firstCardTitle: firstTitle,
          flowOverviewAtTop: Boolean(document.querySelector('.df-overview'))
            && (document.querySelector('.df-overview').getBoundingClientRect().top + scrollY)
               < (document.querySelector('.domain-card').getBoundingClientRect().top + scrollY),
          domainCards: document.querySelectorAll('.domain-card').length,
        };
      })())`));

      // One click on an area must reach the workflow diagram.
      await evaluate(`(() => {
        const c = [...document.querySelectorAll('.domain-card')].find((x) => /GLP/.test(x.textContent));
        if (c) c.click();
        return true;
      })()`);
      let cascades = 0;
      let flowFirst = null;
      for (let i = 0; i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 400));
        cascades = await evaluate(`document.querySelectorAll('.flow-cascade').length`).catch(() => 0);
        if (cascades > 0) break;
      }
      flowFirst = await evaluate(`(() => {
        const t = document.querySelector('.view .card .card-title');
        return t ? t.textContent.trim().split(' / ')[0] : null;
      })()`).catch(() => null);

      return {
        signedIn,
        after,
        order,
        oneClick: { cascades, flowFirst },
        errors,
      };
    }) : null;

    if (wholeSite) {
      check('a whole-site identity can sign in',
        wholeSite.signedIn && wholeSite.signedIn.ok && wholeSite.after.role === 'qa_manager',
        JSON.stringify(wholeSite.signedIn));
      check('the sign-in dialog closes once signed in',
        wholeSite.after.dialogClosed === true);
      check('a whole-site identity lands on the area list, which is its interface',
        wholeSite.after.hash === '#/domains', wholeSite.after.hash);
      check('the screen states who is signed in, so success is not mistaken for failure',
        wholeSite.after.bannerShown === true && Boolean(wholeSite.after.bannerNamesUser),
        JSON.stringify(wholeSite.after));
      check('the screen offers the way into the instance',
        wholeSite.after.hasEntryButton === true);
      check('once signed in, the area list comes before the identity cards',
        wholeSite.order.domainsBeforeIdentities === true
          && wholeSite.order.domainCards === 8,
        JSON.stringify(wholeSite.order));
      check('the flow overview sits above the area list',
        wholeSite.order.flowOverviewAtTop === true, JSON.stringify(wholeSite.order));
      check('one click on an area reaches its workflow diagram',
        wholeSite.oneClick.cascades > 0 && /工作流程|workflows/.test(String(wholeSite.oneClick.flowFirst)),
        JSON.stringify(wholeSite.oneClick));
      check('the whole-site sign-in raises no console errors',
        wholeSite.errors.length === 0, wholeSite.errors.join(' | ').slice(0, 240));
    } else {
      process.stdout.write('  (skipped whole-site checks: no Edge available)\n');
    }

    if (flow) {
      const L = flow.landing;
      check('the application opens on the identity list',
        L.hash === '#/domains' && L.identityCards > 0 && !L.signedIn,
        JSON.stringify(L));
      check('the identities are grouped by how far they reach',
        L.sections.length >= 2 && L.sections.includes('全域职责'),
        L.sections.join(' | '));
      check('no identity can be entered without a password',
        L.passwordlessLogin === 0, `${L.passwordlessLogin} click-to-enter cards remain`);
      check('the area list is still reachable below the identities',
        L.domainCardsBelow > 0, `${L.domainCardsBelow} area cards`);
      check('each identity card states where it will open',
        L.landings.length === L.identityCards
          && L.landings.every((x) => x && x.length > 0),
        `${L.landings.length} of ${L.identityCards} cards`);

      check('clicking an identity asks for a password', flow.clicked && flow.dialog.found
        && flow.dialog.passwordField, JSON.stringify(flow.dialog));
      check('the dialog says who is being signed in', flow.dialog.namesWho === true);
      check('clicking an identity does not sign anybody in by itself',
        flow.dialog.signedInBeforeTyping === false);

      check('a wrong password is refused',
        flow.wrong.signedIn === false && flow.wrong.stillOnStart === true,
        JSON.stringify(flow.wrong));
      check('the refusal says the password was wrong, not something generic',
        Boolean(flow.wrong.message) && /不正确|Incorrect/.test(flow.wrong.message),
        flow.wrong.message);

      check('the correct password signs in',
        flow.correct.role === 'pv_medical', JSON.stringify(flow.correct));
      check('the identity lands in its OWN interface, not a shared menu',
        flow.correct.hash === '#/domain/ICSR' && /ICSR/.test(String(flow.correct.title)),
        JSON.stringify(flow.correct));

      check('the flow raises no console errors',
        flow.errors.length === 0, flow.errors.join(' | ').slice(0, 240));
    } else {
      process.stdout.write('  (skipped browser checks: no Edge available)\n');
    }
  } finally {
    if (server) { try { server.kill(); } catch { /* gone */ } }
    await sleep(700);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed (${passed + failed} checks)\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`\n  Identity-flow test crashed: ${err.stack}\n\n`);
  process.exit(1);
});
