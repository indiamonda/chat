#!/usr/bin/env python3
"""
Schoology Frontend Server
Bridges the web dashboard to the Schoology tool functions.

Gunicorn runs a single worker hosting a *pool* of long-lived run_tool.py
daemons -- one per authenticated student -- so each user gets a warm
browser (the schoology-mcp server is single-tenant and reads its
USERNAME/PASSWORD from the process env at spawn time). The pool is bounded
by DAEMON_POOL_MAX (default 100) and evicts the least-recently-used daemon
when full.

Why one worker: a per-user spawn lock coalesces simultaneous calls for the
same student to a single daemon spawn, but that lock is per-process. With
two gunicorn workers, requests round-robin across them and each worker
spawns its own daemon for the same user -- 2 Chromium instances, which
OOMs the 512MB Fly container. Running one worker keeps all schoology
traffic in one process so the spawn lock works end-to-end. A concurrent
user still gets their own daemon (different key in the pool).
"""

import base64
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

# Gunicorn is launched with cwd=/app/schoology (see Dockerfile CMD), so
# `schoology.ai` is not on the import path. Add /app so the AI tool
# package resolves.
_PARENT_DIR = str(Path(__file__).resolve().parent.parent)
if _PARENT_DIR not in sys.path:
    sys.path.insert(0, _PARENT_DIR)

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


def _storage_state_path(username):
    """Return the Playwright storage_state file for a given student.

    Mirrors the rule in schoology-mcp/schoology_mcp/browser.py:_storage_path:
    the per-student file is `{stem}_{username}{suffix}` of the base path.
    The base path comes from the SCHOOLOGY_STORAGE_STATE env var (default
    /app/schoology-mcp/storage_state.json); the Dockerfile overrides it
    to /data/schoology_storage.json so cookies survive a redeploy.
    """
    base = Path(os.environ.get("SCHOOLOGY_STORAGE_STATE", str(MCP_DIR / "storage_state.json")))
    if username:
        return base.parent / f"{base.stem}_{username}{base.suffix}"
    return base


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
            result = call_mcp_tool(item[2], item[3], item[4], timeout_seconds=180)
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


# ---------------------------------------------------------------------------
# Long-lived MCP daemon (the only worker, runs the pool).
# ---------------------------------------------------------------------------
# Gunicorn is launched with --workers 1. The single worker hosts the
# daemon pool -- one daemon per authenticated user, warm browser across
# calls (~3-5s per call after the first). The per-user spawn lock in
# _get_daemon() coalesces simultaneous calls for the same student so we
# never have more than one Chromium instance per user in flight.


def _should_use_daemon() -> bool:
    """True if this worker should host the long-lived MCP daemon."""
    return os.environ.get("GUNICORN_WORKER_INDEX") == "0"


