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
const PERM_COLS = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users'];
for (const col of PERM_COLS) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {}
}

const USERNAME_RE = /^[a-z0-9]+$/;
export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username) && username.length >= 1 && username.length <= 32;
}

export const GROUP_ID = 'JimmyQrg';
export const PANELS = ['free_chat', 'support', 'problem_solving', 'rules'];
