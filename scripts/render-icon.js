'use strict';
/*
 * Render the LeebertyPV icon assets: blue-black background, uppercase GXP in a
 * gothic (old-English) letterform, stretched TALL and NARROW.
 *
 * The earlier version stretched the text with a CSS transform and clipped the
 * trailing "P" - a transform around a fixed origin does not know how wide or
 * high the glyphs are, and the gothic face is deceptively wide. This version
 * measures the text first and solves for a font size that fits inside the box
 * after the (scaleX≈0.82, scaleY≈1.6) stretch, so all three letters always fit.
 *
 * "Old English Text MT" ships with Windows and is the gothic face a worker would
 * recognise. Re-run `node scripts/render-icon.js` any time the identity changes.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = process.env.PV_EDGE
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// The project root, derived rather than hard-coded, so the script survives the
// folder being renamed or moved.
const OUT = process.argv[2] || path.resolve(__dirname, '..');

/** Letters are drawn ~0.82x wide and ~1.6x tall, centred on the canvas. */
const SX = 0.82;
const SY = 1.60;

const PAGE = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:#02040c;}
  body{display:grid;place-items:center;}
  .stage{position:relative;width:100%;height:100%;display:grid;place-items:center;}
  .halo{position:absolute;left:50%;top:36%;width:80%;height:56%;transform:translate(-50%,-50%);
    background:radial-gradient(closest-side,rgba(84,136,255,0.34),rgba(84,136,255,0) 72%);
    border-radius:50%;}
  .ring{position:absolute;inset:${Math.round(size*0.035)}px;border-radius:${Math.round(size*0.075)}px;
    border:${Math.max(2, Math.round(size*0.012))}px solid rgba(120,162,255,0.42);pointer-events:none;}
  .gxp{position:relative;font-family:"Old English Text MT","Blackadder ITC","UnifrakturCook","Georgia",serif;
    font-weight:700;color:#eaf1ff;line-height:1;white-space:nowrap;letter-spacing:${Math.round(size*0.014)}px;
    text-shadow:0 ${Math.round(size*0.012)}px ${Math.round(size*0.025)}px rgba(0,0,0,0.55),
                0 0 ${Math.round(size*0.05)}px rgba(84,136,255,0.4);
    transform-origin:50% 50%;}
</style></head><body>
  <div class="stage">
    <div class="halo"></div>
    <span id="t" class="gxp">GXP</span>
    <div class="ring"></div>
  </div>
  <script>
    // Measure then shrink: the stretch is (0.85x wide, 1.5x tall) and the font
    // size is solved so the stretched glyphs fit inside the padded box, so the
    // trailing "P" can never be clipped the way the old CSS transform did.
    const S = ${size};
    const t = document.getElementById('t');
    t.style.fontSize = '100px';
    const w = t.offsetWidth, h = t.offsetHeight;
    const SX = 0.72, SY = 1.8;
    const padX = S * 0.16, padY = S * 0.10;
    const fs = Math.min((S - 2*padX) / (SX * w / 100), (S - 2*padY) / (SY * h / 100));
    t.style.fontSize = fs + 'px';
    t.style.transform = 'scale(' + SX + ',' + SY + ')';
    t.style.letterSpacing = '-' + Math.round(S*0.015) + 'px';
  </script>
</body></html>`;

function icoFromPng(png, sizes = [256]) {
  const n = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  sizes.forEach((s, i) => {
    const b = Buffer.alloc(16);
    b[0] = s === 256 ? 0 : s;
    b[1] = s === 256 ? 0 : s;
    b.writeUInt16LE(1, 4);
    b.writeUInt16LE(32, 6);
    b.writeUInt32LE(png.length, 8);
    b.writeUInt32LE(offset, 12);
    b.copy(dir, i * 16);
    offset += png.length;
  });
  return Buffer.concat([header, dir, png]);
}

async function shot(size, profile) {
  // Rendered and captured through CDP rather than the `--screenshot` CLI flag:
  // the CLI capture can snapshot before the canvas has painted and return a
  // black square, while a Page.captureScreenshot after a settle wait reflects
  // the actual pixels. This is the same path the browser test suites use.
  const pageFile = path.join(profile, `icon-${size}.html`);
  fs.writeFileSync(pageFile, PAGE(size));
  const debugPort = 9560 + Math.floor(Math.random() * 300);
  const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(profile, 'edge')}`, '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    if (!version) throw new Error('Edge CDP not reachable');
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    });
    const send = (me, pa = {}) => new Promise((res, rej) => {
      id += 1; pend.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method: me, params: pa }));
      setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + me)); } }, 15000);
    });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.navigate', { url: 'file:///' + pageFile.replace(/\\/g, '/') });
    await new Promise((r) => setTimeout(r, 1600));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  } finally {
    try { browser.kill(); } catch { /* gone */ }
    fs.unlinkSync(pageFile);
  }
}

(async () => {
  if (!fs.existsSync(EDGE)) { console.error('Edge not found; cannot render the icon.'); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gxp-icon-'));
  try {
    const png512 = await shot(512, profile);
    const png256 = await shot(256, profile);
    fs.mkdirSync(path.join(OUT, 'web'), { recursive: true });
    fs.mkdirSync(path.join(OUT, 'desktop'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'web', 'favicon.png'), png256);
    fs.writeFileSync(path.join(OUT, 'web', 'logo-lg.png'), png512);
    fs.writeFileSync(path.join(OUT, 'desktop', 'icon.ico'), icoFromPng(png256, [256]));
    console.log('  saved web/favicon.png (%d bytes)', png256.length);
    console.log('  saved web/logo-lg.png (%d bytes)', png512.length);
    console.log('  saved desktop/icon.ico (%d bytes)', icoFromPng(png256, [256]).length);
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})();