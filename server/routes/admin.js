import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, isAllowed } from '../auth.js';
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
  assertAllowed(req, res);
  if (res.headersSent) return;
  const msg = db.prepare('SELECT id FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE id = ?').run('deleted', req.params.id);
  res.json({ ok: true });
});

// Set user's is_allowed (cannot change jimmyqrg)
router.post('/users/:id/allowed', requireAuth, (req, res) => {
  const admin = assertAllowed(req, res);
  if (admin === undefined) return;
  const { id } = req.params;
  if (id === 'jimmyqrg') return res.status(403).json({ error: 'Cannot change jimmyqrg authority' });
  const { allowed } = req.body || {};
  const value = !!allowed ? 1 : 0;
  db.prepare('UPDATE users SET is_allowed = ? WHERE id = ?').run(value, id);
  res.json({ ok: true });
});

export default router;
