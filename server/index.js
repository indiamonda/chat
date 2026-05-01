import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync, rmSync as fsRm } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { sessionMiddleware, touchSession, getCurrentUser, requireAuth, canRecallOrEdit, canSendInbox, canBroadcast, canEditDocs, canKick, canDeleteMessages, canTimeout, canUnlimitedEditRecall, tokenAuthMiddleware } from './auth.js';
import { db, GROUP_ID, PANELS, isBlacklisted, isUserDeleted } from './db.js';
import { upload } from './upload.js';
import { getUploadUrl, getFileRef } from './upload.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import docsRoutes, { syncAnnouncementsFromPortal } from './routes/docs.js';
import inboxRoutes from './routes/inbox.js';
import adminRoutes from './routes/admin.js';
import friendsRoutes, { areFriends } from './routes/friends.js';
import blocksRoutes, { isBlocked } from './routes/blocks.js';
import notificationsRoutes, { getPrefs as getNotificationPrefs } from './routes/notifications.js';
import savesRoutes from './routes/saves.js';
import reportsRoutes from './routes/reports.js';
import { recordAuditLog } from './audit.js';
import { recordUploadRef, markUploadOrphan } from './uploads-tracker.js';
import { findMentionUserIds, MENTION_INCLUDES_ALL_RE, MENTION_INCLUDES_ADMINS_RE } from './mentions.js';
import { randomUUID } from 'node:crypto';
import tzLookup from 'tz-lookup';

/** Anti-spam: if user sent 2+ same messages in a short window, block for 5s. jimmyqrg excluded. */
const SPAM_INTERVAL_MS = 10000;
const SPAM_COOLDOWN_MS = 5000;
const spamBlockedUntil = new Map();
const DEFAULT_MESSAGE_PAGE_SIZE = 30;
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥']);

function checkSpam(userId, roomType, roomId, content) {
  if (userId === 'jimmyqrg') return false;
  const now = Date.now();
  if (spamBlockedUntil.get(userId) > now) return true;
  const lastTwo = db.prepare(`
    SELECT content, created_at FROM messages
    WHERE room_type = ? AND room_id = ? AND sender_id = ? AND deleted_by_admin = 0
    ORDER BY created_at DESC LIMIT 2
  `).all(roomType, roomId, userId);
  if (lastTwo.length < 2) return false;
  const sameContent = lastTwo.every((m) => m.content === content);
  const oldestAt = lastTwo[lastTwo.length - 1].created_at;
  if (sameContent && now - oldestAt <= SPAM_INTERVAL_MS) {
    spamBlockedUntil.set(userId, now + SPAM_COOLDOWN_MS);
    return true;
  }
  return false;
}

function normalizePageLimit(value) {
  return Math.min(parseInt(value, 10) || DEFAULT_MESSAGE_PAGE_SIZE, 100);
}

function getLikeMap(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT message_id, COUNT(*) as c
    FROM message_likes
    WHERE message_id IN (${placeholders})
    GROUP BY message_id
  `).all(...messageIds);
  return Object.fromEntries(rows.map((row) => [row.message_id, row.c]));
}

function getReactionMap(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT message_id, emoji, COUNT(*) as c
    FROM message_reactions
    WHERE message_id IN (${placeholders})
    GROUP BY message_id, emoji
    ORDER BY message_id, emoji
  `).all(...messageIds);
  const out = {};
  rows.forEach((row) => {
    if (!out[row.message_id]) out[row.message_id] = [];
    out[row.message_id].push({ emoji: row.emoji, count: row.c });
  });
  return out;
}

