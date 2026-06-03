"""File readers: one module per file family.

Each reader exposes ``read(path) -> str`` (or a richer dict) that returns
a plain-text representation of the file's content. The dispatcher in
files.py picks the right reader by MIME type and extension.

The readers are lazy-imported by the dispatcher so the heavy ones
(PyPDF2, openpyxl, etc.) only load on first use.
"""
