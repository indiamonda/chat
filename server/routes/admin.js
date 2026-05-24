import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, isAllowed, canManageUsers, canKick, canDeleteMessages, canTimeout, canPinMessages } from '../auth.js';
import { db, GROUP_ID, banEmail } from '../db.js';
import { recordAuditLog, listAuditLogs } from '../audit.js';
import { markUploadOrphan } from '../uploads-tracker.js';
import { runBackup, listBackups, getBackupsDir } from '../backup.js';
import { join } from 'path';
import { existsSync } from 'fs';

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
  // Immediately kick them out of the group room + refresh their client so
  // the blacklist takes effect without needing a reload.
  try { req.app.get('refreshUserSocketState')?.(user_id); } catch (_) {}
  try {
    const io = req.app.get('io');
    io?.to(`user:${user_id}`).emit('blacklist:changed', { blacklisted: true });
  } catch (_) {}
  res.json({ ok: true });
});

router.delete('/blacklist/:userId', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canKick(admin)) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(req.params.userId);
  recordAuditLog('blacklist.remove', admin.id, req.params.userId);
  try { req.app.get('refreshUserSocketState')?.(req.params.userId); } catch (_) {}
  try {
    const io = req.app.get('io');
    io?.to(`user:${req.params.userId}`).emit('blacklist:changed', { blacklisted: false });
  } catch (_) {}
  res.json({ ok: true });
});

// ── Permanent email bans ──────────────────────────────────────────────────
// Bans here survive account deletion / re-registration. Only jimmyqrg can
// manage this list — these are hard permanent bans.

router.get('/banned-emails', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can view banned emails' });
  try {
    const rows = db.prepare('SELECT email, reason, created_by, created_at FROM banned_emails ORDER BY created_at DESC').all();
    res.json({ banned_emails: rows });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to list banned emails' });
  }
});

router.post('/banned-emails', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can manage banned emails' });
  const { email, reason } = req.body || {};
  const trimmed = String(email || '').trim();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const ok = banEmail(trimmed, { reason: reason ? String(reason).slice(0, 500) : null, actorId: admin.id });
  if (!ok) return res.status(500).json({ error: 'Failed to ban email' });
  recordAuditLog('email.ban', admin.id, null, { email: trimmed.toLowerCase(), reason: reason || null });
  res.json({ ok: true, email: trimmed.toLowerCase() });
});

