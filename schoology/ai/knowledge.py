"""Knowledge tools: Wikipedia (summary, full article, search, random,
sections), DuckDuckGo instant-answer web search, and arXiv academic search.

We proxy the public APIs server-side so the frontend doesn't have to
handle CORS or remember each endpoint's URL. The browser fetches
/api/... and gets back the same JSON the original API returns.
"""

import json
import urllib.parse

import requests
from flask import jsonify, request


WIKI_REST = "https://en.wikipedia.org/api/rest_v1"
WIKI_API = "https://en.wikipedia.org/w/api.php"
DDG_INSTANT = "https://api.duckduckgo.com/"
ARXIV_API = "http://export.arxiv.org/api/query"


def _get(url: str, params: dict | None = None, timeout: int = 10, headers: dict | None = None):
    """Helper: GET a URL, return parsed JSON, or {error: ...} on failure."""
    try:
        h = {"User-Agent": "jchat-schoology-ai/1.0"}
        if headers:
            h.update(headers)
        r = requests.get(url, params=params or {}, timeout=timeout, headers=h)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        return {"_error": True, "message": str(exc)}


# ---------------------------------------------------------------------------
# Wikipedia
# ---------------------------------------------------------------------------

def _wiki_summary(topic: str) -> dict:
    title = topic.replace(" ", "_")
    data = _get(f"{WIKI_REST}/page/summary/{urllib.parse.quote(title)}")
    if "_error" in data:
        return data
    thumb = (data.get("thumbnail") or {}).get("source")
    return {
        "title": data.get("title"),
        "description": data.get("description"),
        "extract": data.get("extract"),
        "url": data.get("content_urls", {}).get("desktop", {}).get("page"),
        "thumbnail": thumb,
    }


def _wiki_article(topic: str, sections_only: bool = False) -> dict:
    title = topic.replace(" ", "_")
    if sections_only:
        data = _get(f"{WIKI_REST}/page/summary/{urllib.parse.quote(title)}")
        if "_error" in data:
            return data
    # Get the plain text body via the REST mobile-sections endpoint; it
    # returns a flat list of sections we can stitch together.
    data = _get(f"{WIKI_REST}/page/mobile-sections/{urllib.parse.quote(title)}")
    if "_error" in data:
        return data
    lead = data.get("lead", {})
    sections = data.get("remaining", {}).get("sections", [])
    out_sections = []
    for s in sections:
        out_sections.append({
            "id": s.get("id"),
            "title": s.get("line"),
            "level": s.get("toclevel", 1),
        })
    if sections_only:
        return {"title": lead.get("displaytitle") or title, "sections": out_sections}
    # Build a single plain-text body (truncate hard at 50k chars).
    parts = [re_strip_tags(lead.get("sections", [{}])[0].get("text", ""))]
    for s in sections[:30]:  # cap number of sections
        for sec in s.get("sections", []):
            parts.append(re_strip_tags(sec.get("text", "")))
    text = "\n\n".join(p for p in parts if p)
    if len(text) > 50_000:
        text = text[:50_000] + "...(truncated)"
    return {
        "title": lead.get("displaytitle") or title,
        "text": text,
        "sections": out_sections,
    }


def _wiki_search(q: str, limit: int = 5) -> dict:
    params = {
        "action": "query",
        "list": "search",
        "srsearch": q,
        "srlimit": str(limit),
        "format": "json",
        "origin": "*",
    }
    data = _get(WIKI_API, params)
    if "_error" in data:
        return data
    results = []
    for hit in data.get("query", {}).get("search", []):
        results.append({
            "title": hit.get("title"),
            "snippet": re_strip_tags(hit.get("snippet", "")),
            "pageid": hit.get("pageid"),
        })
    return {"query": q, "results": results, "count": len(results)}


def _wiki_random() -> dict:
    data = _get(f"{WIKI_REST}/page/random/summary")
    if "_error" in data:
        return data
    return {
        "title": data.get("title"),
        "description": data.get("description"),
        "extract": data.get("extract"),
        "url": data.get("content_urls", {}).get("desktop", {}).get("page"),
    }


def re_strip_tags(html: str) -> str:
    """Quickly strip HTML tags from a string. Wikipedia REST returns
    HTML bodies; we want plain text to put in the model context."""
    import re
    s = re.sub(r"<[^>]+>", "", html or "")
    s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    return s.strip()