function getReplyTargetMap(replyIds) {
  if (!replyIds.length) return {};
  const placeholders = replyIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT m.id, m.content, m.msg_type, m.sender_id, m.recalled_at, m.deleted_by_admin,
           u.username, u.display_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id IN (${placeholders})
  `).all(...replyIds);
  const out = {};
  for (const row of rows) {
    const isRecalled = !!row.recalled_at;
    const isDeleted = !!row.deleted_by_admin;
    let snippet = '';
    if (isRecalled) snippet = '[recalled message]';
    else if (isDeleted) snippet = '[deleted by admin]';
    else if (row.msg_type && row.msg_type !== 'text') snippet = `[${row.msg_type}]`;
    else snippet = (row.content || '').slice(0, 160);
    out[row.id] = {
      id: row.id,
      sender_id: row.sender_id,
      sender_username: row.username || null,
      sender_display_name: row.display_name || row.username || null,
      msg_type: row.msg_type || 'text',
      content: snippet,
      recalled: isRecalled,
      deleted: isDeleted,
    };
  }
  return out;
}

function decorateMessages(rows) {
  const messageIds = rows.map((row) => row.id);
  const likeMap = getLikeMap(messageIds);
  const reactionMap = getReactionMap(messageIds);
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
  const replyMap = getReplyTargetMap(replyIds);
  return rows.map((row) => ({
    ...row,
    likes: likeMap[row.id] || 0,
    reactions: reactionMap[row.id] || [],
    edit_history: row.edit_history ? JSON.parse(row.edit_history) : null,
    reply_to: row.reply_to_id ? (replyMap[row.reply_to_id] || null) : null,
  }));
}

function parseFlexibleDate(dateText, endOfRange = false) {
  if (!dateText) return null;
  const match = String(dateText).trim().match(/^(\d{4})(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) - 1 : (endOfRange ? 11 : 0);
  const day = match[3] ? Number(match[3]) : (endOfRange ? new Date(year, month + 1, 0).getDate() : 1);
  const d = new Date(year, month, day, endOfRange ? 23 : 0, endOfRange ? 59 : 0, endOfRange ? 59 : 0, endOfRange ? 999 : 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function parseSearchFilter(filterText) {
  const text = String(filterText || '').trim();
  const spec = { after: null, before: null, includeUsers: [], excludeUsers: [] };
  if (!text) return spec;
  const lowered = text.toLowerCase();

  const senderClause = text.match(/(?:from|by)\s*:\s*([@\w,\s-]+)/i);
  if (senderClause) {
    spec.includeUsers = senderClause[1].split(',').map((v) => v.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  }
  const excludeClause = text.match(/(?:not|exclude)\s*:\s*([@\w,\s-]+)/i);
  if (excludeClause) {
    spec.excludeUsers = excludeClause[1].split(',').map((v) => v.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  }

  const range = text.match(/(\d{4}(?:\/\d{1,2})?(?:\/\d{1,2})?)\s*~\s*(\d{4}(?:\/\d{1,2})?(?:\/\d{1,2})?)/);
  if (range) {
    spec.after = parseFlexibleDate(range[1], false);
    spec.before = parseFlexibleDate(range[2], true);
    return spec;
  }

  const after = text.match(/(?:after\s+|)(\d{4}(?:\/\d{1,2})?(?:\/\d{1,2})?)\s+after|after\s+(\d{4}(?:\/\d{1,2})?(?:\/\d{1,2})?)/i);
  if (after) spec.after = parseFlexibleDate(after[1] || after[2], false);
  const before = text.match(/(?:before\s+|)(\d{4}(?:\/\d{1,2})?(?:\/\d{1,2})?)\s+before|before\s+(\d{4}(?:\/\d{1,2})?(?:\/\d{1,2})?)/i);
  if (before) spec.before = parseFlexibleDate(before[1] || before[2], true);

  const relative = lowered.match(/in\s+(\d+)\s+(minute|minutes|day|days|month|months|year|years)/);
  if (relative) {
    const amount = Number(relative[1]);
    const now = Date.now();
    const unitMs = relative[2].startsWith('minute') ? 60 * 1000
      : relative[2].startsWith('day') ? 24 * 60 * 60 * 1000
      : relative[2].startsWith('month') ? 30 * 24 * 60 * 60 * 1000
      : 365 * 24 * 60 * 60 * 1000;
    spec.after = now - (amount * unitMs);
  } else if (lowered.includes('in this year')) {
    spec.after = parseFlexibleDate(`${new Date().getFullYear()}`, false);
    spec.before = parseFlexibleDate(`${new Date().getFullYear()}`, true);
  } else if (lowered.includes('in this month')) {
    const now = new Date();
    spec.after = parseFlexibleDate(`${now.getFullYear()}/${now.getMonth() + 1}`, false);
    spec.before = parseFlexibleDate(`${now.getFullYear()}/${now.getMonth() + 1}`, true);
  } else {
    const inYear = lowered.match(/in\s+(\d{4})(?:\/(\d{1,2}))?/);
    if (inYear) {
      const token = inYear[2] ? `${inYear[1]}/${inYear[2]}` : inYear[1];
      spec.after = parseFlexibleDate(token, false);
      spec.before = parseFlexibleDate(token, true);
    }
  }
  return spec;
}

function applySearchFilters(rows, filterSpec) {
  let filtered = rows;
  if (filterSpec.after != null) filtered = filtered.filter((row) => (row.created_at || 0) >= filterSpec.after);
  if (filterSpec.before != null) filtered = filtered.filter((row) => (row.created_at || 0) <= filterSpec.before);
  if (filterSpec.includeUsers?.length) {
    const include = new Set(filterSpec.includeUsers);
    filtered = filtered.filter((row) => include.has(String(row.username || '').toLowerCase()));
  }
  if (filterSpec.excludeUsers?.length) {
    const exclude = new Set(filterSpec.excludeUsers);
    filtered = filtered.filter((row) => !exclude.has(String(row.username || '').toLowerCase()));
  }
  return filtered;
}

function createInboxForNewMessage(messageId, content, replyToId, senderId, roomType, roomId) {
  if (roomId === 'voice_chat') return;
  const toNotify = findMentionUserIds(content, senderId);
  for (const uid of [...toNotify]) {
    if (isBlocked(uid, senderId)) toNotify.delete(uid);
  }
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  toNotify.forEach(uid => {
    insert.run(randomUUID(), uid, 'mention', 'New mention', (content || '').slice(0, 200), messageId, JSON.stringify({ roomType, roomId }), now);
    try {
      const io = app.get('io');
      io?.to(`user:${uid}`).emit('inbox:item', { id: randomUUID(), type: 'mention', title: 'New mention', body: (content || '').slice(0, 200), related_id: messageId, related_extra: { roomType, roomId }, created_at: now });
    } catch (_) {}
  });
  if (replyToId) {
    const orig = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(replyToId);
    if (orig && orig.sender_id !== senderId) {
      db.prepare(`
        INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at) VALUES (?, ?, 'reply', 'New reply', ?, ?, ?, ?)
      `).run(randomUUID(), orig.sender_id, (content || '').slice(0, 200), messageId, JSON.stringify({ roomType, roomId, reply_to_id: replyToId }), now);
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../data');
const uploadsDir = join(dataDir, 'uploads');
const publicDir = join(__dirname, '../public');

const app = express();
const httpServer = createServer(app);

app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/** CORS for cross-origin clients (game pages on jimmyqrg.github.io, etc.). Credentials are
 *  allowed so browsers that still accept the chat session cookie cross-site get a session;
 *  Bearer tokens work for the rest. The allow-list is permissive: the chat API is read/write
 *  only after requireAuth anyway, and tokens are long random strings. */
const CORS_ALLOW_LIST = new Set([
  'https://jimmyqrg.github.io',
  'https://www.jimmyqrg.github.io',
  'https://jchat.fly.dev',
  'https://mcraft.fly.dev',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = CORS_ALLOW_LIST.has(origin)
      || /^https?:\/\/localhost(?::\d+)?$/i.test(origin)
      || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)
      || /^https?:\/\/.+\.github\.io$/i.test(origin)
      || /^https?:\/\/.+\.jimmyqrg\.com$/i.test(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token, X-Requested-With');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve assets and uploads before session so static requests never trigger session/DB errors or 500
app.use('/assets', express.static(join(publicDir, 'assets'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  },
}));
app.use('/uploads', express.static(uploadsDir));

const session = sessionMiddleware();
app.use((req, res, next) => {
  session(req, res, (err) => {
    if (err) {
      console.error('Session middleware error:', err);
      // Stub session with no-op save/destroy/touch so routes and res.end() don't throw
      req.session = {
        save: (cb) => { if (typeof cb === 'function') cb(); },
        destroy: (cb) => { if (typeof cb === 'function') cb(); },
        touch: () => {}
      };
      touchSession(req, res, next);
      return;
    }
    touchSession(req, res, next);
  });
});
app.use(tokenAuthMiddleware);

// Serve SPA HTML with cache-busting for all document routes (before static so "/" gets it too)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/redirect.html' || req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path.startsWith('/uploads') || req.path.startsWith('/socket.io')) return next();
  try {
    const p = join(publicDir, 'index.html');
    if (!existsSync(p)) return next();
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const frameAncestors = process.env.ALLOW_IFRAME === 'false' ? "'self'" : '*';
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.google.com https://www.grecaptcha.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://www.gstatic.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' wss: https:; frame-src 'self' https://www.google.com https://www.recaptcha.net https://www.grecaptcha.com https://jimmyqrg.github.io; frame-ancestors ${frameAncestors};`);
    const version = process.env.ASSET_VERSION || Date.now();
    const html = readFileSync(p, 'utf8').replace(/\?v=\d+/g, `?v=${version}`);
    return res.type('html').send(html);
  } catch (err) {
    console.error('SPA serve error:', err);
    next(err);
  }
});

app.use(express.static(publicDir));

/** Public config for client (e.g. reCAPTCHA site key). */
app.get('/api/config', (req, res) => {
  res.json({
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
    allowIframe: process.env.ALLOW_IFRAME !== 'false',
  });
});

/** List available chatbox styles by scanning the chatboxes directory. */
app.get('/api/chatbox-styles', (req, res) => {
  const dir = join(publicDir, 'assets', 'chatboxes');
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const styles = entries
      .filter(e => e.isDirectory() && e.name !== 'default-old')
      .map(e => {
        const jsonPath = join(dir, e.name, 'chatbox.json');
        if (!existsSync(jsonPath)) return null;
        try {
          const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
          return { id: e.name, name: meta.name || e.name, type: meta.type || 'svg', tail: meta.tail === 'true' || meta.tail === true, author: meta.author || null, description: meta.description || null };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ styles });
  } catch {
    res.json({ styles: [] });
  }
});

