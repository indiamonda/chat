import { Router } from 'express';
import { register, login, getCurrentUser, sessionMiddleware, requireAuth } from '../auth.js';

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
    req.session.save(() => res.json({ user: result.user }));
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
    req.session.save(() => res.json({ user: result.user }));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user: user || null });
});

export default router;
