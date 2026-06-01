#!/usr/bin/env python3
"""
Schoology Frontend Server
Bridges the web dashboard to the Schoology tool functions.

Each tool call is run in a fresh subprocess that calls the tool function
directly (no MCP stdio protocol). This avoids the result-loss race that
happens when the MCP one-shot process exits mid-cleanup.
"""

import base64
import json
import os
import subprocess
import sys
import threading
import traceback
from pathlib import Path
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.')
CORS(app)

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent
MCP_DIR = SCRIPT_DIR.parent / 'schoology-mcp'
VENV_PYTHON = str(MCP_DIR.parent / '.schoology-venv' / 'bin' / 'python')
RUN_TOOL_PY = str(SCRIPT_DIR / 'run_tool.py')


def decode_auth_header():
    """Decode Basic Auth header and return (username, password) or (None, None)."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Basic '):
        return None, None
    try:
        encoded = auth[6:]  # Remove 'Basic ' prefix
        decoded = base64.b64decode(encoded).decode('utf-8')
        username, password = decoded.split(':', 1)
        return username, password
    except Exception:
        return None, None


# Serialize tool subprocesses per gunicorn worker to avoid 16 simultaneous
# Chromium launches on 512MB RAM.
_subprocess_lock = threading.Lock()


class FetchQueue:
    """Priority fetch queue for tool subprocesses.

    Each submission runs as a daemon thread that takes the global subprocess
    lock (so still serializes within one gunicorn worker because of memory
    limits) and writes its result back into the queue item. The submitter
    gets a (Event, item_ref) pair; the Event fires when the result is ready.

    Priority: lower value = served sooner. Background loads use 10; AI-priority
    loads use 0. Within a priority band, FIFO.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._counter = 0
        self._items = []  # list of [priority, seq, tool_name, username, password, event, result]

    def submit(self, tool_name, username, password, priority=10):
        """Enqueue a fetch and start a worker thread. Returns (event, item_ref)."""
        with self._lock:
            self._counter += 1
            item = [priority, self._counter, tool_name, username, password, threading.Event(), None]
            self._items.append(item)
            self._items.sort(key=lambda x: (x[0], x[1]))
            threading.Thread(target=self._worker, args=(item,), daemon=True).start()
        return item[5], item

    def _worker(self, item):
        with _subprocess_lock:
            result = call_mcp_tool_with_timeout(item[2], item[3], item[4])
            item[6] = result
        item[5].set()

    def reprioritize(self, new_priority, predicate=None):
        """Re-rank queued (not yet finished) items to new_priority if predicate matches.

        Default predicate: reprioritize everything currently at AI priority (< 10)
        to new_priority. Pass a custom callable to target a specific item.
        """
        with self._lock:
            for item in self._items:
                if not item[5].is_set() and (predicate is None or predicate(item)):
                    item[0] = new_priority
            self._items.sort(key=lambda x: (x[0], x[1]))


# Singleton
_fetch_queue = FetchQueue()


