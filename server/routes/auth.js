import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { register, login, resetPassword, getCurrentUser, sessionMiddleware, requireAuth } from '../auth.js';
import { issueToken, revokeToken, extractToken, resolveToken } from '../tokens.js';
import { db, isEmailBanned } from '../db.js';
import { sendEmail, buildResetEmail, getPublicBaseUrl } from '../email.js';
import { recordAuditLog } from '../audit.js';

const router = Router();

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Per-IP / per-identifier rate limiter keyed in memory. Resets on restart.
const _resetLimiter = new Map();
function rateLimitKey(req, identifier) {
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || 'unknown').trim();
  return `${ip}::${(identifier || '').toLowerCase()}`;
}
function shouldThrottleReset(req, identifier) {
  const key = rateLimitKey(req, identifier);
  const now = Date.now();
  const arr = (_resetLimiter.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  // No more than 5 reset attempts per identifier+IP per hour.
  if (arr.length >= 5) return true;
  arr.push(now);
  _resetLimiter.set(key, arr);
  return false;
}

function generateResetToken() {
  // 32 random bytes -> 64-char hex token. Cryptographically secure.
  return randomBytes(32).toString('hex');
}

/** Verify reCAPTCHA v2 token with Google. Returns { success: boolean, error?: string }.
 *  Set RECAPTCHA_SITE_KEY (public, for frontend) and RECAPTCHA_SECRET_KEY (secret, for server).
 *  If RECAPTCHA_SECRET_KEY is not set, registration does not require reCAPTCHA. */
async function verifyRecaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret || !token) return { success: false, error: 'recaptcha_missing' };
  try {
    const q = new URLSearchParams({ secret, response: token });
    const res = await fetch(`https://www.google.com/recaptcha/api/siteverify?${q}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) return { success: true };
    return { success: false, error: data['error-codes']?.[0] || 'verification_failed' };
  } catch (e) {
    return { success: false, error: 'network_error' };
  }
}

/** True when the caller looks like an off-origin client (e.g. jimmyqrg.github.io). Such clients
 *  cannot reliably use session cookies because browsers block third-party cookies, so we also
 *  hand back a bearer token they can store and send via `Authorization: Bearer ...`. */
function wantsToken(req) {
  if (req.query?.want_token === '1' || req.body?.want_token) return true;
  const origin = String(req.headers?.origin || '');
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    if (host === req.headers?.host) return false;
  } catch {}
  return true;
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, display_name, recaptcha_token } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'Username, email and password required' });
    if (process.env.RECAPTCHA_SECRET_KEY && !wantsToken(req)) {
      const recaptcha = await verifyRecaptcha(recaptcha_token);
      if (!recaptcha.success) {
        return res.status(400).json({ error: 'Please complete the reCAPTCHA check.' });
      }
    }
    const result = await register(username, email, password, display_name);
    if (result.error) return res.status(400).json({ error: result.error });
    req.session.userId = result.user.id;
    const extras = wantsToken(req) ? { token: issueToken(result.user.id, 'register') } : {};
    req.session.save(() => res.json({ user: result.user, ...extras }));
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, email, identifier, login_id, password } = req.body || {};
    // Accept both legacy and explicit fields so frontend can send whichever
    // shape it has (username-only, email-only, or unified identifier).
    const usernameOrEmail = (identifier || login_id || username || email || '').toString().trim();
    if (!usernameOrEmail || !password) return res.status(400).json({ error: 'Username or email and password required' });
    const result = await login(usernameOrEmail, password);
    if (result.error) return res.status(200).json({ error: result.error });
    req.session.userId = result.user.id;
    const extras = wantsToken(req) ? { token: issueToken(result.user.id, 'login') } : {};
    req.session.save(() => res.json({ user: result.user, ...extras }));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const token = extractToken(req);
  if (token) revokeToken(token);
  req.session.destroy(() => res.json({ ok: true }));
});

/** Explicit token exchange for clients that started with a cookie session or want a fresh token. */
router.post('/token', requireAuth, (req, res) => {
  const label = (req.body?.label || '').toString().slice(0, 64) || 'api';
  const token = issueToken(req.session.userId, label);
  res.json({ token });
});

/** SSO handoff from an external site (e.g. jimmyqrg.github.io). Presenting a valid bearer token
 *  elevates this request into a first-party session cookie so the chat SPA then works normally.
 *  POST form is for fetch() handoff from the SPA; GET form is a full-page redirect landing. */
router.post('/sso', (req, res) => {
  const token = (req.body?.token || '').toString();
  if (!token) return res.status(400).json({ error: 'token required' });
  const userId = resolveToken(token);
  if (!userId) return res.status(401).json({ error: 'invalid token' });
  req.session.userId = userId;
  req.session.save(() => res.json({ ok: true, userId }));
});

router.get('/sso', (req, res) => {
  const token = (req.query?.sso || req.query?.token || '').toString();
  const next = (req.query?.next || '/').toString();
  const safeNext = typeof next === 'string' && next.startsWith('/') ? next : '/';
  if (!token) return res.redirect(safeNext);
  const userId = resolveToken(token);
  if (!userId) return res.redirect(safeNext);
  req.session.userId = userId;
  req.session.save(() => res.redirect(safeNext));
});

router.get('/me', (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user: user || null });
});

/**
 * Request a password reset link by email or username.
 *
 * Returns 200 with a generic success message in every case (whether or not
 * an account exists with the given identifier). This avoids leaking which
 * usernames / emails are registered. Real errors (bad input shape, server
 * error) still return non-200 so the client can show them.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier, recaptcha_token } = req.body || {};
    const trimmed = String(identifier || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Username or email required' });
    if (process.env.RECAPTCHA_SECRET_KEY) {
      const recaptcha = await verifyRecaptcha(recaptcha_token);
      if (!recaptcha.success) {
        return res.status(400).json({ error: 'Please complete the reCAPTCHA check.' });
      }
    }
    if (shouldThrottleReset(req, trimmed)) {
      return res.status(429).json({ error: 'Too many reset requests. Try again later.' });
    }

    const lowered = trimmed.toLowerCase();
    if (lowered.includes('@') && isEmailBanned(lowered)) {
      // Banned emails get the same generic response so they can't probe the ban list.
      return res.json({ ok: true, sent: false, generic: true });
    }

    const user = db.prepare(
      `SELECT id, username, display_name, email, deleted_at FROM users
        WHERE LOWER(username) = ? OR (email IS NOT NULL AND LOWER(email) = ?)`
    ).get(lowered, lowered);

    // Always respond the same way externally so a stranger can't enumerate
    // accounts. Only act internally when we have a real user with an email.
    if (user && user.email && !user.deleted_at) {
      try {
        // Invalidate any prior outstanding tokens for this user so each
        // request supersedes the last one.
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
          .run(Date.now(), user.id);

        const token = generateResetToken();
        const now = Date.now();
        const expiresAt = now + RESET_TOKEN_TTL_MS;
        const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || '').trim() || null;
        db.prepare(`
          INSERT INTO password_reset_tokens (token, user_id, email, created_at, expires_at, used_at, ip)
          VALUES (?, ?, ?, ?, ?, NULL, ?)
        `).run(token, user.id, user.email, now, expiresAt, ip);

        const baseUrl = getPublicBaseUrl(req);
        const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const { html, text } = buildResetEmail({
          displayName: user.display_name || user.username,
          resetUrl,
          expiresMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
        });
        const sendResult = await sendEmail({
          to: user.email,
          subject: 'Reset your JimmyQrg Chat password',
          html,
          text,
        });
        recordAuditLog('password.reset_requested', user.id, user.id, {
          email: user.email,
          delivered: sendResult.ok,
          provider: sendResult.provider,
          ip,
        });
        if (!sendResult.ok) {
          // Log the link so jimmyqrg can forward it manually until SMTP/Resend is set up.
          console.warn(`[forgot-password] Email NOT delivered (${sendResult.error}). Manual reset link for ${user.username} (${user.email}): ${resetUrl}`);
        }
      } catch (err) {
        console.error('[forgot-password] failed to issue token for', user?.id, err);
      }
    }

    res.json({ ok: true, sent: true, generic: true });
  } catch (err) {
    console.error('[forgot-password] error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Validate a reset token and return whose account it belongs to (so the UI
 *  can show a friendly "Resetting password for X" header). */
router.get('/reset-password/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token required' });
  const row = db.prepare(`
    SELECT t.token, t.user_id, t.email, t.expires_at, t.used_at,
           u.username, u.display_name, u.deleted_at
    FROM password_reset_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `).get(token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (row.used_at) return res.status(410).json({ error: 'This link has already been used' });
  if (row.expires_at <= Date.now()) return res.status(410).json({ error: 'This link has expired' });
  if (row.deleted_at) return res.status(410).json({ error: 'This account has been deleted' });
  res.json({
    ok: true,
    username: row.username,
    display_name: row.display_name,
    email_hint: row.email ? row.email.replace(/^(.).+(@.+)$/, '$1***$2') : null,
  });
});

/** Apply a password reset using a previously emailed token. */
router.post('/reset-password', async (req, res) => {
  const { token, password, recaptcha_token } = req.body || {};
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return res.status(400).json({ error: 'Token required' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (process.env.RECAPTCHA_SECRET_KEY) {
    const recaptcha = await verifyRecaptcha(recaptcha_token);
    if (!recaptcha.success) {
      return res.status(400).json({ error: 'Please complete the reCAPTCHA check.' });
    }
  }
  const row = db.prepare(`
    SELECT t.token, t.user_id, t.expires_at, t.used_at, u.deleted_at, u.username
    FROM password_reset_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `).get(cleanToken);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (row.used_at) return res.status(410).json({ error: 'This link has already been used' });
  if (row.expires_at <= Date.now()) return res.status(410).json({ error: 'This link has expired' });
  if (row.deleted_at) return res.status(410).json({ error: 'This account has been deleted' });

  const result = resetPassword(row.user_id, String(password));
  if (result.error) return res.status(400).json({ error: result.error });
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token = ?').run(Date.now(), cleanToken);
  // Invalidate every other outstanding token for this user — only the most
  // recent reset attempt should remain valid.
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
    .run(Date.now(), row.user_id);
  recordAuditLog('password.reset_completed', row.user_id, row.user_id, { username: row.username });
  res.json({ ok: true });
});

export default router;
