// @ts-nocheck
/**
 * Browser-side media compression for chat attachments.
 *
 * Public API:
 *   compressMedia(file, { targetMB = 25, onProgress } ) -> Promise<File>
 *     Dispatches by mime/type. Returns the original file unchanged if it's already small enough
 *     or the type isn't compressible. Always returns a File (never throws — falls back to original).
 *
 *   isCompressibleMedia(file) -> boolean
 *     True for image/*, video/*, audio/*, image/gif (treated specially).
 *
 *   formatBytes(bytes) -> "12.3 MB"
 *
 * Strategy:
 *   - Images (non-GIF): canvas downscale + JPEG quality. Iterate until under target.
 *   - Animated GIFs: try canvas → MediaRecorder WebM (preserves animation), fall back to a
 *     single-frame JPEG if MediaRecorder isn't available. Note: the rough GIF duration is
 *     guessed (3.5 s) since parsing GIF frame timing in vanilla JS is non-trivial; this is
 *     OK for typical chat reaction GIFs.
 *   - Videos: video element + canvas + MediaRecorder. Picks bitrate from target/duration,
 *     downscales >720p, captures both video and audio tracks.
 *   - Audio: audio element + captureStream + MediaRecorder at 64 kbps Opus.
 */

const MIN_IMAGE_DIM = 320;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isCompressibleMedia(file) {
  const t = (file?.type || '').toLowerCase();
  return t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/');
}

/** Main entry. Returns the (possibly recompressed) File. Never throws — on any error
 *  returns the original file so the upload can still be attempted. */
export async function compressMedia(file, opts = {}) {
  const targetMB = opts.targetMB || 25;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const targetBytes = targetMB * 1024 * 1024;
  if (!file || file.size <= targetBytes) return file;
  const t = (file.type || '').toLowerCase();
  try {
    if (t === 'image/gif') return await compressGif(file, targetBytes, onProgress);
    if (t.startsWith('image/')) return await compressImage(file, targetBytes, onProgress);
    if (t.startsWith('video/')) return await compressVideo(file, targetBytes, onProgress);
    if (t.startsWith('audio/')) return await compressAudio(file, targetBytes, onProgress);
  } catch (err) {
    console.warn('[mediaCompression] compression failed:', err);
  }
  return file;
}

// --- internal helpers ---

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob); else reject(new Error('toBlob failed'));
    }, type, quality);
  });
}

function renameExt(name, newExt) {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return `${base}.${newExt}`;
}

function pickWebmMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_) {}
  }
  return null;
}

function pickAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_) {}
  }
  return null;
}

// --- image (non-GIF) ---

async function compressImage(file, targetBytes, onProgress) {
  onProgress(0.05);
  const img = await loadImage(file);
  let { naturalWidth: w, naturalHeight: h } = img;
  let quality = 0.85;
  let blob = null;
  let attempts = 0;
  const maxAttempts = 16;

  while (attempts < maxAttempts) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    attempts++;
    onProgress(Math.min(0.95, 0.1 + attempts / maxAttempts * 0.85));
    if (blob.size <= targetBytes) break;
    if (quality > 0.45) {
      quality -= 0.1;
    } else if (Math.min(w, h) > MIN_IMAGE_DIM) {
      w *= 0.85; h *= 0.85;
      quality = 0.7;
    } else {
      // bottoming out — accept whatever we have
      break;
    }
  }

  onProgress(1);
  if (!blob) return file;
  return new File([blob], renameExt(file.name, 'jpg'), { type: 'image/jpeg', lastModified: Date.now() });
}

// --- GIF (preserve animation when possible) ---

async function compressGif(file, targetBytes, onProgress) {
  const webmMime = pickWebmMime();
  if (!webmMime) {
    // Fall back to single-frame JPEG
    return compressImage(file, targetBytes, onProgress);
  }
  try {
    return await gifToWebm(file, targetBytes, onProgress, webmMime);
  } catch (err) {
    console.warn('[mediaCompression] GIF→WebM failed, falling back to static JPEG:', err);
    return compressImage(file, targetBytes, onProgress);
  }
}

async function gifToWebm(file, targetBytes, onProgress, mimeType) {
  onProgress(0.05);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

  // Animated GIFs only animate when in the layout tree; place off-screen but renderable.
  img.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(img);

  try {
    const maxDim = 720;
    let scale = 1;
    if (img.naturalWidth > maxDim || img.naturalHeight > maxDim) {
      scale = maxDim / Math.max(img.naturalWidth, img.naturalHeight);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');

    const fps = 15;
    const stream = canvas.captureStream(fps);

    // Heuristic recording duration: parsing real GIF timing in JS is messy. 3.5 s covers
    // most reaction GIFs; very long GIFs get truncated, which is an acceptable trade-off.
    const recordMs = 3500;
    const targetBitrate = Math.max(200_000, Math.min(2_000_000, Math.floor((targetBytes * 8) / (recordMs / 1000) * 0.85)));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitrate });

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });

    let drawing = true;
    let frameCount = 0;
    const totalFrames = Math.ceil((recordMs / 1000) * fps);
    function draw() {
      if (!drawing) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      frameCount++;
      onProgress(Math.min(0.95, 0.1 + (frameCount / totalFrames) * 0.85));
      requestAnimationFrame(draw);
    }
    draw();

    recorder.start();
    await new Promise((r) => setTimeout(r, recordMs));
    drawing = false;
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: 'video/webm' });
    onProgress(1);
    return new File([blob], renameExt(file.name, 'webm'), { type: 'video/webm', lastModified: Date.now() });
  } finally {
    if (img.parentNode) img.parentNode.removeChild(img);
    URL.revokeObjectURL(url);
  }
}

