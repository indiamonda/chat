import { Router } from 'express';
import { requireAuth, getCurrentUser } from '../auth.js';
import { db } from '../db.js';

const router = Router();

/** GET /api/blocks – list blocked user ids */
router.get('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const rows = db.prepare('SELECT blocked_id FROM blocked_users WHERE user_id = ?').all(me.id);
  res.json({ blocked_ids: rows.map(r => r.blocked_id) });
});

/** POST /api/blocks – block a user */
router.post('/', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const { user_id: blockedId } = req.body || {};
  if (!blockedId) return res.status(400).json({ error: 'user_id required' });
  if (blockedId === me.id) return res.status(400).json({ error: 'Cannot block yourself' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(blockedId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO blocked_users (user_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(me.id, blockedId, now);
  res.json({ ok: true });
});

/** DELETE /api/blocks/:id – unblock a user */
router.delete('/:id', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  db.prepare('DELETE FROM blocked_users WHERE user_id = ? AND blocked_id = ?').run(me.id, req.params.id);
  res.json({ ok: true });
});

export function isBlocked(blockerId, blockedId) {
  if (!blockerId || !blockedId) return false;
  const row = db.prepare('SELECT 1 FROM blocked_users WHERE user_id = ? AND blocked_id = ?').get(blockerId, blockedId);
  return !!row;
}

export default router;
