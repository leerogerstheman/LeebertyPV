'use strict';

/**
 * Session cookie name, kept in its own module so both the HTTP server and the
 * route layer can reference it without a circular require.
 */
module.exports = {
  SESSION_COOKIE: 'pv_session',
};