import session from 'express-session';
import { db } from './db.js';

const Store = session.Store;

let tableReady = false;
function ensureTable() {
  if (tableReady) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    `);
    tableReady = true;
  } catch (err) {
    console.error('Session store ensureTable error:', err);
  }
}

function getExpires(session) {
  try {
    const c = session?.cookie;
    if (c?.expires && typeof c.expires.getTime === 'function') return c.expires.getTime();
    const maxAge = c?.maxAge;
    if (typeof maxAge === 'number') return Date.now() + maxAge;
  } catch (_) {}
  return Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days default
}

/** Session store extending express-session Store so createSession and .on() exist. */
class SqliteSessionStore extends Store {
  get(sid, callback) {
    try {
      ensureTable();
      const row = db.prepare('SELECT session, expires FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      if (!row) return callback();
      const session = JSON.parse(row.session);
      callback(null, session);
    } catch {
      callback();
    }
  }

  set(sid, session, callback) {
    try {
      ensureTable();
      const expires = getExpires(session);
      const json = JSON.stringify(session);
      db.prepare('INSERT OR REPLACE INTO sessions (sid, session, expires) VALUES (?, ?, ?)').run(sid, json, expires);
    } catch (err) {
      console.error('Session store set error:', err);
    }
    callback();
  }

  destroy(sid, callback) {
    try {
      ensureTable();
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    } catch (err) {
      console.error('Session store destroy error:', err);
    }
    callback();
  }

  touch(sid, session, callback) {
    try {
      ensureTable();
      const expires = getExpires(session);
      db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
    } catch (err) {
      console.error('Session store touch error:', err);
    }
    callback();
  }
}

export function createSessionStore() {
  return new SqliteSessionStore();
}
