import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser } from '../auth.js';
import { db, GROUP_ID } from '../db.js';

const router = Router();
const ONE_MIN = 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;

function friendPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

/** Check if two users are friends */
export function areFriends(userId1, userId2) {
  if (!userId1 || !userId2 || userId1 === userId2) return false;
  const [u1, u2] = friendPair(userId1, userId2);
  const row = db.prepare('SELECT 1 FROM friendships WHERE user1_id = ? AND user2_id = ?').get(u1, u2);
  return !!row;
}

/** Get cooldown ms remaining for fromId -> toId (0 if can send) */
function getFriendRequestCooldown(fromId, toId) {
  const rows = db.prepare(
    'SELECT created_at FROM friend_request_log WHERE from_id = ? AND to_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(fromId, toId);
  if (rows.length === 0) return 0;
  const now = Date.now();
  const latest = rows[0].created_at;
  let cooldownEnd = latest + ONE_MIN;
  if (rows.length >= 3) cooldownEnd = Math.max(cooldownEnd, rows[2].created_at + THIRTY_MIN);
  if (rows.length >= 6) cooldownEnd = Math.max(cooldownEnd, rows[5].created_at + ONE_HOUR);
  if (rows.length >= 10) cooldownEnd = Math.max(cooldownEnd, rows[9].created_at + FIVE_HOURS);
  if (now >= cooldownEnd) return 0;
  return cooldownEnd - now;
}

/** POST /api/friends/request – send friend request (sends inbox item to other user) */
router.post('/request', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { to_user_id } = req.body || {};
  if (!to_user_id) return res.status(400).json({ error: 'to_user_id required' });
  if (to_user_id === me.id) return res.status(400).json({ error: 'Cannot send to yourself' });
  const target = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(to_user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (areFriends(me.id, to_user_id)) return res.status(400).json({ error: 'Already friends' });
  const cooldown = getFriendRequestCooldown(me.id, to_user_id);
  if (cooldown > 0) {
    return res.status(429).json({
      error: 'Friend request cooldown',
      retry_after_ms: cooldown,
      retry_after_seconds: Math.ceil(cooldown / 1000)
    });
  }
  const inboxId = randomUUID();
  const logId = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO friend_request_log (id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(logId, me.id, to_user_id, now);
  db.prepare(`
    INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at)
    VALUES (?, ?, 'friend_request', 'Friend request', ?, ?, ?, ?)
  `).run(
    inboxId,
    to_user_id,
    `${me.display_name || me.username} sent you a friend request.`,
    me.id,
    JSON.stringify({ from_username: me.username, from_display_name: me.display_name }),
    now
  );
  res.json({ ok: true, inbox_id: inboxId });
});

/** POST /api/friends/accept – accept friend request (inbox id or from_user_id) */
router.post('/accept', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { inbox_id, from_user_id } = req.body || {};
  let fromId = from_user_id;
  if (inbox_id) {
    const item = db.prepare('SELECT related_id, user_id FROM inbox WHERE id = ? AND type = ? AND user_id = ?').get(inbox_id, 'friend_request', me.id);
    if (!item) return res.status(404).json({ error: 'Inbox item not found' });
    fromId = item.related_id;
  }
  if (!fromId) return res.status(400).json({ error: 'inbox_id or from_user_id required' });
  if (fromId === me.id) return res.status(400).json({ error: 'Cannot accept from yourself' });
  const other = db.prepare('SELECT id FROM users WHERE id = ?').get(fromId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  if (areFriends(me.id, fromId)) return res.status(400).json({ error: 'Already friends' });
  const [u1, u2] = friendPair(me.id, fromId);
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO friendships (user1_id, user2_id, created_at) VALUES (?, ?, ?)').run(u1, u2, now);
  if (inbox_id) db.prepare('UPDATE inbox SET read_at = ? WHERE id = ?').run(now, inbox_id);
  res.json({ ok: true });
});

/** POST /api/friends/reject – reject friend request */
router.post('/reject', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { inbox_id } = req.body || {};
  if (!inbox_id) return res.status(400).json({ error: 'inbox_id required' });
  const item = db.prepare('SELECT id FROM inbox WHERE id = ? AND type = ? AND user_id = ?').get(inbox_id, 'friend_request', me.id);
  if (!item) return res.status(404).json({ error: 'Inbox item not found' });
  db.prepare('UPDATE inbox SET read_at = ? WHERE id = ?').run(Date.now(), inbox_id);
  res.json({ ok: true });
});

/** GET /api/friends/check?user_id=xxx – are we friends with this user? */
router.get('/check', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  res.json({ friends: areFriends(me.id, userId) });
});

/** GET /api/friends – list my friend user ids */
router.get('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const rows = db.prepare('SELECT user1_id, user2_id FROM friendships WHERE user1_id = ? OR user2_id = ?').all(me.id, me.id);
  const ids = rows.map(r => (r.user1_id === me.id ? r.user2_id : r.user1_id));
  res.json({ friend_ids: ids });
});

export default router;