router.delete('/banned-emails/:email', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can manage banned emails' });
  const normalized = String(req.params.email || '').trim().toLowerCase();
  if (!normalized) return res.status(400).json({ error: 'email required' });
  try {
    db.prepare('DELETE FROM banned_emails WHERE LOWER(email) = ?').run(normalized);
    recordAuditLog('email.unban', admin.id, null, { email: normalized });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to unban email' });
  }
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
  // Revoke every active session so the removed user can't continue spamming
  // with a cached token until they reload. Also disconnect live sockets.
  try { db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(user_id); } catch (_) {}
  const io = req.app.get('io');
  if (io) io.to(`user:${user_id}`).emit('account_removed', {});
  try { req.app.get('disconnectAllSocketsFor')?.(user_id); } catch (_) {}
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

/**
 * Best-effort DELETE helper — swallows errors like "no such table" so a missing
 * legacy table cannot take down the whole permanent-delete flow. Real errors
 * are logged so they remain debuggable.
 */
function safeRun(sql, params = []) {
  try {
    db.prepare(sql).run(...params);
    return true;
  } catch (err) {
    if (!/no such table/i.test(err?.message || '')) {
      console.warn('[delete-permanently] query failed:', sql, err?.message || err);
    }
    return false;
  }
}

function safeAll(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    if (!/no such table/i.test(err?.message || '')) {
      console.warn('[delete-permanently] query failed:', sql, err?.message || err);
    }
    return [];
  }
}

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

  try {
    if (delGroupMsgs) {
      const affected = safeAll('SELECT id FROM messages WHERE room_type = ? AND sender_id = ?', ['group', user_id]);
      safeRun('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE room_type = ? AND sender_id = ?',
        ['deleted', 'group', user_id]);
      for (const a of affected) markUploadOrphan(a.id);
    }

    // Clean up every table that references users(id) or holds per-user state.
    // Each DELETE is best-effort so missing/legacy tables do not crash the flow.
    safeRun('DELETE FROM blacklist WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM blocked_users WHERE user_id = ? OR blocked_id = ?', [user_id, user_id]);
    safeRun('DELETE FROM friendships WHERE user1_id = ? OR user2_id = ?', [user_id, user_id]);
    safeRun('DELETE FROM friend_request_log WHERE from_id = ? OR to_id = ?', [user_id, user_id]);
    safeRun('DELETE FROM message_likes WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM message_reactions WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM inbox WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM user_notification_prefs WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM user_saves WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM auth_tokens WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM message_collections WHERE user_id = ?', [user_id]);

    // Delete DM conversations and their messages
    const convs = safeAll('SELECT id FROM conversations WHERE user1_id = ? OR user2_id = ?', [user_id, user_id]);
    for (const c of convs) {
      safeRun('DELETE FROM messages WHERE room_type = ? AND room_id = ?', ['dm', c.id]);
      safeRun('DELETE FROM conversations WHERE id = ?', [c.id]);
    }

    safeRun('DELETE FROM kicked WHERE user_id = ?', [user_id]);
    safeRun('DELETE FROM group_timeouts WHERE user_id = ?', [user_id]);

    // Moderation: reports filed by the user or about the user, and any notes they authored.
    safeRun('DELETE FROM moderation_notes WHERE author_id = ?', [user_id]);
    safeRun('DELETE FROM message_reports WHERE reporter_id = ? OR target_user_id = ?', [user_id, user_id]);

    // Unpin any pinned messages the user pinned (their authored messages are already
    // covered by deleted_by_admin above; pinned_messages points to message_id so we
    // only need to clear rows where pinned_by references the deleted user).
    safeRun('DELETE FROM pinned_messages WHERE pinned_by = ?', [user_id]);

    // Upload refs: mark this user's uploads as orphaned so the GC can sweep them.
    safeRun('UPDATE upload_refs SET uploaded_by = NULL WHERE uploaded_by = ?', [user_id]);

    // Preserve document history: leave doc_versions intact (editor_id FK isn't
    // enforced so a dangling reference is harmless, and we keep doc history).
    // Audit logs: keep rows for accountability; FKs aren't enforced so the
    // dangling actor/target references are fine.

    db.prepare('DELETE FROM users WHERE id = ?').run(user_id);
    recordAuditLog('account.delete_permanent', admin.id, user_id, { delete_group_messages: delGroupMsgs });
    // Kick the user out of every live socket so any cached session in their
    // browser cannot keep sending messages until they reload.
    try { req.app.get('disconnectAllSocketsFor')?.(user_id); } catch (_) {}
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete-permanently] Failed to delete user', user_id, err);
    res.status(500).json({ error: err?.message || 'Failed to permanently delete account' });
  }
});

// Delete message (permanent; no "recalled" notice). Cannot delete jimmyqrg's messages.
router.post('/messages/:id/delete', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canDeleteMessages(admin)) return res.status(403).json({ error: 'Not allowed to delete messages' });
  const msg = db.prepare('SELECT id, sender_id, room_type, room_id FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot delete jimmyqrg\'s messages' });
  db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE id = ?').run('deleted', req.params.id);
  markUploadOrphan(req.params.id);
  recordAuditLog('message.delete', admin.id, msg.sender_id, { message_id: req.params.id });
  // Broadcast so every viewer's client removes the message in real time — an
  // admin deletion that only hits the DB is useless during an active spam raid.
  // All group subscribers join `group:${GROUP_ID}` (not `group:<room_id>`),
  // so we emit to that canonical room.
  const io = req.app.get('io');
  if (io) {
    try {
      if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:deleted', { id: req.params.id });
      else io.to(`group:${GROUP_ID}`).emit('message:deleted', { id: req.params.id });
    } catch (_) {}
  }
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

