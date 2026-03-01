import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, canSendInbox, canBroadcast } from '../auth.js';
import { db, GROUP_ID } from '../db.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const rows = db.prepare(`
    SELECT id, type, title, body, related_id, related_extra, read_at, created_at
    FROM inbox
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(user.id);
  res.json({ items: rows });
});

router.post('/:id/read', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  db.prepare('UPDATE inbox SET read_at = ? WHERE id = ? AND user_id = ?').run(Date.now(), req.params.id, user.id);
  res.json({ ok: true });
});

// Authorized only: send to one user's inbox
router.post('/send', requireAuth, (req, res) => {
  const from = getCurrentUser(req);
  if (!canSendInbox(from)) return res.status(403).json({ error: 'Not allowed' });
  const { to_user_id, title, body, type, related_id, related_extra } = req.body || {};
  if (!to_user_id) return res.status(400).json({ error: 'to_user_id required' });
  const id = randomUUID();
  db.prepare(`
    INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, to_user_id, type || 'custom', title || '', body || '', related_id || null, related_extra ? JSON.stringify(related_extra) : null, Date.now());
  res.json({ id });
});

// Authorized only: send to all users' inbox
router.post('/broadcast', requireAuth, (req, res) => {
  const from = getCurrentUser(req);
  if (!canBroadcast(from)) return res.status(403).json({ error: 'Not allowed' });
  const { title, body } = req.body || {};
  const users = db.prepare('SELECT id FROM users').all();
  const id = randomUUID();
  const insert = db.prepare(`
    INSERT INTO inbox (id, user_id, type, title, body, created_at) VALUES (?, ?, 'broadcast', ?, ?, ?)
  `);
  for (const u of users) {
    insert.run(randomUUID(), u.id, title || 'Announcement', body || '', Date.now());
  }
  res.json({ ok: true });
});

export default router;