def call_mcp_tool_with_timeout(tool_name, username=None, password=None, timeout_seconds=180):
    """Call a tool by running run_tool.py in a fresh subprocess.

    Returns the parsed JSON dict from the subprocess, or None on failure.
    """
    import time
    request_payload = {
        "tool": tool_name,
        "username": username,
        "password": password,
        "arguments": {},
    }
    print(f"[MCP] >>> {tool_name} start: user={username} timeout={timeout_seconds}s cmd={RUN_TOOL_PY}", file=sys.stderr)
    start = time.monotonic()

    with _subprocess_lock:
        print(f"[MCP] {tool_name} acquired subprocess lock at t+{time.monotonic()-start:.1f}s", file=sys.stderr)
        try:
            proc = subprocess.run(
                [VENV_PYTHON, RUN_TOOL_PY],
                input=json.dumps(request_payload),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        except subprocess.TimeoutExpired as exc:
            elapsed = time.monotonic() - start
            print(f"[MCP] !!! {tool_name} TIMED OUT after {timeout_seconds}s ({elapsed:.1f}s wall) for {username}", file=sys.stderr)
            if exc.stderr:
                print(f"[MCP] {tool_name} subprocess stderr on timeout (last 40 lines):", file=sys.stderr)
                for line in exc.stderr.splitlines()[-40:]:
                    print(f"[tool] {line}", file=sys.stderr)
            else:
                print(f"[MCP] {tool_name} subprocess stderr on timeout: <empty>", file=sys.stderr)
            return None
        except Exception as exc:
            print(f"[MCP] !!! {tool_name} subprocess failed to start: {type(exc).__name__}: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return None

    elapsed = time.monotonic() - start
    print(f"[MCP] <<< {tool_name} subprocess returned: rc={proc.returncode} t+{elapsed:.1f}s stdout_bytes={len(proc.stdout)} stderr_bytes={len(proc.stderr)}", file=sys.stderr)

    if proc.stderr:
        print(f"[MCP] {tool_name} subprocess stderr (last 40 lines):", file=sys.stderr)
        for line in proc.stderr.splitlines()[-40:]:
            print(f"[tool] {line}", file=sys.stderr)

    if proc.returncode != 0 and not proc.stdout:
        print(f"[MCP] {tool_name} exited {proc.returncode} with no stdout. stderr_tail={proc.stderr[-500:]!r}", file=sys.stderr)
        return None

    if not proc.stdout.strip():
        print(f"[MCP] {tool_name} produced empty stdout. stderr_tail={proc.stderr[-500:]!r}", file=sys.stderr)
        return None

    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        if isinstance(result, dict) and result.get('_error'):
            print(f"[MCP] {tool_name} returned error from tool: {result.get('message', '?')!r}", file=sys.stderr)
        else:
            keys = list(result.keys()) if isinstance(result, dict) else type(result).__name__
            print(f"[MCP] {tool_name} success t+{elapsed:.1f}s: keys={keys}", file=sys.stderr)
        return result
    except Exception as exc:
        print(f"[MCP] {tool_name} returned unparseable JSON: {proc.stdout[:200]!r} ({exc})", file=sys.stderr)
        return None


def get_mock_data():
    """Return demo/mock data for when MCP server is not available."""
    return {
        'grades': [
            {'courseName': 'AP Calculus BC', 'teacher': 'Dr. Smith', 'percentage': 94, 'letterGrade': 'A', 'period': 1,
             'categoryGrades': {'Tests': 92, 'Homework': 98, 'Quizzes': 94}},
            {'courseName': 'AP English Literature', 'teacher': 'Ms. Johnson', 'percentage': 88, 'letterGrade': 'B+', 'period': 2,
             'categoryGrades': {'Essays': 85, 'Participation': 95}},
            {'courseName': 'AP Physics C: Mechanics', 'teacher': 'Mr. Williams', 'percentage': 91, 'letterGrade': 'A-', 'period': 3,
             'categoryGrades': {'Labs': 93, 'Tests': 90}},
            {'courseName': 'Computer Science Principles', 'teacher': 'Ms. Davis', 'percentage': 96, 'letterGrade': 'A', 'period': 4,
             'categoryGrades': {'Projects': 98, 'Tests': 94}},
            {'courseName': 'AP US History', 'teacher': 'Mr. Brown', 'percentage': 85, 'letterGrade': 'B', 'period': 5,
             'categoryGrades': {'Essays': 82, 'Tests': 88}},
            {'courseName': 'Spanish Language', 'teacher': 'Sra. Martinez', 'percentage': 92, 'letterGrade': 'A-', 'period': 6,
             'categoryGrades': {'Speaking': 94, 'Writing': 90}}
        ],
        'courses': [
            {'name': 'AP Calculus BC', 'teacher': 'Dr. Smith', 'period': 1, 'room': 'M-101'},
            {'name': 'AP English Literature', 'teacher': 'Ms. Johnson', 'period': 2, 'room': 'E-205'},
            {'name': 'AP Physics C: Mechanics', 'teacher': 'Mr. Williams', 'period': 3, 'room': 'P-302'},
            {'name': 'Computer Science Principles', 'teacher': 'Ms. Davis', 'period': 4, 'room': 'T-101'},
            {'name': 'AP US History', 'teacher': 'Mr. Brown', 'period': 5, 'room': 'H-104'},
            {'name': 'Spanish Language', 'teacher': 'Sra. Martinez', 'period': 6, 'room': 'F-201'}
        ],
        'assignments': [
            {'title': 'Calculus Chapter 7 Test', 'courseName': 'AP Calculus BC', 'dueDate': '2026-05-25', 'points': 100},
            {'title': 'Hamlet Analysis Essay', 'courseName': 'AP English Literature', 'dueDate': '2026-05-23', 'points': 50},
            {'title': 'Momentum Lab Report', 'courseName': 'AP Physics C: Mechanics', 'dueDate': '2026-05-24', 'points': 30},
            {'title': 'Final Project Iteration 3', 'courseName': 'Computer Science Principles', 'dueDate': '2026-05-26', 'points': 100},
            {'title': 'Civil Rights DBQ', 'courseName': 'AP US History', 'dueDate': '2026-05-27', 'points': 45},
            {'title': 'Conversation Practice', 'courseName': 'Spanish Language', 'dueDate': '2026-05-22', 'points': 20}
        ],
        'posts': [
            {'author': 'Dr. Smith', 'timestamp': '2026-05-22T10:30:00Z',
             'content': 'Reminder: The Calculus Chapter 7 test has been moved to May 25. Please review integration techniques and application problems.',
             'attachments': [{'name': 'Review_Packet.pdf', 'type': 'pdf'}]},
            {'author': 'Ms. Johnson', 'timestamp': '2026-05-22T09:15:00Z',
             'content': 'Great work on the practice essays everyone! Your thesis statements have improved significantly. Office hours Thursday if you need help with Hamlet.',
             'attachments': []},
            {'author': 'Mr. Williams', 'timestamp': '2026-05-21T14:45:00Z',
             'content': 'Lab reports due Friday. Make sure to include error analysis and proper significant figures.',
             'attachments': [{'name': 'Sample_Lab_Report.docx', 'type': 'doc'}]},
            {'author': 'Ms. Davis', 'timestamp': '2026-05-21T11:00:00Z',
             'content': 'Final project presentations start next week. Sign up for a slot in the shared spreadsheet.',
             'attachments': [{'name': 'Presentation_Schedule.xlsx', 'type': 'xlsx'}]},
            {'author': 'Sra. Martinez', 'timestamp': '2026-05-20T16:30:00Z',
             'content': 'Conjugation quiz moved to Monday. Study irregular verbs in present tense and stem-changing verbs.',
             'attachments': []}
        ]
    }


def get_data_from_mcp_or_mock(tool_name, username=None, password=None, timeout_seconds=180, priority=10):
    """Try MCP first, fall back to error response (no mock data).

    Args:
        tool_name: Name of the MCP tool to call
        username: Student ID for authentication
        password: Schoology password for authentication
        timeout_seconds: hard timeout for the subprocess
        priority: 0 = AI, 10 = background. Lower runs sooner in the queue.

    NOTE: First call for a user takes ~90s (cold browser + ClassLink login on 512MB Fly.io).
          Subsequent calls take ~3-5s (warm browser reuse).
    """
    import sys
    print(f"[DEBUG] get_data_from_mcp_or_mock called: tool={tool_name}, username={username}, priority={priority}", file=sys.stderr)

    if priority <= 0:
        # AI-priority: enqueue and wait
        evt, item = _fetch_queue.submit(tool_name, username, password, priority=0)
        if not evt.wait(timeout=timeout_seconds):
            print(f"[DEBUG] {tool_name} AI-priority queue wait timed out after {timeout_seconds}s", file=sys.stderr)
            return {'_error': True, 'message': f'{tool_name} timeout'}
        data = item[6]
    else:
        data = call_mcp_tool_with_timeout(tool_name, username=username, password=password, timeout_seconds=timeout_seconds)
    print(f"[DEBUG] MCP returned: {type(data).__name__} = {repr(data)[:300]}" if data else f"[DEBUG] MCP returned None", file=sys.stderr)

    # Check for error in CallToolResult
    if data is not None and hasattr(data, 'content') and isinstance(data.content, list):
        for item in data.content:
            if hasattr(item, 'text') and 'Error executing tool' in item.text:
                print(f"[DEBUG] MCP returned error: {item.text[:200]}", file=sys.stderr)
                data = None
                break

    if data is not None:
        # MCP returns dicts with keys like "courses", "assignments", "posts"
        if isinstance(data, dict):
            if data.get('_error'):
                return {'_error': True, 'message': data.get('message', 'unknown error')}
            if 'courses' in data:
                print(f"[DEBUG] Returning courses array with {len(data.get('courses', []))} items", file=sys.stderr)
                return data['courses']
            if 'assignments' in data:
                print(f"[DEBUG] Returning assignments array with {len(data.get('assignments', []))} items", file=sys.stderr)
                return data['assignments']
            if 'posts' in data:
                print(f"[DEBUG] Returning posts array with {len(data.get('posts', []))} items", file=sys.stderr)
                return data['posts']
            if 'grades' in data and 'courses' in data['grades']:
                print(f"[DEBUG] Returning grade courses with {len(data['grades']['courses'])} items", file=sys.stderr)
                return data['grades']['courses']
        # Not a dict we recognize and not None - fall back to mock
        print(f"[DEBUG] Returning raw data (not a recognized dict), falling back to mock", file=sys.stderr)
        data = None

    print(f"[DEBUG] MCP failed for {tool_name}, returning error response", file=sys.stderr)
    # Return error response WITHOUT mock data - frontend should show error state, not demo info
    return {'_error': True, 'message': f'MCP call failed for {tool_name}'}


@app.route('/')
def index():
    """Serve the main HTML page."""
    return send_from_directory('.', 'index.html')


@app.route('/health')
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'service': 'schoology-mcp-frontend',
        'timestamp': datetime.now().isoformat(),
        'mcp_available': os.path.exists(VENV_PYTHON) and os.path.exists(RUN_TOOL_PY)
    })


