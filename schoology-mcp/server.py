"""Schoology MCP server.

Exposes tools that drive a headless browser to log into PAUSD Schoology (via
the ClassLink portal) and return grades, upcoming assignments and recent posts.

Run directly:  python server.py   (communicates over stdio)
"""

import logging
import os
import re
import sys
from pathlib import Path
from contextlib import asynccontextmanager

# Add the package directory to sys.path so local schoology_mcp is found
_SCHOOLOGY_MCP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCHOOLOGY_MCP_DIR))

from mcp.server.fastmcp import FastMCP

from schoology_mcp import config, parsers
from schoology_mcp.browser import SchoologyClient

_ASSIGNMENT_ID_RE = re.compile(r"/assignment/(\d+)")


def _assignment_path(url_or_id: str) -> str:
    """Normalize a full URL, /assignment/NNN path, or bare id to a fetch path."""
    s = (url_or_id or "").strip()
    if s.isdigit():
        return f"/assignment/{s}"
    m = _ASSIGNMENT_ID_RE.search(s)
    if m:
        return f"/assignment/{m.group(1)}"
    raise ValueError(
        f"Not a recognizable Schoology assignment URL/ID: {url_or_id!r}"
    )


# MCP uses stdout for the protocol -- all logging MUST go to stderr.
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

# Read credentials from environment (passed by Flask proxy) and set runtime credentials
_runtime_user = os.environ.get("SCHOOLOGY_USERNAME", "")
_runtime_pass = os.environ.get("SCHOOLOGY_PASSWORD", "")
if _runtime_user:
    config.set_runtime_credentials(_runtime_user, _runtime_pass)
    log.info("Runtime credentials set for user: %s", _runtime_user)

client = SchoologyClient()


@asynccontextmanager
async def lifespan(_server):
    try:
        yield
    finally:
        await client.close()


mcp = FastMCP("schoology", lifespan=lifespan)


def _get_username_from_config() -> str:
    """Resolve the username: runtime credentials first, then config.USERNAME."""
    runtime_user, _ = config.get_runtime_credentials()
    return runtime_user or config.USERNAME


@mcp.tool()
async def get_grades(detailed: bool = False) -> dict:
    """Get the student's current grades.

    Default: one entry per course with its overall grade -- small and quick.
    Pass `detailed=True` to also include every grading period, category and
    individual assignment row (the full payload, often hundreds of rows).
    """
    username = _get_username_from_config()
    html = await client.fetch(
        "/grades/grades", username, wait_selector="li.s-grades-course-item"
    )
    courses = parsers.parse_grades(html, config.BASE_URL)
    if not detailed:
        courses = [
            {"title": c["title"], "course_grade": c["course_grade"]}
            for c in courses
        ]
    return {
        "base_url": config.BASE_URL,
        "courses": courses,
    }


@mcp.tool()
async def get_profile() -> dict:
    """Return the logged-in student's name, grade level, and school.

    Used as the lightweight 'first paint' fetch for the dashboard: shows
    a personalized loading screen and an identity strip on the dashboard
    without paying the cost of pulling every course/grade/assignment.
    """
    username = _get_username_from_config()
    html = await client.fetch(
        f"/user/{username}", username, wait_selector="#main h1, .page-title, .user-info-name"
    )
    info = parsers.parse_profile(html, config.BASE_URL)
    return {
        "base_url": config.BASE_URL,
        "name": info.get("name"),
        "grade": info.get("grade"),
        "school": info.get("school"),
    }


@mcp.tool()
async def get_courses() -> dict:
    """Get the list of courses the student is enrolled in."""
    username = _get_username_from_config()
    html = await client.fetch(
        "/courses", username, wait_selector="li.course-item, div.course-card"
    )
    return {
        "base_url": config.BASE_URL,
        "courses": parsers.parse_courses(html, config.BASE_URL),
    }


@mcp.tool()
async def get_upcoming_assignments(days: int = 14, include_info: bool = False) -> dict:
    """Get upcoming / due-soon assignments and events.

    `days` is an advisory window; the home widget already shows near-term
    items, so all of them are returned for the model to filter.

    `include_info=True` additionally fetches each assignment's description /
    attachments (one extra page load per item -- noticeably slower). Off by
    default so the common case stays cheap; turn it on when the model needs
    to read what the assignment is actually asking for.
    """
    username = _get_username_from_config()
    html = await client.fetch("/home", username, extra_wait_ms=3_000)
    assignments = parsers.parse_upcoming_assignments(html, config.BASE_URL)
    if include_info:
        for a in assignments:
            url = a.get("url")
            if not url or "/assignment/" not in url:
                # /event/... items have different markup -- skip.
                continue
            try:
                detail = await get_assignment_info(url)
                a["description"] = detail.get("description")
                a["description_html"] = detail.get("description_html")
                a["attachments"] = detail.get("attachments")
            except Exception as exc:  # noqa: BLE001 - one bad page must not abort the batch
                a["info_error"] = str(exc)
    return {
        "base_url": config.BASE_URL,
        "window_days": days,
        "assignments": assignments,
    }


@mcp.tool()
async def get_assignment_info(url_or_id: str) -> dict:
    """Fetch a single Schoology assignment's full details.

    Accepts a full URL, a relative path like `/assignment/123`, or the bare
    numeric assignment id. Returns title, course, due date, description body
    (text + HTML) and any attached files.
    """
    username = _get_username_from_config()
    path = _assignment_path(url_or_id)
    html = await client.fetch(
        path, username, wait_selector=".info-body, #main h1, .page-title"
    )
    info = parsers.parse_assignment_info(html, config.BASE_URL)
    info["url"] = f"{config.BASE_URL}{path}"
    return info


@mcp.tool()
async def get_recent_posts(limit: int = 20) -> dict:
    """Get the latest posts/updates from the Schoology activity feed."""
    username = _get_username_from_config()
    html = await client.fetch("/home", username, extra_wait_ms=3_000)
    return {
        "base_url": config.BASE_URL,
        "posts": parsers.parse_recent_posts(html, config.BASE_URL, limit=limit),
    }


if __name__ == "__main__":
    mcp.run()