// Collections: saved messages per user
app.get('/api/collections', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const rows = db.prepare(`
    SELECT c.id, c.message_id, c.room_type, c.room_id, c.sender_id, c.sender_username, c.sender_display_name,
           c.content_snapshot, c.msg_type, c.message_created_at, c.created_at
    FROM message_collections c
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(user.id);
  res.json({ items: rows });
});

app.post('/api/collections', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const { message_id } = req.body || {};
  if (!message_id) return res.status(400).json({ error: 'message_id required' });
  const msg = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.created_at,
           u.username, u.display_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ? AND m.deleted_by_admin = 0
  `).get(message_id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO message_collections (id, user_id, message_id, room_type, room_id, sender_id,
      sender_username, sender_display_name, content_snapshot, msg_type, message_created_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user.id,
    msg.id,
    msg.room_type,
    msg.room_id,
    msg.sender_id,
    msg.username || null,
    msg.display_name || null,
    msg.content || '',
    msg.msg_type || 'text',
    msg.created_at,
    now
  );
  res.status(201).json({ ok: true, id });
});

app.delete('/api/collections/:id', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  db.prepare('DELETE FROM message_collections WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/blocks', blocksRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/saves', savesRoutes);
app.use('/api/reports', reportsRoutes);

/** Active timeouts for the signed-in user (used by client UI to show hints). */
app.get('/api/my/timeouts', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const now = Date.now();
  const rows = db.prepare(`
    SELECT id, scope, expires_at, locked_release, created_at
    FROM group_timeouts
    WHERE user_id = ? AND released_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
  `).all(user.id, now);
  res.json({ timeouts: rows });
});

/** Link preview: fetch URL and return og:title, og:description, og:image. Requires auth. */
app.get('/api/link-preview', requireAuth, async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'JimmyQrg-Chat-Preview/1' },
      redirect: 'follow'
    });
    clearTimeout(timeout);
    const html = await resp.text();
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    const desc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1]
      || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
    const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
    res.json({ title: title || null, description: desc || null, image: image || null, url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch preview' });
  }
});

/** Timezone from coordinates (for DND at night). Requires auth. */
app.get('/api/timezone', requireAuth, (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid lat/lng' });
  }
  try {
    const tz = tzLookup(lat, lng);
    res.json({ timezone: tz || null });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Timezone lookup failed' });
  }
});

/** Geocode city/address to coordinates (for DND at night). Requires auth. Uses Nominatim. */
app.get('/api/geocode', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'JimmyQrg-Chat-DND/1' }
    });
    clearTimeout(timeout);
    const data = await resp.json();
    const first = Array.isArray(data) ? data[0] : null;
    if (!first || first.lat == null || first.lon == null) {
      return res.json({ lat: null, lon: null });
    }
    res.json({ lat: parseFloat(first.lat), lon: parseFloat(first.lon) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Geocode failed' });
  }
});

app.get('/api/group', requireAuth, (req, res) => {
  res.json({ id: GROUP_ID, panels: PANELS });
});

app.get('/api/voice/participants', requireAuth, (req, res) => {
  res.json({ participants: getVoiceParticipantList() });
});

app.get('/api/rooms/:roomType/:roomId/pinned', requireAuth, (req, res) => {
  const { roomType, roomId } = req.params;
  const row = db.prepare(`
    SELECT p.message_id, p.pinned_by, p.pinned_at, m.sender_id, m.content, m.msg_type, m.created_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM pinned_messages p
    JOIN messages m ON m.id = p.message_id
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE p.room_type = ? AND p.room_id = ? AND m.deleted_by_admin = 0 AND m.recalled_at IS NULL
  `).get(roomType, roomId);
  res.json({ pinned: row || null });
});

app.get('/api/rooms/:roomType/:roomId/messages', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const { roomType, roomId } = req.params;
  if (roomType === 'group' && isBlacklisted(user.id)) {
    return res.status(403).json({ error: 'Access denied. You are blacklisted from group chat.' });
  }
  const limit = normalizePageLimit(req.query.limit);
  const before = req.query.before ? parseInt(req.query.before, 10) : Date.now();
  const blockedIds = db.prepare('SELECT blocked_id FROM blocked_users WHERE user_id = ?').all(user.id).map(r => r.blocked_id);
  const rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = ? AND m.room_id = ? AND m.created_at < ? AND m.deleted_by_admin = 0
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(roomType, roomId, before, (limit + 1) * (blockedIds.length ? 2 : 1));
  const filtered = blockedIds.length ? rows.filter(r => !blockedIds.includes(r.sender_id)) : rows;
  const hasMore = filtered.length > limit;
  const limited = filtered.slice(0, limit);
  const out = decorateMessages(limited.reverse());
  res.json({ messages: out, has_more: hasMore });
});

app.post('/api/rooms/:roomType/:roomId/messages', requireAuth, upload.single('file'), (req, res) => {
  const user = getCurrentUser(req);
  if (!user) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { roomType, roomId } = req.params;
  if (roomType === 'group') {
    if (isBlacklisted(user.id)) {
      if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
      return res.status(403).json({ error: 'Access denied. You are blacklisted from group chat.' });
    }
    if (!['free_chat', 'support', 'voice_chat'].includes(roomId)) {
      if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
      return res.status(400).json({ error: 'Invalid panel' });
    }
    if (isTimedOut(user.id)) {
      if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
      return res.status(403).json({ error: 'You are timed out from group chat' });
    }
  }
  const { content, msg_type, reply_to_id } = req.body || {};
  let finalContent = typeof content === 'string' ? content : '';
  let msgType = (msg_type || 'text').slice(0, 32);
  if (req.file) {
    finalContent = getFileRef(req.file.filename);
    if (!msgType || msgType === 'text') {
      const mt = req.file.mimetype || '';
      msgType = mt.startsWith('image/') ? 'image' : mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'file';
    }
  }
  if (checkSpam(user.id, roomType, roomId, finalContent)) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    return res.status(429).json({ error: 'NO SPAMMING!' });
  }
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, roomType, roomId, user.id, finalContent, msgType, reply_to_id || null, now, now);
  } catch (err) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    console.error('Failed to persist message:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
  if (req.file) {
    recordUploadRef({
      filename: req.file.filename,
      messageId: id,
      uploadedBy: user.id,
      mimeType: req.file.mimetype || null,
      sizeBytes: req.file.size || null,
      originalName: req.file.originalname || null,
    });
  }
  createInboxForNewMessage(id, finalContent, reply_to_id || null, user.id, roomType, roomId);
  const row = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(id);
  res.status(201).json({ message: { ...row, likes: 0, reactions: [], edit_history: null } });
});