@app.route('/api/ready')
def ready():
    """Simple readiness check - returns immediately without calling MCP."""
    return jsonify({'ready': True, 'message': 'Server is running'})


@app.route('/api/basic-info')
def get_basic_info():
    """Fetch the student's name, grade, and school only.

    Used as the lightweight 'first paint' call -- 60s timeout so the
    loading screen can fail fast and show a refresh button instead of
    blocking forever.
    """
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_profile', username, password, timeout_seconds=60)
    return jsonify(data)


def _priority_from_request():
    """Map ?priority=high|low query param to numeric priority (0 or 10)."""
    p = (request.args.get('priority') or '').lower()
    return 0 if p == 'high' else 10


@app.route('/api/grades')
def get_grades():
    """Get current grades."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_grades', username, password, priority=_priority_from_request())
    return jsonify(data)


@app.route('/api/courses')
def get_courses():
    """Get enrolled courses."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_courses', username, password, priority=_priority_from_request())
    return jsonify(data)


@app.route('/api/assignments')
def get_assignments():
    """Get upcoming assignments."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_upcoming_assignments', username, password, priority=_priority_from_request())
    return jsonify(data)


@app.route('/api/posts')
def get_posts():
    """Get recent posts."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_recent_posts', username, password, priority=_priority_from_request())
    return jsonify(data)


