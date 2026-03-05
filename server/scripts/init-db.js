import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../../data');
const dbPath = join(dataDir, 'chat.db');

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    password_hash TEXT NOT NULL,
    is_allowed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL,
    user2_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user1_id) REFERENCES users(id),
    FOREIGN KEY (user2_id) REFERENCES users(id),
    UNIQUE(user1_id, user2_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_type TEXT NOT NULL,
    room_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT,
    msg_type TEXT NOT NULL DEFAULT 'text',
    reply_to_id TEXT,
    edit_history TEXT,
    recalled_at INTEGER,
    deleted_by_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (reply_to_id) REFERENCES messages(id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_type, room_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS doc_versions (
    id TEXT PRIMARY KEY,
    doc_key TEXT NOT NULL,
    content TEXT NOT NULL,
    editor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (editor_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_doc_versions_key ON doc_versions(doc_key);

  CREATE TABLE IF NOT EXISTS message_likes (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT,
    body TEXT,
    related_id TEXT,
    related_extra TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox(user_id);

  CREATE TABLE IF NOT EXISTS kicked (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    room_type TEXT NOT NULL,
    room_id TEXT NOT NULL,
    kicked_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (kicked_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_kicked_user_room ON kicked(user_id, room_type, room_id);

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

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

  CREATE TABLE IF NOT EXISTS friend_request_log (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (from_id) REFERENCES users(id),
    FOREIGN KEY (to_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_friend_request_log_from_to ON friend_request_log(from_id, to_id);

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

try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN website TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN profile_links TEXT'); } catch (_) {}
const permCols = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout'];
for (const col of permCols) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
}
db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, created_at)
  VALUES ('jimmyqrg', 'jimmyqrg', 'jimmyqrg', NULL, NULL, '$2a$10$placeholder', 1, ?)`).run(Date.now());
db.prepare(`UPDATE users SET can_send_inbox=1, can_broadcast=1, can_edit_docs=1, can_kick=1, can_delete_messages=1, can_manage_users=1, can_timeout=1 WHERE id='jimmyqrg'`).run();
// Backfill: existing is_allowed users get all permissions (except can_manage_users) so they keep working
try {
  db.prepare(`UPDATE users SET can_send_inbox=1, can_broadcast=1, can_edit_docs=1, can_kick=1, can_delete_messages=1, can_timeout=1 WHERE is_allowed=1 AND id!='jimmyqrg'`).run();
} catch (_) {}

// Initial password is set at server startup (see server/index.js) so we don't need bcrypt here.

// Initial doc content for problem_solving, rules, and announcements
const docs = [
  { doc_key: 'problem_solving', content: '# Problem Solving\n\nDocument for solutions. Only allowed users can edit.' },
  { doc_key: 'rules', content: '# Rules\n\nCommunity rules. Only allowed users can edit.' },
  { doc_key: 'announcements', content: '# Announcements\n\nOfficial announcements. Only allowed users can edit.' }
];
const insDoc = db.prepare('INSERT OR IGNORE INTO doc_versions (id, doc_key, content, editor_id, created_at) VALUES (?, ?, ?, ?, ?)');
for (const d of docs) {
  const id = randomUUID();
  try { insDoc.run(id, d.doc_key, d.content, 'jimmyqrg', Date.now()); } catch (_) {}
}

console.log('Database initialized at', dbPath);
db.close();
