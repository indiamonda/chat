"""Text/code reader. Handles .txt, .md, .csv, .json, .xml, .html, and
common code extensions by reading as UTF-8 (with a latin-1 fallback
for files that aren't valid UTF-8). Truncates at 50k chars."""

from pathlib import Path

MAX_CHARS = 50_000


def read(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        text = path.read_text(encoding="latin-1", errors="replace")
    if len(text) > MAX_CHARS:
        return text[:MAX_CHARS] + f"\n\n... (truncated at {MAX_CHARS} chars)"
    return text