app.patch('/api/messages/:id/recall', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const isOwn = msg.sender_id === user.id;
  const hasUnlimited = canUnlimitedEditRecall(user);
  if (isOwn) {
    if (!hasUnlimited && !canRecallOrEdit(msg)) return res.status(400).json({ error: 'Recall only within 2 minutes' });
  } else {
    if (!hasUnlimited) return res.status(403).json({ error: 'Forbidden' });
    const target = db.prepare('SELECT can_unlimited_edit_recall FROM users WHERE id = ?').get(msg.sender_id);
    if (target?.can_unlimited_edit_recall && user.id !== 'jimmyqrg') return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('UPDATE messages SET recalled_at = ? WHERE id = ?').run(Date.now(), msg.id);
  res.json({ ok: true });
});

app.patch('/api/messages/:id/edit', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const isOwn = msg.sender_id === user.id;
  const hasUnlimited = canUnlimitedEditRecall(user);
  if (isOwn) {
    if (!hasUnlimited && !canRecallOrEdit(msg)) return res.status(400).json({ error: 'Edit only within 2 minutes' });
  } else {
    if (!hasUnlimited) return res.status(403).json({ error: 'Forbidden' });
    const target = db.prepare('SELECT can_unlimited_edit_recall FROM users WHERE id = ?').get(msg.sender_id);
    if (target?.can_unlimited_edit_recall && user.id !== 'jimmyqrg') return res.status(403).json({ error: 'Forbidden' });
  }
  const { content } = req.body || {};
  const history = (msg.edit_history ? JSON.parse(msg.edit_history) : []).concat([{ content: msg.content, at: msg.updated_at }]);
  const newContent = typeof content === 'string' ? content : msg.content;
  const now = Date.now();
  db.prepare('UPDATE messages SET content = ?, edit_history = ?, updated_at = ? WHERE id = ?')
    .run(newContent, JSON.stringify(history), now, msg.id);
  res.json({ ok: true, content: newContent, edit_history: history });
});

app.post('/api/messages/:id/like', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const msg = db.prepare('SELECT id FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT OR IGNORE INTO message_likes (message_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(req.params.id, user.id, Date.now());
  const count = db.prepare('SELECT COUNT(*) as c FROM message_likes WHERE message_id = ?').get(req.params.id);
  res.json({ likes: count.c });
});

app.delete('/api/messages/:id/like', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  db.prepare('DELETE FROM message_likes WHERE message_id = ? AND user_id = ?').run(req.params.id, user.id);
  const count = db.prepare('SELECT COUNT(*) as c FROM message_likes WHERE message_id = ?').get(req.params.id);
  res.json({ likes: count.c });
});

app.get('/api/search/messages', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const { roomType, roomId } = req.query;
  const q = String(req.query.q || '').trim();
  const attachmentType = String(req.query.attachment_type || '').toLowerCase();
  const filterSpec = parseSearchFilter(req.query.filter || '');
  if (!roomType || !roomId) return res.status(400).json({ error: 'roomType and roomId required' });
  if (roomType === 'group' && isBlacklisted(user.id)) {
    return res.status(403).json({ error: 'Access denied. You are blacklisted from group chat.' });
  }
  if (roomType === 'dm') {
    const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(roomId);
    if (!conv || (conv.user1_id !== user.id && conv.user2_id !== user.id)) return res.status(404).json({ error: 'Not found' });
  }
  const blockedIds = db.prepare('SELECT blocked_id FROM blocked_users WHERE user_id = ?').all(user.id).map(r => r.blocked_id);
  const rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = ? AND m.room_id = ? AND m.deleted_by_admin = 0
    ORDER BY m.created_at DESC
    LIMIT 5000
  `).all(roomType, roomId);
  let filtered = blockedIds.length ? rows.filter((row) => !blockedIds.includes(row.sender_id)) : rows;
  if (attachmentType) {
    const map = { image: 'image', video: 'video', audio: 'audio', voice: 'voice', file: 'file', gif: 'gif', any: 'any' };
    const want = map[attachmentType];
    if (want === 'any') {
      filtered = filtered.filter((row) => /^(image|video|audio|voice|file|gif)$/i.test(row.msg_type || ''));
    } else if (want) {
      filtered = filtered.filter((row) => String(row.msg_type || '').toLowerCase() === want);
    }
  }
  if (q) {
    const lowered = q.toLowerCase();
    filtered = filtered.filter((row) => {
      const content = String(row.content || '').toLowerCase();
      if (content.includes(lowered)) return true;
      // Match the trailing filename embedded in /file <id>.<ext> uploads.
      const refMatch = String(row.content || '').match(/^\/file\s+(.+)$/);
      if (refMatch && refMatch[1].toLowerCase().includes(lowered)) return true;
      // Fall back to matching sender username/display name.
      if (String(row.username || '').toLowerCase().includes(lowered)) return true;
      if (String(row.display_name || '').toLowerCase().includes(lowered)) return true;
      return false;
    });
  }
  filtered = applySearchFilters(filtered, filterSpec).slice(0, 100);
  res.json({ messages: decorateMessages(filtered) });
});

// List current user's conversations (for DM list order and conv mapping)
app.get('/api/conversations', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const blockedIds = db.prepare('SELECT blocked_id FROM blocked_users WHERE user_id = ?').all(me.id).map(r => r.blocked_id);
  const rows = db.prepare(`
    SELECT c.id AS conversation_id,
           CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END AS other_user_id,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.room_type = 'dm' AND m.room_id = c.id AND m.deleted_by_admin = 0) AS last_message_at
    FROM conversations c
    WHERE c.user1_id = ? OR c.user2_id = ?
    ORDER BY last_message_at DESC
  `).all(me.id, me.id, me.id);
  const filtered = blockedIds.length ? rows.filter(r => !blockedIds.includes(r.other_user_id)) : rows;
  res.json({ conversations: filtered });
});

// Private conversation: get or create
app.get('/api/conversations/with/:userId', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const otherId = req.params.userId;
  if (me.id === otherId) return res.status(400).json({ error: 'Cannot chat with yourself' });
  const [u1, u2] = [me.id, otherId].sort();
  let conv = db.prepare('SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?').get(u1, u2);
  if (!conv) {
    conv = { id: randomUUID() };
    db.prepare('INSERT INTO conversations (id, user1_id, user2_id, created_at) VALUES (?, ?, ?, ?)')
      .run(conv.id, u1, u2, Date.now());
  } else {
    conv = db.prepare('SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?').get(u1, u2);
  }
  res.json({ conversation_id: conv.id });
});

app.get('/api/conversations/:convId/messages', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(req.params.convId);
  if (!conv || (conv.user1_id !== me.id && conv.user2_id !== me.id)) return res.status(404).json({ error: 'Not found' });
  const blockedIds = db.prepare('SELECT blocked_id FROM blocked_users WHERE user_id = ?').all(me.id).map(r => r.blocked_id);
  const limit = normalizePageLimit(req.query.limit);
  const before = req.query.before ? parseInt(req.query.before, 10) : Date.now();
  let rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = 'dm' AND m.room_id = ? AND m.created_at < ? AND m.deleted_by_admin = 0
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(req.params.convId, before, blockedIds.length ? (limit + 1) * 2 : (limit + 1));
  if (blockedIds.length) rows = rows.filter(r => !blockedIds.includes(r.sender_id));
  const hasMore = rows.length > limit;
  const limited = rows.slice(0, limit);
  const out = decorateMessages(limited.reverse());
  res.json({ messages: out, has_more: hasMore });
});

app.post('/api/conversations/:convId/messages', requireAuth, upload.single('file'), (req, res) => {
  const user = getCurrentUser(req);
  const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(req.params.convId);
  if (!conv || (conv.user1_id !== user.id && conv.user2_id !== user.id)) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    return res.status(404).json({ error: 'Not found' });
  }
  const otherId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
  if (blockedByDmTimeout(user.id, otherId)) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    return res.status(403).json({ error: 'You are timed out from private chat. You can still message jimmyqrg.' });
  }
  const { content, msg_type, reply_to_id } = req.body || {};
  let finalContent = typeof content === 'string' ? content : '';
  let msgType = (msg_type || 'text').slice(0, 32);
  if (req.file) {
    finalContent = getFileRef(req.file.filename);
    if (!msgType || msgType === 'text') {
      const mt = req.file.mimetype || '';
      msgType = mt.startsWith('image/') ? 'image' : mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'file';
    }
  }
  if (checkSpam(user.id, 'dm', req.params.convId, finalContent)) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    return res.status(429).json({ error: 'NO SPAMMING!' });
  }
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
      VALUES (?, 'dm', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.convId, user.id, finalContent, msgType, reply_to_id || null, now, now);
  } catch (err) {
    if (req.file) try { fsRm(req.file.path, { force: true }); } catch (_) {}
    console.error('Failed to persist DM message:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
  if (req.file) {
    recordUploadRef({
      filename: req.file.filename,
      messageId: id,
      uploadedBy: user.id,
      mimeType: req.file.mimetype || null,
      sizeBytes: req.file.size || null,
      originalName: req.file.originalname || null,
    });
  }
  createInboxForNewMessage(id, finalContent, reply_to_id || null, user.id, 'dm', req.params.convId);
  const row = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url, u.chatbox_style
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(id);
  const msg = { ...row, likes: 0, reactions: [], edit_history: null };
  io.to(`dm:${req.params.convId}`).emit('message', msg);
  res.status(201).json({ message: msg });
});

// SPA fallback for any unhandled GET (e.g. /api/unknown)
app.get('*', (req, res) => {
  const p = join(publicDir, 'index.html');
  if (existsSync(p)) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const version = process.env.ASSET_VERSION || Date.now();
    const html = readFileSync(p, 'utf8').replace(/\?v=\d+/g, `?v=${version}`);
    return res.type('html').send(html);
  }
  res.status(404).send('Not found');
});

// Global error handler – log and respond; for document requests still try to serve the app
app.use((err, req, res, next) => {
  console.error('Request error:', req.method, req.path, err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  // For page requests, serve the SPA so the app loads (user can still try login, etc.)
  try {
    const p = join(publicDir, 'index.html');
    if (existsSync(p)) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      const frameAncestors = process.env.ALLOW_IFRAME === 'false' ? "'self'" : '*';
      res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.google.com https://www.grecaptcha.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://www.gstatic.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' wss: https:; frame-src 'self' https://www.google.com https://www.recaptcha.net https://www.grecaptcha.com https://jimmyqrg.github.io; frame-ancestors ${frameAncestors};`);
      const version = process.env.ASSET_VERSION || Date.now();
      const html = readFileSync(p, 'utf8').replace(/\?v=\d+/g, `?v=${version}`);
      return res.status(200).type('html').send(html);
    }
  } catch (_) {}
  res.status(500).type('html').send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><h1>Something went wrong</h1><p>Please try again later.</p></body></html>');
});

