import { Router } from 'express';
import { register, login, getCurrentUser, sessionMiddleware, requireAuth } from '../auth.js';
import { issueToken, revokeToken, extractToken, resolveToken } from '../tokens.js';

const router = Router();

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
    if (process.env.RECAPTCHA_SECRET_KEY) {
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
    const { username, password } = req.body || {};
    const usernameOrEmail = username; // can be either
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

export default router;
