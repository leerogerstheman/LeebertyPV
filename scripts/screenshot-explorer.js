'use strict';

/**
 * Screenshot the explorer screens through the real browser.
 *
 * Uses the Chrome DevTools Protocol over Node's built-in WebSocket - no
 * third-party dependency, consistent with the rest of the project. The SPA keeps
 * its session in memory, so the flow is: launch Edge headless, sign in through
 * the page's own login endpoint from inside the page context, then navigate to
 * each screen and capture it.
 *
 * Usage: node scripts/screenshot-explorer.js [port] [outDir]
 */

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = Number(process.argv[2] || 8899);
const OUT = process.argv[3] || path.resolve(__dirname, '..', 'docs', 'screenshots');
const BASE = `http://127.0.0.1:${PORT}`;

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    return execFileSync('which', ['msedge'], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client over the browser's WebSocket debugger endpoint. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) => reject(new Error(`websocket error: ${e.message || e.type}`)));
  });
  return new Cdp(ws);
}

async function main() {
  const edge = findEdge();
  if (!edge) {
    process.stdout.write('  Edge not found; skipping screenshots\n');
    process.exit(0);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gxp-shot-'));
  const debugPort = 9222 + Math.floor(Math.random() * 300);

  const browser = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars',
    '--window-size=1600,1150',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { browser.kill(); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    // Wait for the debugger endpoint.
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        version = await res.json();
        break;
      } catch { await sleep(300); }
    }
    if (!version) throw new Error('browser debugger did not come up');
    process.stdout.write(`  browser: ${version['Browser']}\n`);

    const cdp = await connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const call = (method, params) => cdp.send(method, params, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description
          : JSON.stringify(r.exceptionDetails));
      }
      return r.result.value;
    };

    const goto = async (url) => {
      await call('Page.navigate', { url });
      await sleep(1400);
    };

    // ---- sign in through the page's own UI --------------------------------
    // The session cookie is HttpOnly and the SPA keeps `App.user` in memory, so
    // injecting state from the outside does not work: a fetch-based login leaves
    // document.cookie empty and App.user null. Clicking the persona card is the
    // real path, and it also proves the login screen renders.
    //
    // The start-up flow is two steps: pick a PV domain first (the auth gate
    // shows the domain grid), then pick one of the identities that work in it.
    // The bare root redirects to the public domain picker when signed out, so the
    // auth gate (domain grid + persona cards) is reached via #/inbox.
    await goto(`${BASE}/#/inbox`);
    await sleep(1800);

    const domainCards = await evaluate('document.querySelectorAll(".domain-choice-card").length');
    if (domainCards) {
      process.stdout.write(`  login screen shows ${domainCards} domain cards; choosing ICSR\n`);
      const clickedDomain = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.domain-choice-card')];
        const target = cards.find(c => c.dataset && c.dataset.code === 'ICSR')
          || cards.find(c => c.textContent.includes('ICSR')) || cards[0];
        target.click();
        return (target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      })()`);
      await sleep(2200);
      process.stdout.write(`  chose domain: ${clickedDomain}\n`);
    }

    const cards = await evaluate('document.querySelectorAll(".persona-card").length');
    if (!cards) throw new Error('the login screen rendered no persona cards');
    process.stdout.write(`  login screen shows ${cards} persona cards\n`);

    const clicked = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.persona-card')];
      const qa = cards.find(c => /药物警戒质量负责人/.test(c.textContent)) || cards[0];
      qa.click();
      return qa.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40);
    })()`);
    await sleep(2600);

    const who = await evaluate('window.App && window.App.user ? window.App.user.username : null');
    if (!who) throw new Error(`clicking "${clicked}" did not establish a session`);
    process.stdout.write(`  signed in as ${who} by clicking a persona card\n\n`);

    const shots = [
      { name: '01-domains', hash: '#/domains', label: 'level 1: domain picker' },
      { name: '02-domain-icsr', hash: '#/domain/ICSR', label: 'level 2: ICSR domain interface' },
      { name: '03-workflow-icsr-exp', hash: '#/workflow/ICSR-EXP', label: 'level 3: workflow (expedited ICSR)' },
      { name: '04-workflow-signal', hash: '#/workflow/SIG-DET', label: 'level 3: workflow (signal detection)' },
      { name: '05-domain-psur', hash: '#/domain/PSUR', label: 'level 2: PSUR domain interface' },
      { name: '06-domain-aefi', hash: '#/domain/AEFI', label: 'level 2: AEFI domain interface' },
    ];

    for (const shot of shots) {
      await evaluate(`window.location.hash = ${JSON.stringify(shot.hash)}; null`);
      await sleep(2200);
      const dims = await evaluate('JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})');
      const { w, h } = JSON.parse(dims);
      const targetH = Math.min(Math.max(h, 900), 4200);
      await call('Emulation.setDeviceMetricsOverride', {
        width: Math.max(w, 1500), height: targetH, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(700);
      const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(OUT, `${shot.name}.png`);
      fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
      const kb = (fs.statSync(file).size / 1024).toFixed(0);
      process.stdout.write(`  saved ${shot.name}.png  ${kb} KB  (${shot.label})\n`);
      await call('Emulation.clearDeviceMetricsOverride');
    }

    // ---- the interactive part: open a participant sheet and capture it -----
    await evaluate(`window.location.hash = '#/workflow/ICSR-EXP'; null`);
    await sleep(2000);
    const opened = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.participant-card.pc-clickable')];
      if (!cards.length) return { ok: false, reason: 'no clickable participant card' };
      const target = cards.find(c => /药物警戒质量负责人|质量保证负责人/.test(c.textContent)) || cards[0];
      const label = target.querySelector('.pc-role').textContent;
      target.click();
      return { ok: true, label, cardCount: cards.length };
    })()`);
    if (opened.ok) {
      await sleep(1200);
      const dialog = await evaluate(`(() => {
        const m = document.querySelector('.modal-panel');
        return m ? { present: true, height: m.scrollHeight } : { present: false };
      })()`);
      if (dialog.present) {
        await call('Emulation.setDeviceMetricsOverride', {
          width: 1500, height: Math.min(dialog.height + 120, 3600), deviceScaleFactor: 1, mobile: false,
        });
        await sleep(500);
        const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const file = path.join(OUT, '07-participant-sheet.png');
        fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
        process.stdout.write(`  saved participant-sheet.png  (${opened.label}, ${opened.cardCount} clickable cards)\n`);
        await call('Emulation.clearDeviceMetricsOverride');
      }
    } else {
      process.stdout.write(`  participant sheet not captured: ${opened.reason}\n`);
    }

    // ---- report what the page actually rendered ---------------------------
    const stats = await evaluate(`JSON.stringify({
      flowNodes: document.querySelectorAll('.flow-node').length,
      roleBlocks: document.querySelectorAll('.fn-role-block').length,
      duties: [...document.querySelectorAll('.fn-role-duty')].filter(e=>e.textContent.trim()).length,
      responsibilityRows: document.querySelectorAll('.responsibility-table tbody tr').length,
      participantCards: document.querySelectorAll('.participant-card').length,
      clickableCards: document.querySelectorAll('.participant-card.pc-clickable').length,
      matrixRows: document.querySelectorAll('.permission-matrix tbody tr').length,
      conditionalMarks: document.querySelectorAll('.mx-cond').length,
      constraintItems: document.querySelectorAll('.constraint-item').length,
      demoWarning: Boolean(document.querySelector('.demo-warning')),
      depth: document.querySelectorAll('.view > *').length,
    })`);
    process.stdout.write(`\n  rendered DOM: ${stats}\n\n`);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  process.stdout.write(`\n  screenshot run failed: ${err.stack}\n\n`);
  process.exit(1);
});