const io = new Server(httpServer, {
  cors: { origin: true },
  pingInterval: 20000,
  pingTimeout: 10000,
  connectTimeout: 45000,
});
app.set('io', io);

io.use((socket, next) => {
  const fakeRes = {
    setHeader: () => {},
    getHeader: () => undefined,
    end: (fn) => { if (typeof fn === 'function') fn(); }
  };
  session(socket.request, fakeRes, (err) => {
    if (err) {
      console.error('Socket session error:', err);
      return next(err);
    }
    const userId = socket.request.session?.userId;
    if (!userId) return next(new Error('Not authenticated'));
    socket.userId = userId;
    try {
      socket.user = db.prepare('SELECT id, username, display_name, avatar_url, deleted_at, is_allowed, can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages, can_timeout, can_pin_messages, can_unlimited_edit_recall FROM users WHERE id = ?').get(userId);
    } catch (e) {
      console.error('Socket user lookup error:', e);
      return next(new Error('User not found'));
    }
    if (!socket.user) return next(new Error('User not found'));
    if (socket.user.deleted_at != null) return next(new Error('Account has been deleted'));
    socket.user.is_allowed = !!socket.user.is_allowed;
    socket.user.can_send_inbox = !!socket.user.can_send_inbox;
    socket.user.can_broadcast = !!socket.user.can_broadcast;
    socket.user.can_edit_docs = !!socket.user.can_edit_docs;
    socket.user.can_kick = !!socket.user.can_kick;
    socket.user.can_delete_messages = !!socket.user.can_delete_messages;
    socket.user.can_timeout = !!socket.user.can_timeout;
    socket.user.can_pin_messages = !!socket.user.can_pin_messages;
    socket.user.can_unlimited_edit_recall = !!socket.user.can_unlimited_edit_recall;
    next();
  });
});

function isTimedOut(userId) {
  const now = Date.now();
  const row = db.prepare(
    `SELECT id FROM group_timeouts
     WHERE user_id = ?
       AND released_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND (scope = 'group' OR (scope IS NULL AND room_type = 'group' AND room_id = ?))`
  ).get(userId, now, GROUP_ID);
  return !!row;
}

/** True when the user has an active dm-scope timeout. Recipients named
 * 'jimmyqrg' are always reachable so the timed-out user can appeal. */
function isDmTimedOut(userId) {
  if (!userId) return false;
  const now = Date.now();
  const row = db.prepare(
    `SELECT id FROM group_timeouts
     WHERE user_id = ?
       AND scope = 'dm'
       AND released_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`
  ).get(userId, now);
  return !!row;
}

/** Whether a DM from sender to receiver should be blocked by a dm timeout. */
function blockedByDmTimeout(senderId, receiverId) {
  if (!senderId) return false;
  if (receiverId === 'jimmyqrg') return false;
  return isDmTimedOut(senderId);
}

// ── Presence + typing tracking ──
// Presence: per-user state ('online' | 'idle' | 'offline'), last activity, socket count.
const PRESENCE_IDLE_MS = 5 * 60 * 1000;
const TYPING_TTL_MS = 6 * 1000;
const presenceState = new Map();
// Typing: room key -> Map<userId, { expiresAt }>
const typingByRoom = new Map();

function presenceRoomKeyForRoom(roomType, roomId) {
  return roomType === 'dm' ? `dm:${roomId}` : `group:${GROUP_ID}`;
}

