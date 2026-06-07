#!/usr/bin/env python3
"""
Schoology tool runner -- long-lived daemon.

Reads JSON tool requests from stdin (one per line), dispatches to the
underlying tool function concurrently, and writes JSON results to
stdout (one per line, each tagged with the request's id).

The wire protocol (concurrent version):

  REQUEST  (one per line, newline-terminated):
    {"id": "abc-123", "tool": "get_grades", "username": "...", "arguments": {}}
  RESPONSE (one per line, newline-terminated, FIFO by id, NOT by send order):
    {"id": "abc-123", "result": {...}}   on success
    {"id": "abc-123", "error": "..."}    on failure

Each request must carry a unique `id`; the parent (schoology/server.py)
uses that id to match the response to the right caller. The parent
no longer holds a per-daemon lock around the call -- it fires the
request and waits on its own future for the response. Multiple
in-flight requests are now possible; one slow ClassLink login does
NOT block sibling section fetches (they queue on the daemon's
internal browser_lock so the Playwright page stays consistent, but
all four are *dispatched* immediately so the parent never sees a
serialized wait).

Exits cleanly on stdin EOF (parent process closed the pipe) or
SIGTERM.

The schoology-mcp server is single-tenant: this daemon's USERNAME and
PASSWORD are read from the *environment* of the subprocess (set by the
parent when spawning). The parent (`schoology/server.py`) maintains one
daemon per authenticated user so multiple students can be served.
"""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

# Make the schoology-mcp package importable
SCRIPT_DIR = Path(__file__).resolve().parent
MCP_DIR = SCRIPT_DIR.parent / 'schoology-mcp'
sys.path.insert(0, str(MCP_DIR))

# Logging must go to stderr -- stdout is the result channel
import logging
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("run_tool")


# Lazy tool dispatch: imported on first request, inside the coroutine,
# so the schoology-mcp modules' module-level `client = SchoologyClient()`
# is created against the *persistent* event loop. (asyncio.Lock and the
# Playwright browser both bind to the loop that's running when they're
# first awaited on; creating them in a throwaway loop and then using
# them in another is the source of the "browser dies after every call"
# problem.)
_TOOL_FUNCTIONS = None


def _load_tool_functions() -> dict:
    global _TOOL_FUNCTIONS
    if _TOOL_FUNCTIONS is not None:
        return _TOOL_FUNCTIONS
    import server as server_mod
    _TOOL_FUNCTIONS = {
        "get_grades": server_mod.get_grades,
        "get_courses": server_mod.get_courses,
        "get_upcoming_assignments": server_mod.get_upcoming_assignments,
        "get_assignment_info": server_mod.get_assignment_info,
        "get_course_materials": server_mod.get_course_materials,
        "get_material": server_mod.get_material,
        "get_recent_posts": server_mod.get_recent_posts,
    }
    return _TOOL_FUNCTIONS


async def handle_request(client, req: dict) -> dict:
    """Dispatch one tool call. Returns the result dict (may include _error)."""
    tool = req.get("tool")
    username = req.get("username") or "<env>"
    if not tool:
        return {"_error": True, "message": "tool is required"}

    fn = _load_tool_functions().get(tool)
    if fn is None:
        return {"_error": True, "message": f"unknown tool: {tool}"}

    log.info("Calling tool %s with args=%s for user %s", tool, req.get("arguments") or {}, username)
    return await fn(**(req.get("arguments") or {}))


def _write_line(payload: dict) -> None:
    """Write one newline-terminated JSON line to stdout. Caller must
    hold write_lock so concurrent tasks don't interleave bytes."""
    line = (json.dumps(payload, default=str) + "\n").encode("utf-8")
    sys.stdout.buffer.write(line)
    sys.stdout.buffer.flush()


async def _safe_write_line(write_lock: asyncio.Lock, payload: dict) -> None:
    async with write_lock:
        try:
            _write_line(payload)
        except (BrokenPipeError, ValueError):
            # Parent died or stdout closed. Caller is responsible for
            # ending the daemon loop on its next read attempt.
            log.info("Stdout closed; aborting write for id=%s", payload.get("id"))


