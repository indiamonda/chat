import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '../data/chat.db');
const db = new Database(dbPath);

const username = 'tester';
const newPassword = 'password';

const hash = bcrypt.hashSync(newPassword, 10);
const info = db.prepare('UPDATE users SET password_hash = ? WHERE LOWER(username) = LOWER(?)').run(hash, username);

console.log(`Updated password for "${username}". Rows changed: ${info.changes}`);
