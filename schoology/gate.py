"""Age gate for the AI Assistant.

Enforces a "grade 8 and up" policy at the *server* boundary so a hostile
or curious user cannot bypass the JS gate from devtools. The frontend
gate is a UX nicety; this module is the actual guard.

The gate decision is grade-only -- district/school is detected and
stored for diagnostics but is NEVER used to reject. Earlier versions
restricted access to PAUSD only; that check has been removed.

Wire protocol (all routes under /api/gate-*):

  POST /api/gate-check        - run the detect-and-sign flow (one shot)
                                 Body: { termsAcceptedVersion: int }
                                 Auth: Basic <user:pass>
                                 Returns:
                                   200 { ok:true, token, expiresAt,
                                         grade, school }
                                   200 { ok:false, reason:"under_age" }
                                   200 { ok:false, reason:"detection_failed",
                                         message: "..." }
                                   200 { ok:false, reason:"terms_required" }

  POST /api/gate-verify       - validate a previously-issued token without
                                 doing detection. Used internally by
                                 require_gate(); also exposed for the
                                 frontend so it can re-check expiry on
                                 reload without re-running detection.
                                 Body: { token }
                                 Returns:
                                   200 { ok:true, grade, school, expiresAt }
                                   200 { ok:false, reason }

  require_gate(view)          - decorator. Apply to every AI route. Pulls
                                 X-Gate-Token from headers and rejects
                                 with 403 if missing / forged / expired
                                 / not for the current Basic-auth user.

Token shape:
  base64url("{username}|{grade}|{school}|{semester_end_iso}|{terms_ver}|{issued_at}")
    + "." + hex(hmac_sha256(SESSION_SECRET, that))

Tampering with any field breaks the HMAC. Tokens expire on the semester
end the server stamped into them; after that day the cache key changes
and the frontend MUST re-call /api/gate-check.

The detected (grade, school, decision) is also persisted to
<DATA_DIR>/ai_gate/<username>.json so a second device or a re-login
inside the same semester doesn't re-spend a DeepSeek call. Cache key on
disk is the semester_end_iso; when the semester rolls the cache is
ignored and a fresh detection happens.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Optional

from flask import jsonify, request


# Hard-coded PAUSD secondary calendar, mirror of the JS PAUSD_CALENDAR
# in schoology/index.html. The two MUST stay in sync; if you edit one,
# edit the other. Kept here because the server is the source of truth
# for what "this semester" means (the token's expiry).
PAUSD_CALENDAR = {
    '2025': {
        'first_day': '2025-08-14',
        'sem1_end':  '2025-12-19',
        'sem2_end':  '2026-06-04',
    },
    '2026': {
        'first_day': '2026-08-13',
        'sem1_end':  '2026-12-18',
        'sem2_end':  '2027-06-03',
    },
}

MIN_GRADE = 8
TERMS_VERSION = 2   # bumped when the gate policy or Terms wording changes; old tokens invalidate

GATE_DIR = Path(os.environ.get('DATA_DIR', '/data')) / 'ai_gate'

# DeepSeek -- same key the Node app uses (DEEPSEEK_KEY env var).
# When unset (local dev without a key) detection returns
# {ok:false, reason:"detection_failed"} so the frontend shows the
# "designed for PAUSD" notice rather than letting an unverified user
# through.
DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions'
DEEPSEEK_MODEL = 'deepseek-chat'

# In-process per-user rate limit: at most 1 gate-check every 10 s. Stops
# someone from spamming the endpoint to flood DeepSeek or our budget.
_RATE_WINDOW_S = 10
_last_check_at: dict[str, float] = {}


# ---------------------------------------------------------------------------
# Calendar helpers
# ---------------------------------------------------------------------------

def _today_iso() -> str:
    """Today in YYYY-MM-DD, container-local time (set to America/Los_Angeles
    in the Dockerfile if available; otherwise UTC -- both round to the right
    day for the school district 99% of the time)."""
    return datetime.now().strftime('%Y-%m-%d')


def _pick_school_year(today_iso: str) -> Optional[str]:
    """Return the calendar key (e.g. '2026') the given ISO date falls into.
    None if outside every known year."""
    years = sorted(PAUSD_CALENDAR.keys())
    for y in reversed(years):
        if today_iso >= PAUSD_CALENDAR[y]['first_day']:
            return y
    return None


def current_semester_end_iso(today_iso: Optional[str] = None) -> Optional[str]:
    """ISO date the current cached gate-token should expire on. Tokens
    are valid until the end of the semester (or summer-window) the user
    signed up in -- when the semester rolls, the cache key changes and
    the gate re-checks.

    Three cases:
      - Today is in semester 1   -> token expires at sem1_end
      - Today is in semester 2   -> token expires at sem2_end
      - Today is in summer break -> token expires at the next year's
                                    first_day. This keeps the summer
                                    student in the cache for the rest
                                    of the break; come Aug they re-check
                                    and the new year's data sets the new
                                    expiry.

    None if today is outside every hard-coded year (i.e. past the last
    year's lastDay AND no next-year row defined). Callers in that case
    fall back to a one-year-from-today expiry so the cache key still
    rolls forward predictably.
    """
    today = today_iso or _today_iso()
    y = _pick_school_year(today)
    if not y:
        return None
    cal = PAUSD_CALENDAR[y]
    if today <= cal['sem1_end']:
        return cal['sem1_end']
    if today <= cal['sem2_end']:
        return cal['sem2_end']
    # Summer-after-year: between this year's lastDay and the next
    # year's firstDay. Use the next firstDay if we have it, otherwise
    # signal None so the caller picks a safe fallback.
    next_cal = PAUSD_CALENDAR.get(str(int(y) + 1))
    if next_cal:
        return next_cal['first_day']
    return None


# ---------------------------------------------------------------------------
# HMAC token
# ---------------------------------------------------------------------------

def _hmac_key() -> bytes:
    """Server-side signing key. Falls back to the same placeholder the
    Node auth module uses so dev and prod behave the same; in production
    SESSION_SECRET MUST be set."""
    return (os.environ.get('SESSION_SECRET') or 'jimmyqrg-chat-secret-change-in-production').encode('utf-8')


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode('ascii')


def _b64url_decode(s: str) -> bytes:
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode('ascii'))


def _sign(payload: dict) -> str:
    """Sign a payload dict; returns "<base64url(json)>.<hex hmac>"."""
    raw = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    body = _b64url(raw)
    sig = hmac.new(_hmac_key(), body.encode('ascii'), hashlib.sha256).hexdigest()
    return f'{body}.{sig}'


def _verify(token: str) -> Optional[dict]:
    """Decode + HMAC-verify a token. Returns the payload dict, or None
    if the token is malformed, signature is wrong, or it's expired."""
    if not token or not isinstance(token, str) or '.' not in token:
        return None
    body, sig = token.rsplit('.', 1)
    expected = hmac.new(_hmac_key(), body.encode('ascii'), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_b64url_decode(body).decode('utf-8'))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    # Expiry: server-stamped semester end. Once today rolls past that,
    # the token is dead and the client must re-check.
    exp = payload.get('exp')
    if not isinstance(exp, str) or _today_iso() > exp:
        return None
    # Terms version must match the current code; bumping TERMS_VERSION
    # invalidates every outstanding token at once.
    if payload.get('tv') != TERMS_VERSION:
        return None
    # Soft-fail tokens (issued when the gate classifier couldn't
    # determine a grade) carry grade=0 + unv=True. They get through
    # the AI gate; the frontend then re-checks the grade after the
    # dashboard loads. Once /api/grade/confirm mints a regular token
    # (grade >= MIN_GRADE, unv absent/false), the new token supersedes
    # the soft-fail one. Under-grade or missing grade remains a hard
    # reject.
    grade = payload.get('grade')
    if grade is None:
        return None
    if grade < MIN_GRADE and not payload.get('unv'):
        return None
    return payload


# ---------------------------------------------------------------------------
# Persistent per-user cache (so re-login or second device doesn't re-spend
# a DeepSeek call this semester)
# ---------------------------------------------------------------------------

def _safe_username(username: str) -> str:
    return ''.join(c for c in (username or '') if c.isalnum() or c in '._-') or 'anonymous'


def _cache_path(username: str) -> Path:
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    return GATE_DIR / f'{_safe_username(username)}.json'


def _read_cache(username: str, semester_end: str) -> Optional[dict]:
    """Return cached decision if it's for the same semester, else None."""
    p = _cache_path(username)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text('utf-8'))
    except Exception:
        return None
    if data.get('semester_end') != semester_end:
        return None
    if data.get('terms_version') != TERMS_VERSION:
        return None
    return data


