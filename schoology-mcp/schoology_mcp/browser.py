"""Playwright browser lifecycle, session-checked fetching, and keep-alive.

Auto-refresh strategy (Schoology sessions expire quickly):

1. **Detect-and-retry** -- every `fetch()` checks whether the page it got back
   is actually logged in (content-based, not just URL). If not, it re-logs in
   via ClassLink and retries once. This guarantees a fetch never silently
   returns a logged-out page.
2. **Keep-alive** -- a background task periodically re-visits Schoology so the
   sliding session stays warm, so interactive calls rarely pay re-login latency.
3. **Persistence** -- the refreshed session is written back to
   `storage_state_{username}.json` so per-student sessions persist.
4. **Per-student contexts** -- each student gets their own browser context,
   keyed by username. Supports concurrent multiple students.
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Self

from playwright.async_api import async_playwright
from playwright.async_api import TimeoutError as PlaywrightTimeout

from . import config
from .auth import login

log = logging.getLogger("schoology_mcp.browser")

# Override Playwright's default browser cache directory
PLAYWRIGHT_BROWSERS_DIR = os.environ.get(
    "PLAYWRIGHT_BROWSERS_DIR",
    "/root/.cache/ms-playwright"
)


class SchoologyClient:
    """Owns one headless browser with per-student contexts.

    Each student gets their own Playwright BrowserContext, stored in a dict
    keyed by username. This allows concurrent requests for different students.
    """

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        # Per-student contexts: username -> (context, keepalive_task)
        self._contexts: dict[str, tuple] = {}
        self._lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------

    async def _ensure_browser(self) -> None:
        if self._browser is not None:
            return
        log.info("Launching Chromium (headless=%s)", config.HEADLESS)
        self._pw = await async_playwright().start()
        env = {}
        # Only set PLAYWRIGHT_BROWSERS_DIR if explicitly configured to non-default
        if PLAYWRIGHT_BROWSERS_DIR != "/root/.cache/ms-playwright":
            env["PLAYWRIGHT_BROWSERS_DIR"] = PLAYWRIGHT_BROWSERS_DIR
            log.info("Browser launch env: %s", env)
        self._browser = await self._pw.chromium.launch(
            headless=config.HEADLESS,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-software-rasterizer",
                "--no-zygote",
                "--disable-features=VizDisplayCompositor",
                "--disable-blink-features=AutomationControlled",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-default-apps",
                "--disable-sync",
                "--disable-translate",
                "--metrics-recording-only",
                "--mute-audio",
                "--no-first-run",
                "--safebrowsing-disable-auto-update",
            ],
            env=env if env else None
        )

    def _storage_path(self, username: str) -> Path:
        """Get storage state file path for a given username."""
        stem = config.STORAGE_STATE_PATH.stem
        suffix = config.STORAGE_STATE_PATH.suffix
        return config.STORAGE_STATE_PATH.parent / f"{stem}_{username}{suffix}"

    async def _get_context(self, username: str) -> tuple:
        """Get or create a browser context for the given username.

        Returns (context, keepalive_task or None).
        """
        if username in self._contexts:
            return self._contexts[username]

        storage_path = self._storage_path(username)
        if storage_path.exists():
            log.info("Restoring session for %s from %s", username, storage_path)
            context = await self._browser.new_context(storage_state=str(storage_path))
        else:
            log.info("Creating new context for %s", username)
            context = await self._browser.new_context()

        self._contexts[username] = (context, None)
        return context, None

    async def close(self) -> None:
        for username, (context, task) in list(self._contexts.items()):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            await context.close()
        self._contexts.clear()

        if self._browser is not None:
            await self._browser.close()
        if self._pw is not None:
            await self._pw.stop()
        self._browser = self._pw = None

    # -- session management ------------------------------------------------

    async def _login_and_save(self, context, username: str) -> None:
        """Re-run ClassLink login in the live context and persist the session."""
        await login(context, username=username)
        storage_path = self._storage_path(username)
        await context.storage_state(path=str(storage_path))
        log.info("Session refreshed and saved to %s", storage_path)

    async def _keepalive_loop(self, context, username: str) -> None:
        """Periodically refresh the session so it never goes cold."""
        while True:
            try:
                await asyncio.sleep(config.KEEPALIVE_SECONDS)
            except asyncio.CancelledError:
                break
            try:
                url, html = await self._load(context, "/home")
                if _is_logged_in(url, html):
                    storage_path = self._storage_path(username)
                    await context.storage_state(path=str(storage_path))
                    log.debug("Keep-alive: session healthy for %s", username)
                else:
                    log.info("Keep-alive: session expired for %s -- re-logging in", username)
                    await self._login_and_save(context, username)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("Keep-alive refresh failed for %s: %s", username, exc)

    # -- fetching ----------------------------------------------------------

    async def fetch(
        self,
        path: str,
        username: str,
        wait_selector: str | None = None,
        extra_wait_ms: int = 2_000,
    ) -> str:
        """Return the rendered HTML of a Schoology page under BASE_URL.

        The username is used to select/created the per-student browser context.
        Re-logs in and retries once if the page comes back logged out.
        """
        async with self._lock:
            await self._ensure_browser()
            context, _ = await self._get_context(username)

            for attempt in (1, 2):
                url, html = await self._load(context, path, wait_selector, extra_wait_ms)
                if _is_logged_in(url, html):
                    if attempt == 2:
                        storage_path = self._storage_path(username)
                        await context.storage_state(path=str(storage_path))
                    return html
                if attempt == 1:
                    log.info("Session expired while fetching %s -- re-logging in", path)
                    await self._login_and_save(context, username)
            raise RuntimeError(
                f"Not logged in after re-login when fetching {path}. "
                "Check credentials or run scripts/login_check.py --show-browser."
            )

    async def _load(
        self,
        context,
        path: str,
        wait_selector: str | None = None,
        extra_wait_ms: int = 0,
    ) -> tuple[str, str]:
        """Navigate to a path and return (final_url, html)."""
        page = await context.new_page()
        try:
            await page.goto(f"{config.BASE_URL}{path}", wait_until="domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=15_000)
            except PlaywrightTimeout:
                pass
            if wait_selector:
                try:
                    await page.wait_for_selector(wait_selector, timeout=8_000)
                except PlaywrightTimeout:
                    log.warning("Selector %r not found on %s", wait_selector, path)
            if extra_wait_ms:
                await page.wait_for_timeout(extra_wait_ms)
            return page.url, await page.content()
        finally:
            await page.close()


def _is_logged_in(url: str, html: str) -> bool:
    """Content-based login check.

    A logged-in Schoology page stays on schoology.com (not a login URL), has no
    password input, and carries authenticated chrome (`/logout`, site nav).
    """
    if "schoology.com" not in url or "/login" in url:
        return False
    lowered = html.lower()
    if 'type="password"' in lowered or 'name="pass"' in lowered:
        return False
    return "/logout" in lowered or "site-navigation" in lowered
