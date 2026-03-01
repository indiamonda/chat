import { Router } from 'express';
import { register, login, getCurrentUser, sessionMiddleware, requireAuth } from '../auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  const { username, email, password, display_name } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Username, email and password required' });
  const result = await register(username, email, password, display_name);
  if (result.error) return res.status(400).json({ error: result.error });
  req.session.userId = result.user.id;
  req.session.save(() => res.json({ user: result.user }));
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const usernameOrEmail = username; // can be either
  if (!usernameOrEmail || !password) return res.status(400).json({ error: 'Username or email and password required' });
  const result = await login(usernameOrEmail, password);
  if (result.error) return res.status(401).json({ error: result.error });
  req.session.userId = result.user.id;
  req.session.save(() => res.json({ user: result.user }));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user: user || null });
});

export default router;
