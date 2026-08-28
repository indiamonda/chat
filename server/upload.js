import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, statSync, renameSync, rmSync } from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

// --- HEVC/H.265 safety net ----------------------------------------------------
// iPhone/Android recordings often arrive as HEVC (H.265): Safari plays it, but
// Chrome on most devices (school Chromebooks especially) cannot decode it, so
// recipients see a video that "won't load". The client compresses before
// upload, but when compression fails or gains nothing it falls back to the
// ORIGINAL file — which is how a 103 MB HEVC screen recording reached the
// group chat (2026-08-26, message 4f801009…). These codecs are playable
// everywhere; anything else gets transcoded to H.264 in place.
const PLAYABLE_VIDEO_CODECS = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1', 'theora']);
const TRANSCODE_MAX_BYTES = 200 * 1024 * 1024; // skip gigantic files (would stall the upload)
const TRANSCODE_TIMEOUT_MS = 8 * 60 * 1000;
const execFileP = promisify(execFile);

async function probeVideoCodec(filePath) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath,
  ], { timeout: 20000 });
  return String(stdout || '').trim().toLowerCase();
}

/**
 * Ensure an uploaded video uses a broadly-playable codec. If ffprobe finds an
 * unplayable codec (e.g. HEVC), transcode to H.264 in place — the file keeps
 * its name and path, so message refs (/file <name>), upload tracking and the
 * DB row all stay valid; only the size changes. Never throws: on any failure
 * (missing ffmpeg, timeout, huge file) the original is kept and sent as-is.
 */
export async function ensurePlayableVideo(file) {
  if (!file || !file.path || !/^video\//.test(file.mimetype || '')) return file;
  if (!existsSync(file.path)) return file;
  try {
    if ((file.size || statSync(file.path).size) > TRANSCODE_MAX_BYTES) return file;
    const codec = await probeVideoCodec(file.path);
    if (!codec || PLAYABLE_VIDEO_CODECS.has(codec)) return file;
    console.log(`[ensurePlayableVideo] transcoding ${file.path} (${codec}) -> h264`);
    const tmp = `${file.path}.h264.mp4`;
    try { rmSync(tmp, { force: true }); } catch (_) {}
    await execFileP('ffmpeg', [
      '-y', '-v', 'error', '-i', file.path,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp,
    ], { timeout: TRANSCODE_TIMEOUT_MS });
    rmSync(file.path, { force: true });
    renameSync(tmp, file.path);
    file.size = statSync(file.path).size;
    file.transcoded = true;
    return file;
  } catch (err) {
    console.warn('[ensurePlayableVideo] failed, keeping original:', err?.message || err);
    try { rmSync(`${file.path}.h264.mp4`, { force: true }); } catch (_) {}
    return file;
  }
}
