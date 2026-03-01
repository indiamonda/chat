import { Router } from 'express';
import { requireAuth, getCurrentUser, changePassword, canManageUsers } from '../auth.js';
import { db, GROUP_ID } from '../db.js';
import { upload } from '../upload.js';

const router = Router();
const PERM_COLS = 'can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages, can_manage_users';

router.get('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const canSeeAllowed = me?.is_allowed;
  const canSeePerms = canManageUsers(me);
  const list = db.prepare(`
    SELECT id, username, display_name, avatar_url${canSeeAllowed ? ', is_allowed' : ''}${canSeePerms ? `, ${PERM_COLS}` : ''}
    FROM users
    ORDER BY username
  `).all();
  const users = list.map(u => {
    const out = { ...u };
    if (!canSeeAllowed) delete out.is_allowed;
    else out.is_allowed = !!u.is_allowed;
    if (canSeePerms) {
      out.can_send_inbox = !!u.can_send_inbox;
      out.can_broadcast = !!u.can_broadcast;
      out.can_edit_docs = !!u.can_edit_docs;
      out.can_kick = !!u.can_kick;
      out.can_delete_messages = !!u.can_delete_messages;
      out.can_manage_users = !!u.can_manage_users;
    } else {
      PERM_COLS.split(', ').forEach(c => delete out[c]);
    }
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

router.patch('/password', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current password and new password required' });
  const result = await changePassword(user.id, current_password, new_password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

export default router;
