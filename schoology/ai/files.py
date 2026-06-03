"""File upload + context for AI Assistant.

Routes:
  POST /api/file/ingest    -- multipart upload, returns {id, name, type, size}
  GET  /api/file/<id>      -- fetch the raw file (for AI to display)
  POST /api/file/context   -- given a list of file_ids, return text
                              summaries of each (readers dispatched by
                              MIME/extension). Returns
                              [{id, name, type, summary, error?}].

Files are stored under ``$DATA_DIR/ai_uploads/<id>.<ext>`` and auto-purged
after 1 hour by a background sweeper thread. DATA_DIR defaults to /data
on Fly and to schoology/.ai_uploads for local dev.

Phase 1 ships with the text reader only. Phase 2 will add PDF, image,
audio, video, MIDI, docx, pptx, xlsx, image_vision, and audio analyzers.
"""

import os
import threading
import time
import uuid
from pathlib import Path

from flask import jsonify, request, send_file


_DEFAULT_DATA_DIR = os.environ.get("DATA_DIR", "/data")
UPLOAD_DIR = Path(_DEFAULT_DATA_DIR) / "ai_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 1 hour TTL; background thread sweeps older files.
FILE_TTL_SECONDS = 3600
_SWEEPER_STARTED = False
_SWEEPER_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Cleanup sweeper (daemon thread)
# ---------------------------------------------------------------------------

def _sweeper_loop():
    while True:
        try:
            now = time.time()
            for f in UPLOAD_DIR.iterdir():
                try:
                    if now - f.stat().st_mtime > FILE_TTL_SECONDS:
                        f.unlink(missing_ok=True)
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(300)  # every 5 min


def _ensure_sweeper_started():
    global _SWEEPER_STARTED
    with _SWEEPER_LOCK:
        if _SWEEPER_STARTED:
            return
        t = threading.Thread(target=_sweeper_loop, daemon=True)
        t.start()
        _SWEEPER_STARTED = True


# ---------------------------------------------------------------------------
# Reader dispatch
# ---------------------------------------------------------------------------

# Map (MIME prefix, extension) -> reader function. The dispatcher's
# lookup tries the most specific match first.
_IMAGE_MIMES = ("image/",)
_AUDIO_MIMES = ("audio/",)
_VIDEO_MIMES = ("video/",)
_PDF_EXTS = (".pdf",)
_DOCX_EXTS = (".docx",)
_PPTX_EXTS = (".pptx",)
_XLSX_EXTS = (".xlsx",)
_MIDI_EXTS = (".mid", ".midi")


def _read_text(path: Path) -> str:
    from .readers import text as reader
    return reader.read(path)


def _read_pdf(path: Path) -> str:
    from .readers import pdf as reader
    return reader.read(path)


def _read_docx(path: Path) -> str:
    from .readers import docx as reader
    return reader.read(path)


def _read_pptx(path: Path) -> str:
    from .readers import pptx as reader
    return reader.read(path)


def _read_xlsx(path: Path) -> str:
    from .readers import xlsx as reader
    return reader.read(path)


def _read_midi(path: Path) -> str:
    from .readers import midi as reader
    return reader.read(path)


def _read_image(path: Path, mime: str) -> dict:
    """Image: OCR + (if available) CLIP object detection."""
    out = {"ocr_text": None, "objects": None, "error": None}
    try:
        from .readers import image_ocr as ocr_reader
        out["ocr_text"] = ocr_reader.read(path)
    except Exception as exc:
        out["error"] = f"ocr failed: {exc}"
    try:
        from .readers import image_vision as vision_reader
        out["objects"] = vision_reader.read(path)
    except Exception:
        out["objects"] = None  # optional, silently skip if unavailable
    return out


def _read_audio(path: Path) -> dict:
    from .readers import audio as reader
    return reader.read(path)


def _read_video(path: Path) -> dict:
    from .readers import video as reader
    return reader.read(path)


