import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, isAllowed, canManageUsers, canKick, canDeleteMessages, canTimeout } from '../auth.js';
import { db, GROUP_ID } from '../db.js';

const router = Router();

function assertAllowed(req, res) {
  const user = getCurrentUser(req);
  if (!isAllowed(user)) return res.status(403).json({ error: 'Not allowed' });
  return user;
}

// Kick user from group (we store kick record; socket layer will disconnect/not allow rejoin until logic says so)
router.post('/kick', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canKick(admin)) return res.status(403).json({ error: 'Not allowed to kick' });
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot kick jimmyqrg' });
  const id = randomUUID();
  db.prepare(`
    INSERT INTO kicked (id, user_id, room_type, room_id, kicked_by, created_at)
    VALUES (?, ?, 'group', ?, ?, ?)
  `).run(id, user_id, GROUP_ID, admin.id, Date.now());
  res.json({ ok: true });
});

// Delete message (permanent; no "recalled" notice)
router.post('/messages/:id/delete', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canDeleteMessages(admin)) return res.status(403).json({ error: 'Not allowed to delete messages' });
  const msg = db.prepare('SELECT id FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE id = ?').run('deleted', req.params.id);
  res.json({ ok: true });
});

// Set user's is_allowed (add/remove from admin list). Requires can_manage_users.
router.post('/users/:id/allowed', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canManageUsers(admin)) return res.status(403).json({ error: 'Not allowed to manage users' });
  const { id } = req.params;
  if (id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot change jimmyqrg authority' });
  const { allowed } = req.body || {};
  const value = !!allowed ? 1 : 0;
  db.prepare('UPDATE users SET is_allowed = ? WHERE id = ?').run(value, id);
  res.json({ ok: true });
});

const PERM_KEYS = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout'];

// Set a user's permissions (only for users on admin list). Requires can_manage_users.
router.patch('/users/:id/permissions', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canManageUsers(admin)) return res.status(403).json({ error: 'Not allowed to manage users' });
  const { id } = req.params;
  if (id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot change jimmyqrg permissions' });
  const target = db.prepare('SELECT id, is_allowed FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!target.is_allowed) return res.status(400).json({ error: 'User is not on admin list; add them first' });
  const updates = (req.body || {});
  const setCols = [];
  const values = [];
  for (const key of PERM_KEYS) {
    if (updates[key] !== undefined) {
      setCols.push(`${key} = ?`);
      values.push(!!updates[key] ? 1 : 0);
    }
  }
  if (setCols.length === 0) return res.status(400).json({ error: 'No permissions to update' });
  values.push(id);
  db.prepare(`UPDATE users SET ${setCols.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// Recalled messages (group JimmyQrg only) – requires admin
router.get('/recalled-messages', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.recalled_at, m.created_at,
           u.username, u.display_name, u.avatar_url
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = 'group' AND m.room_id = ? AND m.recalled_at IS NOT NULL AND m.deleted_by_admin = 0
    ORDER BY m.recalled_at DESC
    LIMIT ?
  `).all(GROUP_ID, limit);
  res.json({ messages: rows });
});

// Parse duration string: "5 minute", "1 hour", "forever"
function parseDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (s === 'forever') return null; // no expiry
  const match = s.match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  const sec = num * (multipliers[unit] || 0);
  return Date.now() + sec * 1000;
}

// Timeout user in group – requires can_timeout
router.post('/timeout', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canTimeout(admin)) return res.status(403).json({ error: 'Not allowed to timeout' });
  const { user_id, duration, locked_release } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot timeout jimmyqrg' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const expiresAt = duration ? parseDuration(duration) : null;
  const locked = admin.id !== 'jimmyqrg' ? 0 : (!!locked_release ? 1 : 0); // only jimmyqrg can set locked_release
  const id = randomUUID();
  db.prepare(`
    INSERT INTO group_timeouts (id, user_id, room_type, room_id, expires_at, locked_release, created_at, created_by)
    VALUES (?, ?, 'group', ?, ?, ?, ?, ?)
  `).run(id, user_id, GROUP_ID, expiresAt, locked, Date.now(), admin.id);
  res.json({ ok: true, timeout_id: id });
});

// Release timeout – any admin with can_timeout unless locked (then only jimmyqrg)
router.post('/timeout/:id/release', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canTimeout(admin)) return res.status(403).json({ error: 'Not allowed to release timeout' });
  const row = db.prepare('SELECT id, user_id, locked_release FROM group_timeouts WHERE id = ? AND released_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Timeout not found or already released' });
  if (row.locked_release && admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can release this timeout' });
  db.prepare('UPDATE group_timeouts SET released_at = ?, released_by = ? WHERE id = ?').run(Date.now(), admin.id, row.id);
  res.json({ ok: true });
});

// List active timeouts
router.get('/timeouts', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const rows = db.prepare(`
    SELECT t.id, t.user_id, t.expires_at, t.locked_release, t.created_at, t.created_by,
           u.username, u.display_name
    FROM group_timeouts t
    JOIN users u ON u.id = t.user_id
    WHERE t.room_type = 'group' AND t.room_id = ? AND t.released_at IS NULL
    ORDER BY t.created_at DESC
  `).all(GROUP_ID);
  res.json({ timeouts: rows });
});

export default router;