def _write_cache(username: str, decision: dict) -> None:
    p = _cache_path(username)
    tmp = p.with_suffix(p.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(decision, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


# ---------------------------------------------------------------------------
# Detection: DeepSeek call against the user's actual schoology data
# ---------------------------------------------------------------------------

_DETECT_SYS_PROMPT = """You are a school-grade classifier. Given a student's
Schoology data (course list + recent post excerpts), return a strict JSON
object with the student's current US K-12 grade level (1-12) and school
abbreviation. Return ONLY the JSON, no prose.

Rules:
- "grade" must be an integer 1-12, or null if you genuinely can't tell.
- "school" should be a short identifier (e.g. "JLS", "Paly", "Gunn",
  "Fletcher", "Greene") or null. This is metadata only -- the gate
  does NOT reject based on school or district.
- "confidence" must be "high", "medium", or "low". Use "high" only if a
  course title literally encodes the grade (e.g. "Social Studies 8",
  "English 9") or a post explicitly says "8th grade".
- Output schema (strict):
  {"grade": int|null, "school": str|null, "confidence": "high"|"medium"|"low"}
"""


def _build_detect_user_msg(courses: list, posts: list) -> str:
    """Compact the courses + posts list into a small prompt body."""
    lines: list[str] = []
    lines.append('Courses:')
    for c in (courses or [])[:30]:
        # Be liberal: upstream shape varies between routes.
        name = (
            c.get('name') if isinstance(c, dict) else None
        ) or (
            c.get('title') if isinstance(c, dict) else None
        ) or (
            c.get('courseName') if isinstance(c, dict) else None
        ) or ''
        if name:
            lines.append(f'- {str(name)[:120]}')
    lines.append('')
    lines.append('Recent posts (author + first sentence):')
    for p in (posts or [])[:10]:
        if not isinstance(p, dict):
            continue
        author = (p.get('author') or '').strip()
        content = (p.get('content') or '').strip().replace('\n', ' ')
        if not author and not content:
            continue
        lines.append(f'- {author}: {content[:200]}')
    return '\n'.join(lines)[:6000]  # hard cap; tokens are cheap but bounded


def _call_deepseek_detect(courses: list, posts: list) -> Optional[dict]:
    """Returns the parsed classifier output, or None on any failure."""
    api_key = os.environ.get('DEEPSEEK_KEY')
    if not api_key:
        # No key -> can't verify. Caller treats this as detection_failed
        # which the frontend renders as the "designed for PAUSD" notice.
        return None
    user_msg = _build_detect_user_msg(courses, posts)
    body = {
        'model': DEEPSEEK_MODEL,
        'messages': [
            {'role': 'system', 'content': _DETECT_SYS_PROMPT},
            {'role': 'user',   'content': user_msg},
        ],
        'temperature': 0,
        'max_tokens': 120,
        'response_format': {'type': 'json_object'},
    }
    req = urllib.request.Request(
        DEEPSEEK_API,
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode('utf-8')
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        print(f'[GATE] DeepSeek call failed: {type(exc).__name__}: {exc}')
        return None
    try:
        envelope = json.loads(raw)
        text = envelope['choices'][0]['message']['content']
        parsed = json.loads(text)
    except Exception as exc:
        print(f'[GATE] DeepSeek response unparseable: {exc!r}; raw={raw[:200]!r}')
        return None
    if not isinstance(parsed, dict):
        return None
    grade = parsed.get('grade')
    school = parsed.get('school')
    confidence = parsed.get('confidence')
    # Type-coerce and bound-check.
    try:
        grade_int = int(grade) if grade is not None else None
    except (TypeError, ValueError):
        grade_int = None
    if grade_int is not None and not (1 <= grade_int <= 12):
        grade_int = None
    return {
        'grade': grade_int,
        'school': str(school)[:32] if isinstance(school, str) else None,
        'confidence': confidence if confidence in ('high', 'medium', 'low') else 'low',
    }


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------

def _rate_limited(username: str) -> bool:
    now = time.monotonic()
    last = _last_check_at.get(username, 0)
    if now - last < _RATE_WINDOW_S:
        return True
    _last_check_at[username] = now
    return False


# ---------------------------------------------------------------------------
# Public Flask routes + decorator
# ---------------------------------------------------------------------------

def _ok_token(username: str, grade: int, school: Optional[str],
              semester_end: str, unverified: bool = False) -> dict:
    payload = {
        'u':    username,
        'grade': int(grade),
        'school': school,
        'unv':  bool(unverified),
        'exp':  semester_end,
        'tv':   TERMS_VERSION,
        'iat':  int(time.time()),
    }
    token = _sign(payload)
    return {
        'ok':           True,
        'token':        token,
        'expiresAt':    semester_end,
        'grade':        int(grade),
        'school':       school,
        'unverified':   bool(unverified),
    }


def _gate_check_view():
    """Handler for POST /api/gate-check."""
    from .server import decode_auth_header, get_data_from_mcp_or_mock  # local to avoid cycle

    username, password = decode_auth_header()
    if not username or not password:
        return jsonify({'ok': False, 'reason': 'auth_required'}), 401

    body = request.get_json(silent=True) or {}
    if body.get('termsAcceptedVersion') != TERMS_VERSION:
        return jsonify({'ok': False, 'reason': 'terms_required',
                        'currentVersion': TERMS_VERSION}), 200

    semester_end = current_semester_end_iso()
    if not semester_end:
        # Outside the hard-coded calendar window. Fall back to one year
        # from today so the cache key still rolls forward predictably.
        semester_end = (datetime.now().replace(year=datetime.now().year + 1)
                        .strftime('%Y-%m-%d'))

    # Cache hit?
    cached = _read_cache(username, semester_end)
    if cached:
        # Gate only cares about grade level. Cached district/school
        # remain on the row for diagnostics but are not enforced.
        if cached.get('grade', 0) >= MIN_GRADE:
            return jsonify(_ok_token(username, cached['grade'],
                                     cached.get('school'), semester_end))
        return jsonify({
            'ok': False,
            'reason': cached.get('reason', 'under_age'),
            'message': cached.get('message'),
            'fromCache': True,
        })

    # Rate limit fresh detections (per-user, in-process).
    if _rate_limited(username):
        return jsonify({'ok': False, 'reason': 'rate_limited',
                        'message': 'Please wait a few seconds and try again.'}), 200

    # Pull the student's data via the per-user daemon. Both calls use
    # AI-priority (priority=0) so the gate beats background dashboard
    # loads -- we want this finished before anything else renders.
    courses_payload = get_data_from_mcp_or_mock('get_courses', username, password,
                                                priority=0, timeout_seconds=120)
    posts_payload = get_data_from_mcp_or_mock('get_recent_posts', username, password,
                                              priority=0, timeout_seconds=120)
    # get_data_from_mcp_or_mock returns either a list (already-unwrapped)
    # or a dict {_error:True,...}. Normalize.
    courses = courses_payload if isinstance(courses_payload, list) else []
    posts = posts_payload if isinstance(posts_payload, list) else []

    if not courses and not posts:
        # No data to classify against. Issue a soft-fail token: the
        # frontend will let the dashboard load, then after data
        # finishes populating try the AI-driven grade detection on
        # the freshly-loaded courses + posts.
        return jsonify(_ok_token(username, grade=0, school=None,
                                 semester_end=semester_end,
                                 unverified=True))

    result = _call_deepseek_detect(courses, posts)
    if not result:
        # Classifier unavailable or unparseable -- same soft-fail path.
        return jsonify(_ok_token(username, grade=0, school=None,
                                 semester_end=semester_end,
                                 unverified=True))

    grade = result['grade']
    school = result['school']

    if grade is None:
        # Couldn't tell the grade from the data. Soft-fail.
        return jsonify(_ok_token(username, grade=0, school=None,
                                 semester_end=semester_end,
                                 unverified=True))

    if grade < MIN_GRADE:
        decision = {
            'grade': grade, 'school': school,
            'reason': 'under_age',
            'message': f'This AI assistant is available to students in grade {MIN_GRADE} and up. Detected grade: {grade}.',
            'semester_end': semester_end,
            'terms_version': TERMS_VERSION,
        }
        _write_cache(username, decision)
        return jsonify({'ok': False, 'reason': decision['reason'],
                        'message': decision['message'],
                        'grade': grade})

    # Pass.
    decision = {
        'grade': grade, 'school': school,
        'reason': 'ok',
        'semester_end': semester_end,
        'terms_version': TERMS_VERSION,
    }
    _write_cache(username, decision)
    return jsonify(_ok_token(username, grade, school, semester_end))


def _gate_verify_view():
    """Handler for POST /api/gate-verify -- validate a token without
    burning a detection round-trip. Used by the frontend on page reload
    so it can short-circuit when its cached token is still good."""
    from .server import decode_auth_header

    username, _ = decode_auth_header()
    if not username:
        return jsonify({'ok': False, 'reason': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    payload = _verify(body.get('token') or '')
    if not payload:
        return jsonify({'ok': False, 'reason': 'invalid_or_expired'})
    # Token must be bound to the currently-authenticated user.
    if payload.get('u') != username:
        return jsonify({'ok': False, 'reason': 'wrong_user'})
    return jsonify({
        'ok': True,
        'grade': payload['grade'],
        'school': payload.get('school'),
        'expiresAt': payload['exp'],
    })


def require_gate(view):
    """Decorator: 403 unless the request carries a valid X-Gate-Token
    bound to the authenticated user.

    Apply this to every AI route (schoology/ai/*.py) so a hostile client
    that bypasses the frontend gate still can't call the AI.

    In practice we apply the same enforcement via the before_request
    hook installed by ``install_gate_middleware(app)`` so individual
    AI routes don't need to remember to decorate themselves. The
    decorator is kept for explicit use or for routes that need to
    enforce the gate but don't match the path-based middleware rules.
    """
    @wraps(view)
    def wrapper(*args, **kwargs):
        from .server import decode_auth_header
        username, _ = decode_auth_header()
        if not username:
            return jsonify({'error': 'auth_required'}), 401
        token = request.headers.get('X-Gate-Token', '')
        payload = _verify(token)
        if not payload:
            return jsonify({'error': 'gate_required',
                            'message': 'AI Assistant is only available to verified PAUSD students in grade 8 or up.'}), 403
        if payload.get('u') != username:
            return jsonify({'error': 'gate_wrong_user'}), 403
        return view(*args, **kwargs)
    return wrapper


# Paths the gate middleware ALWAYS lets through, regardless of token:
#   - the gate endpoints themselves (chicken-and-egg)
#   - the schoology data the gate-check depends on (courses + posts)
#   - infra / setup / non-AI status endpoints
#   - the assistant's static page assets and the / page
# Match is prefix-based for the dashboard endpoints (so query strings
# and dynamic segments are covered) and exact for the gate endpoints.
_GATE_EXEMPT_PREFIXES = (
    '/api/gate-check',
    '/api/gate-verify',
    # Soft-fail re-check: called by the user with only a soft-fail
    # token in hand. If we gated it, the only person who could call it
    # would be the user who just got rejected -- self-defeating.
    # The endpoint itself re-validates the input and only mints a
    # regular token if grade >= MIN_GRADE.
    '/api/grade/confirm',
    '/api/basic-info',
    '/api/courses',
    '/api/grades',
    '/api/assignments',
    '/api/posts',
    '/api/assignment-info',
    '/api/reprioritize',
    '/api/clear-session',
    '/api/status',
    '/api/setup-status',
    '/api/daemon-status',
    '/api/ready',
    '/health',
)


def _path_is_exempt(path: str) -> bool:
    if not path.startswith('/api/'):
        # Static assets, /, /assets/... -- never gated.
        return True
    for p in _GATE_EXEMPT_PREFIXES:
        if path == p or path.startswith(p + '/') or path.startswith(p + '?'):
            return True
    return False


def install_gate_middleware(app):
    """Install a before_request hook that enforces require_gate on every
    /api/* path NOT in the exempt list. New AI routes added under
    schoology/ai/*.py are gated automatically; no per-route decoration
    needed. Add new exempt paths to ``_GATE_EXEMPT_PREFIXES`` above.
    """
    from .server import decode_auth_header

    @app.before_request
    def _gate_guard():
        path = request.path or ''
        if _path_is_exempt(path):
            return None
        # OPTIONS preflight: never block CORS.
        if request.method == 'OPTIONS':
            return None
        username, _ = decode_auth_header()
        if not username:
            return jsonify({'error': 'auth_required'}), 401
        token = request.headers.get('X-Gate-Token', '')
        payload = _verify(token)
        if not payload:
            print(f'[GATE] reject {request.method} {path} user={username!r}: missing/invalid token')
            return jsonify({'error': 'gate_required',
                            'message': 'AI Assistant is only available to verified PAUSD students in grade 8 or up.'}), 403
        if payload.get('u') != username:
            print(f'[GATE] reject {request.method} {path} user={username!r}: token bound to {payload.get("u")!r}')
            return jsonify({'error': 'gate_wrong_user'}), 403
        return None


def _grade_confirm_view():
    """Confirm the detected grade after the dashboard loads.

    Called by the frontend once the AI re-attempted grade detection
    using the freshly-loaded courses + posts. The endpoint re-validates
    the grade, mints a regular (non-soft-fail) token on success, and
    caches the decision so the next reload skips the re-check.

    On under-8, returns the same shape the gate would have -- the
    caller paints the under-8 gate block. On malformed input, the
    caller treats it as "still unknown" and either retries or hard-
    fails.

    Open to soft-fail token holders (it's in the exempt prefix list);
    the endpoint itself is the source of truth.
    """
    from .server import decode_auth_header

    username, _ = decode_auth_header()
    if not username:
        return jsonify({'ok': False, 'reason': 'auth_required'}), 401

    body = request.get_json(silent=True) or {}
    raw_grade = body.get('grade')
    try:
        grade = int(raw_grade) if raw_grade is not None else None
    except (TypeError, ValueError):
        grade = None
    if grade is None or not (1 <= grade <= 12):
        return jsonify({
            'ok': False,
            'reason': 'invalid_grade',
            'message': 'grade must be an integer 1-12.',
        })

    school = (body.get('school') or '').strip() or None
    if school and len(school) > 32:
        school = school[:32]

    semester_end = current_semester_end_iso() or (datetime.now().replace(
        year=datetime.now().year + 1).strftime('%Y-%m-%d'))

    if grade < MIN_GRADE:
        # Cache the under-8 decision so future loads don't loop the
        # same prompt -- the user has been told.
        _write_cache(username, {
            'grade': grade, 'school': school,
            'reason': 'under_age',
            'message': f'This AI assistant is available to students in grade {MIN_GRADE} and up. Detected grade: {grade}.',
            'semester_end': semester_end,
            'terms_version': TERMS_VERSION,
        })
        return jsonify({
            'ok': False,
            'reason': 'under_age',
            'message': f'This AI assistant is available to students in grade {MIN_GRADE} and up. Detected grade: {grade}.',
            'grade': grade,
        })

    # Pass. Cache + mint a regular token.
    _write_cache(username, {
        'grade': grade, 'school': school,
        'reason': 'ok',
        'semester_end': semester_end,
        'terms_version': TERMS_VERSION,
    })
    return jsonify(_ok_token(username, grade, school, semester_end))


def register_routes(app):
    """Register the gate endpoints on the Flask app. Called from
    schoology/ai/__init__.py."""
    app.add_url_rule('/api/gate-check',      view_func=_gate_check_view,      methods=['POST'])
    app.add_url_rule('/api/gate-verify',     view_func=_gate_verify_view,     methods=['POST'])
    app.add_url_rule('/api/grade/confirm',   view_func=_grade_confirm_view,   methods=['POST'])
    install_gate_middleware(app)
