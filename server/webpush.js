/**
 * Web Push notifications — server side.
 *
 * The old notification system was 100% client-side (Web Notifications API):
 * it only fired while a chat tab was open in the background, and never on
 * phones where the tab gets suspended or closed. This module implements real
 * push: clients subscribe via PushManager, store the subscription here, and
 * the server sends a push whenever a message/mention arrives for that user.
 *
 * VAPID keys come from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
 * VAPID_SUBJECT); dev fallbacks are embedded so local runs work out of the
 * box. In prod, set the secrets and restart.
 */
import webpush from 'web-push';
import { db } from './db.js';

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  'BLA_IdhXG4ry1CLcojk33JtlXohMOy40o88pY-wMQ16wenYAg4HUhrvr45DjjcRbEa2UZmPn2vcxbeHDK4n8ljw';
const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || '0hW1LEJh-9x5Jes6DzpGmAAvhwK4H-HQXRUxbtNUxdE';
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:jimmyqrg@jchat.fly.dev';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

/** Save (or replace) a user's push subscription. */
export function saveSubscription(userId, sub) {
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return false;
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth
  `).run(userId, endpoint, p256dh, auth, Date.now());
  return true;
}

/** Remove a subscription (e.g. on 410/404 from the push service). */
export function deleteSubscription(endpoint) {
  if (!endpoint) return;
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function getSubscriptions(userId) {
  return db.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
  ).all(userId);
}

/** Night check for a stored IANA timezone (22:00–07:00 local). */
function isNightInTimezone(tz) {
  if (!tz) return false; // unknown tz -> don't block (user explicitly enabled)
  try {
    const hour = parseInt(
      new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }),
      10
    );
    return hour >= 22 || hour < 7;
  } catch (_) {
    return false;
  }
}

/**
 * True if this user should receive a push for `trigger` ('dm'|'group'|'mail').
 * Mirrors the client-side shouldShowNotification prefs so closed tabs still
 * respect DND / allow-list / block-list.
 */
export function shouldPushToUser(userId, trigger) {
  const row = db.prepare(`
    SELECT enabled, notify_mails, notify_dm, notify_group, dm_allow_list, dm_block_list, dnd_until, dnd_at_night, dnd_timezone
    FROM user_notification_prefs WHERE user_id = ?
  `).get(userId);
  if (!row || !row.enabled) return false;
  if (trigger === 'mail' && !row.notify_mails) return false;
  if (trigger === 'dm' && !row.notify_dm) return false;
  if (trigger === 'group' && !row.notify_group) return false;
  const now = Date.now();
  if (row.dnd_until && now < row.dnd_until) return false;
  if (row.dnd_at_night && isNightInTimezone(row.dnd_timezone)) return false;
  return true;
}

/** DM-specific allow/block list filtering (caller passes the sender id). */
export function dmAllowedForUser(userId, fromUserId) {
  const row = db.prepare(`
    SELECT dm_allow_list, dm_block_list FROM user_notification_prefs WHERE user_id = ?
  `).get(userId);
  if (!row) return true;
  const allow = row.dm_allow_list ? JSON.parse(row.dm_allow_list) : null;
  const block = row.dm_block_list ? JSON.parse(row.dm_block_list) : null;
  if (allow?.length && !allow.includes(fromUserId)) return false;
  if (block?.length && block.includes(fromUserId)) return false;
  return true;
}

/**
 * Send a push notification to a user. `payload`:
 *   { title, body, url, tag?, data? }
 * Respects prefs via shouldPushToUser. Removes dead subscriptions (410/404).
 */
export async function sendPushToUser(userId, payload) {
  const subs = getSubscriptions(userId);
  if (!subs.length) return;
  const body = JSON.stringify({
    title: payload.title || 'JimmyQrg Chat',
    body: payload.body || '',
    url: payload.url || '/chat/group/',
    tag: payload.tag || null,
    data: payload.data || {},
    ts: Date.now(),
  });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 86400 } // 24h: push survives a closed tab
      );
    } catch (err) {
      const status = err?.statusCode;
      // 404/410 = subscription gone; drop it so we stop burning attempts.
      if (status === 404 || status === 410) {
        deleteSubscription(sub.endpoint);
      } else {
        console.error(`[webpush] send failed (${status || err.message}):`, sub.endpoint.slice(0, 60));
      }
    }
  }
}

/** Convenience: send to everyone in the group except excludedIds. */
export function sendPushToGroup({ title, body, url, tag, data, excludeIds = [] }) {
  const excluded = new Set(excludeIds);
  const users = db.prepare(
    "SELECT id FROM users WHERE deleted_at IS NULL AND id != 'helper'"
  ).all();
  for (const u of users) {
    if (excluded.has(u.id)) continue;
    if (!shouldPushToUser(u.id, 'group')) continue;
    sendPushToUser(u.id, { title, body, url, tag, data }).catch(() => {});
  }
}

/**
 * Send a push to a raw subscription object ({endpoint, keys:{p256dh, auth}})
 * — used by the Schoology Flask app (different user store, same machine) via
 * the internal /internal/send-push endpoint. Same TTL + dead-sub cleanup as
 * sendPushToUser.
 */
export async function sendRawPush(subscription, payload) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { ok: false, error: 'invalid subscription' };
  }
  const body = JSON.stringify({
    title: payload.title || 'Schoology Help',
    body: payload.body || '',
    url: payload.url || '/schoology/',
    tag: payload.tag || null,
    data: payload.data || {},
    ts: Date.now(),
  });
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      body,
      { TTL: 86400 }
    );
    return { ok: true };
  } catch (err) {
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      deleteSubscription(subscription.endpoint);
      return { ok: false, status, gone: true };
    }
    console.error(`[webpush] sendRawPush failed (${status || err.message})`);
    return { ok: false, status };
  }
}

const HELPER_USER_ID = 'helper';

function senderLabel(msg) {
  return msg.display_name || msg.username || 'Someone';
}

/**
 * Fire pushes for a freshly-inserted message row (has sender display fields).
 * Call sites: right after the message is broadcast via socket.io.
 * - whisper -> recipient + jimmyqrg (dm trigger)
 * - dm      -> the other conversation participant (dm trigger)
 * - group   -> every non-sender user with group notifications on
 * Helper (Venory) replies are skipped for group (spammy); DM helper replies
 * still notify the human participant.
 */
export function maybePushForMessage(msg) {
  if (!msg) return;
  try {
    const content = (msg.content || '').slice(0, 140);
    const from = senderLabel(msg);

    if (msg.msg_type === 'whisper') {
      const targets = new Set([msg.recipient_user_id, 'jimmyqrg']);
      targets.delete(msg.sender_id);
      for (const uid of targets) {
        if (!uid) continue;
        if (!shouldPushToUser(uid, 'dm')) continue;
        if (!dmAllowedForUser(uid, msg.sender_id)) continue;
        sendPushToUser(uid, {
          title: `${from} (whisper)`,
          body: content,
          url: `/chat/${encodeURIComponent(msg.sender_id)}`,
          tag: `dm:${msg.room_id}`,
          data: { roomType: 'dm', roomId: msg.sender_id, msgId: msg.id },
        }).catch(() => {});
      }
      return;
    }

    if (msg.room_type === 'dm') {
      const conv = db.prepare('SELECT user1_id, user2_id FROM conversations WHERE id = ?').get(msg.room_id);
      if (!conv) return;
      const other = conv.user1_id === msg.sender_id ? conv.user2_id : conv.user1_id;
      if (!other || other === msg.sender_id) return;
      if (!shouldPushToUser(other, 'dm')) return;
      if (!dmAllowedForUser(other, msg.sender_id)) return;
      const title = msg.sender_id === HELPER_USER_ID ? `Venory replied` : `DM from ${from}`;
      sendPushToUser(other, {
        title,
        body: content,
        url: `/chat/${encodeURIComponent(msg.sender_id)}`,
        tag: `dm:${msg.room_id}`,
        data: { roomType: 'dm', roomId: msg.sender_id, msgId: msg.id },
      }).catch(() => {});
      return;
    }

    if (msg.room_type === 'group') {
      if (msg.sender_id === HELPER_USER_ID) return; // Venory replies are group spam
      sendPushToGroup({
        title: from,
        body: content,
        url: '/chat/group/',
        tag: 'group',
        data: { roomType: 'group', roomId: msg.room_id || 'free_chat', msgId: msg.id },
        excludeIds: [msg.sender_id],
      });
    }
  } catch (err) {
    console.error('[webpush] maybePushForMessage error:', err);
  }
}

/** Mention push: send to a mentioned user (group trigger, like inbox). */
export function maybePushForMention(uid, senderName, content, roomType, roomId, messageId) {
  try {
    if (!uid || uid === HELPER_USER_ID) return;
    if (!shouldPushToUser(uid, 'group')) return;
    sendPushToUser(uid, {
      title: `${senderName} mentioned you`,
      body: (content || '').slice(0, 140),
      url: roomType === 'dm' ? `/chat/${encodeURIComponent(roomId)}` : '/chat/group/',
      tag: 'mention',
      data: { roomType, roomId, msgId: messageId },
    }).catch(() => {});
  } catch (err) {
    console.error('[webpush] maybePushForMention error:', err);
  }
}
