import session from 'express-session';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { db, validateUsername } from './db.js';

const TWO_MINUTES_MS = 2 * 60 * 1000;

export function sessionMiddleware() {
  return session({
    secret: process.env.SESSION_SECRET || 'jimmyqrg-chat-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
  });
}

export function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

export function getCurrentUser(req) {
  if (!req.session?.userId) return null;
  const u = db.prepare('SELECT id, username, display_name, avatar_url, is_allowed FROM users WHERE id = ?').get(req.session.userId);
  return u ? { ...u, is_allowed: !!u.is_allowed } : null;
}

export async function register(username, password, displayName) {
  if (!validateUsername(username)) return { error: 'Username must be lowercase letters and numbers only' };
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  if (existing) return { error: 'Username taken' };
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const name = (displayName || username).slice(0, 64);
  db.prepare('INSERT INTO users (id, username, display_name, avatar_url, password_hash, is_allowed, created_at) VALUES (?, ?, ?, NULL, ?, 0, ?)')
    .run(id, username.toLowerCase(), name, hash, Date.now());
  return { user: { id, username: username.toLowerCase(), display_name: name, avatar_url: null, is_allowed: false } };
}

export async function login(username, password) {
  const u = db.prepare('SELECT id, username, display_name, avatar_url, password_hash, is_allowed FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return { error: 'Invalid credentials' };
  return { user: { id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, is_allowed: !!u.is_allowed } };
}

export function canRecallOrEdit(msg) {
  if (!msg) return false;
  const age = Date.now() - msg.created_at;
  return age <= TWO_MINUTES_MS;
}

export function isAllowed(user) {
  return user && !!user.is_allowed;
}
