"""External integrations: GitHub, GitLab, Codeberg, YouTube.

All free, no API keys required (with the standard public rate limits).
YouTube uses oEmbed for metadata; captions come from
youtube-transcript-api when available.
"""

import re

import requests
from flask import jsonify, request


# ---------------------------------------------------------------------------
# GitHub
# ---------------------------------------------------------------------------

def _github_repo(owner: str, name: str) -> dict:
    try:
        h = {"Accept": "application/vnd.github+json", "User-Agent": "jchat-ai/1.0"}
        r = requests.get(f"https://api.github.com/repos/{owner}/{name}", headers=h, timeout=10)
        if r.status_code == 404:
            return {"_error": True, "message": f"repo not found: {owner}/{name}"}
        r.raise_for_status()
        data = r.json()
        # README (first 500 lines).
        readme = ""
        try:
            rr = requests.get(
                f"https://api.github.com/repos/{owner}/{name}/readme",
                headers={**h, "Accept": "application/vnd.github.raw"},
                timeout=10,
            )
            if rr.status_code == 200:
                readme = "\n".join(rr.text.splitlines()[:500])
        except Exception:
            pass
        return {
            "full_name": data.get("full_name"),
            "description": data.get("description"),
            "language": data.get("language"),
            "stars": data.get("stargazers_count"),
            "forks": data.get("forks_count"),
            "open_issues": data.get("open_issues_count"),
            "default_branch": data.get("default_branch"),
            "html_url": data.get("html_url"),
            "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
            "pushed_at": data.get("pushed_at"),
            "license": (data.get("license") or {}).get("spdx_id"),
            "topics": data.get("topics") or [],
            "readme_excerpt": readme,
        }
    except Exception as exc:
        return {"_error": True, "message": f"github repo fetch failed: {exc}"}


def _github_search(q: str, limit: int = 5) -> dict:
    try:
        r = requests.get(
            "https://api.github.com/search/repositories",
            params={"q": q, "per_page": str(limit)},
            headers={"Accept": "application/vnd.github+json", "User-Agent": "jchat-ai/1.0"},
            timeout=10,
        )
        r.raise_for_status()
        items = r.json().get("items", [])
        return {
            "query": q,
            "count": len(items),
            "results": [
                {
                    "full_name": it.get("full_name"),
                    "description": it.get("description"),
                    "stars": it.get("stargazers_count"),
                    "language": it.get("language"),
                    "url": it.get("html_url"),
                }
                for it in items
            ],
        }
    except Exception as exc:
        return {"_error": True, "message": f"github search failed: {exc}"}


# ---------------------------------------------------------------------------
# GitLab
# ---------------------------------------------------------------------------

def _gitlab_snippet_or_project(token: str) -> dict:
    # The GitLab public API is project-scoped. For a generic "GitLab:<id>"
    # we try a few common endpoints. Most useful is a project path like
    # "namespace/project"; for a snippet we'd need a different endpoint.
    # We try the projects endpoint by path.
    try:
        r = requests.get(
            f"https://gitlab.com/api/v4/projects/{requests.utils.quote(token, safe='')}",
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            return {
                "name": d.get("name"),
                "description": d.get("description"),
                "url": d.get("web_url"),
                "stars": d.get("star_count"),
                "forks": d.get("forks_count"),
                "default_branch": d.get("default_branch"),
            }
        return {"_error": True, "message": f"gitlab '{token}' not found (try a path like 'namespace/project')"}
    except Exception as exc:
        return {"_error": True, "message": f"gitlab fetch failed: {exc}"}


# ---------------------------------------------------------------------------
# Codeberg (uses Gitea API)
# ---------------------------------------------------------------------------

def _codeberg_repo(owner: str, name: str) -> dict:
    try:
        r = requests.get(
            f"https://codeberg.org/api/v1/repos/{owner}/{name}",
            headers={"Accept": "application/json"},
            timeout=10,
        )
        if r.status_code == 404:
            return {"_error": True, "message": f"codeberg repo not found: {owner}/{name}"}
        r.raise_for_status()
        d = r.json()
        return {
            "full_name": d.get("full_name"),
            "description": d.get("description"),
            "language": d.get("language"),
            "stars": d.get("stars_count"),
            "forks": d.get("forks_count"),
            "url": d.get("html_url"),
            "default_branch": d.get("default_branch"),
            "updated_at": d.get("updated_at"),
        }
    except Exception as exc:
        return {"_error": True, "message": f"codeberg fetch failed: {exc}"}


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------

_YT_ID_RE = re.compile(r"(?:v=|youtu\.be/|embed/)([A-Za-z0-9_-]{11})")


def _extract_youtube_id(url: str) -> str | None:
    m = _YT_ID_RE.search(url or "")
    return m.group(1) if m else None


def _youtube_info(url: str) -> dict:
    video_id = _extract_youtube_id(url)
    if not video_id:
        return {"_error": True, "message": f"could not parse YouTube URL: {url}"}
    out: dict = {"video_id": video_id, "url": url}
    # oEmbed for title, author, thumbnail.
    try:
        r = requests.get(
            "https://www.youtube.com/oembed",
            params={"url": url, "format": "json"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            out["title"] = d.get("title")
            out["author"] = d.get("author_name")
            out["thumbnail"] = d.get("thumbnail_url")
            out["embed_html"] = d.get("html")
    except Exception as exc:
        out["oembed_error"] = f"oembed failed: {exc}"
    # Captions via youtube-transcript-api (optional, may not be installed).
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        segments = YouTubeTranscriptApi.get_transcript(video_id)
        out["captions"] = [
            {"t": s.get("start"), "d": s.get("duration"), "text": s.get("text")}
            for s in segments
        ]
        out["transcript"] = " ".join(s.get("text", "") for s in segments)
    except Exception as exc:
        out["captions_error"] = f"captions unavailable: {exc}"
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route("/api/github/repo/<owner>/<name>", methods=["GET"])
    def _gh_repo_route(owner, name):
        return jsonify(_github_repo(owner, name))

    @app.route("/api/github/search", methods=["GET"])
    def _gh_search_route():
        q = request.args.get("q", "").strip()
        limit = int(request.args.get("limit") or 5)
        if not q:
            return jsonify({"_error": True, "message": "q is required"})
        return jsonify(_github_search(q, limit=limit))

    @app.route("/api/gitlab/<path:token>", methods=["GET"])
    def _gitlab_route(token):
        return jsonify(_gitlab_snippet_or_project(token))

    @app.route("/api/codeberg/<owner>/<name>", methods=["GET"])
    def _codeberg_route(owner, name):
        return jsonify(_codeberg_repo(owner, name))

    @app.route("/api/youtube/info", methods=["GET"])
    def _youtube_route():
        url = request.args.get("url", "").strip()
        if not url:
            return jsonify({"_error": True, "message": "url is required"})
        return jsonify(_youtube_info(url))