class DaemonClient:
    """Long-lived run_tool.py subprocess with a persistent SchoologyClient.

    Wire protocol: one JSON-line request on stdin, one JSON-line response
    on stdout. Strictly ordered (one request -> one response, no pipelining).
    Stderr is drained on a background thread so log output never deadlocks
    the pipe.

    The schoology-mcp server is single-tenant: the daemon's USERNAME and
    PASSWORD are set in its environment at spawn time. Each DaemonClient
    is therefore tied to one user.
    """

    def __init__(self, username: str, password: str):
        self.username = username
        self.password = password
        self._lock = threading.Lock()
        self._stdout_buffer = b""
        self.proc = None
        self._stderr_thread = None
        self.started_at = time.monotonic()
        self._spawn()

    def _spawn(self):
        env = {
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            "SCHOOLOGY_USERNAME": self.username,
            "SCHOOLOGY_PASSWORD": self.password,
        }
        print(f"[MCP-DAEMON] spawning run_tool.py for user={self.username} (worker={os.environ.get('GUNICORN_WORKER_INDEX')})", file=sys.stderr)
        self.proc = subprocess.Popen(
            [VENV_PYTHON, RUN_TOOL_PY],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr,
            name=f"mcp-daemon-stderr-{self.proc.pid}",
            daemon=True,
        )
        self._stderr_thread.start()

    def _drain_stderr(self):
        try:
            for raw in iter(self.proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace")
                print(f"[daemon] {line}", end="", file=sys.stderr)
                sys.stderr.flush()
        except Exception as exc:  # noqa: BLE001 - thread must not crash
            print(f"[MCP-DAEMON] stderr drainer died: {type(exc).__name__}: {exc}", file=sys.stderr)

    def call(self, request, timeout_seconds):
        """Send one request, read one response, return the parsed JSON dict."""
        with self._lock:
            # Pre-flight: the proc may be alive (reaped-pid check passes)
            # but its stdin was already closed by Python because the
            # child died and we never noticed. Detect both the dead
            # process AND the closed-stdin file-object case.
            if self.proc.poll() is not None:
                raise EOFError(f"daemon exited (rc={self.proc.returncode})")
            if getattr(self.proc.stdin, "closed", False):
                raise EOFError("daemon stdin already closed (child died without reaping)")

            payload = (json.dumps(request) + "\n").encode("utf-8")
            try:
                self.proc.stdin.write(payload)
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as exc:
                # ValueError covers "write to closed file" — Python's
                # BufferedWriter flags itself closed when the underlying
                # pipe errors, then raises ValueError on the next write
                # instead of BrokenPipeError. Without this catch, one
                # dead-daemon cycle raises an unhandled 500 to the
                # browser. EOFError propagates so the caller can respawn.
                raise EOFError(f"daemon stdin closed: {exc}")

            line = self._read_line_with_timeout(timeout_seconds)
            return json.loads(line.decode("utf-8"))

    def _read_line_with_timeout(self, timeout_seconds):
        """Read one newline-terminated line from the daemon's stdout.

        Uses select.select for the timeout and a manual buffer to handle
        partial reads. Reads via os.read on the raw fd to avoid mixing
        with the BufferedReader's internal state.
        """
        import select
        fd = self.proc.stdout.fileno()
        deadline = time.monotonic() + timeout_seconds
        while True:
            if b"\n" in self._stdout_buffer:
                line, self._stdout_buffer = self._stdout_buffer.split(b"\n", 1)
                return line

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"daemon read timed out after {timeout_seconds}s")

            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                continue  # loop re-checks buffer + timeout

            chunk = os.read(fd, 4096)
            if not chunk:
                raise EOFError("daemon stdout closed")
            self._stdout_buffer += chunk

    def close(self):
        if self.proc is None:
            return
        try:
            if self.proc.poll() is None:
                try:
                    self.proc.stdin.close()  # signal EOF so the daemon exits cleanly
                except Exception:  # noqa: BLE001
                    pass
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
        except Exception:  # noqa: BLE001
            pass
        self.proc = None


# Per-user daemon registry. Each gunicorn worker has its own dict.
# The schoology-mcp server is single-tenant, so each student needs their
# own daemon process (configured with that student's USERNAME/PASSWORD).
# Capped at _DAEMON_POOL_MAX to keep memory bounded on 512MB Fly; when
# the cap is reached the least-recently-used daemon is killed.
_DAEMON_POOL_MAX = int(os.environ.get("DAEMON_POOL_MAX", "100"))
_daemons: dict[str, "DaemonClient"] = {}
_daemons_lock = threading.Lock()
_daemon_total_calls = 0
_daemon_total_respawns = 0

# Per-user spawn lock: when N requests for the same user arrive
# simultaneously (e.g. the dashboard's 4 background sections firing at
# once on load), they must coalesce to ONE daemon spawn. Without this,
# each request calls DaemonClient() independently and we'd briefly have
# N Chromium instances alive during the spawn window, which OOMs the
# 512MB Fly container. The first caller holds the spawn lock, the rest
# wait, then find the daemon in the pool and reuse it.
_spawn_locks: dict[str, threading.Lock] = {}
_spawn_locks_guard = threading.Lock()


def _get_daemon(username: str, password: str) -> "DaemonClient":
    """Return a daemon for ``username``, spawning one (with eviction) on miss.

    Concurrent calls for the same user serialize on a per-user spawn lock
    so we never have more than one in-flight spawn per (worker, user).
    """
    global _daemon_total_calls
    with _spawn_locks_guard:
        spawn_lock = _spawn_locks.setdefault(username, threading.Lock())
    with spawn_lock:
        with _daemons_lock:
            d = _daemons.get(username)
            if d is not None and d.proc.poll() is None:
                return d
            # Spawn fresh; evict LRU if at cap.
            if len(_daemons) >= _DAEMON_POOL_MAX:
                lru_user, lru_daemon = next(iter(_daemons.items()))
                try:
                    lru_daemon.close()
                except Exception:  # noqa: BLE001
                    pass
                _daemons.pop(lru_user, None)
                print(f"[MCP-DAEMON] evicted LRU daemon for user={lru_user} (pool cap {_DAEMON_POOL_MAX})", file=sys.stderr)
            d = DaemonClient(username, password)
            _daemons[username] = d
            return d


