import { Router } from 'express';
import { requireAuth, getCurrentUser, changePassword, canManageUsers } from '../auth.js';
import { db, GROUP_ID } from '../db.js';
import { upload } from '../upload.js';

const router = Router();
const PERM_COLS = 'can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages, can_manage_users, can_timeout';

router.get('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const canSeeAllowed = me?.is_allowed;
  const canSeePerms = canManageUsers(me);
  const list = db.prepare(`
    SELECT id, username, display_name, avatar_url, deleted_at${canSeeAllowed ? ', is_allowed' : ''}${canSeePerms ? `, ${PERM_COLS}` : ''}
    FROM users
    ORDER BY username
  `).all();
  const users = list.map(u => {
    const out = { ...u };
    out.deleted_at = u.deleted_at || null;
    if (!canSeeAllowed) delete out.is_allowed;
    else out.is_allowed = !!u.is_allowed;
    if (canSeePerms) {
      out.can_send_inbox = !!u.can_send_inbox;
      out.can_broadcast = !!u.can_broadcast;
      out.can_edit_docs = !!u.can_edit_docs;
      out.can_kick = !!u.can_kick;
      out.can_delete_messages = !!u.can_delete_messages;
      out.can_manage_users = !!u.can_manage_users;
      out.can_timeout = !!u.can_timeout;
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

/** Public profile for viewing another user (id, username, display_name, avatar_url, website, profile_links). */
router.get('/:id/profile', requireAuth, (req, res) => {
  const target = db.prepare(
    'SELECT id, username, display_name, avatar_url, website, profile_links, description FROM users WHERE id = ?'
  ).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const profile = {
    id: target.id,
    username: target.username,
    display_name: target.display_name,
    avatar_url: target.avatar_url,
    website: target.website || null,
    profile_links: target.profile_links ? JSON.parse(target.profile_links) : null,
    description: target.description || null
  };
  res.json({ profile });
});

router.patch('/profile', requireAuth, upload.single('avatar'), (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { display_name, website, profile_links, description } = req.body || {};
  let avatar_url = user.avatar_url;
  if (req.file) avatar_url = `/uploads/${req.file.filename}`;
  const name = typeof display_name === 'string' && display_name.trim() ? display_name.trim().slice(0, 64) : null;
  const web = typeof website === 'string' ? website.trim().slice(0, 512) : null;
  const links = profile_links != null ? (typeof profile_links === 'string' ? profile_links : JSON.stringify(profile_links)) : null;
  const desc = description !== undefined ? (typeof description === 'string' ? description.trim().slice(0, 1024) : null) : undefined;
  if (name !== null || req.file || web !== null || links !== null || desc !== undefined) {
    const updates = [];
    const values = [];
    if (name !== null) { updates.push('display_name = ?'); values.push(name); }
    if (req.file || avatar_url !== undefined) { updates.push('avatar_url = ?'); values.push(avatar_url || null); }
    if (web !== null) { updates.push('website = ?'); values.push(web); }
    if (links !== null) { updates.push('profile_links = ?'); values.push(links); }
    if (desc !== undefined) { updates.push('description = ?'); values.push(desc); }
    if (updates.length) {
      values.push(user.id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  }
  const updated = db.prepare('SELECT id, username, display_name, avatar_url, website, profile_links, description, is_allowed FROM users WHERE id = ?').get(user.id);
  const out = { ...updated, is_allowed: !!updated.is_allowed };
  if (out.profile_links && typeof out.profile_links === 'string') out.profile_links = JSON.parse(out.profile_links);
  res.json({ user: out });
});

router.patch('/password', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const current_password = typeof body.current_password === 'string' ? body.current_password.trim() : '';
  const new_password = typeof body.new_password === 'string' ? body.new_password.trim() : '';
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current password and new password required' });
  const result = await changePassword(user.id, current_password, new_password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

export default router;