# ---------------------------------------------------------------------------
# Web search (DuckDuckGo instant answer + Wikipedia fallback)
# ---------------------------------------------------------------------------

def _search_web(q: str) -> dict:
    params = {"q": q, "format": "json", "no_html": "1", "skip_disambig": "1"}
    data = _get(DDG_INSTANT, params)
    abstract = data.get("AbstractText") if isinstance(data, dict) else None
    answer = data.get("Answer") if isinstance(data, dict) else None
    related = []
    if isinstance(data, dict):
        for r in data.get("RelatedTopics", []) or []:
            if isinstance(r, dict) and r.get("Text"):
                related.append({"text": r["Text"], "url": r.get("FirstURL")})
    # Wikipedia fallback if DDG had nothing.
    if not abstract and not answer and not related:
        wiki = _wiki_summary(q)
        if "_error" not in wiki and wiki.get("extract"):
            return {
                "source": "wikipedia",
                "query": q,
                "abstract": wiki.get("extract"),
                "title": wiki.get("title"),
                "url": wiki.get("url"),
                "related": [],
            }
    return {
        "source": "duckduckgo",
        "query": q,
        "abstract": abstract,
        "answer": answer,
        "related": related[:8],
    }


# ---------------------------------------------------------------------------
# arXiv
# ---------------------------------------------------------------------------

def _search_arxiv(q: str, limit: int = 5) -> dict:
    try:
        r = requests.get(
            ARXIV_API,
            params={"search_query": q, "start": 0, "max_results": limit},
            timeout=15,
        )
        r.raise_for_status()
    except Exception as exc:
        return {"_error": True, "message": str(exc)}
    # arXiv returns Atom XML; parse with ElementTree.
    from xml.etree import ElementTree as ET
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    try:
        root = ET.fromstring(r.text)
    except ET.ParseError as exc:
        return {"_error": True, "message": f"could not parse arXiv response: {exc}"}
    out = []
    for entry in root.findall("atom:entry", ns):
        title = (entry.findtext("atom:title", default="", namespaces=ns) or "").strip()
        summary = (entry.findtext("atom:summary", default="", namespaces=ns) or "").strip()
        authors = [a.findtext("atom:name", default="", namespaces=ns) for a in entry.findall("atom:author", ns)]
        pdf_link = ""
        for link in entry.findall("atom:link", ns):
            if link.get("title") == "pdf":
                pdf_link = link.get("href") or ""
        out.append({
            "title": title,
            "authors": [a for a in authors if a],
            "summary": summary[:600] + ("..." if len(summary) > 600 else ""),
            "pdf": pdf_link,
        })
    return {"query": q, "results": out, "count": len(out)}


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route("/api/wiki/summary", methods=["GET"])
    def _wiki_summary_route():
        topic = request.args.get("topic", "").strip()
        if not topic:
            return jsonify({"_error": True, "message": "topic is required"})
        return jsonify(_wiki_summary(topic))

    @app.route("/api/wiki/article", methods=["GET"])
    def _wiki_article_route():
        topic = request.args.get("topic", "").strip()
        sections_only = request.args.get("sections", "").lower() in ("1", "true", "yes")
        if not topic:
            return jsonify({"_error": True, "message": "topic is required"})
        return jsonify(_wiki_article(topic, sections_only=sections_only))

    @app.route("/api/wiki/search", methods=["GET"])
    def _wiki_search_route():
        q = request.args.get("q", "").strip()
        limit = int(request.args.get("limit") or 5)
        if not q:
            return jsonify({"_error": True, "message": "q is required"})
        return jsonify(_wiki_search(q, limit=limit))

    @app.route("/api/wiki/random", methods=["GET"])
    def _wiki_random_route():
        return jsonify(_wiki_random())

    @app.route("/api/search/web", methods=["GET"])
    def _search_web_route():
        q = request.args.get("q", "").strip()
        if not q:
            return jsonify({"_error": True, "message": "q is required"})
        return jsonify(_search_web(q))

    @app.route("/api/search/arxiv", methods=["GET"])
    def _search_arxiv_route():
        q = request.args.get("q", "").strip()
        limit = int(request.args.get("limit") or 5)
        if not q:
            return jsonify({"_error": True, "message": "q is required"})
        return jsonify(_search_arxiv(q, limit=limit))
