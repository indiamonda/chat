import { Router } from 'express';
import { register, login, getCurrentUser, sessionMiddleware, requireAuth } from '../auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const result = await register(username, password, display_name);
  if (result.error) return res.status(400).json({ error: result.error });
  req.session.userId = result.user.id;
  req.session.save(() => res.json({ user: result.user }));
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const result = await login(username, password);
  if (result.error) return res.status(401).json({ error: result.error });
  req.session.userId = result.user.id;
  req.session.save(() => res.json({ user: result.user }));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user });
});

export default router;
