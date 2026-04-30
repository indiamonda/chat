import { db } from './db.js';

/**
 * Mention parsing utility shared by HTTP and socket message paths.
 * Supports:
 *   - @username   → user with that lowercase username
 *   - @all        → every user
 *   - @admins     → every user with is_allowed = 1
 */

const USERNAME_RE = /\B@([a-z0-9]{1,32})\b/gi;
export const MENTION_INCLUDES_ALL_RE = /(^|\s)@all\b/i;
export const MENTION_INCLUDES_ADMINS_RE = /(^|\s)@admins\b/i;

/**
 * Resolve mentions inside a message body to a set of user ids that should
 * receive a mention notification. The resulting set excludes the sender and
 * users that have blocked the sender (see isBlocked usage at the call site).
 */
export function findMentionUserIds(content, senderId) {
  const set = new Set();
  if (!content) return set;
  const text = String(content);
  if (MENTION_INCLUDES_ALL_RE.test(text)) {
    db.prepare('SELECT id FROM users WHERE deleted_at IS NULL').all().forEach((u) => set.add(u.id));
  }
  if (MENTION_INCLUDES_ADMINS_RE.test(text)) {
    db.prepare('SELECT id FROM users WHERE is_allowed = 1 AND deleted_at IS NULL').all().forEach((u) => set.add(u.id));
  }
  text.replace(USERNAME_RE, (_match, name) => {
    const lower = String(name || '').toLowerCase();
    if (!lower || lower === 'all' || lower === 'admins') return '';
    const row = db.prepare('SELECT id FROM users WHERE LOWER(username) = ? AND deleted_at IS NULL').get(lower);
    if (row) set.add(row.id);
    return '';
  });
  if (senderId) set.delete(senderId);
  return set;
}
