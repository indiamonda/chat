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

// Migration: add columns to existing users table (idempotent)
for (const col of ['is_private']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    password_hash TEXT NOT NULL,
    is_allowed INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

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
    scope TEXT NOT NULL DEFAULT 'group',
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_timeouts_user_room ON group_timeouts(user_id, room_type, room_id);
  CREATE INDEX IF NOT EXISTS idx_group_timeouts_scope_user ON group_timeouts(scope, user_id);

  CREATE TABLE IF NOT EXISTS user_saves (
    user_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'localStorage',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, origin, key, kind),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_saves_user_updated ON user_saves(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_id TEXT,
    target_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (actor_id) REFERENCES users(id),
    FOREIGN KEY (target_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS message_reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    target_user_id TEXT,
    message_id TEXT,
    room_type TEXT,
    room_id TEXT,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    assigned_to TEXT,
    outcome TEXT,
    resolved_by TEXT,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (reporter_id) REFERENCES users(id),
    FOREIGN KEY (target_user_id) REFERENCES users(id),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (assigned_to) REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_message_reports_target ON message_reports(target_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_message_reports_message ON message_reports(message_id);
  CREATE INDEX IF NOT EXISTS idx_message_reports_reporter ON message_reports(reporter_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS moderation_notes (
    id TEXT PRIMARY KEY,
    report_id TEXT,
    target_user_id TEXT,
    message_id TEXT,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (report_id) REFERENCES message_reports(id),
    FOREIGN KEY (target_user_id) REFERENCES users(id),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (author_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_moderation_notes_report ON moderation_notes(report_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_moderation_notes_target ON moderation_notes(target_user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS upload_refs (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    message_id TEXT,
    uploaded_by TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    original_name TEXT,
    referenced INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_upload_refs_filename ON upload_refs(filename);
  CREATE INDEX IF NOT EXISTS idx_upload_refs_message ON upload_refs(message_id);
  CREATE INDEX IF NOT EXISTS idx_upload_refs_referenced ON upload_refs(referenced, created_at);

  CREATE INDEX IF NOT EXISTS idx_messages_msg_type ON messages(msg_type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_id, created_at DESC);
`);

try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN website TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN profile_links TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN chatbox_style TEXT DEFAULT 'default'"); } catch (_) {}
const permCols = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout', 'can_pin_messages', 'can_unlimited_edit_recall'];
for (const col of permCols) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
}
db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, created_at)
  VALUES ('jimmyqrg', 'jimmyqrg', 'jimmyqrg', NULL, NULL, '$2a$10$placeholder', 1, ?)`).run(Date.now());
db.prepare(`UPDATE users SET can_send_inbox=1, can_broadcast=1, can_edit_docs=1, can_kick=1, can_delete_messages=1, can_manage_users=1, can_timeout=1, can_pin_messages=1, can_unlimited_edit_recall=1 WHERE id='jimmyqrg'`).run();
db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, created_at)
  VALUES ('helper', 'helper', 'Venory', '/assets/helper/avatar.png', NULL, '$2a$10$placeholder', 0, ?)`).run(Date.now());
try {
  db.prepare(`UPDATE users SET avatar_url = '/assets/helper/avatar.png' WHERE id = 'helper' AND (avatar_url IS NULL OR avatar_url = '')`).run();
} catch (_) {}
// Backfill: existing is_allowed users get all permissions (except can_manage_users) so they keep working
try {
  db.prepare(`UPDATE users SET can_send_inbox=1, can_broadcast=1, can_edit_docs=1, can_kick=1, can_delete_messages=1, can_timeout=1, can_pin_messages=1 WHERE is_allowed=1 AND id!='jimmyqrg'`).run();
} catch (_) {}

// Private user: visible to jimmyqrg only. Bcrypt hash of 'xyz12345'.
// INSERT OR IGNORE means re-running init-db on an existing DB is a no-op.
const SEZI_PRIVATE_HASH = '$2a$10$v/lcOM/h5euuHEqKNfVJRuT3iYY/1Jxb7.SLP3OFmrcQE0JcVnJca';
db.prepare(
  `INSERT OR IGNORE INTO users (id, username, display_name, avatar_url, email, password_hash, is_allowed, is_private, created_at)
   VALUES (?, ?, ?, NULL, ?, ?, 0, 1, ?)`
).run('sezitoushangyibadao', 'sezitoushangyibadao', '色字头上一把刀', 'a@a.a', SEZI_PRIVATE_HASH, Date.now());
// On subsequent runs, make sure the email is set even if the row already
// exists with a different value (e.g. NULL from the original seed).
db.prepare(`UPDATE users SET email = 'a@a.a' WHERE id = 'sezitoushangyibadao' AND (email IS NULL OR email != 'a@a.a')`).run();

// Initial password is set at server startup (see server/index.js) so we don't need bcrypt here.

// Initial doc content only when no version exists for that doc_key (so restarts don't overwrite saved content)
const docs = [
  { doc_key: 'problem_solving', content: '# Problem Solving\n\nDocument for solutions. Only allowed users can edit.' },
  { doc_key: 'rules', content: '# Rules\n\nCommunity rules. Only allowed users can edit.' },
  { doc_key: 'announcements', content: '# Announcements\n\nOfficial announcements. Only allowed users can edit.' }
];
const hasDoc = db.prepare('SELECT 1 FROM doc_versions WHERE doc_key = ? LIMIT 1');
const insDoc = db.prepare('INSERT INTO doc_versions (id, doc_key, content, editor_id, created_at) VALUES (?, ?, ?, ?, ?)');
for (const d of docs) {
  if (hasDoc.get(d.doc_key)) continue;
  insDoc.run(randomUUID(), d.doc_key, d.content, 'jimmyqrg', Date.now());
}

console.log('Database initialized at', dbPath);
db.close();
