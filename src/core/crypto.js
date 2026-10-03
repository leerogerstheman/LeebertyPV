'use strict';

/**
 * Cryptographic helpers for the compliance kernel.
 *
 * Uses only Node's built-in `crypto`, so the application keeps its
 * zero-dependency property (important for validated/qualified environments
 * where installing packages requires a change control).
 */

const crypto = require('node:crypto');

// --------------------------------------------------------------- hashing ---

/**
 * Password hashing with scrypt. Format: `scrypt$N$r$p$salt$hash` (all hex).
 * Chosen over bcrypt/argon2 to avoid a native dependency; parameters below
 * target roughly 100 ms per verification on a typical bench PC.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(normalize(password), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return {
    hash: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`,
    salt: salt.toString('hex'),
    algo: 'scrypt',
  };
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const derived = crypto.scryptSync(normalize(password), Buffer.from(saltHex, 'hex'), hashHex.length / 2, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return timingSafeEqualHex(derived.toString('hex'), hashHex);
  } catch {
    return false;
  }
}

/** Unicode-normalise so the same typed password always derives the same key. */
function normalize(value) {
  return String(value == null ? '' : value).normalize('NFKC');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // Still perform a comparison to keep the timing profile flat.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmac(key, input) {
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function uuid() {
  return crypto.randomUUID();
}

/**
 * Deterministic JSON serialisation so a payload hashes identically regardless
 * of key insertion order.
 */
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFKC'));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

// ------------------------------------------------------------------ TOTP ---

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP, 6 digits, 30 s period, SHA-1 (authenticator-app compatible). */
function totpCode(secretBase32, atMs = Date.now(), period = 30, digits = 6) {
  const counter = Math.floor(atMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const digest = crypto.createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

/** Accept the previous, current and next window to tolerate clock drift. */
function totpVerify(secretBase32, code, window = 1) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Date.now();
  for (let offset = -window; offset <= window; offset += 1) {
    if (timingSafeEqualHex(totpCode(secretBase32, now + offset * 30000), clean)) return true;
  }
  return false;
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** otpauth:// URI for QR rendering on the enrolment screen. */
function totpUri(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Hash used for the second component of an electronic signature. Storing only
 * a digest means a leaked database cannot be replayed to forge signatures.
 */
function signatureCredentialHash(user, method, components) {
  return sha256(canonicalJson({
    userId: user.id,
    username: user.username,
    method,
    components,
    changedAt: user.password_changed_at || null,
  }));
}

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  hmac,
  randomToken,
  uuid,
  canonicalJson,
  timingSafeEqualHex,
  base32Encode,
  base32Decode,
  totpCode,
  totpVerify,
  generateTotpSecret,
  totpUri,
  signatureCredentialHash,
};
