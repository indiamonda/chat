"""Audio reader: duration, sample rate, pitch (autocorrelation), tempo,
and transcription (Whisper).

Returns a dict that the file dispatcher flattens into a single text
summary for the model. Whisper is heavy (~75MB for tiny), so we lazy-load
and cache on first call. The caller can pass a model size via
``model_size`` for higher accuracy at the cost of more memory.
"""

from pathlib import Path


def read(path: Path, model_size: str = "tiny") -> dict:
    out: dict = {"duration": None, "sample_rate": None, "pitches": [], "tempo": None, "transcript": None}
    # Load audio once with librosa at a low sample rate to keep memory
    # bounded. librosa.load returns (y, sr) as float32 mono.
    try:
        import librosa
        import numpy as np
    except Exception as exc:
        out["error"] = f"librosa not available: {exc}"
        return out
    try:
        y, sr = librosa.load(str(path), sr=16000, mono=True)
        out["sample_rate"] = int(sr)
        out["duration"] = float(len(y) / sr)
        # Pitch via librosa.pyin (probabilistic YIN). Cheap and good enough.
        try:
            f0, _, _ = librosa.pyin(
                y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"), sr=sr
            )
            # Drop NaNs and bin to 0.5s windows.
            valid = f0[~np.isnan(f0)] if f0 is not None else np.array([])
            if len(valid) > 0:
                hop = int(sr * 0.5)
                frames = [float(np.median(valid[i:i+hop])) for i in range(0, len(valid), hop) if len(valid[i:i+hop]) > 0]
                out["pitches"] = frames[:60]  # cap for history
        except Exception:
            pass
        # Tempo via librosa.beat.tempo.
        try:
            tempo, _ = librosa.beat.tempo(y=y, sr=sr)
            if len(tempo) > 0:
                out["tempo"] = float(tempo[0])
        except Exception:
            pass
    except Exception as exc:
        out["error"] = f"audio decode failed: {exc}"
        return out
    # Transcription via Whisper. The package lives in a runtime-installed
    # venv on the /data volume (scripts/setup-whisper.sh) so the deploy image
    # stays under Fly's size limit; add its site-packages lazily and degrade
    # gracefully until the background install finishes on first boot.
    try:
        import os
        import sys
        import glob
        _sites = glob.glob("/data/whisper-venv/lib/python*/site-packages")
        if _sites and _sites[0] not in sys.path:
            sys.path.insert(0, _sites[0])
        import whisper
        global _whisper_model, _whisper_size
        if _whisper_model is None or _whisper_size != model_size:
            _whisper_model = whisper.load_model(
                model_size, download_root="/data/whisper-models"
            )
            _whisper_size = model_size
        result = _whisper_model.transcribe(str(path), fp16=False)
        out["transcript"] = (result.get("text") or "").strip()
    except Exception as exc:
        out["transcript"] = None
        out["transcription_error"] = f"whisper unavailable: {exc}"
    return out


_whisper_model = None
_whisper_size = None
