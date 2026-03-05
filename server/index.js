import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { sessionMiddleware, touchSession, getCurrentUser, requireAuth, canRecallOrEdit, canSendInbox, canBroadcast, canEditDocs, canKick, canDeleteMessages, canTimeout } from './auth.js';
import { db, GROUP_ID, PANELS } from './db.js';
import { upload } from './upload.js';
import { getUploadUrl } from './upload.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import docsRoutes from './routes/docs.js';
import inboxRoutes from './routes/inbox.js';
import adminRoutes from './routes/admin.js';
import friendsRoutes, { areFriends } from './routes/friends.js';
import { randomUUID } from 'node:crypto';

function createInboxForNewMessage(messageId, content, replyToId, senderId, roomType, roomId) {
  const toNotify = new Set();
  if (/\@All\b/i.test(content || '')) {
    db.prepare('SELECT id FROM users').all().forEach(r => toNotify.add(r.id));
  }
  [...(content || '').matchAll(/\@([a-z0-9]+)/g)].forEach(m => {
    const r = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(m[1].toLowerCase());
    if (r) toNotify.add(r.id);
  });
  toNotify.delete(senderId);
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO inbox (id, user_id, type, title, body, related_id, related_extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  toNotify.forEach(uid => {
    insert.run(randomUUID(), uid, 'mention', 'New mention', (content || '').slice(0, 200), messageId, JSON.stringify({ roomType, roomId }), now);
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

app.use(express.json());
app.use(cookieParser());

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

// Serve SPA HTML with cache-busting for all document routes (before static so "/" gets it too)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path.startsWith('/uploads') || req.path.startsWith('/socket.io')) return next();
  try {
    const p = join(publicDir, 'index.html');
    if (!existsSync(p)) return next();
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com https://cdn.jsdelivr.net https://www.google.com https://www.grecaptcha.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://www.gstatic.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' wss: https:; frame-src 'self' https://translate.google.com https://www.google.com https://www.recaptcha.net https://www.grecaptcha.com;");
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
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/friends', friendsRoutes);

app.get('/api/group', requireAuth, (req, res) => {
  res.json({ id: GROUP_ID, panels: PANELS });
});

app.get('/api/rooms/:roomType/:roomId/messages', requireAuth, (req, res) => {
  const { roomType, roomId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before, 10) : Date.now();
  const rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = ? AND m.room_id = ? AND m.created_at < ? AND m.deleted_by_admin = 0
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(roomType, roomId, before, limit);
  const likes = db.prepare(`
    SELECT message_id, COUNT(*) as c FROM message_likes GROUP BY message_id
  `).all();
  const likeMap = Object.fromEntries(likes.map(l => [l.message_id, l.c]));
  const out = rows.reverse().map(r => ({
    ...r,
    likes: likeMap[r.id] || 0,
    edit_history: r.edit_history ? JSON.parse(r.edit_history) : null
  }));
  res.json({ messages: out });
});

app.post('/api/rooms/:roomType/:roomId/messages', requireAuth, upload.single('file'), (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { roomType, roomId } = req.params;
  const { content, msg_type, reply_to_id } = req.body || {};
  let finalContent = typeof content === 'string' ? content : '';
  let msgType = (msg_type || 'text').slice(0, 32);
  if (req.file) {
    finalContent = getUploadUrl(req.file.filename);
    if (!msgType || msgType === 'text') {
      const mt = req.file.mimetype || '';
      msgType = mt.startsWith('image/') ? 'image' : mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'file';
    }
  }
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, roomType, roomId, user.id, finalContent, msgType, reply_to_id || null, now, now);
  createInboxForNewMessage(id, finalContent, reply_to_id || null, user.id, roomType, roomId);
  const row = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(id);
  res.status(201).json({ message: { ...row, likes: 0, edit_history: null } });
});

app.patch('/api/messages/:id/recall', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg || msg.sender_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!canRecallOrEdit(msg)) return res.status(400).json({ error: 'Recall only within 2 minutes' });
  db.prepare('UPDATE messages SET recalled_at = ? WHERE id = ?').run(Date.now(), msg.id);
  res.json({ ok: true });
});

app.patch('/api/messages/:id/edit', requireAuth, (req, res) => {
  const user = getCurrentUser(req);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg || msg.sender_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!canRecallOrEdit(msg)) return res.status(400).json({ error: 'Edit only within 2 minutes' });
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

// List current user's conversations (for DM list order and conv mapping)
app.get('/api/conversations', requireAuth, (req, res) => {
  const me = getCurrentUser(req);
  const rows = db.prepare(`
    SELECT c.id AS conversation_id,
           CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END AS other_user_id,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.room_type = 'dm' AND m.room_id = c.id AND m.deleted_by_admin = 0) AS last_message_at
    FROM conversations c
    WHERE c.user1_id = ? OR c.user2_id = ?
    ORDER BY last_message_at DESC
  `).all(me.id, me.id, me.id);
  res.json({ conversations: rows });
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before, 10) : Date.now();
  const rows = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_type = 'dm' AND m.room_id = ? AND m.created_at < ? AND m.deleted_by_admin = 0
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(req.params.convId, before, limit);
  const likes = db.prepare('SELECT message_id, COUNT(*) as c FROM message_likes GROUP BY message_id').all();
  const likeMap = Object.fromEntries(likes.map(l => [l.message_id, l.c]));
  const out = rows.reverse().map(r => ({ ...r, likes: likeMap[r.id] || 0, edit_history: r.edit_history ? JSON.parse(r.edit_history) : null }));
  res.json({ messages: out });
});

app.post('/api/conversations/:convId/messages', requireAuth, upload.single('file'), (req, res) => {
  const user = getCurrentUser(req);
  const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(req.params.convId);
  if (!conv || (conv.user1_id !== user.id && conv.user2_id !== user.id)) return res.status(404).json({ error: 'Not found' });
  const { content, msg_type, reply_to_id } = req.body || {};
  let finalContent = typeof content === 'string' ? content : '';
  let msgType = (msg_type || 'text').slice(0, 32);
  if (req.file) {
    finalContent = getUploadUrl(req.file.filename);
    if (!msgType || msgType === 'text') {
      const mt = req.file.mimetype || '';
      msgType = mt.startsWith('image/') ? 'image' : mt.startsWith('video/') ? 'video' : mt.startsWith('audio/') ? 'audio' : 'file';
    }
  }
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
    VALUES (?, 'dm', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.convId, user.id, finalContent, msgType, reply_to_id || null, now, now);
  createInboxForNewMessage(id, finalContent, reply_to_id || null, user.id, 'dm', req.params.convId);
  const row = db.prepare(`
    SELECT m.id, m.room_type, m.room_id, m.sender_id, m.content, m.msg_type, m.reply_to_id, m.edit_history, m.recalled_at, m.deleted_by_admin, m.created_at, m.updated_at,
           u.username, u.display_name, u.avatar_url
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(id);
  const msg = { ...row, likes: 0, edit_history: null };
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
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com https://cdn.jsdelivr.net https://www.google.com https://www.grecaptcha.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://www.gstatic.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' wss: https:; frame-src 'self' https://translate.google.com https://www.google.com https://www.recaptcha.net https://www.grecaptcha.com;");
      const version = process.env.ASSET_VERSION || Date.now();
      const html = readFileSync(p, 'utf8').replace(/\?v=\d+/g, `?v=${version}`);
      return res.status(200).type('html').send(html);
    }
  } catch (_) {}
  res.status(500).type('html').send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><h1>Something went wrong</h1><p>Please try again later.</p></body></html>');
});

const io = new Server(httpServer, { cors: { origin: true } });
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
      socket.user = db.prepare('SELECT id, username, display_name, avatar_url, is_allowed, can_send_inbox, can_broadcast, can_edit_docs, can_kick, can_delete_messages, can_timeout FROM users WHERE id = ?').get(userId);
    } catch (e) {
      console.error('Socket user lookup error:', e);
      return next(new Error('User not found'));
    }
    if (!socket.user) return next(new Error('User not found'));
    socket.user.is_allowed = !!socket.user.is_allowed;
    socket.user.can_send_inbox = !!socket.user.can_send_inbox;
    socket.user.can_broadcast = !!socket.user.can_broadcast;
    socket.user.can_edit_docs = !!socket.user.can_edit_docs;
    socket.user.can_kick = !!socket.user.can_kick;
    socket.user.can_delete_messages = !!socket.user.can_delete_messages;
    socket.user.can_timeout = !!socket.user.can_timeout;
    next();
  });
});

function isKicked(userId) {
  const row = db.prepare('SELECT id FROM kicked WHERE user_id = ? AND room_type = ? AND room_id = ?').get(userId, 'group', GROUP_ID);
  return !!row;
}

function isTimedOut(userId) {
  const now = Date.now();
  const row = db.prepare(
    'SELECT id FROM group_timeouts WHERE user_id = ? AND room_type = ? AND room_id = ? AND released_at IS NULL AND (expires_at IS NULL OR expires_at > ?)'
  ).get(userId, 'group', GROUP_ID, now);
  return !!row;
}

io.on('connection', (socket) => {
  if (isKicked(socket.userId)) {
    socket.emit('kicked', {});
    socket.disconnect(true);
    return;
  }
  socket.join(`group:${GROUP_ID}`);
  socket.join(`user:${socket.userId}`);

  socket.on('dm:join', (convId, ack) => {
    const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(convId);
    if (!conv || (conv.user1_id !== socket.userId && conv.user2_id !== socket.userId)) return ack?.({ error: 'Forbidden' });
    socket.join(`dm:${convId}`);
    ack?.({ ok: true });
  });

  socket.on('message:send', (payload, ack) => {
    const { roomType, roomId, content, msg_type, reply_to_id } = payload || {};
    if (!roomType || !roomId) return ack?.({ error: 'roomType and roomId required' });
    const id = randomUUID();
    const now = Date.now();
    if (roomType === 'dm') {
      const conv = db.prepare('SELECT id, user1_id, user2_id FROM conversations WHERE id = ?').get(roomId);
      if (!conv || (conv.user1_id !== socket.userId && conv.user2_id !== socket.userId)) return ack?.({ error: 'Forbidden' });
      const otherId = conv.user1_id === socket.userId ? conv.user2_id : conv.user1_id;
      if (!areFriends(socket.userId, otherId)) {
        const myCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_type = ? AND room_id = ? AND sender_id = ?').get('dm', roomId, socket.userId).c;
        const otherCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_type = ? AND room_id = ? AND sender_id = ?').get('dm', roomId, otherId).c;
        if (otherCount > 0) return ack?.({ error: 'Accept their friend request to continue chatting' });
        if (myCount >= 10) return ack?.({ error: 'Add as friend to send more messages' });
        if ((msg_type && msg_type !== 'text') || (payload && payload.msg_type && payload.msg_type !== 'text')) return ack?.({ error: 'Add as friend to send files' });
      }
      db.prepare(`
        INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
        VALUES (?, 'dm', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, roomId, socket.userId, content || '', msg_type || 'text', reply_to_id || null, now, now);
      createInboxForNewMessage(id, content || '', reply_to_id || null, socket.userId, 'dm', roomId);
      const row = db.prepare(`
        SELECT m.*, u.username, u.display_name, u.avatar_url FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
      `).get(id);
      const msg = { ...row, likes: 0, edit_history: null };
      io.to(`dm:${roomId}`).emit('message', msg);
      return ack?.({ message: msg });
    }
    if (roomType === 'group' && !['free_chat', 'support'].includes(roomId)) return ack?.({ error: 'Invalid panel' });
    if (roomType === 'group' && isTimedOut(socket.userId)) return ack?.({ error: 'You are timed out from group chat' });
    db.prepare(`
      INSERT INTO messages (id, room_type, room_id, sender_id, content, msg_type, reply_to_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, roomType, roomId, socket.userId, content || '', msg_type || 'text', reply_to_id || null, now, now);
    createInboxForNewMessage(id, content || '', reply_to_id || null, socket.userId, roomType, roomId);
    const row = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar_url FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?
    `).get(id);
    const msg = { ...row, likes: 0, edit_history: null };
    io.to(`group:${GROUP_ID}`).emit('message', msg);
    ack?.({ message: msg });
  });

  socket.on('message:recall', (msgId, ack) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg || msg.sender_id !== socket.userId) return ack?.({ error: 'Forbidden' });
    if (!canRecallOrEdit(msg)) return ack?.({ error: 'Only within 2 minutes' });
    db.prepare('UPDATE messages SET recalled_at = ? WHERE id = ?').run(Date.now(), msgId);
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:recalled', { id: msgId });
    else io.to(`group:${GROUP_ID}`).emit('message:recalled', { id: msgId });
    ack?.({ ok: true });
  });

  socket.on('message:edit', (payload, ack) => {
    const { id: msgId, content } = payload || {};
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg || msg.sender_id !== socket.userId) return ack?.({ error: 'Forbidden' });
    if (!canRecallOrEdit(msg)) return ack?.({ error: 'Only within 2 minutes' });
    const history = (msg.edit_history ? JSON.parse(msg.edit_history) : []).concat([{ content: msg.content, at: msg.updated_at }]);
    const newContent = typeof content === 'string' ? content : msg.content;
    const now = Date.now();
    db.prepare('UPDATE messages SET content = ?, edit_history = ?, updated_at = ? WHERE id = ?')
      .run(newContent, JSON.stringify(history), now, msgId);
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

  socket.on('message:delete', (msgId, ack) => {
    if (!canDeleteMessages(socket.user)) return ack?.({ error: 'Not allowed' });
    const msg = db.prepare('SELECT id, room_type, room_id FROM messages WHERE id = ?').get(msgId);
    if (!msg) return ack?.({ error: 'Not found' });
    db.prepare('UPDATE messages SET deleted_by_admin = 1, content = NULL, msg_type = ? WHERE id = ?').run('deleted', msgId);
    if (msg.room_type === 'dm') io.to(`dm:${msg.room_id}`).emit('message:deleted', { id: msgId });
    else io.to(`group:${GROUP_ID}`).emit('message:deleted', { id: msgId });
    ack?.({ ok: true });
  });

  socket.on('kick', (userId, ack) => {
    if (!canKick(socket.user)) return ack?.({ error: 'Not allowed' });
    if (userId === 'jimmyqrg') return ack?.({ error: 'Cannot kick jimmyqrg' });
    db.prepare(`
      INSERT INTO kicked (id, user_id, room_type, room_id, kicked_by, created_at) VALUES (?, ?, 'group', ?, ?, ?)
    `).run(randomUUID(), userId, GROUP_ID, socket.userId, Date.now());
    io.to(`user:${userId}`).emit('kicked', {});
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
});

// Do not replace placeholder password: lets first signup with username jimmyqrg "claim" that account

function start() {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  httpServer.listen(PORT, HOST, () => console.log(`Server listening on ${HOST}:${PORT}`));
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