def _pick_reader(mime: str, filename: str):
    """Return the appropriate reader function for a file."""
    name = filename.lower()
    ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if mime:
        if mime.startswith(_IMAGE_MIMES):
            return ("image", lambda p: _read_image(p, mime))
        if mime.startswith(_AUDIO_MIMES):
            return ("audio", _read_audio)
        if mime.startswith(_VIDEO_MIMES):
            return ("video", _read_video)
    if ext in _PDF_EXTS:
        return ("pdf", _read_pdf)
    if ext in _DOCX_EXTS:
        return ("docx", _read_docx)
    if ext in _PPTX_EXTS:
        return ("pptx", _read_pptx)
    if ext in _XLSX_EXTS:
        return ("xlsx", _read_xlsx)
    if ext in _MIDI_EXTS:
        return ("midi", _read_midi)
    return ("text", _read_text)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_routes(app):
    _ensure_sweeper_started()

    @app.route("/api/file/ingest", methods=["POST"])
    def _ingest_route():
        """Accept a multipart file upload, store it, return its id."""
        if "file" not in request.files:
            return jsonify({"_error": True, "message": "no 'file' field in multipart body"}), 400
        f = request.files["file"]
        if not f.filename:
            return jsonify({"_error": True, "message": "empty filename"}), 400
        file_id = uuid.uuid4().hex[:16]
        # Preserve the extension so the reader dispatcher can match.
        ext = ""
        if "." in f.filename:
            ext = "." + f.filename.rsplit(".", 1)[-1].lower()
        if len(ext) > 8:
            ext = ""  # sanity: no path tricks
        path = UPLOAD_DIR / f"{file_id}{ext}"
        f.save(str(path))
        return jsonify({
            "id": file_id,
            "name": f.filename,
            "type": f.mimetype or "application/octet-stream",
            "size": path.stat().st_size,
        })

    @app.route("/api/file/<file_id>", methods=["GET"])
    def _fetch_route(file_id):
        """Stream a previously-ingested file by id."""
        # Sanitize: only allow hex ids.
        if not all(c in "0123456789abcdef" for c in file_id) or len(file_id) > 32:
            return jsonify({"_error": True, "message": "invalid id"}), 400
        for f in UPLOAD_DIR.iterdir():
            if f.stem == file_id:
                return send_file(str(f), as_attachment=False)
        return jsonify({"_error": True, "message": "not found"}), 404

    @app.route("/api/file/context", methods=["POST"])
    def _context_route():
        """Return text summaries for a list of file_ids.

        Body: { file_ids: ["abc123", "def456"] }.
        Response: [{ id, name, type, summary, error? }, ...].
        """
        payload = request.get_json(silent=True) or {}
        ids = payload.get("file_ids") or []
        if not isinstance(ids, list):
            return jsonify({"_error": True, "message": "file_ids must be a list"}), 400
        out = []
        for file_id in ids:
            if not all(c in "0123456789abcdef" for c in str(file_id)) or len(str(file_id)) > 32:
                out.append({"id": file_id, "error": "invalid id"})
                continue
            # Find the file with this stem.
            target = None
            for f in UPLOAD_DIR.iterdir():
                if f.stem == file_id:
                    target = f
                    break
            if target is None:
                out.append({"id": file_id, "error": "not found"})
                continue
            # Look up original metadata from a sidecar if present; else
            # default. The frontend can pass mime/name via a separate
            # /api/file/describe if needed; for now we dispatch by ext.
            mime, name = "", target.name
            kind, reader = _pick_reader(mime, target.name)
            try:
                result = reader(target)
                if isinstance(result, dict):
                    # Image / audio / video readers return rich dicts;
                    # we flatten to a single text summary.
                    summary = _flatten(kind, result)
                else:
                    summary = str(result)
                if len(summary) > 4000:
                    summary = summary[:4000] + "...(truncated)"
                out.append({
                    "id": file_id,
                    "name": name,
                    "type": kind,
                    "summary": summary,
                })
            except Exception as exc:
                out.append({"id": file_id, "name": name, "error": f"{kind} reader failed: {exc}"})
        return jsonify(out)


def _flatten(kind: str, data: dict) -> str:
    """Turn a structured reader result into a single text block that
    the model can read in context."""
    if kind == "image":
        parts = []
        if data.get("ocr_text"):
            parts.append(f"OCR text:\n{data['ocr_text']}")
        if data.get("objects"):
            objs = data["objects"]
            if isinstance(objs, list) and objs:
                top = ", ".join(f"{o.get('label', '?')} ({o.get('confidence', 0):.2f})" for o in objs[:8])
                parts.append(f"Detected objects: {top}")
        if data.get("error"):
            parts.append(f"Note: {data['error']}")
        return "\n\n".join(parts) if parts else "(image, no text or objects detected)"
    if kind == "audio":
        parts = []
        if data.get("transcript"):
            parts.append(f"Transcript:\n{data['transcript']}")
        if data.get("duration"):
            parts.append(f"Duration: {data['duration']:.1f}s")
        if data.get("tempo"):
            parts.append(f"Tempo: {data['tempo']:.1f} BPM")
        if data.get("pitches"):
            p = data["pitches"]
            if isinstance(p, list) and p:
                avg = sum(x for x in p if x) / max(1, sum(1 for x in p if x))
                parts.append(f"Pitch (avg fundamental): {avg:.1f} Hz over {len(p)} frames")
        return "\n\n".join(parts) if parts else "(audio, no analysis available)"
    if kind == "video":
        parts = []
        if data.get("duration"):
            parts.append(f"Duration: {data['duration']:.1f}s")
        if data.get("audio_summary"):
            parts.append(f"Audio:\n{data['audio_summary']}")
        if data.get("frame_summaries"):
            parts.append("Frame summaries:")
            for fr in data["frame_summaries"][:5]:
                parts.append(f"- t={fr.get('t', '?')}s: {fr.get('summary', '')}")
        return "\n\n".join(parts) if parts else "(video, no analysis available)"
    return str(data)