function readPresence(userId) {
  const entry = presenceState.get(userId);
  if (!entry) return { state: 'offline', last_seen_at: null };
  return entry;
}

function setPresence(userId, partial) {
  const existing = presenceState.get(userId) || { state: 'offline', last_seen_at: null, sockets: 0 };
  const next = { ...existing, ...partial };
  presenceState.set(userId, next);
  return next;
}

function broadcastPresenceTo(userId) {
  try {
    const status = readPresence(userId);
    io.emit('presence:update', { user_id: userId, state: status.state, last_seen_at: status.last_seen_at });
  } catch (_) {}
}

function recomputePresence(userId, { explicitState } = {}) {
  const prev = presenceState.get(userId) || { state: 'offline', last_seen_at: null, sockets: 0 };
  let state = explicitState;
  if (!state) {
    if ((prev.sockets || 0) <= 0) state = 'offline';
    else if (prev.last_seen_at && (Date.now() - prev.last_seen_at) > PRESENCE_IDLE_MS) state = 'idle';
    else state = 'online';
  }
  if (state !== prev.state) {
    setPresence(userId, { state });
    broadcastPresenceTo(userId);
  }
}

function snapshotPresence() {
  const out = [];
  for (const [userId, entry] of presenceState.entries()) {
    out.push({ user_id: userId, state: entry.state, last_seen_at: entry.last_seen_at || null });
  }
  return out;
}

function emitTypingTo(roomKey) {
  const map = typingByRoom.get(roomKey);
  const now = Date.now();
  const out = [];
  if (map) {
    for (const [uid, info] of map.entries()) {
      if (info.expiresAt > now) out.push(uid);
      else map.delete(uid);
    }
  }
  io.to(roomKey).emit('typing:update', { room: roomKey, user_ids: out });
}

function setTyping(userId, roomKey, isTyping) {
  let map = typingByRoom.get(roomKey);
  if (!map) {
    map = new Map();
    typingByRoom.set(roomKey, map);
  }
  if (isTyping) {
    map.set(userId, { expiresAt: Date.now() + TYPING_TTL_MS });
  } else {
    map.delete(userId);
  }
  emitTypingTo(roomKey);
}

function pruneExpiredTyping() {
  const now = Date.now();
  for (const [roomKey, map] of typingByRoom.entries()) {
    let changed = false;
    for (const [uid, info] of map.entries()) {
      if (info.expiresAt <= now) {
        map.delete(uid);
        changed = true;
      }
    }
    if (!map.size) typingByRoom.delete(roomKey);
    if (changed) io.to(roomKey).emit('typing:update', { room: roomKey, user_ids: Array.from(map.keys()) });
  }
}

setInterval(pruneExpiredTyping, 2000);

// Voice chat: in-memory participant tracking (userId → socketId)
const voiceParticipants = new Map();

function getVoiceParticipantList() {
  const list = [];
  for (const [userId, socketId] of voiceParticipants) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) { voiceParticipants.delete(userId); continue; }
    const u = s.user || {};
    list.push({ id: userId, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, media: s._voiceMedia || { audio: false, video: false, screen: false } });
  }
  return list;
}

