import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, isAllowed, canManageUsers, canKick, canDeleteMessages, canTimeout, canPinMessages } from '../auth.js';
import { db, GROUP_ID } from '../db.js';
import { recordAuditLog, listAuditLogs } from '../audit.js';

const router = Router();

function assertAllowed(req, res) {
  const user = getCurrentUser(req);
  if (!isAllowed(user)) return res.status(403).json({ error: 'Not allowed' });
  return user;
}

// List blacklisted user ids
router.get('/blacklist', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const rows = db.prepare('SELECT user_id FROM blacklist').all();
  res.json({ blacklisted_ids: rows.map(r => r.user_id) });
});

// Blacklist user – blacklisted user cannot access group chat, only DM with jimmyqrg or allowed users
router.post('/blacklist', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canKick(admin)) return res.status(403).json({ error: 'Not allowed' });
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot blacklist jimmyqrg' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('INSERT OR REPLACE INTO blacklist (user_id, created_by, created_at) VALUES (?, ?, ?)')
    .run(user_id, admin.id, Date.now());
  recordAuditLog('blacklist.add', admin.id, user_id);
  res.json({ ok: true });
});

router.delete('/blacklist/:userId', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canKick(admin)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(req.params.userId);
  recordAuditLog('blacklist.remove', admin.id, req.params.userId);
  res.json({ ok: true });
});

// Remove account (soft delete) – user cannot log in, messages stay, can be restored
router.post('/remove-account', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canKick(admin)) return res.status(403).json({ error: 'Not allowed' });
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot remove jimmyqrg' });
  const target = db.prepare('SELECT id, deleted_at FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.deleted_at) return res.status(400).json({ error: 'Account already removed' });
  db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(Date.now(), user_id);
  const io = req.app.get('io');
  if (io) io.to(`user:${user_id}`).emit('account_removed', {});
  recordAuditLog('account.soft_delete', admin.id, user_id);
  res.json({ ok: true });
});

// Restore removed account
router.post('/restore-account', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canKick(admin)) return res.status(403).json({ error: 'Not allowed' });
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const target = db.prepare('SELECT id, deleted_at FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!target.deleted_at) return res.status(400).json({ error: 'Account is not removed' });
  db.prepare('UPDATE users SET deleted_at = NULL WHERE id = ?').run(user_id);
  recordAuditLog('account.restore', admin.id, user_id);
  res.json({ ok: true });
});

// Permanently delete account – removes user and optionally their group messages. Only jimmyqrg can do this.
router.post('/delete-account-permanently', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can permanently delete accounts' });
  const { user_id, delete_group_messages } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot delete jimmyqrg' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const delGroupMsgs = delete_group_messages !== false; // default true
  if (delGroupMsgs) {
    db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE room_type = ? AND room_id = ? AND sender_id = ?')
      .run('deleted', 'group', GROUP_ID, user_id);
  }
  db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(user_id);
  db.prepare('DELETE FROM blocked_users WHERE user_id = ? OR blocked_id = ?').run(user_id, user_id);
  db.prepare('DELETE FROM friendships WHERE user1_id = ? OR user2_id = ?').run(user_id, user_id);
  db.prepare('DELETE FROM friend_request_log WHERE from_id = ? OR to_id = ?').run(user_id, user_id);
  db.prepare('DELETE FROM message_likes WHERE user_id = ?').run(user_id);
  db.prepare('DELETE FROM inbox WHERE user_id = ?').run(user_id);
  db.prepare('DELETE FROM user_notification_prefs WHERE user_id = ?').run(user_id);
  const convs = db.prepare('SELECT id FROM conversations WHERE user1_id = ? OR user2_id = ?').all(user_id, user_id);
  for (const c of convs) {
    db.prepare('DELETE FROM messages WHERE room_type = ? AND room_id = ?').run('dm', c.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
  }
  db.prepare('DELETE FROM kicked WHERE user_id = ?').run(user_id);
  db.prepare('DELETE FROM group_timeouts WHERE user_id = ?').run(user_id);
  db.prepare('DELETE FROM doc_versions WHERE editor_id = ?').run(user_id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user_id);
  recordAuditLog('account.delete_permanent', admin.id, user_id, { delete_group_messages: delGroupMsgs });
  res.json({ ok: true });
});

// Delete message (permanent; no "recalled" notice). Cannot delete jimmyqrg's messages.
router.post('/messages/:id/delete', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canDeleteMessages(admin)) return res.status(403).json({ error: 'Not allowed to delete messages' });
  const msg = db.prepare('SELECT id, sender_id FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot delete jimmyqrg\'s messages' });
  db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE id = ?').run('deleted', req.params.id);
  recordAuditLog('message.delete', admin.id, msg.sender_id, { message_id: req.params.id });
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
  recordAuditLog('admin.allowed_toggle', admin.id, id, { allowed: !!value });
  res.json({ ok: true });
});

const PERM_KEYS = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout', 'can_pin_messages', 'can_unlimited_edit_recall'];

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
  const changed = {};
  for (const key of PERM_KEYS) {
    if (updates[key] !== undefined) changed[key] = !!updates[key];
  }
  recordAuditLog('admin.permissions_update', admin.id, id, { changed });
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
  recordAuditLog('timeout.create', admin.id, user_id, {
    duration: duration || 'forever',
    expires_at: expiresAt || null,
    locked_release: !!locked,
    timeout_id: id,
  });
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
  recordAuditLog('timeout.release', admin.id, row.user_id, { timeout_id: row.id, locked_release: !!row.locked_release });
  res.json({ ok: true });
});

router.get('/audit', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const rows = listAuditLogs(req.query.limit);
  res.json({ logs: rows });
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

// Pin message in a room – requires can_pin_messages
router.post('/pin', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canPinMessages(admin)) return res.status(403).json({ error: 'Not allowed to pin messages' });
  const { message_id, room_type, room_id } = req.body || {};
  if (!message_id || !room_type || !room_id) return res.status(400).json({ error: 'message_id, room_type, room_id required' });
  const msg = db.prepare('SELECT id, sender_id, content, msg_type, created_at FROM messages WHERE id = ? AND room_type = ? AND room_id = ? AND deleted_by_admin = 0 AND recalled_at IS NULL').get(message_id, room_type, room_id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  db.prepare('INSERT OR REPLACE INTO pinned_messages (room_type, room_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)').run(room_type, room_id, message_id, admin.id, Date.now());
  const sender = db.prepare('SELECT username, display_name, avatar_url FROM users WHERE id = ?').get(msg.sender_id);
  const pinned = { message_id: msg.id, sender_id: msg.sender_id, content: msg.content, msg_type: msg.msg_type, created_at: msg.created_at, username: sender?.username, display_name: sender?.display_name, pinned_by: admin.id, pinned_at: Date.now() };
  const io = req.app.get('io');
  if (io) io.to(`${room_type === 'dm' ? 'dm' : 'group'}:${room_id}`).emit('message:pinned', { room_type, room_id, pinned });
  res.json({ ok: true, pinned });
});

// Unpin message in a room – requires can_pin_messages
router.delete('/pin/:roomType/:roomId', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canPinMessages(admin)) return res.status(403).json({ error: 'Not allowed to unpin messages' });
  const { roomType, roomId } = req.params;
  db.prepare('DELETE FROM pinned_messages WHERE room_type = ? AND room_id = ?').run(roomType, roomId);
  const io = req.app.get('io');
  if (io) io.to(`${roomType === 'dm' ? 'dm' : 'group'}:${roomId}`).emit('message:unpinned', { room_type: roomType, room_id: roomId });
  res.json({ ok: true });
});

export default router;
