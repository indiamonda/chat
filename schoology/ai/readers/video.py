"""Video reader: extract 1fps keyframes and the audio track.

Audio goes to the audio reader (transcription + analysis). Keyframes go
to the image_vision reader (object detection). Frames are downsampled
to fit the model context.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def read(path: Path, model_size: str = "tiny") -> dict:
    out: dict = {"duration": None, "frames_analyzed": 0, "frame_summaries": [], "audio_summary": None}
    if not shutil.which("ffmpeg"):
        out["error"] = "ffmpeg not installed"
        return out
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # Get duration.
        try:
            r = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                capture_output=True, text=True, timeout=30
            )
            if r.stdout.strip():
                out["duration"] = float(r.stdout.strip())
        except Exception:
            pass
        # Extract 1-fps keyframes.
        frame_dir = tmp / "frames"
        frame_dir.mkdir()
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(path), "-vf", "fps=1", "-q:v", "2",
                 str(frame_dir / "f_%04d.jpg")],
                capture_output=True, timeout=120,
            )
        except Exception as exc:
            out["error"] = f"frame extract failed: {exc}"
        frames = sorted(frame_dir.glob("f_*.jpg"))
        out["frames_analyzed"] = len(frames)
        # Analyze up to 5 frames evenly distributed across the video.
        if frames:
            from . import image_vision, image_ocr
            step = max(1, len(frames) // 5)
            sample = frames[::step][:5]
            for i, f in enumerate(sample):
                t = (i * step)  # seconds (we extracted 1fps)
                objects = image_vision.read(f)
                ocr = image_ocr.read(f) if image_ocr else None
                summary_parts = []
                if objects:
                    summary_parts.append("objects: " + ", ".join(o["label"] for o in objects[:3]))
                if ocr:
                    summary_parts.append(f"text: {ocr[:200]}")
                if not summary_parts:
                    summary_parts.append("(no text or objects detected)")
                out["frame_summaries"].append({"t": t, "summary": "; ".join(summary_parts)})
        # Extract audio.
        audio_path = tmp / "audio.wav"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
                 str(audio_path)],
                capture_output=True, timeout=120,
            )
            if audio_path.exists() and audio_path.stat().st_size > 0:
                from . import audio as audio_reader
                audio_out = audio_reader.read(audio_path, model_size=model_size)
                if audio_out.get("transcript"):
                    out["audio_summary"] = audio_out["transcript"]
                else:
                    dur = audio_out.get("duration") or out.get("duration") or 0
                    out["audio_summary"] = f"(no transcript available; audio is {dur:.1f}s)"
        except Exception:
            pass
    return out