// --- video ---

async function compressVideo(file, targetBytes, onProgress) {
  const webmMime = pickWebmMime();
  if (!webmMime) return file;

  onProgress(0.02);
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('video load failed'));
    });
    // Some browsers need a brief play to populate captureStream's audio.
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) duration = 30;

    const maxDim = 720;
    let scale = 1;
    if (video.videoWidth > maxDim || video.videoHeight > maxDim) {
      scale = maxDim / Math.max(video.videoWidth, video.videoHeight);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    // Round to even for codec friendliness.
    canvas.width -= canvas.width % 2;
    canvas.height -= canvas.height % 2;
    const ctx = canvas.getContext('2d');

    const fps = 24;
    const canvasStream = canvas.captureStream(fps);

    // Audio bitrate budget ~64 kbps; rest goes to video.
    const audioKbps = 64;
    const overheadFactor = 0.88;
    const totalBitrate = Math.floor((targetBytes * 8) / duration * overheadFactor);
    const videoBitrate = Math.max(200_000, totalBitrate - audioKbps * 1000);

    // Try to combine canvas video + original audio into a single stream.
    const combinedStream = new MediaStream();
    canvasStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));
    let videoCaptureStream = null;
    try {
      // captureStream is what most browsers expose; mozCaptureStream is Firefox.
      videoCaptureStream = (typeof video.captureStream === 'function')
        ? video.captureStream()
        : (typeof video.mozCaptureStream === 'function' ? video.mozCaptureStream() : null);
      if (videoCaptureStream) {
        videoCaptureStream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));
      }
    } catch (_) { /* no audio — proceed video-only */ }

    const recorder = new MediaRecorder(combinedStream, {
      mimeType: webmMime,
      videoBitsPerSecond: videoBitrate,
      audioBitsPerSecond: audioKbps * 1000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });

    let drawing = true;
    function draw() {
      if (!drawing) return;
      try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch (_) {}
      requestAnimationFrame(draw);
    }
    draw();

    let endedNormally = false;
    const ended = new Promise((res) => {
      video.onended = () => { endedNormally = true; res(); };
      // Watchdog: if the video stalls (autoplay blocked, codec hiccup) 'ended'
      // may never fire. Give up after the duration + a buffer instead of
      // leaving the compressing overlay blocking the composer forever.
      const watchMs = Math.max(15000, Math.min(900000, (duration + 20) * 1000));
      setTimeout(res, watchMs);
    });
    recorder.start();
    let playFailed = false;
    try { await video.play(); } catch (_) { playFailed = true; }

    if (playFailed) {
      // Autoplay was blocked — the video will never reach 'ended'. Fall back
      // to the original file instead of hanging the composer.
      drawing = false;
      recorder.stop();
      await stopped;
      canvasStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      if (videoCaptureStream) {
        videoCaptureStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      return file;
    }

    // Progress driver based on currentTime.
    const tickProgress = setInterval(() => {
      if (!duration) return;
      onProgress(Math.min(0.95, 0.05 + (video.currentTime / duration) * 0.9));
    }, 250);

    await ended;
    drawing = false;
    clearInterval(tickProgress);
    recorder.stop();
    await stopped;

    if (videoCaptureStream) {
      videoCaptureStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    }
    canvasStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });

    onProgress(1);
    // If the watchdog fired (video never ended), the recording is partial —
    // send the original instead of a truncated clip.
    if (!endedNormally) return file;
    const blob = new Blob(chunks, { type: 'video/webm' });
    if (!blob.size) return file;
    return new File([blob], renameExt(file.name, 'webm'), { type: 'video/webm', lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- audio ---

async function compressAudio(file, targetBytes, onProgress) {
  const audioMime = pickAudioMime();
  if (!audioMime) return file;

  onProgress(0.02);
  const url = URL.createObjectURL(file);
  const audio = document.createElement('audio');
  audio.src = url;
  audio.preload = 'auto';

  try {
    await new Promise((res, rej) => {
      audio.onloadedmetadata = res;
      audio.onerror = () => rej(new Error('audio load failed'));
    });

    let duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) duration = 30;

    let captureStream = null;
    try {
      captureStream = (typeof audio.captureStream === 'function')
        ? audio.captureStream()
        : (typeof audio.mozCaptureStream === 'function' ? audio.mozCaptureStream() : null);
    } catch (_) {}
    if (!captureStream || captureStream.getAudioTracks().length === 0) return file;

    // Target bitrate from size budget: prefer 96 kbps, but drop lower for long files.
    const overheadFactor = 0.9;
    const targetKbps = Math.max(48, Math.min(128, Math.floor((targetBytes * 8) / duration / 1000 * overheadFactor)));
    const recorder = new MediaRecorder(captureStream, {
      mimeType: audioMime,
      audioBitsPerSecond: targetKbps * 1000,
    });

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });

    const ended = new Promise((res) => { audio.onended = res; });
    recorder.start();
    try { await audio.play(); } catch (_) { return file; }

    const tickProgress = setInterval(() => {
      onProgress(Math.min(0.95, 0.05 + (audio.currentTime / duration) * 0.9));
    }, 250);

    await ended;
    clearInterval(tickProgress);
    recorder.stop();
    await stopped;
    captureStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });

    onProgress(1);
    const ext = audioMime.includes('webm') ? 'webm' : audioMime.includes('ogg') ? 'ogg' : 'm4a';
    const blob = new Blob(chunks, { type: audioMime.split(';')[0] });
    if (!blob.size) return file;
    return new File([blob], renameExt(file.name, ext), { type: audioMime.split(';')[0], lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(url);
  }
}
