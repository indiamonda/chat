import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

/** All server-stored progress keys use a namespace (the "origin") so one account can hold data
 *  for many apps without collisions. Defaults to 'jimmyqrg' which is where the game library lives. */
const DEFAULT_ORIGIN = 'jimmyqrg';
const DEFAULT_KIND = 'localStorage';
const MAX_VALUE_BYTES = 512 * 1024; // 512 KB per key – plenty for save states, blocks huge abuse
const MAX_KEYS_PER_USER = 4000;

function normalizeOrigin(value) {
  const s = String(value || DEFAULT_ORIGIN).toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 64);
  return s || DEFAULT_ORIGIN;
}

function normalizeKind(value) {
  const s = String(value || DEFAULT_KIND).replace(/[^a-zA-Z0-9_\-:.]/g, '').slice(0, 32);
  return s || DEFAULT_KIND;
}

function normalizeKey(value) {
  const s = String(value || '').slice(0, 512);
  return s;
}

function userKeyCount(userId) {
  const row = db.prepare('SELECT COUNT(*) as c FROM user_saves WHERE user_id = ?').get(userId);
  return row?.c || 0;
}

/** GET /api/saves?origin=jimmyqrg&since=<ms>&kind=localStorage
 *  Returns { items: [{ key, value, kind, updated_at }], server_time }. When `since` is given, only
 *  keys newer than that are returned — suitable for incremental sync. */
router.get('/', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const origin = normalizeOrigin(req.query.origin);
  const kind = req.query.kind ? normalizeKind(req.query.kind) : null;
  const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
  const clauses = ['user_id = ?', 'origin = ?', 'updated_at > ?'];
  const params = [userId, origin, since];
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  const rows = db.prepare(
    `SELECT key, value, kind, updated_at FROM user_saves WHERE ${clauses.join(' AND ')} ORDER BY updated_at ASC`
  ).all(...params);
  res.json({ items: rows, server_time: Date.now(), origin });
});

/** GET /api/saves/one?origin=...&kind=...&key=...  →  single entry or 404. */
router.get('/one', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const origin = normalizeOrigin(req.query.origin);
  const kind = normalizeKind(req.query.kind);
  const key = normalizeKey(req.query.key);
  if (!key) return res.status(400).json({ error: 'key required' });
  const row = db.prepare(
    'SELECT key, value, kind, updated_at FROM user_saves WHERE user_id = ? AND origin = ? AND key = ? AND kind = ?'
  ).get(userId, origin, key, kind);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

/** PUT /api/saves  body: { origin?, kind?, key, value, updated_at? }
 *  Conflict resolution: last-writer-wins by updated_at (client may pass its write time). */
router.put('/', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const body = req.body || {};
  const origin = normalizeOrigin(body.origin);
  const kind = normalizeKind(body.kind);
  const key = normalizeKey(body.key);
  if (!key) return res.status(400).json({ error: 'key required' });
  const value = body.value == null ? '' : String(body.value);
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    return res.status(413).json({ error: `value too large (limit ${MAX_VALUE_BYTES} bytes)` });
  }
  const clientTime = Number.isFinite(Number(body.updated_at)) ? Number(body.updated_at) : Date.now();
  const updatedAt = Math.min(clientTime, Date.now() + 60000);
  const existing = db.prepare('SELECT updated_at FROM user_saves WHERE user_id = ? AND origin = ? AND key = ? AND kind = ?').get(userId, origin, key, kind);
  if (!existing && userKeyCount(userId) >= MAX_KEYS_PER_USER) {
    return res.status(507).json({ error: 'save quota exceeded' });
  }
  if (existing && existing.updated_at > updatedAt) {
    return res.json({ ok: true, skipped: true, updated_at: existing.updated_at });
  }
  db.prepare(`
    INSERT INTO user_saves (user_id, origin, key, value, kind, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, origin, key, kind) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(userId, origin, key, value, kind, updatedAt);
  res.json({ ok: true, updated_at: updatedAt });
});

/** DELETE /api/saves?origin=...&kind=...&key=...   Or pass `all=1` to drop every key in origin/kind. */
router.delete('/', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const origin = normalizeOrigin(req.query.origin);
  const kind = req.query.kind ? normalizeKind(req.query.kind) : null;
  if (req.query.all === '1' || req.query.all === 'true') {
    if (kind) {
      db.prepare('DELETE FROM user_saves WHERE user_id = ? AND origin = ? AND kind = ?').run(userId, origin, kind);
    } else {
      db.prepare('DELETE FROM user_saves WHERE user_id = ? AND origin = ?').run(userId, origin);
    }
    return res.json({ ok: true });
  }
  const key = normalizeKey(req.query.key);
  if (!key) return res.status(400).json({ error: 'key required (or pass all=1)' });
  db.prepare('DELETE FROM user_saves WHERE user_id = ? AND origin = ? AND key = ? AND kind = ?').run(userId, origin, key, kind || DEFAULT_KIND);
  res.json({ ok: true });
});

/** POST /api/saves/bulk  body: { origin?, items: [{key, value, kind?, updated_at?}] }
 *  Bulk upsert. Used by the client for first-login migration of existing localStorage. */
router.post('/bulk', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const origin = normalizeOrigin(req.body?.origin);
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items array required' });
  if (items.length > 2000) return res.status(413).json({ error: 'too many items (max 2000 per bulk)' });
  const now = Date.now();
  let accepted = 0;
  let skipped = 0;
  let rejected = 0;
  const upsert = db.prepare(`
    INSERT INTO user_saves (user_id, origin, key, value, kind, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, origin, key, kind) DO UPDATE SET
      value = CASE WHEN excluded.updated_at >= user_saves.updated_at THEN excluded.value ELSE user_saves.value END,
      updated_at = CASE WHEN excluded.updated_at >= user_saves.updated_at THEN excluded.updated_at ELSE user_saves.updated_at END
  `);
  const existingCount = userKeyCount(userId);
  let remaining = MAX_KEYS_PER_USER - existingCount;
  const tx = db.transaction((list) => {
    for (const item of list) {
      const key = normalizeKey(item?.key);
      if (!key) { rejected++; continue; }
      const value = item?.value == null ? '' : String(item.value);
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) { rejected++; continue; }
      const kind = normalizeKind(item?.kind);
      const exists = db.prepare('SELECT 1 FROM user_saves WHERE user_id = ? AND origin = ? AND key = ? AND kind = ?').get(userId, origin, key, kind);
      if (!exists) {
        if (remaining <= 0) { skipped++; continue; }
        remaining--;
      }
      const clientTime = Number.isFinite(Number(item?.updated_at)) ? Number(item.updated_at) : now;
      upsert.run(userId, origin, key, value, kind, Math.min(clientTime, now + 60000));
      accepted++;
    }
  });
  tx(items);
  res.json({ ok: true, accepted, skipped, rejected, total: items.length });
});

/** Convenience for debug/dev: how many keys/bytes does the current user have stored? */
router.get('/stats', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const origin = req.query.origin ? normalizeOrigin(req.query.origin) : null;
  const where = origin ? 'user_id = ? AND origin = ?' : 'user_id = ?';
  const params = origin ? [userId, origin] : [userId];
  const row = db.prepare(
    `SELECT COUNT(*) as keys, COALESCE(SUM(LENGTH(value)), 0) as bytes, MAX(updated_at) as last FROM user_saves WHERE ${where}`
  ).get(...params);
  res.json({ keys: row?.keys || 0, bytes: row?.bytes || 0, last_updated: row?.last || null, max_keys: MAX_KEYS_PER_USER, max_value_bytes: MAX_VALUE_BYTES });
});

export default router;
