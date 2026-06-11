"""Social / community-opinion tools.

Currently: Reddit. X/Twitter is intentionally not included -- the v2
API costs $200/mo as of 2023, and the unofficial Nitter mirrors are
too brittle to ship to students.

Reddit is read via Reddit's public JSON endpoints
(https://www.reddit.com/r/<sub>/search.json?... and similar). No API
key required. Anonymous limit is roughly 60 requests/minute per IP;
in practice the dashboard's traffic is far below that.

A short, polite User-Agent string is mandatory -- without one, Reddit
returns 429 ("too many requests") almost immediately, even on the first
call. The string identifies the project so Reddit ops can contact us
if the traffic ever becomes a problem.

Two endpoints:

  POST /api/reddit/search
    Body: { q: "...", subreddit?: "askscience", limit?: 5, sort?: "relevance"|"hot"|"top" }
    Returns: { posts: [{ title, subreddit, score, num_comments,
                         permalink, url, author, created_iso,
                         selftext_snippet, over_18 }, ...] }

  POST /api/reddit/comments
    Body: { permalink: "/r/xxx/comments/abc123/title/", limit?: 5 }
    Returns: { post: {...}, comments: [{ author, score, body, ... }] }

Both auto-gated by the schoology gate middleware (they live under
/api/, not in the exempt prefix list). Results are JSON, capped in
size so the AI's context doesn't blow up on a viral thread.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
from typing import Optional

import requests
from flask import jsonify, request


_USER_AGENT = "jchat-ai/1.0 (+https://jchat.fly.dev; school study assistant)"
_REDDIT_TIMEOUT = 10
_MAX_LIMIT = 10
_SELFTEXT_SNIPPET_CHARS = 600
_COMMENT_BODY_CHARS = 400

# In-process per-username rate limit: at most 30 Reddit calls / minute /
# student. Cheap dict + lock, reset on a sliding window. Stops a single
# student from flooding Reddit if the AI loops on a [REDDIT:...] call.
_RATE_WINDOW_S = 60
_RATE_MAX = 30
_calls_by_user: dict[str, list[float]] = {}
_calls_lock = threading.Lock()


def _rate_limited(user_key: str) -> bool:
    now = time.monotonic()
    with _calls_lock:
        bucket = _calls_by_user.setdefault(user_key, [])
        # Drop entries outside the sliding window.
        cutoff = now - _RATE_WINDOW_S
        i = 0
        while i < len(bucket) and bucket[i] < cutoff:
            i += 1
        if i:
            del bucket[:i]
        if len(bucket) >= _RATE_MAX:
            return True
        bucket.append(now)
        return False


def _basic_auth_user() -> str:
    """Pull username from Basic-auth so the rate-limit bucket is per-
    student. Falls back to a shared 'anon' bucket if the request isn't
    authenticated (the gate middleware would have already 401'd, so
    this is purely defensive)."""
    from ..server import decode_auth_header
    u, _ = decode_auth_header()
    return u or 'anon'


def _safe_sub(sub: Optional[str]) -> str:
    """Validate a subreddit name. Reddit subs are [a-z0-9_], max ~21
    chars; an attacker controlled name could otherwise inject a path
    segment into the URL. Empty/invalid input -> '' (search all)."""
    if not sub:
        return ''
    s = str(sub).strip().lstrip('/').lstrip('r/').lstrip('R/').rstrip('/')
    # Allow letters/digits/underscore only, length 2-30 (Reddit caps at 21,
    # but allow some slop in case Reddit relaxes).
    if not s or not all(c.isalnum() or c == '_' for c in s) or not (2 <= len(s) <= 30):
        return ''
    return s


def _safe_permalink(p: Optional[str]) -> str:
    """Reddit comment-page paths look like /r/<sub>/comments/<id>/<slug>/.
    Reject anything else so a malicious permalink can't pivot the
    request off reddit.com."""
    if not p or not isinstance(p, str):
        return ''
    s = p.strip()
    if not s.startswith('/r/'):
        return ''
    # No protocol, no host, no whitespace.
    if any(c in s for c in (' ', '\t', '\n', '?', '#')):
        return ''
    if '//' in s.lstrip('/'):
        return ''
    if not s.endswith('/'):
        s = s + '/'
    return s


def _reddit_get(path: str, params: dict) -> dict:
    """Issue one GET to www.reddit.com and return parsed JSON, or a
    {_error:True} dict on failure. Anonymous (no auth header); only
    sends a polite User-Agent."""
    url = 'https://www.reddit.com' + path
    try:
        r = requests.get(
            url,
            params=params,
            headers={
                'User-Agent': _USER_AGENT,
                'Accept': 'application/json',
            },
            timeout=_REDDIT_TIMEOUT,
        )
    except requests.RequestException as exc:
        return {'_error': True, 'message': f'reddit request failed: {exc}'}
    if r.status_code == 429:
        return {'_error': True, 'message': 'Reddit rate-limited us (HTTP 429). Try again in a minute.'}
    if r.status_code >= 400:
        snippet = (r.text or '')[:160]
        return {'_error': True, 'message': f'Reddit returned HTTP {r.status_code}: {snippet}'}
    try:
        return r.json()
    except ValueError:
        return {'_error': True, 'message': 'Reddit returned non-JSON'}


def _trim(s, n):
    if not s:
        return ''
    s = str(s)
    if len(s) <= n:
        return s
    return s[:n].rstrip() + '…'


def _format_post(child: dict) -> dict:
    """Reduce a Reddit listing child to the fields the AI actually
    needs. Drops thumbnails, awards, mod flags, etc."""
    if not isinstance(child, dict):
        return {}
    d = child.get('data') if isinstance(child.get('data'), dict) else child
    created = d.get('created_utc')
    iso = ''
    if created:
        try:
            iso = time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(float(created)))
        except (ValueError, TypeError):
            iso = ''
    return {
        'title':            _trim(d.get('title'), 250),
        'subreddit':        d.get('subreddit') or '',
        'score':            int(d.get('score') or 0),
        'num_comments':     int(d.get('num_comments') or 0),
        'permalink':        d.get('permalink') or '',
        'url':              d.get('url') or '',
        'author':           d.get('author') or '',
        'created_iso':      iso,
        'selftext_snippet': _trim(d.get('selftext'), _SELFTEXT_SNIPPET_CHARS),
        'over_18':          bool(d.get('over_18')),
    }


def _format_comment(child: dict) -> dict:
    if not isinstance(child, dict):
        return {}
    d = child.get('data') if isinstance(child.get('data'), dict) else child
    if d.get('body') in (None, '', '[deleted]', '[removed]'):
        return {}
    created = d.get('created_utc')
    iso = ''
    if created:
        try:
            iso = time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(float(created)))
        except (ValueError, TypeError):
            iso = ''
    return {
        'author':      d.get('author') or '',
        'score':       int(d.get('score') or 0),
        'body':        _trim(d.get('body'), _COMMENT_BODY_CHARS),
        'created_iso': iso,
        'is_op':       bool(d.get('is_submitter')),
    }


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route('/api/reddit/search', methods=['POST'])
    def _reddit_search_route():
        payload = request.get_json(silent=True) or {}
        q = (payload.get('q') or '').strip()
        if not q:
            return jsonify({'_error': True, 'message': 'q is required'})
        if len(q) > 200:
            q = q[:200]

        # Subreddit is optional. If present and valid, we hit
        # /r/<sub>/search; if not, we hit the site-wide /search.
        sub = _safe_sub(payload.get('subreddit'))

        try:
            limit = int(payload.get('limit') or 5)
        except (TypeError, ValueError):
            limit = 5
        limit = max(1, min(_MAX_LIMIT, limit))

        sort = payload.get('sort')
        if sort not in ('relevance', 'hot', 'top', 'new', 'comments'):
            sort = 'relevance'

        user_key = _basic_auth_user()
        if _rate_limited(user_key):
            return jsonify({'_error': True,
                            'message': f'Reddit rate limit: max {_RATE_MAX} searches/min/student.'})

        path = f'/r/{sub}/search.json' if sub else '/search.json'
        params = {
            'q':       q,
            'limit':   limit,
            'sort':    sort,
            'raw_json': 1,
            't':       'year',  # cap "top" to the past year so results stay relevant
        }
        if sub:
            params['restrict_sr'] = '1'

        raw = _reddit_get(path, params)
        if isinstance(raw, dict) and raw.get('_error'):
            return jsonify(raw)

        try:
            children = raw['data']['children']
        except (KeyError, TypeError):
            return jsonify({'_error': True, 'message': 'Unexpected Reddit response shape'})

        posts = [_format_post(c) for c in (children or [])]
        posts = [p for p in posts if p.get('title')][:limit]

        return jsonify({
            'q':         q,
            'subreddit': sub or None,
            'sort':      sort,
            'count':     len(posts),
            'posts':     posts,
        })

    @app.route('/api/reddit/comments', methods=['POST'])
    def _reddit_comments_route():
        payload = request.get_json(silent=True) or {}
        permalink = _safe_permalink(payload.get('permalink'))
        if not permalink:
            return jsonify({'_error': True,
                            'message': 'permalink is required (e.g. /r/sub/comments/abc/title/)'})
        try:
            limit = int(payload.get('limit') or 5)
        except (TypeError, ValueError):
            limit = 5
        limit = max(1, min(_MAX_LIMIT, limit))

        user_key = _basic_auth_user()
        if _rate_limited(user_key):
            return jsonify({'_error': True,
                            'message': f'Reddit rate limit: max {_RATE_MAX} requests/min/student.'})

        # /r/.../.json returns a 2-element array: [post listing, comments listing].
        # `sort=top` orders comments by upvotes, which is what students
        # actually want when looking at "what's the popular take here".
        raw = _reddit_get(permalink.rstrip('/') + '.json', {
            'limit':    limit,
            'sort':     'top',
            'raw_json': 1,
        })
        if isinstance(raw, dict) and raw.get('_error'):
            return jsonify(raw)
        if not isinstance(raw, list) or len(raw) < 2:
            return jsonify({'_error': True, 'message': 'Unexpected Reddit comment response shape'})

        try:
            post_children = raw[0]['data']['children']
            comment_children = raw[1]['data']['children']
        except (KeyError, TypeError):
            return jsonify({'_error': True, 'message': 'Could not parse Reddit response'})

        post = _format_post(post_children[0]) if post_children else None
        comments = [_format_comment(c) for c in (comment_children or [])]
        # Drop the "load more" stubs and deleted/removed comments that
        # _format_comment returned empty for.
        comments = [c for c in comments if c.get('body')]
        # Sort by score desc just to be sure (Reddit's listing is
        # already sorted, but a removed-mod-comment can leave gaps).
        comments.sort(key=lambda c: -int(c.get('score') or 0))
        comments = comments[:limit]

        return jsonify({
            'permalink': permalink,
            'post':      post,
            'count':     len(comments),
            'comments':  comments,
        })