async def main_loop() -> None:
    """Persistent loop: one SchoologyClient for the daemon's lifetime.

    The loop dispatches each request to a child task. Multiple
    in-flight requests run concurrently -- the only serialization is
    `browser_lock` (so two tool calls don't race on the same Playwright
    page). The parent matches responses to callers by `id`.
    """
    # Defer the heavy import until we're inside the event loop so the
    # `client = SchoologyClient()` in schoology-mcp.server binds to *this* loop.
    from schoology_mcp import config  # noqa: F401 -- ensure .env loaded
    from schoology_mcp.browser import SchoologyClient

    if not config.USERNAME:
        log.warning("SCHOOLOGY_USERNAME not set in this daemon's env; tools will fail")
    else:
        log.info("Daemon serving user: %s", config.USERNAME)

    client = SchoologyClient()
    loop = asyncio.get_running_loop()
    log.info("Daemon started (pid=%d); entering concurrent request loop", os.getpid())

    pending: dict = {}
    browser_lock = asyncio.Lock()
    write_lock = asyncio.Lock()

    async def process_one(req_id: str, req: dict) -> None:
        try:
            async with browser_lock:
                # All in-flight tool calls serialize on browser_lock
                # so they don't race on the Playwright page object.
                # Cold start (ClassLink login) pays once; the next
                # sibling call reuses the warm browser.
                result = await handle_request(client, req)
        except Exception as exc:
            log.exception("Tool %s failed", req.get("tool"))
            payload = {"id": req_id, "error": str(exc), "type": type(exc).__name__}
        else:
            payload = {"id": req_id, "result": result}
        await _safe_write_line(write_lock, payload)

    async def read_loop() -> None:
        """Read JSON requests from stdin, dispatch each to a background
        task. Blocks on stdin read; exits when stdin EOFs."""
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                log.info("Stdin closed; exiting daemon loop")
                return

            try:
                req = json.loads(line)
            except Exception as exc:
                # No id available; emit an error with a generated id
                # so the parent never hangs waiting for a response
                # it can't match.
                await _safe_write_line(write_lock, {
                    "id": str(uuid.uuid4()),
                    "error": f"bad request: {exc}",
                })
                continue

            req_id = req.get("id")
            if not req_id:
                # Parent must always include an id. If missing,
                # synthesize one and log -- but still respond so the
                # parent doesn't time out waiting.
                req_id = str(uuid.uuid4())
                log.warning("Request missing id field, synthesized %s", req_id)
                req["id"] = req_id

            # Dispatch as a background task. The read loop returns
            # immediately to the next request. Multiple in-flight
            # requests are now possible (they queue on browser_lock
            # for the actual Playwright access, but the *parent* no
            # longer serializes on a per-daemon Python lock).
            task = asyncio.create_task(process_one(req_id, req))
            pending[req_id] = task
            # Best-effort cleanup of finished tasks so the dict
            # doesn't grow unbounded over a long daemon lifetime.
            done_ids = [k for k, t in pending.items() if t.done() and k != req_id]
            for k in done_ids:
                del pending[k]

    try:
        await read_loop()
    finally:
        # Give in-flight tasks a brief grace to finish writing.
        in_flight = [t for t in pending.values() if not t.done()]
        if in_flight:
            log.info("Draining %d in-flight request(s) before exit", len(in_flight))
            try:
                await asyncio.wait_for(
                    asyncio.gather(*in_flight, return_exceptions=True),
                    timeout=5,
                )
            except asyncio.TimeoutError:
                log.warning("Drain timeout; cancelling %d task(s)", len(in_flight))
                for t in in_flight:
                    t.cancel()
        log.info("Closing client and exiting")
        try:
            await client.close()
        except Exception as exc:  # noqa: BLE001 - best-effort cleanup
            log.warning("Error closing client: %s", exc)


if __name__ == "__main__":
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        log.info("Interrupted; exiting")
    except BrokenPipeError:
        # Parent process closed stdout. Treat as a clean exit.
        log.info("Stdout pipe closed; exiting")
