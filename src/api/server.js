'use strict';

/**
 * Zero-dependency HTTP server: static file delivery plus the JSON API.
 *
 * Deliberately built on `node:http` rather than Express so the application has
 * no installable dependencies. In a validated environment every third-party
 * package would otherwise need its own supplier assessment and change control
 * (EU GMP Annex 11 §7.1), so having none is a genuine compliance advantage.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');
const authCore = require('../core/auth');
const rbac = require('../core/rbac');
const api = require('./routes');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SESSION_COOKIE = 'pv_session';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function clientIp(req) {
  if (config.http.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.http.maxBodyBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('Request body is not valid JSON'), { status: 400, code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // The workbench is a local/LAN tool; deny framing to avoid clickjacking of
    // signature dialogs.
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * Send a body the handler produced itself (e.g. the CSV audit export) verbatim,
 * together with the headers that handler declared. Anything else is JSON.
 */
function sendRaw(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders,
  });
  res.end(body);
}

/** Serve a file from the web root, guarding against path traversal. */
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(config.webDir, rel);
  if (!target.startsWith(config.webDir)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  // The HTML shell must never be cached so a new build is picked up on reload;
  // vendored assets may be cached briefly.
  const cache = ext === '.html' ? 'no-store' : 'public, max-age=300';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
  return true;
}

/**
 * Readiness gate.
 *
 * The port is bound before built-in accounts are provisioned and before the
 * background monitor starts. A client connecting in that window would see an
 * instance with no accounts and conclude it was empty. The health endpoint
 * therefore reports 503 until start-up work has finished - which is exactly what
 * start.bat, start-silent.bat and the desktop launcher poll before opening a
 * browser window, so none of them can show a half-initialised instance.
 */
let ready = false;
function markReady() { ready = true; }
function isReady() { return ready; }

function createServer() {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const urlPath = decodeURIComponent(url.pathname);
    const ip = clientIp(req);

    // Start-up still in progress: ask the caller to retry rather than serving a
    // half-initialised instance.
    if (!ready && urlPath === '/api/health') {
      sendJson(res, 503, {
        ok: false,
        starting: true,
        version: config.app.version,
        message: 'The workbench is still starting up. Retry in a moment.',
      });
      return;
    }

    // ------------------------------------------------------------- context --
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE] || req.headers['x-session-id'] || null;
    const ctx = {
      ip,
      userAgent: req.headers['user-agent'] || null,
      sessionId,
      method: req.method,
      path: urlPath,
    };

    try {
      // ------------------------------------------------------------- API --
      if (urlPath.startsWith('/api/')) {
        let user = null;
        let session = null;
        if (sessionId) {
          const resolved = authCore.resolveSession(sessionId);
          if (resolved.user) { user = resolved.user; session = resolved.session; }
          else if (resolved.reason && !['NO_SESSION'].includes(resolved.reason)) {
            // Tell the client why the session ended so it can explain the logout.
            res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
            sendJson(res, 401, { error: 'SESSION_ENDED', code: resolved.reason, message: sessionEndMessage(resolved.reason) });
            return;
          }
        }

        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const result = await api.handle({
          method: req.method,
          path: urlPath,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          user,
          session,
          ctx,
        });

        if (result && result.setCookie) {
          res.setHeader('Set-Cookie', result.setCookie);
        }
        // A handler that returns a string body (CSV export, plain text) has
        // already produced the exact bytes to send, so do not JSON-encode it.
        if (result && typeof result.body === 'string') {
          sendRaw(res, result.status || 200, result.body, result.headers || {});
          return;
        }
        sendJson(res, result.status || 200, result.body === undefined ? { ok: true } : result.body, result.headers || {});
        return;
      }

      // --------------------------------------------------------- static ----
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (serveStatic(req, res, urlPath)) return;
        // SPA fallback: unknown non-API paths render the shell.
        if (!path.extname(urlPath)) {
          if (serveStatic(req, res, '/index.html')) return;
        }
      }

      sendJson(res, 404, { error: 'NOT_FOUND', message: `No route for ${req.method} ${urlPath}` });
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || 'INTERNAL_ERROR';
      if (status >= 500) {
        console.error(`[error] ${req.method} ${urlPath} ->`, err);
        try {
          audit.append({
            action: 'system_error',
            entityType: 'system',
            entityId: urlPath,
            actor: null,
            reason: `${err.message}`,
            ctx,
            severity: 'warning',
            meta: { stack: String(err.stack || '').split('\n').slice(0, 6) },
          });
        } catch { /* never let error logging break the response */ }
      }
      sendJson(res, status, {
        error: code,
        message: err.message || 'Request failed',
        details: err.details || undefined,
      });
    } finally {
      const ms = Date.now() - startedAt;
      if (ms > 1500) console.warn(`[slow] ${req.method} ${urlPath} took ${ms} ms`);
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function sessionEndMessage(reason) {
  const messages = {
    IDLE_TIMEOUT: 'Your session was closed after a period of inactivity (GVP Module I / 21 CFR Part 11.10(d)). Please sign in again.',
    SESSION_EXPIRED: 'Your session reached its maximum duration. Please sign in again.',
    SESSION_REVOKED: 'Your session was revoked. Please sign in again.',
    ACCOUNT_LOCKED: 'Your account is locked. Contact the system administrator.',
    ACCOUNT_DISABLED: 'Your account is disabled.',
    ACCOUNT_PENDING: 'Your account is not yet activated.',
    USER_NOT_FOUND: 'Your account no longer exists.',
  };
  return messages[reason] || 'Your session is no longer valid. Please sign in again.';
}

function start() {
  db.open();
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${config.http.port} is already in use. Close the other instance or start with ` +
          `a different port, e.g.  set PV_PORT=8793 && start.bat`
        ));
      } else {
        reject(err);
      }
    });
    // Bind to localhost by default. Use PV_HOST=0.0.0.0 to publish on the LAN,
    // which also means TLS should terminate in front of it.
    server.listen(config.http.port, config.http.host, () => {
      resolve(server);
    });
  });
}

module.exports = { createServer, start, markReady, isReady, sendJson, sendText, SESSION_COOKIE };
