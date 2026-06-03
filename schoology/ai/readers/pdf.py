"""PDF reader: page-by-page text extraction via pypdf."""

from pathlib import Path

MAX_CHARS = 50_000


def read(path: Path) -> str:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    parts = []
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = "(could not extract this page)"
        parts.append(f"--- Page {i+1} ---\n{text}")
    out = "\n\n".join(parts)
    if len(out) > MAX_CHARS:
        out = out[:MAX_CHARS] + f"\n\n... (truncated at {MAX_CHARS} chars)"
    return out
