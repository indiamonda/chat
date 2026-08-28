import { Router } from 'express';
import { requireAuth, getCurrentUser } from '../auth.js';
import { db } from '../db.js';
import { saveSubscription, deleteSubscription, getVapidPublicKey } from '../webpush.js';

const router = Router();

function getPrefs(userId) {
  const row = db.prepare(`
    SELECT enabled, notify_mails, notify_dm, notify_group, dm_allow_list, dm_block_list, dnd_until, dnd_at_night, dnd_timezone
    FROM user_notification_prefs WHERE user_id = ?
  `).get(userId);
  if (!row) {
    return {
      enabled: false,
      notify_mails: true,
      notify_dm: true,
      notify_group: true,
      dm_allow_list: null,
      dm_block_list: null,
      dnd_until: null,
      dnd_at_night: false,
      dnd_timezone: null
    };
  }
  return {
    enabled: !!row.enabled,
    notify_mails: !!row.notify_mails,
    notify_dm: !!row.notify_dm,
    notify_group: !!row.notify_group,
    dm_allow_list: row.dm_allow_list ? JSON.parse(row.dm_allow_list) : null,
    dm_block_list: row.dm_block_list ? JSON.parse(row.dm_block_list) : null,
    dnd_until: row.dnd_until,
    dnd_at_night: !!(row.dnd_at_night ?? 0),
    dnd_timezone: row.dnd_timezone || null
  };
}

/** GET /api/notifications/prefs */
router.get('/prefs', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  res.json(getPrefs(me.id));
});

/** PATCH /api/notifications/prefs */
router.patch('/prefs', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const body = req.body || {};
  const now = Date.now();
  const current = getPrefs(me.id);

  const enabled = body.enabled !== undefined ? !!body.enabled : current.enabled;
  const notify_mails = body.notify_mails !== undefined ? !!body.notify_mails : current.notify_mails;
  const notify_dm = body.notify_dm !== undefined ? !!body.notify_dm : current.notify_dm;
  const notify_group = body.notify_group !== undefined ? !!body.notify_group : current.notify_group;
  const dm_allow_list = body.dm_allow_list !== undefined
    ? (Array.isArray(body.dm_allow_list) ? body.dm_allow_list : null)
    : current.dm_allow_list;
  const dm_block_list = body.dm_block_list !== undefined
    ? (Array.isArray(body.dm_block_list) ? body.dm_block_list : null)
    : current.dm_block_list;
  const dnd_until = body.dnd_until !== undefined ? (body.dnd_until != null ? body.dnd_until : null) : current.dnd_until;
  const dnd_at_night = body.dnd_at_night !== undefined ? !!body.dnd_at_night : current.dnd_at_night;
  const dnd_timezone = body.dnd_timezone !== undefined ? (body.dnd_timezone || null) : current.dnd_timezone;

  db.prepare(`
    INSERT INTO user_notification_prefs (user_id, enabled, notify_mails, notify_dm, notify_group, dm_allow_list, dm_block_list, dnd_until, dnd_at_night, dnd_timezone, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, notify_mails=excluded.notify_mails, notify_dm=excluded.notify_dm,
      notify_group=excluded.notify_group, dm_allow_list=excluded.dm_allow_list, dm_block_list=excluded.dm_block_list,
      dnd_until=excluded.dnd_until, dnd_at_night=excluded.dnd_at_night, dnd_timezone=excluded.dnd_timezone, updated_at=excluded.updated_at
  `).run(
    me.id,
    enabled ? 1 : 0,
    notify_mails ? 1 : 0,
    notify_dm ? 1 : 0,
    notify_group ? 1 : 0,
    dm_allow_list ? JSON.stringify(dm_allow_list) : null,
    dm_block_list ? JSON.stringify(dm_block_list) : null,
    dnd_until,
    dnd_at_night ? 1 : 0,
    dnd_timezone,
    now
  );

  res.json(getPrefs(me.id));
});

/** GET /api/notifications/vapid-public-key — needed by the client to subscribe. */
router.get('/vapid-public-key', requireAuth, (req, res) => {
  res.json({ key: getVapidPublicKey() });
});

/** POST /api/notifications/subscribe — store a PushManager subscription. */
router.post('/subscribe', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const ok = saveSubscription(me.id, req.body || {});
  if (!ok) return res.status(400).json({ error: 'Invalid subscription' });
  res.json({ ok: true });
});

/** POST /api/notifications/unsubscribe — remove a PushManager subscription. */
router.post('/unsubscribe', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const endpoint = req.body?.endpoint;
  if (endpoint) {
    // Only delete if it belongs to this user.
    const owned = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').get(me.id, endpoint);
    if (owned) deleteSubscription(endpoint);
  }
  res.json({ ok: true });
});

export { getPrefs };
export default router;