def _kill_daemon(username: str | None = None) -> None:
    """Tear down a daemon so the next call respawns it.

    If ``username`` is None, kill all daemons.
    """
    global _daemon_total_respawns
    with _daemons_lock:
        if username is None:
            victims = list(_daemons.items())
        else:
            d = _daemons.pop(username, None)
            victims = [(username, d)] if d else []
        for user, d in victims:
            if d is None:
                continue
            try:
                d.close()
            except Exception:  # noqa: BLE001
                pass
            _daemon_total_respawns += 1


def _eagerly_start_daemon():
    """No-op: with per-user daemons, we can't eagerly spawn without creds.
    The first real request will spawn the right daemon."""
    return


def _call_mcp_tool_via_daemon(tool_name, username, password, timeout_seconds):
    """Call a tool through the long-lived daemon for ``username``.

    Respawns and retries once on daemon death (EOFError / BrokenPipeError
    / OSError). On TimeoutError, the daemon is killed and respawned to
    keep the wire protocol in sync with the slow first-call response.
    """
    global _daemon_total_calls
    if not username or not password:
        return {"_error": True, "message": "username and password required for daemon path"}
    request = {
        "tool": tool_name,
        "username": username,
        "arguments": {},
    }
    try:
        result = _get_daemon(username, password).call(request, timeout_seconds)
        _daemon_total_calls += 1
        return result
    except TimeoutError as exc:
        print(f"[MCP-DAEMON] {tool_name}: timed out after {timeout_seconds}s; killing daemon to keep protocol in sync", file=sys.stderr)
        _kill_daemon(username)
    except (EOFError, BrokenPipeError, OSError) as exc:
        print(f"[MCP-DAEMON] {tool_name}: daemon for {username} died ({type(exc).__name__}: {exc}); respawning", file=sys.stderr)
        _kill_daemon(username)

    # Retry once on a fresh daemon for the same user.
    try:
        result = _get_daemon(username, password).call(request, timeout_seconds)
        _daemon_total_calls += 1
        return result
    except Exception as exc:  # noqa: BLE001
        print(f"[MCP-DAEMON] {tool_name}: retry after respawn failed ({type(exc).__name__}: {exc})", file=sys.stderr)
        _kill_daemon(username)
        return None


def call_mcp_tool(tool_name, username=None, password=None, timeout_seconds=180):
    """Dispatcher: per-user daemon pool (single gunicorn worker).

    Gunicorn runs --workers 1, so all schoology traffic is handled in one
    process. Combined with the per-user spawn lock in _get_daemon(), this
    caps Chromium at 1 instance per student -- the dashboard's parallel
    background loads coalesce to a single daemon spawn, instead of one
    per request, which previously OOMed the 512MB Fly container.
    """
    return _call_mcp_tool_via_daemon(tool_name, username, password, timeout_seconds)


