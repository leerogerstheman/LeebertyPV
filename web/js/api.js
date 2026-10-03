/* LeebertyPV - API client.
 *
 * Thin wrapper over fetch that centralises three GxP-relevant behaviours:
 *   1. the session cookie is always sent (no token juggling in views);
 *   2. a 401 with SESSION_ENDED is surfaced globally so the shell can explain
 *      *why* the user was signed out (idle timeout vs revocation vs lockout),
 *      which is an Annex 11 §12.3 expectation;
 *   3. server errors arrive as {error, message} and are rethrown as Error
 *      objects carrying `code` and `status`, so a view can react to
 *      SIGNATURE_REQUIRED or REASON_REQUIRED rather than string-matching.
 */
(function () {
  'use strict';

  const state = {
    onSessionEnded: null,
    lastError: null,
  };

  class ApiError extends Error {
    constructor(status, code, message, payload) {
      super(message || code || `HTTP ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.payload = payload || {};
    }
  }

  async function request(method, path, body, opts = {}) {
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Is the workbench still running?', {});
    }

    const contentType = res.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
      try { payload = await res.json(); } catch { payload = null; }
    } else {
      payload = await res.text();
    }

    if (!res.ok) {
      const code = (payload && payload.error) || `HTTP_${res.status}`;
      const message = (payload && payload.message) || `Request failed (${res.status})`;
      const error = new ApiError(res.status, code, message, payload);

      if (res.status === 401 && state.onSessionEnded) {
        state.onSessionEnded(code, message);
      }
      state.lastError = error;
      throw error;
    }
    return payload;
  }

  const api = {
    get: (path, params) => request('GET', withQuery(path, params)),
    post: (path, body) => request('POST', path, body || {}),
    patch: (path, body) => request('PATCH', path, body || {}),
    put: (path, body) => request('PUT', path, body || {}),
    del: (path, body) => request('DELETE', path, body || {}),
    onSessionEnded: (fn) => { state.onSessionEnded = fn; },
    ApiError,
  };

  function withQuery(path, params) {
    if (!params) return path;
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      usp.append(key, value);
    }
    const qs = usp.toString();
    return qs ? `${path}?${qs}` : path;
  }

  /** Download a server-generated file (audit trail CSV export). */
  async function download(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) {
      let message = `Download failed (${res.status})`;
      try {
        const payload = await res.json();
        message = payload.message || message;
      } catch { /* non-JSON error body */ }
      throw new ApiError(res.status, 'DOWNLOAD_FAILED', message, {});
    }
    const disposition = res.headers.get('content-disposition') || '';
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const filename = match ? match[1] : `export-${Date.now()}.csv`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has definitely been handled.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  }

  window.Api = api;
  window.Api.download = download;
})();
