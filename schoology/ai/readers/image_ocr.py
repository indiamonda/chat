"""Image OCR via Tesseract (pytesseract)."""

from pathlib import Path


def read(path: Path) -> str:
    import pytesseract
    from PIL import Image
    img = Image.open(str(path))
    text = pytesseract.image_to_string(img)
    return text.strip() or ""
