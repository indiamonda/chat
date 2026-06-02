#!/usr/bin/env python3
"""
Schoology tool runner -- long-lived daemon.

Reads JSON tool requests from stdin (one per line), dispatches to the
underlying tool function, and writes JSON results to stdout (one per
line). The wire protocol is identical to the old one-shot version so
the server side needs no changes; the only difference is that the
asyncio event loop is kept alive for the lifetime of the process so
the Playwright browser (and its in-memory session cookies) persist
across calls.

Exits cleanly on stdin EOF (parent process closed the pipe) or
SIGTERM.
"""

import asyncio
import json
import os
import sys
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
        "get_profile": server_mod.get_profile,
        "get_grades": server_mod.get_grades,
        "get_courses": server_mod.get_courses,
        "get_upcoming_assignments": server_mod.get_upcoming_assignments,
        "get_assignment_info": server_mod.get_assignment_info,
        "get_recent_posts": server_mod.get_recent_posts,
    }
    return _TOOL_FUNCTIONS


async def handle_request(client, req: dict) -> dict:
    """Dispatch one tool call. Returns the result dict (may include _error)."""
    tool = req.get("tool")
    username = req.get("username")
    if not tool or not username:
        return {"_error": True, "message": "tool and username are required"}

    # Configure credentials before any tool runs -- tools read them lazily
    # via config.get_runtime_credentials().
    from schoology_mcp import config
    config.set_runtime_credentials(username, req.get("password") or "")

    fn = _load_tool_functions().get(tool)
    if fn is None:
        return {"_error": True, "message": f"unknown tool: {tool}"}

    log.info("Calling tool %s with args=%s for user %s", tool, req.get("arguments") or {}, username)
    return await fn(**(req.get("arguments") or {}))


async def main_loop() -> None:
    """Persistent loop: one SchoologyClient for the daemon's lifetime."""
    # Defer the heavy import until we're inside the event loop so the
    # `client = SchoologyClient()` in schoology-mcp.server binds to *this* loop.
    from schoology_mcp import config  # noqa: F401 -- ensure .env loaded
    from schoology_mcp.browser import SchoologyClient

    client = SchoologyClient()
    loop = asyncio.get_running_loop()
    log.info("Daemon started (pid=%d); entering request loop", os.getpid())

    try:
        while True:
            # Offload the blocking read to a thread so the event loop
            # can service browser coroutines concurrently.
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                log.info("Stdin closed; exiting daemon loop")
                break

            try:
                req = json.loads(line)
            except Exception as exc:
                _write_result({"_error": True, "message": f"bad request: {exc}"})
                continue

            try:
                result = await handle_request(client, req)
            except Exception as exc:
                log.exception("Tool %s failed", req.get("tool"))
                result = {"_error": True, "message": str(exc), "type": type(exc).__name__}

            # If the parent died, stop trying to write to it.
            try:
                _write_result(result)
            except BrokenPipeError:
                log.info("Stdout pipe closed; exiting daemon loop")
                break
    finally:
        log.info("Closing client and exiting")
        try:
            await client.close()
        except Exception as exc:  # noqa: BLE001 - best-effort cleanup
            log.warning("Error closing client: %s", exc)


def _write_result(result: dict) -> None:
    sys.stdout.write(json.dumps(result, default=str) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        log.info("Interrupted; exiting")
    except BrokenPipeError:
        # Parent process closed stdout. Treat as a clean exit.
        log.info("Stdout pipe closed; exiting")
