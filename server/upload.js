import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../data');
const uploadDir = join(dataDir, 'uploads');
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = (file.originalname && file.originalname.includes('.')) ? file.originalname.slice(file.originalname.lastIndexOf('.')) : '';
    cb(null, `${randomUUID()}${ext}`);
  }
});

/** 2 GB hard cap. Zip files are allowed up to 2 GB; HTML up to 100 MB; media is
 *  compressed client-side. All other types are capped at 100 MB on the client. */
export const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

export function getUploadUrl(filename) {
  return `/uploads/${filename}`;
}

/** File reference format for messages: /file <id> */
export function getFileRef(filename) {
  return `/file ${filename}`;
}