function voiceLeave(socket) {
  if (voiceParticipants.get(socket.userId) === socket.id) {
    voiceParticipants.delete(socket.userId);
    socket.leave('voice:room');
    const participants = getVoiceParticipantList();
    io.to('voice:room').emit('voice:participants', participants);
    io.to('voice:room').emit('voice:peer-left', { userId: socket.userId });
    io.to(`group:${GROUP_ID}`).emit('voice:participant-count', participants.length);
  }
}

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  if (!isBlacklisted(socket.userId)) {
    socket.join(`group:${GROUP_ID}`);
  }

  // Presence: track active sockets per user.
  const prev = presenceState.get(socket.userId) || { sockets: 0, state: 'offline', last_seen_at: null };
  setPresence(socket.userId, { sockets: (prev.sockets || 0) + 1, last_seen_at: Date.now() });
  recomputePresence(socket.userId, { explicitState: 'online' });
  socket.emit('presence:snapshot', snapshotPresence());

  socket.on('presence:heartbeat', (payload) => {
    const desired = (payload && typeof payload.state === 'string' && ['online', 'idle'].includes(payload.state)) ? payload.state : null;
    setPresence(socket.userId, { last_seen_at: Date.now() });
    recomputePresence(socket.userId, { explicitState: desired });
  });

  socket.on('typing:start', (payload) => {
    const { roomType, roomId } = payload || {};
    if (!roomType || !roomId) return;
    if (roomType === 'group' && isBlacklisted(socket.userId)) return;
    if (roomType === 'group' && isTimedOut(socket.userId)) return;
    setTyping(socket.userId, presenceRoomKeyForRoom(roomType, roomId), true);
  });
  socket.on('typing:stop', (payload) => {
    const { roomType, roomId } = payload || {};
    if (!roomType || !roomId) return;
    setTyping(socket.userId, presenceRoomKeyForRoom(roomType, roomId), false);
  });

  socket.on('dm:join', (convId, ack) => {
    const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(convId);
    if (!conv || (conv.user1_id !== socket.userId && conv.user2_id !== socket.userId)) return ack?.({ error: 'Forbidden' });
    socket.join(`dm:${convId}`);
    ack?.({ ok: true });
  });

  socket.on('message:send', (payload, ack) => {
    const { roomType, roomId, content, msg_type, reply_to_id } = payload || {};
    if (!roomType || !roomId) return ack?.({ error: 'roomType and roomId required' });
    const textContent = content || '';
    if (roomType === 'dm') {
      if (checkSpam(socket.userId, 'dm', roomId, textContent)) return ack?.({ error: 'NO SPAMMING!' });
      const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(roomId);
      if (!conv || (conv.user1_id !== socket.userId && conv.user2_id !== socket.userId)) return ack?.({ error: 'Forbidden' });
      const otherId = conv.user1_id === socket.userId ? conv.user2_id : conv.user1_id;
      if (isBlacklisted(socket.userId)) {
        const other = db.prepare('SELECT id, is_allowed FROM users WHERE id = ?').get(otherId);
        if (!other || (other.id !== 'jimmyqrg' && !other.is_allowed)) return ack?.({ error: 'Access denied. Blacklisted users can only DM with JimmyQrg or allowed users.' });
      }
      if (blockedByDmTimeout(socket.userId, otherId)) {
        return ack?.({ error: 'You are timed out from private chat. You can still message jimmyqrg.' });
      }
      if (!areFriends(socket.userId, otherId)) {
        const myCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_type = ? AND room_id = ? AND sender_id = ?').get('dm', roomId, socket.userId).c;
        const otherCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_type = ? AND room_id = ? AND sender_id = ?').get('dm', roomId, otherId).c;
        if (otherCount > 0) return ack?.({ error: 'Accept their friend request to continue chatting' });
        if (myCount >= 10) return ack?.({ error: 'Add as friend to send more messages' });
        if ((msg_type && msg_type !== 'text') || (payload && payload.msg_type && payload.msg_type !== 'text')) return ack?.({ error: 'Add as friend to send files' });
      }
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
        VALUES (?, 'dm', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, roomId, socket.userId, content || '', msg_type || 'text', reply_to_id || null, now, now);
      createInboxForNewMessage(id, content || '', reply_to_id || null, socket.userId, 'dm', roomId);
      const row = db.prepare(`
        SELECT m.*, u.username, u.display_name, u.avatar_url, u.chatbox_style FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
      `).get(id);
      const msg = { ...row, likes: 0, edit_history: null };
      io.to(`dm:${roomId}`).emit('message', msg);
      setTyping(socket.userId, presenceRoomKeyForRoom('dm', roomId), false);
      return ack?.({ message: msg });
    }
    if (roomType === 'group') {
      if (checkSpam(socket.userId, 'group', roomId, textContent)) return ack?.({ error: 'NO SPAMMING!' });
      if (isBlacklisted(socket.userId)) return ack?.({ error: 'Access denied. You are blacklisted from group chat.' });
      if (!['free_chat', 'support', 'voice_chat'].includes(roomId)) return ack?.({ error: 'Invalid panel' });
      if (isTimedOut(socket.userId)) return ack?.({ error: 'You are timed out from group chat' });
    }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, roomType, roomId, socket.userId, content || '', msg_type || 'text', reply_to_id || null, now, now);
    createInboxForNewMessage(id, content || '', reply_to_id || null, socket.userId, roomType, roomId);
    const row = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar_url, u.chatbox_style FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
    `).get(id);
    const msg = { ...row, likes: 0, edit_history: null };
    io.to(`group:${GROUP_ID}`).emit('message', msg);
    setTyping(socket.userId, presenceRoomKeyForRoom(roomType, roomId), false);
    ack?.({ message: msg });
  });

  socket.on('message:recall', (msgId, ack) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    const isOwn = msg.sender_id === socket.userId;
    const hasUnlimited = canUnlimitedEditRecall(socket.user);
    if (isOwn) {
      if (!hasUnlimited && !canRecallOrEdit(msg)) return ack?.({ error: 'Only within 2 minutes' });
    } else {
      if (!hasUnlimited) return ack?.({ error: 'Forbidden' });
      const target = db.prepare('SELECT can_unlimited_edit_recall FROM users WHERE id = ?').get(msg.sender_id);
      if (target?.can_unlimited_edit_recall && socket.userId !== 'jimmyqrg') return ack?.({ error: 'Forbidden' });
    }
    db.prepare('UPDATE messages SET recalled_at = ? WHERE id = ?').run(Date.now(), msgId);
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:recalled', { id: msgId });
    else io.to(`group:${GROUP_ID}`).emit('message:recalled', { id: msgId });
    ack?.({ ok: true });
  });

  socket.on('message:edit', (payload, ack) => {
    const { id: msgId, content } = payload || {};
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    const isOwn = msg.sender_id === socket.userId;
    const hasUnlimited = canUnlimitedEditRecall(socket.user);
    if (isOwn) {
      if (!hasUnlimited && !canRecallOrEdit(msg)) return ack?.({ error: 'Only within 2 minutes' });
    } else {
      if (!hasUnlimited) return ack?.({ error: 'Forbidden' });
      const target = db.prepare('SELECT can_unlimited_edit_recall FROM users WHERE id = ?').get(msg.sender_id);
      if (target?.can_unlimited_edit_recall && socket.userId !== 'jimmyqrg') return ack?.({ error: 'Forbidden' });
    }
    const history = (msg.edit_history ? JSON.parse(msg.edit_history) : []).concat([{ content: msg.content, at: msg.updated_at }]);
    const newContent = typeof content === 'string' ? content : msg.content;
    const now = Date.now();
    db.prepare('UPDATE messages SET content = ?, edit_history = ?, updated_at = ? WHERE id = ?')
      .run(newContent, JSON.stringify(history), now, msgId);
    // Notify users newly mentioned by this edit (skip ones that were already mentioned in the previous content).
    try {
      const before = findMentionUserIds(msg.content || '', msg.sender_id);
      const after = findMentionUserIds(newContent || '', msg.sender_id);
      for (const uid of after) {
        if (before.has(uid)) continue;
        if (isBlocked(uid, msg.sender_id)) continue;
        const inboxId = randomUUID();
        db.prepare(`
          INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at) VALUES (?, ?, 'mention', 'New mention', ?, ?, ?, ?)
        `).run(inboxId, uid, (newContent || '').slice(0, 200), msgId, JSON.stringify({ roomType: msg.room_type, roomId: msg.room_id }), now);
        io.to(`user:${uid}`).emit('inbox:item', { id: inboxId, type: 'mention', title: 'New mention', body: (newContent || '').slice(0, 200), related_id: msgId, related_extra: { roomType: msg.room_type, roomId: msg.room_id }, created_at: now });
      }
    } catch (_) {}
    const payloadOut = { id: msgId, content: newContent, edit_history: history, updated_at: now };
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:edited', payloadOut);
    else io.to(`group:${GROUP_ID}`).emit('message:edited', payloadOut);
    ack?.({ ok: true });
  });

  socket.on('message:like', (msgId, ack) => {
    const msg = db.prepare('SELECT id, room_type, room_id FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    db.prepare('INSERT OR IGNORE INTO message_likes (message_id, user_id, created_at) VALUES (?, ?, ?)').run(msgId, socket.userId, Date.now());
    const count = db.prepare('SELECT COUNT(*) as c FROM message_likes WHERE message_id = ?').get(msgId);
    const payloadOut = { id: msgId, likes: count.c };
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:liked', payloadOut);
    else io.to(`group:${GROUP_ID}`).emit('message:liked', payloadOut);
    ack?.({ likes: count.c });
  });

  socket.on('message:unlike', (msgId, ack) => {
    const msg = db.prepare('SELECT id, room_type, room_id FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    db.prepare('DELETE FROM message_likes WHERE message_id = ? AND user_id = ?').run(msgId, socket.userId);
    const count = db.prepare('SELECT COUNT(*) as c FROM message_likes WHERE message_id = ?').get(msgId);
    const payloadOut = { id: msgId, likes: count.c };
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:liked', payloadOut);
    else io.to(`group:${GROUP_ID}`).emit('message:liked', payloadOut);
    ack?.({ likes: count.c });
  });

  socket.on('message:reaction:toggle', (payload, ack) => {
    const { id: msgId, emoji } = payload || {};
    if (!msgId || !ALLOWED_REACTIONS.has(emoji)) return ack?.({ error: 'Invalid reaction' });
    const msg = db.prepare('SELECT id, room_type, room_id FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    const existing = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(msgId, socket.userId, emoji);
    if (existing) {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(msgId, socket.userId, emoji);
    } else {
      db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(msgId, socket.userId, emoji, Date.now());
    }
    const reactions = getReactionMap([msgId])[msgId] || [];
    const payloadOut = { id: msgId, reactions };
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:reactions', payloadOut);
    else io.to(`group:${GROUP_ID}`).emit('message:reactions', payloadOut);
    ack?.(payloadOut);
  });

  socket.on('message:delete', (msgId, ack) => {
    const msg = db.prepare('SELECT id, room_type, room_id, sender_id FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    const isOwn = msg.sender_id === socket.userId;
    const canAdminDelete = canDeleteMessages(socket.user);
    if (isOwn) {
      /* User can always delete their own messages. */
    } else if (canAdminDelete && msg.sender_id !== 'jimmyqrg') {
      /* Admin can delete others' messages except jimmyqrg's. */
    } else {
      return ack?.({ error: 'Not allowed' });
    }
    db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE id = ?').run('deleted', msgId);
    markUploadOrphan(msgId);
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:deleted', { id: msgId });
    else io.to(`group:${GROUP_ID}`).emit('message:deleted', { id: msgId });
    ack?.({ ok: true });
  });

  socket.on('remove-account', (userId, ack) => {
    if (!canKick(socket.user)) return ack?.({ error: 'Not allowed' });
    if (userId === 'jimmyqrg') return ack?.({ error: 'Cannot remove jimmyqrg' });
    const target = db.prepare('SELECT id, deleted_at FROM users WHERE id = ?').get(userId);
    if (!target) return ack?.({ error: 'User not found' });
    if (target.deleted_at) return ack?.({ error: 'Account already removed' });
    db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(Date.now(), userId);
    io.to(`user:${userId}`).emit('account_removed', {});
    ack?.({ ok: true });
  });

  socket.on('inbox:send', (payload, ack) => {
    if (!canSendInbox(socket.user)) return ack?.({ error: 'Not allowed' });
    const { to_user_id, title, body, type, related_id, related_extra } = payload || {};
    if (!to_user_id) return ack?.({ error: 'to_user_id required' });
    const id = randomUUID();
    db.prepare(`
      INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, to_user_id, type || 'custom', title || '', body || '', related_id || null, related_extra ? JSON.stringify(related_extra) : null, Date.now());
    io.to(`user:${to_user_id}`).emit('inbox:item', { id, type: type || 'custom', title, body, related_id, related_extra, created_at: Date.now() });
    ack?.({ id });
  });

  socket.on('inbox:broadcast', (payload, ack) => {
    if (!canBroadcast(socket.user)) return ack?.({ error: 'Not allowed' });
    const { title, body } = payload || {};
    const users = db.prepare('SELECT id FROM users').all();
    const insert = db.prepare('INSERT INTO inbox (id, user_id, type, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of users) {
      const id = randomUUID();
      insert.run(id, u.id, 'broadcast', title || 'Announcement', body || '', Date.now());
      io.to(`user:${u.id}`).emit('inbox:item', { id, type: 'broadcast', title: title || 'Announcement', body: body || '', created_at: Date.now() });
    }
    ack?.({ ok: true });
  });

  socket.on('solve:start', (payload, ack) => {
    if (!canEditDocs(socket.user)) return ack?.({ error: 'Not allowed' });
    const { support_message_id } = payload || {};
    ack?.({ ok: true, support_message_id });
  });

  // ── Voice Chat (WebRTC signaling) ──

  socket.on('voice:join', (ack) => {
    if (isBlacklisted(socket.userId)) return ack?.({ error: 'Access denied' });
    const existing = voiceParticipants.get(socket.userId);
    if (existing && existing !== socket.id) {
      io.to(existing).emit('voice:kicked', { reason: 'joined_elsewhere' });
    }
    voiceParticipants.set(socket.userId, socket.id);
    socket.join('voice:room');
    const participants = getVoiceParticipantList();
    io.to('voice:room').emit('voice:participants', participants);
    io.to(`group:${GROUP_ID}`).emit('voice:participant-count', participants.length);
    ack?.({ ok: true, participants });
  });

  socket.on('voice:leave', (ack) => {
    voiceLeave(socket);
    ack?.({ ok: true });
  });

  socket.on('voice:offer', ({ to, offer }, ack) => {
    const targetSocketId = voiceParticipants.get(to);
    if (!targetSocketId) return ack?.({ error: 'Peer not found' });
    io.to(targetSocketId).emit('voice:offer', { from: socket.userId, offer });
    ack?.({ ok: true });
  });

  socket.on('voice:answer', ({ to, answer }, ack) => {
    const targetSocketId = voiceParticipants.get(to);
    if (!targetSocketId) return ack?.({ error: 'Peer not found' });
    io.to(targetSocketId).emit('voice:answer', { from: socket.userId, answer });
    ack?.({ ok: true });
  });

  socket.on('voice:ice-candidate', ({ to, candidate }, ack) => {
    const targetSocketId = voiceParticipants.get(to);
    if (!targetSocketId) return ack?.({ error: 'Peer not found' });
    io.to(targetSocketId).emit('voice:ice-candidate', { from: socket.userId, candidate });
    ack?.({ ok: true });
  });

  socket.on('voice:media-state', ({ audio, video, screen }) => {
    socket._voiceMedia = { audio: !!audio, video: !!video, screen: !!screen };
    io.to('voice:room').emit('voice:media-state', { userId: socket.userId, audio: !!audio, video: !!video, screen: !!screen });
  });

  socket.on('disconnect', () => {
    voiceLeave(socket);
    const entry = presenceState.get(socket.userId) || { sockets: 0 };
    const remaining = Math.max(0, (entry.sockets || 0) - 1);
    setPresence(socket.userId, { sockets: remaining, last_seen_at: Date.now() });
    if (remaining === 0) {
      recomputePresence(socket.userId, { explicitState: 'offline' });
    }
    for (const [roomKey, map] of typingByRoom.entries()) {
      if (map.delete(socket.userId)) {
        io.to(roomKey).emit('typing:update', { room: roomKey, user_ids: Array.from(map.keys()) });
      }
      if (!map.size) typingByRoom.delete(roomKey);
    }
  });
});

app.get('/api/presence', requireAuth, (req, res) => {
  res.json({ presence: snapshotPresence() });
});

// Do not replace placeholder password: lets first signup with username jimmyqrg "claim" that account

async function pollAnnouncementsFromPortal() {
  try {
    const result = await syncAnnouncementsFromPortal('system');
    if (result.synced && result.newItems?.length) {
      console.log(`Announcements sync: ${result.newItems.length} new item(s) from portal`);
      io.emit('announcements:updated', {
        version_id: result.version_id,
        created_at: result.created_at,
        newItems: result.newItems,
      });
    }
  } catch (err) {
    console.warn('Announcements poll error:', err.message || err);
  }
}

const ANNOUNCEMENT_POLL_INTERVAL_MS = 60 * 60 * 1000;

function start() {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  httpServer.listen(PORT, HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
    pollAnnouncementsFromPortal();
    setInterval(pollAnnouncementsFromPortal, ANNOUNCEMENT_POLL_INTERVAL_MS);
  });
}
httpServer.on('error', (err) => {
  console.error('Server listen error:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at', promise, 'reason:', reason);
  // Log but do not exit: a single failed async route can reject and would otherwise 502 the whole process (e.g. on Fly).
});
start();