// Timeout user – requires can_timeout. `scope` can be 'group' (mute in group chat)
// or 'dm' (mute in private chats, except with jimmyqrg).
router.post('/timeout', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (!canTimeout(admin)) return res.status(403).json({ error: 'Not allowed to timeout' });
  const { user_id, duration, locked_release, scope } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot timeout jimmyqrg' });
  const normalizedScope = scope === 'dm' ? 'dm' : 'group';
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const expiresAt = duration ? parseDuration(duration) : null;
  const locked = admin.id !== 'jimmyqrg' ? 0 : (!!locked_release ? 1 : 0);
  const id = randomUUID();
  const roomType = normalizedScope === 'dm' ? 'dm' : 'group';
  const roomId = normalizedScope === 'dm' ? '*' : GROUP_ID;
  // Release any previous active timeouts of the same scope so we don't stack
  // stale rows — otherwise an earlier row could expire and leave stale state.
  db.prepare(`
    UPDATE group_timeouts SET released_at = ?, released_by = ?
    WHERE user_id = ? AND scope = ? AND released_at IS NULL
  `).run(Date.now(), admin.id, user_id, normalizedScope);
  try {
    db.prepare(`
      INSERT INTO group_timeouts (id, user_id, room_type, room_id, expires_at, locked_release, created_at, created_by, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user_id, roomType, roomId, expiresAt, locked, Date.now(), admin.id, normalizedScope);
  } catch (err) {
    console.error('[timeout.create] Failed to insert timeout row', {
      admin: admin.id, user_id, scope: normalizedScope, error: err?.message || err,
    });
    return res.status(500).json({ error: err?.message || 'Failed to create timeout' });
  }
  recordAuditLog('timeout.create', admin.id, user_id, {
    duration: duration || 'forever',
    expires_at: expiresAt || null,
    locked_release: !!locked,
    scope: normalizedScope,
    timeout_id: id,
  });
  notifyTimeoutChanged(req, user_id);
  res.json({ ok: true, timeout_id: id, scope: normalizedScope });
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
  notifyTimeoutChanged(req, row.user_id);
  res.json({ ok: true });
});

/** Emit a 'timeouts:changed' event to the affected user so their client
 * refreshes its banner/state immediately. */
function notifyTimeoutChanged(req, userId) {
  const io = req.app.get('io');
  if (!io || !userId) return;
  try { io.to(`user:${userId}`).emit('timeouts:changed'); } catch (_) {}
  try { io.to(`user:${userId}`).emit('permissions:changed', {}); } catch (_) {}
}

router.get('/audit', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const limit = req.query.limit;
  const search = String(req.query.q || '').trim().toLowerCase();
  let rows = listAuditLogs(limit);
  if (search) {
    rows = rows.filter((row) => {
      const blob = [
        row.action,
        row.actor_username,
        row.actor_display_name,
        row.target_username,
        row.target_display_name,
        row.details ? JSON.stringify(row.details) : '',
      ].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(search);
    });
  }
  res.json({ logs: rows });
});

// CSV helpers ---------------------------------------------------------------
function csvEscape(value) {
  if (value == null) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function rowsToCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(',')).join('\n');
  return header + '\n' + body + '\n';
}

function sendExport(res, filename, format, rows, columns) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(rowsToCsv(rows, columns));
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
  return res.send(JSON.stringify({ exported_at: Date.now(), rows }, null, 2));
}

const EXPORT_KINDS = new Set(['messages', 'users', 'audit', 'docs', 'reports']);

router.get('/export/:kind', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const { kind } = req.params;
  if (!EXPORT_KINDS.has(kind)) return res.status(400).json({ error: 'Unknown export kind' });
  if (admin.id !== 'jimmyqrg' && (kind === 'users' || kind === 'audit')) {
    return res.status(403).json({ error: 'Only jimmyqrg can export this dataset' });
  }
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 50000);

  if (kind === 'messages') {
    const rows = db.prepare(`
      SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type,
             m.reply_to_id, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
             u.username AS sender_username
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      ORDER BY m.created_at DESC LIMIT ?
    `).all(limit);
    recordAuditLog('admin.export', admin.id, null, { kind, format, rows: rows.length });
    return sendExport(res, `chat-messages-${Date.now()}`, format, rows, [
      'id', 'room_type', 'room_id', 'sender_id', 'sender_username', 'content', 'msg_type',
      'reply_to_id', 'recalled_at', 'deleted_by_admin', 'created_at', 'updated_at',
    ]);
  }
  if (kind === 'users') {
    const rows = db.prepare(`
      SELECT id, username, display_name, email, is_allowed, deleted_at, created_at,
             can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages,
             can_manage_users, can_timeout, can_pin_messages, can_unlimited_edit_recall
      FROM users ORDER BY created_at ASC
    `).all();
    recordAuditLog('admin.export', admin.id, null, { kind, format, rows: rows.length });
    return sendExport(res, `chat-users-${Date.now()}`, format, rows, [
      'id', 'username', 'display_name', 'email', 'is_allowed', 'deleted_at', 'created_at',
      'can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages',
      'can_manage_users', 'can_timeout', 'can_pin_messages', 'can_unlimited_edit_recall',
    ]);
  }
  if (kind === 'audit') {
    const rows = listAuditLogs(limit);
    recordAuditLog('admin.export', admin.id, null, { kind, format, rows: rows.length });
    return sendExport(res, `chat-audit-${Date.now()}`, format, rows.map((r) => ({
      ...r,
      details: r.details ? JSON.stringify(r.details) : null,
    })), ['id', 'action', 'actor_id', 'actor_username', 'target_id', 'target_username', 'details', 'created_at']);
  }
  if (kind === 'docs') {
    const rows = db.prepare(`
      SELECT id, doc_key, content, editor_id, created_at FROM doc_versions
      ORDER BY doc_key, created_at DESC
    `).all();
    recordAuditLog('admin.export', admin.id, null, { kind, format, rows: rows.length });
    return sendExport(res, `chat-docs-${Date.now()}`, format, rows, ['id', 'doc_key', 'editor_id', 'created_at', 'content']);
  }
  if (kind === 'reports') {
    const rows = db.prepare(`
      SELECT r.id, r.reporter_id, r.target_user_id, r.message_id, r.room_type, r.room_id,
             r.reason, r.details, r.status, r.outcome, r.assigned_to, r.resolved_by, r.resolved_at,
             r.created_at, r.updated_at
      FROM message_reports r ORDER BY r.created_at DESC LIMIT ?
    `).all(limit);
    recordAuditLog('admin.export', admin.id, null, { kind, format, rows: rows.length });
    return sendExport(res, `chat-reports-${Date.now()}`, format, rows, [
      'id', 'reporter_id', 'target_user_id', 'message_id', 'room_type', 'room_id', 'reason',
      'details', 'status', 'outcome', 'assigned_to', 'resolved_by', 'resolved_at', 'created_at', 'updated_at',
    ]);
  }
});

// Manual database backup. Only jimmyqrg can trigger.
router.post('/backup', requireAuth, async (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can run backups' });
  try {
    const result = await runBackup(admin.id);
    res.json({ ok: true, backup: result });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err?.message || 'Backup failed' });
  }
});

// List the existing backup snapshots so admin can download them.
router.get('/backup', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can view backups' });
  res.json({ backups: listBackups() });
});

router.get('/backup/:filename', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  if (admin.id !== 'jimmyqrg') return res.status(403).json({ error: 'Only jimmyqrg can download backups' });
  const filename = String(req.params.filename || '');
  if (!/^chat-[0-9TZ\-]+\.sqlite$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = join(getBackupsDir(), filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
  recordAuditLog('admin.backup_download', admin.id, null, { filename });
  res.download(filePath, filename);
});

// List active timeouts (both group and dm scopes).
router.get('/timeouts', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const rows = db.prepare(`
    SELECT t.id, t.user_id, t.expires_at, t.locked_release, t.created_at, t.created_by,
           t.scope, t.room_type, t.room_id,
           u.username, u.display_name
    FROM group_timeouts t
    JOIN users u ON u.id = t.user_id
    WHERE t.released_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > ?)
    ORDER BY t.created_at DESC
  `).all(Date.now());
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