def call_mcp_tool_subprocess(tool_name, username=None, password=None, timeout_seconds=180):
    """Call a tool by running run_tool.py in a fresh subprocess.

    The schoology-mcp server reads USERNAME/PASSWORD from its env, so
    this path sets them when spawning. Returns the parsed JSON dict from
    the subprocess, or None on failure.
    """
    request_payload = {
        "tool": tool_name,
        "username": username,
        "arguments": {},
    }
    env = {
        **os.environ,
        "PYTHONUNBUFFERED": "1",
    }
    if username:
        env["SCHOOLOGY_USERNAME"] = username
    if password:
        env["SCHOOLOGY_PASSWORD"] = password
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
                env=env,
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
        data = call_mcp_tool(tool_name, username=username, password=password, timeout_seconds=timeout_seconds)
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

    The upstream schoology-mcp removed the dedicated ``get_profile``
    tool, so the lightweight "first paint" identity fetch no longer
    exists. Return 200 with a ``removed`` marker so the browser does
    not log a "Failed to load resource" console error; the frontend
    reads ``removed`` and skips the identity strip, rendering the
    dashboard with whatever ``get_courses``/``get_grades`` returns.
    Cold-start timeouts still benefit from the 150s budget the
    frontend gives this route (the *first* tool call pays for
    Chromium + ClassLink login) but the rest is now opportunistic.
    """
    return jsonify({
        "removed": True,
        "message": "get_profile was removed in schoology-mcp upstream; the dashboard will derive identity from courses/grades instead.",
    }), 200


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
    storage_state = _storage_state_path(username)
    if storage_state.exists():
        storage_state.unlink()
    return jsonify({'status': 'ok'})


@app.route('/api/status')
def get_status():
    """Get connection status."""
    mcp_installed = os.path.exists(VENV_PYTHON) and os.path.exists(RUN_TOOL_PY)
    username, _ = decode_auth_header()
    storage_state = _storage_state_path(username)

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
    storage_exists = _storage_state_path(username).exists()

    return jsonify({
        'needs_setup': not venv_exists,
        'needs_credentials': not env_exists,
        'needs_login': not storage_exists,
        'venv_path': str(Path(VENV_PYTHON).parent.parent),
        'server_path': RUN_TOOL_PY
    })


@app.route('/api/daemon-status')
def daemon_status():
    """Status of the long-lived MCP daemon in this gunicorn worker.

    Worker 0 reports the daemon's state; worker 1 reports enabled=False
    and falls back to per-request subprocesses. Useful for verifying the
    warm/cold path after a deploy.
    """
    enabled = _should_use_daemon()
    if not enabled:
        return jsonify({
            'enabled': False,
            'running': False,
            'pid': None,
            'calls': 0,
            'respawns': 0,
            'uptime_s': 0,
            'worker_index': os.environ.get('GUNICORN_WORKER_INDEX'),
            'mode': 'subprocess-fallback',
            'pool_max': 0,
            'pool_size': 0,
            'users': [],
        })

    with _daemons_lock:
        # Use the most-recently-used daemon as the "primary" reported here.
        primary = next(reversed(_daemons.values()), None) if _daemons else None
        users = list(_daemons.keys())
    running = primary is not None and primary.proc.poll() is None
    return jsonify({
        'enabled': True,
        'running': running,
        'pid': primary.proc.pid if running else None,
        'calls': _daemon_total_calls,
        'respawns': _daemon_total_respawns,
        'uptime_s': round(time.monotonic() - primary.started_at, 1) if primary else 0,
        'worker_index': os.environ.get('GUNICORN_WORKER_INDEX'),
        'mode': 'per-user-daemon-pool',
        'pool_max': _DAEMON_POOL_MAX,
        'pool_size': len(users),
        'users': users,
    })


# AI Assistant tool routes (math, geometry, knowledge, science, files).
# Each module in schoology/ai/ registers its own routes via register_routes(app).
from schoology.ai import register_routes as _register_ai_routes
_register_ai_routes(app)


# ---------------------------------------------------------------------------
# AI chat + global memory persistence
#
# One file per chat at <DATA_DIR>/ai_chats/<username>/<chatId>.json, plus a
# _memory.json for cross-chat "remember this" items and a _last_chat.json
# recording which chat the user had open. Atomic writes (tmp + os.replace)
# keep the persistent volume safe against partial writes on redeploys.
# Auth is the same Basic-auth header as the rest of the API.
# ---------------------------------------------------------------------------
AI_CHATS_DIR = Path(os.environ.get('DATA_DIR', '/data')) / 'ai_chats'
MAX_MEMORY_ITEMS = 50
MAX_CHATS_PER_USER = 50
MAX_MESSAGES_PER_CHAT = 200
MAX_OTHER_SUMMARIES = 8
MAX_MEMORY_IN_CONTEXT = 20
SUMMARIZE_MIN_MESSAGES = 4  # don't summarize very short chats
SUMMARY_MAX_CHARS = 400


def _chat_user_dir(username: str) -> Path:
    """Return the per-user chat directory, creating it if missing."""
    d = AI_CHATS_DIR / _safe_username(username)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_username(username: str) -> str:
    """Username from Basic auth may contain anything; constrain to a safe
    filename component so we never write outside AI_CHATS_DIR."""
    return ''.join(c for c in (username or '') if c.isalnum() or c in '._-') or 'anonymous'


def _atomic_write_json(path: Path, obj) -> None:
    """Write JSON atomically: tmp + os.replace. Safe on the persistent volume."""
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _read_json(path: Path, default):
    """Read JSON, returning ``default`` if the file is missing or malformed."""
    if not path.exists():
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def _chat_path(username: str, chat_id: str) -> Path:
    return _chat_user_dir(username) / f'{chat_id}.json'


def _summarize_chat(messages) -> str:
    """Build a short non-LLM summary from a chat's message list.

    Joins user-authored text, truncates to SUMMARY_MAX_CHARS. Good enough
    for the "other chats" awareness block; if the user later wants LLM
    summaries, this is the single place to swap.
    """
    parts = []
    for m in messages:
        if m.get('role') == 'user':
            text = (m.get('content') or '').strip()
            if text:
                parts.append(text)
    blob = ' | '.join(parts)
    if len(blob) > SUMMARY_MAX_CHARS:
        blob = blob[:SUMMARY_MAX_CHARS].rstrip() + '...'
    return blob


def _require_username():
    """Return username from auth, or raise with a Flask abort."""
    username, _ = decode_auth_header()
    if not username:
        return None
    return username


def _list_chat_files(username: str):
    d = _chat_user_dir(username)
    return sorted(d.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)


@app.route('/api/chats', methods=['GET'])
def list_chats():
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    out = []
    for p in _list_chat_files(username):
        if p.name.startswith('_'):
            continue
        chat = _read_json(p, None)
        if not chat or not isinstance(chat, dict) or 'id' not in chat:
            continue
        out.append({
            'id': chat['id'],
            'title': chat.get('title') or 'Untitled',
            'createdAt': chat.get('createdAt'),
            'updatedAt': chat.get('updatedAt'),
            'summary': chat.get('summary') or '',
            'messageCount': len(chat.get('messages') or []),
        })
    out.sort(key=lambda c: c.get('updatedAt') or 0, reverse=True)
    return jsonify(out)


@app.route('/api/chats', methods=['POST'])
def create_chat():
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    # Cap total chats per user; if over, drop the oldest by updatedAt.
    existing = list(_list_chat_files(username))
    real = [p for p in existing if not p.name.startswith('_')]
    if len(real) >= MAX_CHATS_PER_USER:
        real.sort(key=lambda p: p.stat().st_mtime)
        for p in real[: len(real) - MAX_CHATS_PER_USER + 1]:
            try: p.unlink()
            except OSError: pass
    body = request.get_json(silent=True) or {}
    title = (body.get('title') or '').strip()[:80] or 'New chat'
    now = int(time.time() * 1000)
    chat = {
        'id': uuid.uuid4().hex,
        'title': title,
        'createdAt': now,
        'updatedAt': now,
        'messages': [],
        'summary': None,
        'summaryUpdatedAt': None,
    }
    _atomic_write_json(_chat_path(username, chat['id']), chat)
    return jsonify(chat), 201


@app.route('/api/chats/<chat_id>', methods=['GET'])
def get_chat(chat_id):
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    chat = _read_json(_chat_path(username, chat_id), None)
    if not chat:
        return jsonify({'error': 'not_found'}), 404
    return jsonify(chat)


@app.route('/api/chats/<chat_id>', methods=['PUT'])
def update_chat(chat_id):
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    path = _chat_path(username, chat_id)
    chat = _read_json(path, None)
    if not chat:
        return jsonify({'error': 'not_found'}), 404
    body = request.get_json(silent=True) or {}
    if 'title' in body and isinstance(body['title'], str):
        chat['title'] = body['title'].strip()[:80] or chat.get('title') or 'Untitled'
    if 'messages' in body and isinstance(body['messages'], list):
        # Cap the message list server-side; oldest dropped.
        messages = body['messages'][-MAX_MESSAGES_PER_CHAT:]
        chat['messages'] = messages
        # Auto-summarize when there's enough material.
        non_system = [m for m in messages if m.get('role') != 'system']
        if len(non_system) >= SUMMARIZE_MIN_MESSAGES:
            chat['summary'] = _summarize_chat(messages)
            chat['summaryUpdatedAt'] = int(time.time() * 1000)
    chat['updatedAt'] = int(time.time() * 1000)
    _atomic_write_json(path, chat)
    return jsonify(chat)


@app.route('/api/chats/<chat_id>', methods=['DELETE'])
def delete_chat(chat_id):
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    path = _chat_path(username, chat_id)
    try:
        path.unlink()
    except FileNotFoundError:
        return jsonify({'error': 'not_found'}), 404
    # If this was the last-opened pointer, clear it.
    last = _chat_user_dir(username) / '_last_chat.json'
    try:
        data = _read_json(last, None)
        if data and data.get('chatId') == chat_id:
            last.unlink()
    except OSError:
        pass
    return '', 204


@app.route('/api/chats/context', methods=['POST'])
def chat_context():
    """Return cross-chat summaries + global memory for context injection.

    The frontend posts {chatId: ...} to exclude the currently-open chat
    from the "other chats" list. The server reads from disk; nothing is
    written, no LLM call, no per-request summary regeneration.
    """
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    exclude = (body.get('chatId') or '').strip()

    other = []
    for p in _list_chat_files(username):
        if p.name.startswith('_'):
            continue
        chat = _read_json(p, None)
        if not chat or chat.get('id') == exclude:
            continue
        if not (chat.get('summary') or chat.get('title')):
            continue
        other.append({
            'id': chat.get('id'),
            'title': chat.get('title') or 'Untitled',
            'summary': chat.get('summary') or '',
            'updatedAt': chat.get('updatedAt'),
        })
    other.sort(key=lambda c: c.get('updatedAt') or 0, reverse=True)
    other = other[:MAX_OTHER_SUMMARIES]

    mem = _read_json(_chat_user_dir(username) / '_memory.json', {'items': []})
    items = (mem.get('items') or [])[-MAX_MEMORY_IN_CONTEXT:]

    return jsonify({
        'otherSummaries': other,
        'globalMemory': [{'id': i.get('id'), 'text': i.get('text')} for i in items],
    })


@app.route('/api/memory', methods=['GET'])
def list_memory():
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    mem = _read_json(_chat_user_dir(username) / '_memory.json', {'items': []})
    return jsonify({'items': mem.get('items') or []})


@app.route('/api/memory', methods=['POST'])
def add_memory():
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    text = (body.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'text is required'}), 400
    if len(text) > 1000:
        return jsonify({'error': 'text too long (max 1000 chars)'}), 400
    source = (body.get('sourceChatId') or '').strip() or None
    path = _chat_user_dir(username) / '_memory.json'
    mem = _read_json(path, {'items': []})
    items = mem.get('items') or []
    # De-dupe exact matches (case-insensitive) so the same fact isn't stored twice.
    lower = text.lower()
    items = [i for i in items if (i.get('text') or '').lower() != lower]
    items.append({
        'id': uuid.uuid4().hex,
        'text': text,
        'createdAt': int(time.time() * 1000),
        'sourceChatId': source,
    })
    # Cap: drop oldest first.
    if len(items) > MAX_MEMORY_ITEMS:
        items = items[-MAX_MEMORY_ITEMS:]
    mem['items'] = items
    _atomic_write_json(path, mem)
    return jsonify({'id': items[-1]['id'], 'text': text}), 201


@app.route('/api/memory/<memory_id>', methods=['DELETE'])
def delete_memory(memory_id):
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    path = _chat_user_dir(username) / '_memory.json'
    mem = _read_json(path, {'items': []})
    items = mem.get('items') or []
    new_items = [i for i in items if i.get('id') != memory_id]
    if len(new_items) == len(items):
        return jsonify({'error': 'not_found'}), 404
    mem['items'] = new_items
    _atomic_write_json(path, mem)
    return '', 204


@app.route('/api/chats/last', methods=['POST'])
def set_last_chat():
    """Record the last chat the user had open, for restore-on-load."""
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    chat_id = (body.get('chatId') or '').strip()
    path = _chat_user_dir(username) / '_last_chat.json'
    if not chat_id:
        try: path.unlink()
        except FileNotFoundError: pass
        return '', 204
    _atomic_write_json(path, {'chatId': chat_id, 'ts': int(time.time() * 1000)})
    return '', 204


@app.route('/api/chats/last', methods=['GET'])
def get_last_chat():
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    data = _read_json(_chat_user_dir(username) / '_last_chat.json', None)
    if not data:
        return jsonify({'chatId': None})
    return jsonify({'chatId': data.get('chatId')})


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