import { db } from './db.js';
import { randomUUID } from 'node:crypto';

/**
 * Record an admin/audit action.
 * Best-effort: failures should not break request handling.
 */
export function recordAuditLog(action, actorId, targetId = null, details = null) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, action, actor_id, target_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      String(action || '').slice(0, 96),
      actorId || null,
      targetId || null,
      details ? JSON.stringify(details) : null,
      Date.now()
    );
  } catch (err) {
    console.warn('Failed to record audit log:', err?.message || err);
  }
}

export function listAuditLogs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`
    SELECT a.id, a.action, a.actor_id, a.target_id, a.details, a.created_at,
           actor.username AS actor_username, actor.display_name AS actor_display_name,
           target.username AS target_username, target.display_name AS target_display_name
    FROM audit_logs a
    LEFT JOIN users actor ON actor.id = a.actor_id
    LEFT JOIN users target ON target.id = a.target_id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(safeLimit).map((r) => ({
    ...r,
    details: (() => {
      try { return r.details ? JSON.parse(r.details) : null; } catch { return null; }
    })(),
  }));
}

