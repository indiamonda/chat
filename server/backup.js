import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs';
import { db } from './db.js';
import { recordAuditLog } from './audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../data');
const backupsDir = process.env.BACKUPS_DIR || join(dataDir, 'backups');

const MAX_BACKUPS = parseInt(process.env.BACKUP_MAX_KEEP || '20', 10);

function ensureBackupsDir() {
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
}

function pruneOldBackups() {
  ensureBackupsDir();
  const files = readdirSync(backupsDir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ name: f, path: join(backupsDir, f), mtimeMs: statSync(join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length > MAX_BACKUPS) {
    files.slice(MAX_BACKUPS).forEach((f) => {
      try { unlinkSync(f.path); } catch (_) {}
    });
  }
}

/** Take a SQLite snapshot using better-sqlite3's online backup API. */
export async function runBackup(actorId = 'system') {
  ensureBackupsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `chat-${stamp}.sqlite`;
  const target = join(backupsDir, filename);
  await db.backup(target);
  pruneOldBackups();
  const stat = existsSync(target) ? statSync(target) : null;
  const result = { filename, path: target, size: stat?.size || 0, created_at: Date.now() };
  recordAuditLog('admin.backup', actorId, null, { filename, size: result.size });
  return result;
}

export function listBackups() {
  ensureBackupsDir();
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const stat = statSync(join(backupsDir, f));
      return { filename: f, size: stat.size, created_at: stat.mtimeMs };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

export function getBackupsDir() {
  ensureBackupsDir();
  return backupsDir;
}
