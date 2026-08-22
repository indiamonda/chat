#!/bin/sh
# Runtime install of openai-whisper (CPU-only torch) into a venv on the /data
# volume, so the deploy image stays small enough for Fly's size limit.
#
# Runs in the background at boot (see Dockerfile CMD). First boot takes a few
# minutes (pip download + install); later boots reuse the installed venv.
# schoology/ai/readers/audio.py picks the venv up lazily via sys.path and
# degrades gracefully to "whisper unavailable" until this completes.

set -u

VENV=/data/whisper-venv
MARKER="$VENV/.setup-complete"
LOCK="$VENV/.setup-in-progress"

if [ -f "$MARKER" ]; then
  echo "[whisper-setup] already installed, nothing to do"
  exit 0
fi
if [ -f "$LOCK" ]; then
  echo "[whisper-setup] setup already in progress, exiting"
  exit 0
fi

mkdir -p "$VENV"
touch "$LOCK"

echo "[whisper-setup] creating venv with $(/usr/bin/python3 -V 2>&1)"
/usr/bin/python3 -m venv "$VENV" || { echo "[whisper-setup] FAILED: venv creation"; rm -f "$LOCK"; exit 1; }

"$VENV/bin/pip" install --no-cache-dir --upgrade pip || { echo "[whisper-setup] FAILED: pip upgrade"; rm -f "$LOCK"; exit 1; }

echo "[whisper-setup] installing CPU-only torch from download.pytorch.org"
"$VENV/bin/pip" install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch || { echo "[whisper-setup] FAILED: torch install"; rm -f "$LOCK"; exit 1; }

echo "[whisper-setup] installing openai-whisper from PyPI"
"$VENV/bin/pip" install --no-cache-dir openai-whisper || { echo "[whisper-setup] FAILED: openai-whisper install"; rm -f "$LOCK"; exit 1; }

# Whisper models are downloaded on first use; keep them on the volume so they
# survive restarts (audio.py passes download_root=/data/whisper-models).
mkdir -p /data/whisper-models

touch "$MARKER"
rm -f "$LOCK"
echo "[whisper-setup] done"
