#!/usr/bin/env python3
"""
Schoology tool runner -- bypasses the MCP stdio protocol entirely.

Reads a tool request as a JSON line from stdin, calls the underlying tool
function directly, and writes the result as JSON to stdout.

This avoids the MCP stdio teardown race where the result is lost when the
one-shot MCP process exits. We don't need the MCP protocol because each
subprocess handles exactly one tool call.
"""

import asyncio
import json
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


TOOL_FUNCTIONS = {}


def _load_tool_functions():
    """Import tool functions from the MCP server module by name.

    Avoids using the internal `_tool_manager` API which varies by version.
    """
    if TOOL_FUNCTIONS:
        return TOOL_FUNCTIONS
    import server as server_mod
    TOOL_FUNCTIONS.update({
        "get_grades": server_mod.get_grades,
        "get_courses": server_mod.get_courses,
        "get_upcoming_assignments": server_mod.get_upcoming_assignments,
        "get_assignment_info": server_mod.get_assignment_info,
        "get_recent_posts": server_mod.get_recent_posts,
    })
    return TOOL_FUNCTIONS


async def run_tool(tool_name: str, arguments: dict, username: str, password: str | None) -> dict:
    """Run a tool by importing its function and calling it directly."""
    # Configure credentials before any tool runs -- tools read them lazily via config.get_runtime_credentials()
    from schoology_mcp import config
    config.set_runtime_credentials(username, password or "")

    tools = _load_tool_functions()
    fn = tools.get(tool_name)
    if fn is None:
        raise ValueError(f"unknown tool: {tool_name}")

    log.info("Calling tool %s with args=%s for user %s", tool_name, arguments, username)
    return await fn(**(arguments or {}))


def main() -> int:
    try:
        line = sys.stdin.readline()
        if not line:
            sys.stdout.write(json.dumps({"_error": True, "message": "no request on stdin"}) + "\n")
            return 1
        req = json.loads(line)
    except Exception as exc:
        sys.stdout.write(json.dumps({"_error": True, "message": f"bad request: {exc}"}) + "\n")
        return 1

    tool = req.get("tool")
    username = req.get("username")
    if not tool or not username:
        sys.stdout.write(json.dumps({"_error": True, "message": "tool and username are required"}) + "\n")
        return 1

    try:
        result = asyncio.run(
            run_tool(
                tool_name=tool,
                arguments=req.get("arguments") or {},
                username=username,
                password=req.get("password"),
            )
        )
    except Exception as exc:
        log.exception("Tool %s failed", tool)
        sys.stdout.write(json.dumps({"_error": True, "message": str(exc), "type": type(exc).__name__}) + "\n")
        sys.stdout.flush()
        return 0  # caller reads the error from JSON, not exit code

    sys.stdout.write(json.dumps(result, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
