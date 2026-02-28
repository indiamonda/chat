import { Router } from 'express';
import { requireAuth, getCurrentUser } from '../auth.js';
import { db, GROUP_ID } from '../db.js';
import { upload } from '../upload.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const canSeeAllowed = getCurrentUser(req)?.is_allowed;
  const list = db.prepare(`
    SELECT id, username, display_name, avatar_url${canSeeAllowed ? ', is_allowed' : ''}
    FROM users
    ORDER BY username
  `).all();
  const users = list.map(u => {
    const out = { ...u };
    if (!canSeeAllowed) delete out.is_allowed;
    else out.is_allowed = !!u.is_allowed;
    return out;
  });
  res.json({ users });
});

router.get('/profile', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user });
});

router.patch('/profile', requireAuth, upload.single('avatar'), (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { display_name } = req.body || {};
  let avatar_url = user.avatar_url;
  if (req.file) avatar_url = `/uploads/${req.file.filename}`;
  if (typeof display_name === 'string' && display_name.trim()) {
    db.prepare('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?')
      .run(display_name.trim().slice(0, 64), avatar_url || null, user.id);
  } else if (req.file) {
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar_url, user.id);
  }
  const updated = db.prepare('SELECT id, username, display_name, avatar_url, is_allowed FROM users WHERE id = ?').get(user.id);
  res.json({ user: { ...updated, is_allowed: !!updated.is_allowed } });
});

export default router;
