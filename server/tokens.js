import { randomBytes } from 'node:crypto';
import { db } from './db.js';

/** Default token lifetime: 180 days. Long enough that a logged-in game client rarely has to re-login. */
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Issue a new opaque bearer token bound to a user. Returns the plaintext token string. */
export function issueToken(userId, label) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO auth_tokens (token, user_id, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(token, userId, label || null, now, now, now + DEFAULT_TTL_MS);
  return token;
}

/** Look up a user id from a bearer token; returns null if invalid or expired. Updates last_used_at. */
export function resolveToken(token) {
  if (!token || typeof token !== 'string') return null;
  const now = Date.now();
  const row = db.prepare(
    'SELECT user_id, expires_at FROM auth_tokens WHERE token = ?'
  ).get(token);
  if (!row) return null;
  if (row.expires_at && row.expires_at < now) {
    try { db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token); } catch (_) {}
    return null;
  }
  try { db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token = ?').run(now, token); } catch (_) {}
  return row.user_id;
}

/** Invalidate a bearer token. */
export function revokeToken(token) {
  if (!token) return false;
  try {
    const res = db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return res.changes > 0;
  } catch {
    return false;
  }
}

/** Invalidate every token for a given user (e.g. on password change or "sign out everywhere"). */
export function revokeAllTokensForUser(userId) {
  try {
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId);
  } catch (_) {}
}

/** Extract bearer token from request. Accepts Authorization: Bearer ..., X-Auth-Token header, or ?access_token=... query. */
export function extractToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const headerToken = req.headers?.['x-auth-token'];
  if (headerToken) return String(headerToken);
  const qt = req.query?.access_token;
  if (qt) return String(qt);
  return null;
}
