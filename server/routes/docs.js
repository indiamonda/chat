import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, canEditDocs } from '../auth.js';
import { db } from '../db.js';

const router = Router();
const EDITABLE_DOCS = ['problem_solving', 'rules'];

router.get('/:docKey', requireAuth, (req, res) => {
  const { docKey } = req.params;
  if (!EDITABLE_DOCS.includes(docKey)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(`
    SELECT id, content, editor_id, created_at
    FROM doc_versions
    WHERE doc_key = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(docKey);
  res.json({ doc: row ? { content: row.content, version_id: row.id, editor_id: row.editor_id, created_at: row.created_at } : { content: '', version_id: null } });
});

router.put('/:docKey', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  if (!canEditDocs(user)) return res.status(403).json({ error: 'Not allowed to edit' });
  const { docKey } = req.params;
  if (!EDITABLE_DOCS.includes(docKey)) return res.status(404).json({ error: 'Not found' });
  const { content, support_message_id } = req.body || {};
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO doc_versions (id, doc_key, content, editor_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, docKey, typeof content === 'string' ? content : '', user.id, now);
  if (docKey === 'problem_solving' && support_message_id) {
    const msg = db.prepare('SELECT id, sender_id FROM messages WHERE id = ? AND room_type = ? AND room_id = ?').get(support_message_id, 'group', 'support');
    if (msg && msg.sender_id !== user.id) {
      const inboxId = randomUUID();
      db.prepare(`
        INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at)
        VALUES (?, ?, 'solved', 'Your problem is solved', 'A solution has been added to Problem Solving.', ?, ?, ?)
      `).run(inboxId, msg.sender_id, id, JSON.stringify({ panel: 'problem_solving', version_id: id, support_message_id }), now);
    }
  }
  res.json({ version_id: id, created_at: now });
});

router.get('/:docKey/versions', requireAuth, (req, res) => {
  const { docKey } = req.params;
  if (!EDITABLE_DOCS.includes(docKey)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(`
    SELECT id, content, editor_id, created_at
    FROM doc_versions
    WHERE doc_key = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(docKey);
  res.json({ versions: rows });
});

export default router;
