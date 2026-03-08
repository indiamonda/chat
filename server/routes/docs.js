import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth, getCurrentUser, canEditDocs } from '../auth.js';
import { db } from '../db.js';

const router = Router();
const EDITABLE_DOCS = ['problem_solving', 'rules', 'announcements'];

const PORTAL_ANNOUNCEMENT_URL = 'https://jimmyqrg.github.io/?directly=1';

/** Parse "Latest updates" and "History" list items from portal announcement HTML. Returns array of item strings (e.g. "Added Stickman Arena"). */
function parsePortalAnnouncementItems(html) {
  const items = [];
  const latestMatch = html.match(/✨\s*Latest updates:[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
  if (latestMatch) {
    const lis = latestMatch[1].match(/<li>([\s\S]*?)<\/li>/g) || [];
    lis.forEach(li => items.push(li.replace(/<\/?li>/g, '').replace(/<[^>]+>/g, '').trim()));
  }
  const historyMatch = html.match(/⏱️\s*History[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
  if (historyMatch) {
    const lis = historyMatch[1].match(/<li>([\s\S]*?)<\/li>/g) || [];
    lis.forEach(li => items.push(li.replace(/<\/?li>/g, '').replace(/<b>|<\/b>/gi, '**').replace(/<[^>]+>/g, '').trim()));
  }
  return items.filter(Boolean);
}

/** Extract items from jchat's latest announcement entry. E.g. "**MM/DD/YYYY** Added Amenda, Potato." -> ["Amenda", "Potato"]. */
function parseJchatLatestItems(content) {
  const title = '# Announcements';
  let rest = content.startsWith(title) ? content.slice(title.length).trim() : content.trim();
  if (!rest) return [];
  const firstEntry = rest.split(/\n\n+/)[0] || rest.split('\n')[0] || '';
  const addedMatch = firstEntry.match(/\*\*[\d/]+\*\*\s*(?:Added\s+)?([^.]+)/i);
  if (!addedMatch) return [];
  const list = addedMatch[1].replace(/^Added\s+/i, '').replace(/\.$/, '').trim();
  return list.split(',').map(s => s.trim()).filter(Boolean);
}

/** Check if portal item matches any jchat item. E.g. "Added Amenda the Adventurer" matches jchat "Amenda". */
function itemMatches(portalItem, jchatItems) {
  const content = portalItem.replace(/^(Added|Updated|Fixed)\s+/i, '').trim().toLowerCase();
  const firstWord = content.split(/\s+/)[0] || '';
  return jchatItems.some(j => {
    const jn = j.toLowerCase().trim();
    return content.includes(jn) || jn.includes(firstWord) || jn.includes(content);
  });
}

/** Sync announcements doc with portal: only add NEW items not already in jchat. */
router.post('/announcements/sync', requireAuth, async (req, res) => {
  const user = getCurrentUser(req);
  if (!canEditDocs(user)) return res.status(403).json({ error: 'Not allowed to edit' });
  try {
    const resp = await fetch(PORTAL_ANNOUNCEMENT_URL, { headers: { 'User-Agent': 'JimmyQrg-Chat-Sync/1' } });
    const html = await resp.text();
    const portalItems = parsePortalAnnouncementItems(html);
    if (!portalItems.length) return res.json({ synced: false, reason: 'no_content' });

    const row = db.prepare(`
      SELECT id, content FROM doc_versions WHERE doc_key = 'announcements' ORDER BY created_at DESC LIMIT 1
    `).get();
    const currentContent = row?.content || '';
    const jchatItems = parseJchatLatestItems(currentContent);

    const newItems = portalItems.filter(p => !itemMatches(p, jchatItems));
    if (!newItems.length) return res.json({ synced: false, reason: 'already_present' });

    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = now.getFullYear();
    const dateLine = `**${mm}/${dd}/${yyyy}**`;
    const newEntry = `${dateLine} ${newItems.join(', ')}`;

    const title = '# Announcements\n\n';
    const rest = currentContent.startsWith(title) ? currentContent.slice(title.length) : currentContent;
    const updatedContent = title + newEntry + '\n\n' + rest;

    const id = randomUUID();
    const created = Date.now();
    db.prepare('INSERT INTO doc_versions (id, doc_key, content, editor_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'announcements', updatedContent, user.id, created);
    res.json({ synced: true, version_id: id, created_at: created });
  } catch (err) {
    console.error('Announcements sync error:', err);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

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