@app.route('/api/refresh', methods=['POST'])
def refresh_data():
    """Force refresh all data."""
    # Note: Per-student sessions are managed by MCP; no global cache to clear
    return jsonify({'status': 'ok', 'last_updated': datetime.now().isoformat()})


@app.route('/api/reprioritize', methods=['POST'])
def reprioritize_queue():
    """Demote all queued high-priority (AI) fetches back to background priority.

    Called by the frontend when the user stops an AI response. Body is ignored;
    we always reprioritize everything currently in the queue that's still
    pending and not yet started.
    """
    _fetch_queue.reprioritize(10)
    return jsonify({'status': 'ok'})


@app.route('/api/clear-session', methods=['POST'])
def clear_session():
    """Clear the Schoology session for the authenticated student."""
    username, _ = decode_auth_header()
    storage_state = MCP_DIR / f'storage_state_{username}.json' if username else MCP_DIR / 'storage_state.json'
    if storage_state.exists():
        storage_state.unlink()
    return jsonify({'status': 'ok'})


@app.route('/api/status')
def get_status():
    """Get connection status."""
    mcp_installed = os.path.exists(VENV_PYTHON) and os.path.exists(RUN_TOOL_PY)
    username, _ = decode_auth_header()
    storage_state = MCP_DIR / f'storage_state_{username}.json' if username else MCP_DIR / 'storage_state.json'

    return jsonify({
        'mcp_installed': mcp_installed,
        'session_exists': storage_state.exists(),
        'last_updated': None
    })


@app.route('/api/setup-status')
def setup_status():
    """Check what setup is needed."""
    venv_exists = os.path.exists(VENV_PYTHON)
    env_exists = (MCP_DIR / '.env').exists()
    username, _ = decode_auth_header()
    storage_exists = (MCP_DIR / f'storage_state_{username}.json').exists() if username else (MCP_DIR / 'storage_state.json').exists()

    return jsonify({
        'needs_setup': not venv_exists,
        'needs_credentials': not env_exists,
        'needs_login': not storage_exists,
        'venv_path': str(Path(VENV_PYTHON).parent.parent),
        'server_path': RUN_TOOL_PY
    })


if __name__ == '__main__':
    print("""
    ╔═══════════════════════════════════════════════════════════╗
    ║        Schoology MCP Frontend Server                     ║
    ╠═══════════════════════════════════════════════════════════╣
    ║                                                           ║
    ║  Local:     http://localhost:8080                         ║
    ║                                                           ║
    ║  MCP Path:  {mcp_path}      ║
    ║                                                           ║
    ╚═══════════════════════════════════════════════════════════╝
    """.format(mcp_path=MCP_DIR))

    app.run(host='0.0.0.0', port=8081, debug=True)