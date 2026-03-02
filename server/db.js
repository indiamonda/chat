import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../data');
const dbPath = join(dataDir, 'chat.db');

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);

// Ensure permission columns exist (migration for older DBs)
const PERM_COLS = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout'];
for (const col of PERM_COLS) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {}
}
try { db.exec('ALTER TABLE users ADD COLUMN website TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN profile_links TEXT'); } catch (_) {} // JSON array of {label, url}

// Friendships and friend-request rate limits
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (
      user1_id TEXT NOT NULL,
      user2_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user1_id, user2_id),
      CHECK (user1_id < user2_id),
      FOREIGN KEY (user1_id) REFERENCES users(id),
      FOREIGN KEY (user2_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user1_id, user2_id);
  `);
} catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friend_request_log (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_id) REFERENCES users(id),
      FOREIGN KEY (to_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_friend_request_log_from_to ON friend_request_log(from_id, to_id);
  `);
} catch (_) {}

// Group timeouts (mute in JimmyQrg group)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_timeouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      room_type TEXT NOT NULL,
      room_id TEXT NOT NULL,
      expires_at INTEGER,
      locked_release INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      released_at INTEGER,
      released_by TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_timeouts_user_room ON group_timeouts(user_id, room_type, room_id);
  `);
} catch (_) {}

const USERNAME_RE = /^[a-z0-9]+$/;
export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username) && username.length >= 1 && username.length <= 32;
}

export const GROUP_ID = 'JimmyQrg';
export const PANELS = ['free_chat', 'support', 'problem_solving', 'rules'];
