import { Router } from 'express';
import { requireAuth, getCurrentUser } from '../auth.js';
import { db } from '../db.js';

const router = Router();

function getPrefs(userId) {
  const row = db.prepare(`
    SELECT enabled, notify_mails, notify_dm, notify_group, dm_allow_list, dm_block_list, dnd_until
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
      dnd_until: null
    };
  }
  return {
    enabled: !!row.enabled,
    notify_mails: !!row.notify_mails,
    notify_dm: !!row.notify_dm,
    notify_group: !!row.notify_group,
    dm_allow_list: row.dm_allow_list ? JSON.parse(row.dm_allow_list) : null,
    dm_block_list: row.dm_block_list ? JSON.parse(row.dm_block_list) : null,
    dnd_until: row.dnd_until
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

  db.prepare(`
    INSERT INTO user_notification_prefs (user_id, enabled, notify_mails, notify_dm, notify_group, dm_allow_list, dm_block_list, dnd_until, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, notify_mails=excluded.notify_mails, notify_dm=excluded.notify_dm,
      notify_group=excluded.notify_group, dm_allow_list=excluded.dm_allow_list, dm_block_list=excluded.dm_block_list,
      dnd_until=excluded.dnd_until, updated_at=excluded.updated_at
  `).run(
    me.id,
    enabled ? 1 : 0,
    notify_mails ? 1 : 0,
    notify_dm ? 1 : 0,
    notify_group ? 1 : 0,
    dm_allow_list ? JSON.stringify(dm_allow_list) : null,
    dm_block_list ? JSON.stringify(dm_block_list) : null,
    dnd_until,
    now
  );

  res.json(getPrefs(me.id));
});

export { getPrefs };
export default router;
