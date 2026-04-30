import { db } from './db.js';
import { randomUUID } from 'node:crypto';

/**
 * Track an uploaded file's link to a message so the GC script can
 * remove orphaned uploads (files where no living message references them).
 */
export function recordUploadRef({ filename, messageId, uploadedBy, mimeType, sizeBytes, originalName }) {
  if (!filename) return null;
  try {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO upload_refs (id, filename, message_id, uploaded_by, mime_type, size_bytes, original_name, referenced, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(filename),
      messageId || null,
      uploadedBy || null,
      mimeType || null,
      sizeBytes != null ? Number(sizeBytes) : null,
      originalName || null,
      messageId ? 1 : 0,
      Date.now()
    );
    return id;
  } catch (err) {
    console.warn('recordUploadRef failed:', err?.message || err);
    return null;
  }
}

/** Mark every upload reference for a message_id as orphaned so the GC will reap the file. */
export function markUploadOrphan(messageId) {
  if (!messageId) return;
  try {
    db.prepare(`UPDATE upload_refs SET referenced = 0 WHERE message_id = ?`).run(messageId);
  } catch (err) {
    console.warn('markUploadOrphan failed:', err?.message || err);
  }
}

/** Mark a specific filename as orphaned (used when a follow-up message insert fails). */
export function markFilenameOrphan(filename) {
  if (!filename) return;
  try {
    db.prepare(`UPDATE upload_refs SET referenced = 0 WHERE filename = ?`).run(String(filename));
  } catch (err) {
    console.warn('markFilenameOrphan failed:', err?.message || err);
  }
}

/** Find the original filename a message reference points to. */
export function extractFilenameFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  const m = content.match(/^\/file\s+([^\s]+)$/);
  return m ? m[1] : null;
}
