"""Server-side cached positive GPA message.

When the dashboard loads, the overview tab asks for a short,
encouraging AI message about the student's GPA. To avoid making an
AI call on every page load, we cache the message per user and only
regenerate when:

  1. The student's GPA has changed (different value than what was
     cached), OR
  2. More than 7 days have passed since the last generation.

The cache lives in /data/gpa_messages/<username>.json. Each entry
has:
  {
    "gpa": 3.62,                  // float | null
    "count": 5, "total": 6,        // grade-count snapshot at gen time
    "generated_at": 1700000000000, // ms epoch
    "message": "...",              // the AI-generated text
  }

The message is plain prose (1-2 sentences), positive without being
cheesy, and references the actual GPA + grade count so it doesn't
sound generic.

The AI call uses the same DeepSeek endpoint as the rest of the
pipeline. We deliberately use a tiny model call (max_tokens 200,
single turn) since the message is short.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from flask import jsonify, request

# Reuse the same DeepSeek config as the 5-layer pipeline.
DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions'
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_TIMEOUT = int(os.environ.get('GPA_MESSAGE_TIMEOUT', '30'))
REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000  # 7 days


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def _safe_username(username: str) -> str:
    """Username -> safe filename component."""
    return ''.join(c for c in (username or '') if c.isalnum() or c in '._-') or 'anonymous'


def _gpa_message_path(username: str) -> Path:
    base = Path(os.environ.get('DATA_DIR', '/data)) / 'gpa_messages'
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{_safe_username(username)}.json"


def _read_cache(username: str) -> Optional[dict]:
    p = _gpa_message_path(username)
    if not p.exists():
        return None
    try:
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(username: str, data: dict) -> None:
    p = _gpa_message_path(username)
    tmp = p.with_suffix(p.suffix + '.tmp')
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, p)
    except OSError:
        # Don't fail the request just because the cache write missed.
        pass


# ---------------------------------------------------------------------------
# AI call
# ---------------------------------------------------------------------------

GPA_SYSTEM_PROMPT = """You are a friendly assistant writing a SHORT, POSITIVE 1-2 sentence message about a student's current GPA, to be shown next to the GPA number on their dashboard overview.

Rules:
  - Stay factual: mention the GPA value and the grade count if provided.
  - Be warm and encouraging, NOT preachy or condescending.
  - 1-2 sentences MAX. Aim for under 35 words.
  - No emoji unless one emoji adds value.
  - Don't moralize or add unsolicited advice ("keep up the hard work!" etc. unless very brief).
  - Don't repeat grades the student already sees.
  - Output ONLY the message text. No JSON wrapper, no preamble, no closing line.

If the student's GPA is low, the message should be brief, supportive, and forward-looking (one short sentence) -- still positive but honest.
If the GPA is null (no graded courses yet), say something encouraging about getting started without inventing a number.
"""


def _generate_message(gpa: Optional[float], count: int, total: int) -> Optional[str]:
    api_key = os.environ.get('DEEPSEEK_KEY')
    if not api_key:
        return None
    gpa_str = f"{gpa:.2f}" if gpa is not None else 'N/A'
    user_msg = (
        f"GPA: {gpa_str}\n"
        f"Graded courses: {count} of {total}\n\n"
        "Write the short positive message for this student."
    )
    body = {
        'model': DEEPSEEK_MODEL,
        'messages': [
            {'role': 'system', 'content': GPA_SYSTEM_PROMPT},
            {'role': 'user',   'content': user_msg},
        ],
        'temperature': 0.7,
        'max_tokens': 200,
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
        with urllib.request.urlopen(req, timeout=DEEPSEEK_TIMEOUT) as resp:
            raw = resp.read().decode('utf-8')
        data = json.loads(raw)
        msg = data['choices'][0]['message']['content'].strip()
        return msg or None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError, json.JSONDecodeError):
        return None


def _should_regenerate(cached: Optional[dict], current_gpa: Optional[float],
                       count: int, total: int, now_ms: int) -> bool:
    if cached is None:
        return True
    # GPA changed (with a small tolerance -- round to 2 decimals to
    # avoid regenerating on a sub-rounding-unit bump).
    cached_gpa = cached.get('gpa')
    if cached_gpa is None and current_gpa is None:
        pass  # both null -- don't treat as changed just for that
    elif cached_gpa is None or current_gpa is None:
        return True
    elif abs(round(cached_gpa, 2) - round(current_gpa, 2)) > 0.005:
        return True
    # Counts changed (e.g. a new grade was added or removed).
    if cached.get('count') != count or cached.get('total') != total:
        return True
    # Stale.
    if (now_ms - int(cached.get('generated_at') or 0)) > REFRESH_AFTER_MS:
        return True
    return False


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route('/api/gpa-message', methods=['GET'])
    def _gpa_message_route():
        from ..server import decode_auth_header
        from ..gate import _verify

        username, _ = decode_auth_header()
        if not username:
            return jsonify({'error': 'auth_required'}), 401
        token = request.headers.get('X-Gate-Token', '')
        if not _verify(token):
            return jsonify({'error': 'gate_required'}), 403

        # The frontend posts the current GPA snapshot in the body of the
        # GET (yes, GET with body -- avoids needing query params and
        # matches the layered endpoint convention).
        body = request.get_json(silent=True) or {}
        gpa = body.get('gpa')
        try:
            gpa_f = float(gpa) if gpa is not None else None
        except (TypeError, ValueError):
            gpa_f = None
        count = int(body.get('count') or 0)
        total = int(body.get('total') or 0)

        now_ms = int(time.time() * 1000)
        cached = _read_cache(username)
        if _should_regenerate(cached, gpa_f, count, total, now_ms):
            msg = _generate_message(gpa_f, count, total)
            if msg:
                _write_cache(username, {
                    'gpa': gpa_f,
                    'count': count,
                    'total': total,
                    'generated_at': now_ms,
                    'message': msg,
                })
                cached = {
                    'gpa': gpa_f,
                    'count': count,
                    'total': total,
                    'generated_at': now_ms,
                    'message': msg,
                }
            else:
                # AI call failed. Serve whatever stale cache we have, or
                # None (frontend can fall back to a placeholder).
                if cached is None:
                    return jsonify({'message': None, 'cached': False, 'error': 'ai_unavailable'}), 200
        return jsonify({
            'message': (cached or {}).get('message'),
            'generated_at': (cached or {}).get('generated_at'),
            'gpa': (cached or {}).get('gpa'),
            'count': (cached or {}).get('count'),
            'total': (cached or {}).get('total'),
            'cached': True,
        })