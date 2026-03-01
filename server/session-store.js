import { EventEmitter } from 'events';
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

function getExpires(session) {
  const c = session?.cookie;
  if (c?.expires && typeof c.expires.getTime === 'function') return c.expires.getTime();
  const maxAge = c?.maxAge;
  if (typeof maxAge === 'number') return Date.now() + maxAge;
  return Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days default
}

export function createSessionStore() {
  const store = new EventEmitter();
  store.get = function get(sid, callback) {
    try {
      const row = db.prepare('SELECT session, expires FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      if (!row) return callback();
      const session = JSON.parse(row.session);
      callback(null, session);
    } catch {
      // Corrupt or missing session: treat as no session so we never 500 on asset/API requests
      callback();
    }
  };
  store.set = function set(sid, session, callback) {
    const expires = getExpires(session);
    try {
      db.prepare('INSERT OR REPLACE INTO sessions (sid, session, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(session), expires);
      callback();
    } catch (err) {
      callback(err);
    }
  };
  store.destroy = function destroy(sid, callback) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback();
    } catch (err) {
      callback(err);
    }
  };
  store.touch = function touch(sid, session, callback) {
    const expires = getExpires(session);
    try {
      db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
      callback();
    } catch (err) {
      callback(err);
    }
  };
  return store;
}
