"""Web tools: screenshot a URL and fetch a URL's main text.

Screenshot uses a one-shot Playwright run (not the daemon's persistent
browser, which is busy with the dashboard MCP). Slower (~5s) but works
without coordination. Fetch uses requests + readability-lxml to extract
the main text of an HTML page.
"""

import base64
import io
import re
import threading
import time

import requests
from flask import jsonify, request


_SCREENSHOT_TIMEOUT = 30


def _do_screenshot(url: str, full_page: bool, wait_for: str | None) -> dict:
    """Run a one-shot Playwright screenshot. Imports playwright lazily."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            page.goto(url, timeout=_SCREENSHOT_TIMEOUT * 1000, wait_until="domcontentloaded")
            if wait_for:
                try:
                    page.wait_for_selector(wait_for, timeout=10000)
                except Exception:
                    pass
            png = page.screenshot(full_page=full_page, type="png")
            return {
                "url": url,
                "png_base64": base64.b64encode(png).decode("ascii"),
                "size_bytes": len(png),
                "full_page": full_page,
            }
        finally:
            browser.close()


def _screenshot(url: str, full_page: bool, wait_for: str | None) -> dict:
    # Run in a thread with a hard timeout so a hung page doesn't
    # permanently block the gunicorn worker.
    result: dict = {}
    def _run():
        try:
            result["data"] = _do_screenshot(url, full_page, wait_for)
        except Exception as exc:
            result["error"] = str(exc)
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(_SCREENSHOT_TIMEOUT + 5)
    if t.is_alive():
        return {"_error": True, "message": f"screenshot timed out after {_SCREENSHOT_TIMEOUT}s"}
    if "error" in result:
        return {"_error": True, "message": f"screenshot failed: {result['error']}"}
    return result["data"]


def _fetch(url: str, max_bytes: int = 2_000_000) -> dict:
    try:
        r = requests.get(
            url,
            headers={"User-Agent": "jchat-ai/1.0 (+https://jchat.fly.dev)"},
            timeout=15,
            stream=True,
        )
        r.raise_for_status()
        ctype = r.headers.get("content-type", "").lower()
        # Read up to max_bytes.
        buf = io.BytesIO()
        for chunk in r.iter_content(8192):
            buf.write(chunk)
            if buf.tell() > max_bytes:
                break
        data = buf.getvalue()
        if "html" in ctype:
            html = data.decode("utf-8", errors="replace")
            try:
                from readability import Document
                doc = Document(html)
                title = doc.title()
                summary = doc.summary()
                # Strip tags from summary.
                text = re.sub(r"<[^>]+>", " ", summary)
                text = re.sub(r"\s+", " ", text).strip()
                if len(text) > 50_000:
                    text = text[:50_000] + "...(truncated)"
                return {"url": url, "title": title, "text": text, "content_type": ctype, "size_bytes": len(data)}
            except Exception as exc:
                # Fall through to raw text.
                text = re.sub(r"<[^>]+>", " ", html)
                text = re.sub(r"\s+", " ", text).strip()
                if len(text) > 50_000:
                    text = text[:50_000] + "...(truncated)"
                return {"url": url, "text": text, "content_type": ctype, "size_bytes": len(data), "readability_error": str(exc)}
        # Non-HTML: best-effort utf-8 decode.
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception:
            text = ""
        if len(text) > 50_000:
            text = text[:50_000] + "...(truncated)"
        return {"url": url, "text": text, "content_type": ctype, "size_bytes": len(data)}
    except Exception as exc:
        return {"_error": True, "message": f"fetch failed: {exc}"}


def register_routes(app):
    @app.route("/api/web/screenshot", methods=["POST"])
    def _web_screenshot_route():
        payload = request.get_json(silent=True) or {}
        url = (payload.get("url") or "").strip()
        if not url:
            return jsonify({"_error": True, "message": "url is required"})
        full_page = bool(payload.get("full_page"))
        wait_for = payload.get("wait_for")
        if not (url.startswith("http://") or url.startswith("https://")):
            return jsonify({"_error": True, "message": "url must be http(s)"})
        return jsonify(_screenshot(url, full_page, wait_for))

    @app.route("/api/web/fetch", methods=["POST"])
    def _web_fetch_route():
        payload = request.get_json(silent=True) or {}
        url = (payload.get("url") or "").strip()
        if not url:
            return jsonify({"_error": True, "message": "url is required"})
        if not (url.startswith("http://") or url.startswith("https://")):
            return jsonify({"_error": True, "message": "url must be http(s)"})
        max_bytes = int(payload.get("max_bytes") or 2_000_000)
        return jsonify(_fetch(url, max_bytes=max_bytes))
