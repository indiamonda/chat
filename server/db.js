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
try { db.exec('ALTER TABLE users ADD COLUMN description TEXT'); } catch (_) {}

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

// Blocked users (blocker_id blocks blocked_id)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (blocked_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_users_user ON blocked_users(user_id);
  `);
} catch (_) {}

// Notification preferences
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_notification_prefs (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      notify_mails INTEGER NOT NULL DEFAULT 1,
      notify_dm INTEGER NOT NULL DEFAULT 1,
      notify_group INTEGER NOT NULL DEFAULT 1,
      dm_allow_list TEXT,
      dm_block_list TEXT,
      dnd_until INTEGER,
      dnd_at_night INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
} catch (_) {}
try { db.exec('ALTER TABLE user_notification_prefs ADD COLUMN dnd_at_night INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

// Blacklist: blacklisted user cannot access group chat, only DM with jimmyqrg or allowed users
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blacklist (
      user_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
} catch (_) {}

// users.deleted_at: soft delete (timestamp) or null (active). Permanently deleted users are removed from DB.
try { db.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER'); } catch (_) {}

const USERNAME_RE = /^[a-z0-9]+$/;
export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username) && username.length >= 1 && username.length <= 32;
}

export const GROUP_ID = 'JimmyQrg';
export const PANELS = ['announcements', 'free_chat', 'support', 'problem_solving', 'rules'];

export function isBlacklisted(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT 1 FROM blacklist WHERE user_id = ?').get(userId);
  return !!row;
}

export function isUserDeleted(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(userId);
  return row && row.deleted_at != null;
}

// Saved message collections (per-user saved messages for quick access)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      room_type TEXT NOT NULL,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_username TEXT,
      sender_display_name TEXT,
      content_snapshot TEXT,
      msg_type TEXT,
      message_created_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );
    CREATE INDEX IF NOT EXISTS idx_collections_user_created ON message_collections(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_collections_message ON message_collections(message_id);
  `);
} catch (_) {}
