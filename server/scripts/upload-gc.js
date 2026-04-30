#!/usr/bin/env node
// Garbage-collect orphaned upload files. Safe to run on a cron / by hand.
// An upload is considered orphan when:
//   1. It has an upload_refs row with referenced=0 older than UPLOAD_GC_GRACE_MS, OR
//   2. There is no upload_refs row pointing at the file AND no message references
//      the filename, AND the file is older than UPLOAD_GC_GRACE_MS.
// Avatars on the users table are excluded automatically.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { db } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../../data');
const uploadDir = process.env.UPLOAD_DIR || join(dataDir, 'uploads');
const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');
const grace = Number(process.env.UPLOAD_GC_GRACE_MS || 24 * 60 * 60 * 1000);

if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

function log(...args) { if (verbose) console.log(...args); }

function isReferenced(filename) {
  const refRow = db.prepare('SELECT id FROM upload_refs WHERE filename = ? AND referenced = 1 LIMIT 1').get(filename);
  if (refRow) return true;
  const msgRow = db.prepare(`
    SELECT id FROM messages
    WHERE deleted_by_admin = 0 AND content = ? LIMIT 1
  `).get(`/file ${filename}`);
  if (msgRow) return true;
  // Profile avatars are stored as /uploads/<filename>; treat them as referenced.
  const avatar = db.prepare('SELECT id FROM users WHERE avatar_url = ?').get(`/uploads/${filename}`);
  if (avatar) return true;
  return false;
}

function deleteFile(filename) {
  const target = join(uploadDir, filename);
  if (!existsSync(target)) return false;
  if (dryRun) {
    log('[dry-run] would delete', filename);
    return true;
  }
  try {
    unlinkSync(target);
    log('deleted', filename);
    return true;
  } catch (err) {
    console.warn('Failed to delete', filename, err?.message || err);
    return false;
  }
}

const now = Date.now();
let deleted = 0;
let inspected = 0;
const seen = new Set();

const files = readdirSync(uploadDir).filter((f) => !f.startsWith('.'));
for (const file of files) {
  inspected += 1;
  seen.add(file);
  const stat = statSync(join(uploadDir, file));
  if (now - stat.mtimeMs < grace) continue;
  if (isReferenced(file)) continue;
  if (deleteFile(file)) deleted += 1;
  if (!dryRun) {
    try { db.prepare('DELETE FROM upload_refs WHERE filename = ?').run(file); } catch (_) {}
  }
}

const orphans = db.prepare(`
  SELECT DISTINCT filename FROM upload_refs WHERE referenced = 0 AND created_at < ?
`).all(now - grace);
for (const row of orphans) {
  if (seen.has(row.filename)) continue;
  if (!dryRun) {
    try { db.prepare('DELETE FROM upload_refs WHERE filename = ?').run(row.filename); } catch (_) {}
  }
}

console.log(`upload-gc: inspected=${inspected} deleted=${deleted} dry_run=${dryRun}`);
process.exit(0);
