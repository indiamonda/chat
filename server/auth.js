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
  const u = db.prepare('SELECT id, username, display_name, avatar_url, email, is_allowed FROM users WHERE id = ?').get(req.session.userId);
  return u ? { ...u, is_allowed: !!u.is_allowed } : null;
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

const PLACEHOLDER_PASSWORD = '$2a$10$placeholder';

export async function register(username, email, password, displayName) {
  if (!validateUsername(username)) return { error: 'Username must be lowercase letters and numbers only' };
  if (!isValidEmail(email)) return { error: 'Valid email required' };
  const existingUser = db.prepare('SELECT id, password_hash, email FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  const isJimmyqrg = username.toLowerCase() === 'jimmyqrg';
  const isPlaceholder = existingUser?.password_hash === PLACEHOLDER_PASSWORD && existingUser?.email == null;
  if (existingUser && !(isJimmyqrg && isPlaceholder)) return { error: 'Username taken' };
  const existingEmail = db.prepare('SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = LOWER(?)').get(email.trim());
  if (existingEmail) return { error: 'Email already registered' };
  const hash = bcrypt.hashSync(password, 10);
  const name = (displayName || username).slice(0, 64);
  const emailVal = email.trim().toLowerCase().slice(0, 255);
  if (isJimmyqrg && isPlaceholder) {
    db.prepare('UPDATE users SET display_name = ?, email = ?, password_hash = ?, created_at = ? WHERE id = ?')
      .run(name, emailVal, hash, Date.now(), existingUser.id);
    return { user: { id: existingUser.id, username: 'jimmyqrg', display_name: name, avatar_url: null, email: emailVal, is_allowed: true } };
  }
  const id = isJimmyqrg ? 'jimmyqrg' : uuidv4();
  db.prepare('INSERT INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)')
    .run(id, username.toLowerCase(), name, emailVal, hash, isJimmyqrg ? 1 : 0, Date.now());
  return { user: { id, username: username.toLowerCase(), display_name: name, avatar_url: null, email: emailVal, is_allowed: !!isJimmyqrg } };
}

export async function login(usernameOrEmail, password) {
  const input = (usernameOrEmail || '').trim().toLowerCase();
  const u = db.prepare(
    'SELECT id, username, display_name, avatar_url, email, password_hash, is_allowed FROM users WHERE LOWER(username) = ? OR (email IS NOT NULL AND LOWER(email) = ?)'
  ).get(input, input);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return { error: 'Invalid credentials' };
  return { user: { id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, email: u.email, is_allowed: !!u.is_allowed } };
}

export function canRecallOrEdit(msg) {
  if (!msg) return false;
  const age = Date.now() - msg.created_at;
  return age <= TWO_MINUTES_MS;
}

export function isAllowed(user) {
  return user && !!user.is_allowed;
}
