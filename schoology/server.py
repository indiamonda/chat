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
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
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

    def submit(self, tool_name, username, password, priority=10, arguments=None):
        """Enqueue a fetch and start a worker thread. Returns (event, item_ref).

        ``arguments`` (optional dict) is forwarded verbatim to the MCP tool
        call. Stored at index 7 of the item so existing positional readers
        (priority/seq/tool/user/pw/event/result at 0-6) keep working.
        """
        with self._lock:
            self._counter += 1
            item = [priority, self._counter, tool_name, username, password, threading.Event(), None, arguments]
            self._items.append(item)
            self._items.sort(key=lambda x: (x[0], x[1]))
            threading.Thread(target=self._worker, args=(item,), daemon=True).start()
        return item[5], item

    def _worker(self, item):
        with _subprocess_lock:
            result = call_mcp_tool(item[2], item[3], item[4], timeout_seconds=200, arguments=item[7])
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
        # Concurrency: the daemon processes multiple in-flight requests
        # in parallel. Per-call serialization on a Python lock is GONE
        # -- instead each call gets a request id, registers a Future,
        # and a single reader thread demuxes responses by id and
        # resolves the right Future. Multiple callers can be inside
        # call() simultaneously, all waiting on their own Future.
        self._requests_lock = threading.Lock()  # only protects the dict
        self._pending: dict = {}  # request_id -> (Future, timeout_deadline)
        self.proc = None
        self._stderr_thread = None
        self._reader_thread = None
        self._reader_thread_stopped = threading.Event()
        self.started_at = time.monotonic()
        # Bumped to True after the first tool call completes
        # successfully. Used to give the cold-start (Chromium launch +
        # ClassLink login, ~3-6 min on 512MB Fly) a much longer
        # budget than subsequent warm calls (~5-30s).
        self._warmed = False
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
        # Start the stdout demuxer thread. It runs for the daemon's
        # lifetime; on EOF / broken pipe it sets _reader_thread_stopped
        # and all in-flight calls fail with EOFError so the caller
        # can respawn.
        self._reader_thread_stopped.clear()
        self._reader_thread = threading.Thread(
            target=self._read_loop,
            name=f"mcp-daemon-stdout-{self.proc.pid}",
            daemon=True,
        )
        self._reader_thread.start()

    def _drain_stderr(self):
        try:
            for raw in iter(self.proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace")
                print(f"[daemon] {line}", end="", file=sys.stderr)
                sys.stderr.flush()
        except Exception as exc:  # noqa: BLE001 - thread must not crash
            print(f"[MCP-DAEMON] stderr drainer died: {type(exc).__name__}: {exc}", file=sys.stderr)

    def _read_loop(self):
        """Demux stdout lines to their pending callers by request id.

        Runs in its own thread for the daemon's lifetime. On EOF
        (parent closed pipe) or any read error, resolves all pending
        callers with EOFError and marks the reader as stopped.
        """
        try:
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    # EOF -- parent closed our stdin or the daemon
                    # died. Fail every in-flight call.
                    self._fail_all_pending(EOFError("daemon stdout closed"))
                    return
                try:
                    msg = json.loads(line.decode("utf-8"))
                except Exception as exc:
                    # Garbled line; skip but keep going (the daemon
                    # may recover).
                    print(f"[MCP-DAEMON] demux: bad JSON line: {exc}", file=sys.stderr)
                    continue
                req_id = msg.get("id")
                if not req_id:
                    # Defensive: daemon should always echo id.
                    print(f"[MCP-DAEMON] demux: response missing id: {msg}", file=sys.stderr)
                    continue
                with self._requests_lock:
                    entry = self._pending.pop(req_id, None)
                if entry is None:
                    # Late response for a call that already gave up.
                    # Drop it; the daemon's protocol assumes the parent
                    # is still listening, but we're not.
                    print(f"[MCP-DAEMON] demux: late response for id={req_id}", file=sys.stderr)
                    continue
                future, _ = entry
                if not future.done():
                    if "error" in msg:
                        future.set_exception(ChildProcessError(msg["error"]))
                    elif "result" in msg:
                        future.set_result(msg["result"])
                    else:
                        # Unknown response shape -- treat as error
                        future.set_exception(RuntimeError(f"daemon returned: {msg}"))
        except Exception as exc:
            # Unexpected reader error -- fail everything.
            self._fail_all_pending(exc)
        finally:
            self._reader_thread_stopped.set()

    def _fail_all_pending(self, exc: BaseException) -> None:
        """Resolve every pending Future with the given exception.
        Used when the reader detects EOF / broken pipe."""
        with self._requests_lock:
            pending = list(self._pending.items())
            self._pending.clear()
        for req_id, (future, _) in pending:
            if not future.done():
                future.set_exception(exc)

    def call(self, request, timeout_seconds):
        """Send one request, read its specific response, return the result.

        Concurrency: the daemon processes multiple in-flight requests
        in parallel, so we don't hold a Python lock around the whole
        call. Instead, we register a Future keyed by request id,
        write the request, and wait on OUR Future. A background
        reader thread demuxes responses and resolves the right one.
        """
        # Pre-flight: detect dead/tombstoned daemon. Same checks as
        # before, but now they don't need to be inside a lock.
        if self.proc is None:
            raise EOFError("daemon proc is None (close() was already called)")
        if self.proc.poll() is not None:
            raise EOFError(f"daemon exited (rc={self.proc.returncode})")
        if getattr(self.proc.stdin, "closed", False):
            raise EOFError("daemon stdin already closed (child died without reaping)")

        # Tag every request with a uuid so the reader thread can
        # match responses to callers. The parent request is allowed
        # to carry its own id (for tracing); we prefer it.
        req_id = request.get("id") or str(uuid.uuid4())
        tagged = dict(request)
        tagged["id"] = req_id

        future = concurrent.futures.Future()
        deadline = time.monotonic() + timeout_seconds
        with self._requests_lock:
            if self._reader_thread_stopped.is_set():
                raise EOFError("daemon reader thread is stopped")
            self._pending[req_id] = (future, deadline)

        # Write the request. If this fails, undo the registration and
        # raise. Python's BufferedWriter may raise ValueError on
        # "write to closed file" if the child died between our
        # pre-flight and now -- treat it as a normal EOF.
        try:
            self.proc.stdin.write((json.dumps(tagged) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            with self._requests_lock:
                self._pending.pop(req_id, None)
            raise EOFError(f"daemon stdin closed: {exc}")

        # Wait for our specific response. If the read takes longer
        # than the per-call budget, cancel our registration and
        # surface a timeout. The daemon is NOT killed; sibling calls
        # are unaffected; the in-flight request will eventually
        # resolve (or the daemon will die and our pending entry will
        # be failed by the reader thread's EOF handler).
        #
        # Cold-start budget: the FIRST successful call (per daemon
        # lifetime) gets a much longer timeout because Chromium +
        # ClassLink login can take 1-3 min on small Fly machines.
        # Subsequent warm calls use the normal per-call budget (120s).
        # This gives the user 1 slow call + 3 fast ones instead of 4
        # all timing out. 300s cap keeps a stuck cold start from
        # holding request threads hostage for 10+ minutes.
        effective_timeout = 300 if not self._warmed else timeout_seconds
        try:
            result = future.result(timeout=effective_timeout)
            self._warmed = True  # mark warm for the next call
            return result
        except concurrent.futures.TimeoutError:
            # Don't remove our pending entry -- the response may
            # still arrive and we don't want a late response to be
            # silently dropped (it would be assigned to a future
            # caller, but we keyed by id and no one will reuse this
            # id). Leave it; the reader thread will resolve it
            # eventually and the call's caller has already given up.
            raise TimeoutError(f"daemon call timed out after {timeout_seconds}s")
        except Exception:
            # Our caller failed for whatever reason; remove the
            # pending entry so a late response doesn't sit there.
            with self._requests_lock:
                self._pending.pop(req_id, None)
            raise

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
            # Reuse only if the daemon has a live proc. A tombstoned
            # DaemonClient (proc is None after close()) looks alive to
            # the pool but would AttributeError on next call.
            if d is not None and d.proc is not None and d.proc.poll() is None:
                return d
            # Drop the tombstoned entry from the pool so the new spawn
            # becomes the canonical one.
            if d is not None and (d.proc is None or d.proc.poll() is not None):
                _daemons.pop(username, None)
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

    WARNING: this is keyed on username. If another caller just spawned a
    fresh daemon for the same user, ``_kill_daemon`` will pop *that*
    new daemon from the pool and kill it -- a TOCTOU race. Use
    ``_kill_daemon_object`` whenever you have a specific DaemonClient
    reference you want to kill.
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


def _kill_daemon_object(target) -> None:
    """Kill a specific DaemonClient and remove it from the pool iff it's
    still the one stored there. Avoids the username-keyed TOCTOU race
    where caller A spawns a fresh daemon, caller B's pre-flight fails
    on the OLD daemon, and B's _kill_daemon kills A's brand-new one.
    """
    global _daemon_total_respawns
    if target is None:
        return
    # Close the subprocess first so any in-flight call waiting on the
    # lock wakes up and sees the dead proc.
    try:
        target.close()
    except Exception:  # noqa: BLE001
        pass
    # Now pop from pool only if it's still us. If a different caller
    # already replaced it, leave the new one alone.
    with _daemons_lock:
        for uname, d in list(_daemons.items()):
            if d is target:
                _daemons.pop(uname, None)
                _daemon_total_respawns += 1
                break


def _eagerly_start_daemon():
    """No-op: with per-user daemons, we can't eagerly spawn without creds.
    The first real request will spawn the right daemon."""
    return


def _call_mcp_tool_via_daemon(tool_name, username, password, timeout_seconds, arguments=None):
    """Call a tool through the long-lived daemon for ``username``.

    Respawns and retries once on daemon death (EOFError / BrokenPipeError
    / OSError). On TimeoutError, the daemon is killed and respawned to
    keep the wire protocol in sync with the slow first-call response.

    Concurrency note: the per-user spawn lock inside ``_get_daemon``
    coalesces concurrent spawns, but the pool key is the *username*,
    not the *DaemonClient object*. If caller A spawns a fresh daemon
    and caller B's pre-flight check (against the OLD daemon) raises
    EOFError, B's retry path used to call ``_kill_daemon(username)``
    which would pop the NEW daemon from the pool and kill it -- a
    classic TOCTOU race. We fix it by tracking the specific
    ``DaemonClient`` we tried to use and only closing *that one*,
    never whatever happens to be in the pool under the same key.
    """
    global _daemon_total_calls
    if not username or not password:
        return {"_error": True, "message": "username and password required for daemon path"}
    request = {
        "tool": tool_name,
        "username": username,
        "arguments": arguments or {},
    }
    tried = None
    try:
        tried = _get_daemon(username, password)
        result = tried.call(request, timeout_seconds)
        _daemon_total_calls += 1
        return result
    except TimeoutError as exc:
        # Cold-start path: the first call after daemon spawn takes
        # ~3+ min on 512MB Fly (Chromium + ClassLink login). The
        # concurrent daemon keeps the daemon warm across the 4 sibling
        # calls, so on retry the second+ calls should hit a warm
        # Chromium and return in seconds. We don't kill the daemon
        # -- we just fall through to the retry below.
        print(f"[MCP-DAEMON] {tool_name}: timed out after {timeout_seconds}s; daemon kept warm, retrying", file=sys.stderr)
    except (EOFError, BrokenPipeError, OSError) as exc:
        print(f"[MCP-DAEMON] {tool_name}: daemon for {username} died ({type(exc).__name__}: {exc}); respawning", file=sys.stderr)
        if tried is not None:
            _kill_daemon_object(tried)

    # Retry once on a fresh daemon for the same user. Retry budget is
    # capped at 60s -- if the first attempt didn't make it, a second
    # 200s wait just doubles the thread-hostage window for little gain.
    tried = None
    try:
        tried = _get_daemon(username, password)
        result = tried.call(request, min(timeout_seconds, 60))
        _daemon_total_calls += 1
        return result
    except Exception as exc:  # noqa: BLE001
        print(f"[MCP-DAEMON] {tool_name}: retry after respawn failed ({type(exc).__name__}: {exc})", file=sys.stderr)
        if tried is not None:
            _kill_daemon_object(tried)
        return None


def call_mcp_tool(tool_name, username=None, password=None, timeout_seconds=200, arguments=None):
    """Dispatcher: per-user daemon pool (single gunicorn worker).

    Gunicorn runs --workers 1, so all schoology traffic is handled in one
    process. Combined with the per-user spawn lock in _get_daemon(), this
    caps Chromium at 1 instance per student -- the dashboard's parallel
    background loads coalesce to a single daemon spawn, instead of one
    per request, which previously OOMed the 512MB Fly container.
    """
    return _call_mcp_tool_via_daemon(tool_name, username, password, timeout_seconds, arguments=arguments)


def call_mcp_tool_subprocess(tool_name, username=None, password=None, timeout_seconds=200, arguments=None):
    """Call a tool by running run_tool.py in a fresh subprocess.

    The schoology-mcp server reads USERNAME/PASSWORD from its env, so
    this path sets them when spawning. Returns the parsed JSON dict from
    the subprocess, or None on failure.
    """
    request_payload = {
        "tool": tool_name,
        "username": username,
        "arguments": arguments or {},
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


def get_data_from_mcp_or_mock(tool_name, username=None, password=None, timeout_seconds=120, priority=10, arguments=None):
    """Try MCP first, fall back to error response (no mock data).

    Args:
        tool_name: Name of the MCP tool to call
        username: Student ID for authentication
        password: Schoology password for authentication
        timeout_seconds: hard timeout for the subprocess
        priority: 0 = AI, 10 = background. Lower runs sooner in the queue.
        arguments: optional dict of kwargs forwarded to the MCP tool.

    NOTE: First call for a user takes ~90s (cold browser + ClassLink login on 512MB Fly.io).
          Subsequent calls take ~3-5s (warm browser reuse).
    """
    import sys
    print(f"[DEBUG] get_data_from_mcp_or_mock called: tool={tool_name}, username={username}, priority={priority}", file=sys.stderr)

    if priority <= 0:
        # AI-priority: enqueue and wait
        evt, item = _fetch_queue.submit(tool_name, username, password, priority=0, arguments=arguments)
        if not evt.wait(timeout=timeout_seconds):
            print(f"[DEBUG] {tool_name} AI-priority queue wait timed out after {timeout_seconds}s", file=sys.stderr)
            return {'_error': True, 'message': f'{tool_name} timeout'}
        data = item[6]
    else:
        data = call_mcp_tool(tool_name, username=username, password=password, timeout_seconds=timeout_seconds, arguments=arguments)
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
            # Tools that return a single record dict (not a list-shaped
            # wrapper) -- pass the dict through unchanged so the route
            # can jsonify it. Without this, get_assignment_info /
            # get_material / get_course_materials would fall through to
            # the "not a recognized dict" branch and 502.
            if tool_name in ('get_assignment_info', 'get_material', 'get_course_materials'):
                print(f"[DEBUG] Returning raw dict for {tool_name}: keys={list(data.keys())}", file=sys.stderr)
                return data
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
    # Cache for the server-side notification scheduler (so it can fire
    # pushes without spawning its own Chromium).
    if username and isinstance(data, dict) and isinstance(data.get('assignments'), list):
        try:
            store = _notif_store_for(username)
            _atomic_write_json(store.dir / 'assignments_cache.json', data['assignments'])
        except Exception as exc:
            print(f'[notif] cache write failed: {exc}', file=sys.stderr)
    return jsonify(data)


@app.route('/api/notifications/prefs', methods=['GET', 'POST'])
def notif_prefs():
    """Get or set notification prefs for the current user."""
    username, _ = decode_auth_header()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    store = _notif_store_for(username)
    if request.method == 'GET':
        return jsonify(store.get_prefs())
    body = request.get_json(silent=True) or {}
    store.set_prefs(body)
    return jsonify(store.get_prefs())


@app.route('/api/notifications/subscribe', methods=['POST'])
def notif_subscribe():
    """Store a Web Push subscription for the current user."""
    username, _ = decode_auth_header()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    sub = request.get_json(silent=True) or {}
    store = _notif_store_for(username)
    if not store.add_sub(sub):
        return jsonify({'error': 'invalid subscription'}), 400
    return jsonify({'ok': True})


@app.route('/api/notifications/unsubscribe', methods=['POST'])
def notif_unsubscribe():
    """Remove a Web Push subscription for the current user."""
    username, _ = decode_auth_header()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    endpoint = (request.get_json(silent=True) or {}).get('endpoint')
    if endpoint:
        _notif_store_for(username).remove_sub(endpoint)
    return jsonify({'ok': True})


@app.route('/api/notifications/vapid-public-key')
def notif_vapid_key():
    """VAPID public key for PushManager.subscribe(). Mirrors the Node app's
    env var so both apps use the same key pair."""
    return jsonify({'key': os.environ.get('VAPID_PUBLIC_KEY', 'BLA_IdhXG4ry1CLcojk33JtlXohMOy40o88pY-wMQ16wenYAg4HUhrvr45DjjcRbEa2UZmPn2vcxbeHDK4n8ljw')})


@app.route('/api/posts')
def get_posts():
    """Get recent posts."""
    username, password = decode_auth_header()
    # Upstream get_recent_posts now downloads embedded images by default;
    # the dashboard only renders text/author/timestamp, so skip the image
    # fetch (keeps /api/posts fast and avoids per-image failures).
    data = get_data_from_mcp_or_mock(
        'get_recent_posts', username, password,
        priority=_priority_from_request(),
        arguments={'download_images': False},
    )
    return jsonify(data)


@app.route('/api/refresh', methods=['POST'])
def refresh_data():
    """Force refresh all data."""
    # Note: Per-student sessions are managed by MCP; no global cache to clear
    return jsonify({'status': 'ok', 'last_updated': datetime.now().isoformat()})


@app.route('/api/assignment-info')
def get_assignment_info_route():
    """Fetch a single assignment's full details from the MCP daemon.

    The dashboard's assignment list shows just title + course + due
    date. Clicking a card calls this endpoint to get the rest of what
    Schoology has: the description body (text + HTML), attachments,
    and any in-line links. Used by the frontend's expand-on-click
    handler to surface the info that's normally hidden behind two
    clicks in the Schoology web UI.

    Query params: `url` (required) — the assignment's Schoology URL,
    `/assignment/<id>` path, or bare numeric id. The MCP tool
    normalizes all three forms.
    """
    username, password = decode_auth_header()
    if not username or not password:
        return jsonify({'error': 'auth_required'}), 401
    url = (request.args.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'url is required'}), 400
    # Use the per-user daemon pool (same path as grades/assignments).
    # 200s per-call; cold-start path retries on its own. The MCP tool
    # signature is ``get_assignment_info(url_or_id: str)`` -- pass the
    # raw query value through; the tool normalizes URL / path / id.
    data = get_data_from_mcp_or_mock(
        'get_assignment_info', username, password,
        priority=_priority_from_request(),
        arguments={'url_or_id': url},
    )
    if data is None or (isinstance(data, dict) and data.get('_error')):
        return jsonify(data or {'_error': True, 'message': 'MCP call failed'}), 502
    return jsonify(data)


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


# ---------------------------------------------------------------------------
# Schoology notification state (server-side scheduler + Web Push)
#
# The dashboard's original scheduler ran 100% in the browser tab: it could
# only show in-app toasts while the tab was open, so closing the tab meant
# zero notifications. This server-side store keeps per-user prefs, push
# subscriptions and fired-dedup keys under <DATA_DIR>/schoology_notif/ so a
# background thread can fire real Web Push notifications even when the app
# is closed.
# ---------------------------------------------------------------------------
NOTIF_DIR = Path(os.environ.get('DATA_DIR', '/data')) / 'schoology_notif'
NOTIF_DEDUP_DAYS = 14


class NotifStore:
    """Per-user notification state: prefs, push subscriptions, fired keys."""

    def __init__(self, username: str):
        self.username = username
        self.dir = NOTIF_DIR / _safe_username(username)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.prefs_path = self.dir / 'prefs.json'
        self.subs_path = self.dir / 'subs.json'
        self.fired_path = self.dir / 'fired.json'

    def _read(self, path: Path, default):
        return _read_json(path, default)

    def _write(self, path: Path, obj) -> None:
        _atomic_write_json(path, obj)

    # ── prefs ────────────────────────────────────────────────────────
    DEFAULT_PREFS = {
        'enabled': True,
        'events': {'enabled': True, 'offsets': [60, 30, 15]},
        'dueTomorrow': {'enabled': True, 'startHour': 16, 'spacingHours': 1},
        'missing': {'enabled': True, 'hour': 16, 'minute': 30},
    }

    def get_prefs(self):
        p = self._read(self.prefs_path, None)
        if not p:
            return json.loads(json.dumps(self.DEFAULT_PREFS))
        # Backfill missing fields
        base = json.loads(json.dumps(self.DEFAULT_PREFS))
        base.update({k: v for k, v in p.items() if k in base})
        if isinstance(p.get('events'), dict):
            base['events'].update(p['events'])
        if isinstance(p.get('dueTomorrow'), dict):
            base['dueTomorrow'].update(p['dueTomorrow'])
        if isinstance(p.get('missing'), dict):
            base['missing'].update(p['missing'])
        return base

    def set_prefs(self, prefs: dict):
        self._write(self.prefs_path, prefs)

    # ── push subscriptions ───────────────────────────────────────────
    def get_subs(self):
        return self._read(self.subs_path, [])

    def add_sub(self, sub: dict) -> bool:
        if not sub or not sub.get('endpoint') or not sub.get('keys'):
            return False
        subs = [s for s in self.get_subs() if s.get('endpoint') != sub.get('endpoint')]
        subs.append(sub)
        self._write(self.subs_path, subs)
        return True

    def remove_sub(self, endpoint: str) -> None:
        subs = [s for s in self.get_subs() if s.get('endpoint') != endpoint]
        self._write(self.subs_path, subs)

    # ── dedup keys (per rule per day) ────────────────────────────────
    def get_fired(self):
        return self._read(self.fired_path, {})

    def mark_fired(self, key: str) -> None:
        fired = self.get_fired()
        fired[key] = int(time.time() * 1000)
        # Prune old keys
        cutoff = int(time.time() * 1000) - NOTIF_DEDUP_DAYS * 24 * 60 * 60 * 1000
        fired = {k: v for k, v in fired.items() if v >= cutoff}
        self._write(self.fired_path, fired)

    def has_fired(self, key: str) -> bool:
        return key in self.get_fired()


def _notif_store_for(username: str) -> NotifStore:
    return NotifStore(username)


def _push_to_user(username: str, title: str, body: str, url: str = '/schoology/', tag: str = None) -> None:
    """Send a push to every subscription of a user via the Node app's
    internal endpoint (same machine, port 8080). Fire-and-forget."""
    store = _notif_store_for(username)
    subs = store.get_subs()
    if not subs:
        return
    secret = os.environ.get('SCHOOLOGY_PUSH_SECRET', '')
    if not secret:
        return
    for sub in subs:
        try:
            req = urllib.request.Request(
                'http://127.0.0.1:8080/internal/send-push',
                data=json.dumps({
                    'subscription': sub,
                    'payload': {'title': title, 'body': body, 'url': url, 'tag': tag, 'data': {'roomType': 'schoology', 'roomId': 'dashboard'}},
                }).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'x-push-secret': secret},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                pass
        except Exception as exc:
            print(f'[notif] push to {username} failed: {exc}', file=sys.stderr)


def _notif_dedup_key(username: str, item_id: str, rule: str, date_str: str) -> str:
    return f'{_safe_username(username)}:{item_id}:{rule}:{date_str}'


def _notif_parse_due(item) -> float | None:
    """Best-effort due timestamp (epoch ms) from upstream item data."""
    if not item:
        return None
    for key in ('dueDate', 'due_iso', 'due'):
        val = item.get(key)
        if val:
            try:
                return datetime.fromisoformat(str(val).replace('Z', '+00:00')).timestamp() * 1000
            except (ValueError, TypeError):
                continue
    return None


def _notif_item_type(item) -> str:
    url = (item and item.get('url')) or ''
    return 'event' if '/event/' in url else 'assignment'


def _notif_item_id(item) -> str:
    return (item and (item.get('url') or item.get('title'))) or 'unknown'


def _notif_same_local_day(a_ms: float, b_dt: datetime) -> bool:
    a = datetime.fromtimestamp(a_ms / 1000)
    return (a.year, a.month, a.day) == (b_dt.year, b_dt.month, b_dt.day)


def _notif_scheduler_tick() -> None:
    """One sweep over every user with notification state. Mirrors the old
    client-side rules: event offsets, due-tomorrow hourly, missing daily.
    Uses cached assignments (fetched by /api/assignments on dashboard load),
    so it never spawns a Chromium itself."""
    if not NOTIF_DIR.exists():
        return
    now = datetime.now()
    today_str = now.strftime('%Y-%m-%d')
    tomorrow = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta
    tomorrow = tomorrow + timedelta(days=1)

    for user_dir in NOTIF_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        username = user_dir.name
        store = _notif_store_for(username)
        prefs = store.get_prefs()
        if not prefs.get('enabled'):
            continue
        subs = store.get_subs()
        if not subs:
            continue
        items = _read_json(user_dir / 'assignments_cache.json', [])
        if not isinstance(items, list) or not items:
            continue

        event_offsets = sorted(
            [int(x) for x in (prefs.get('events', {}).get('offsets') or []) if x in (5, 10, 15, 30, 45, 60, 90, 120)],
            reverse=True,
        )
        due_tomorrow = prefs.get('dueTomorrow', {})
        missing = prefs.get('missing', {})

        for item in items:
            due_ms = _notif_parse_due(item)
            if not due_ms:
                continue
            item_type = _notif_item_type(item)
            item_id = _notif_item_id(item)
            title = item.get('title') or 'Untitled'
            course = item.get('courseName') or item.get('course_name') or ''

            if item_type == 'event' and event_offsets:
                ms_until = due_ms - time.time() * 1000
                if ms_until < 0:
                    continue
                minutes = int(ms_until // 60000)
                for threshold in event_offsets:
                    if threshold - 1 < minutes <= threshold:
                        key = _notif_dedup_key(username, item_id, f'event-{threshold}m', today_str)
                        if not store.has_fired(key):
                            label = f'{threshold // 60}h' if threshold >= 60 else f'{threshold}m'
                            _push_to_user(username, f'📅 {label} until "{title}"', f'{course}'.strip())
                            store.mark_fired(key)
                        break
                continue

            # Assignments
            if due_tomorrow.get('enabled') and _notif_same_local_day(due_ms, tomorrow):
                start_hour = int(due_tomorrow.get('startHour') or 16)
                hour = now.hour
                if hour >= start_hour:
                    hour_key = f'{hour:02d}'
                    key = _notif_dedup_key(username, item_id, f'due-tmrw-{hour_key}', today_str)
                    if not store.has_fired(key):
                        _push_to_user(username, f'📝 "{title}" due tomorrow', course.strip())
                        store.mark_fired(key)

            if missing.get('enabled') and due_ms > time.time() * 1000:
                m_hour = int(missing.get('hour') or 16)
                m_min = int(missing.get('minute') or 30)
                if now.hour == m_hour:
                    if m_min == 0:
                        fire = True
                    else:
                        fire = m_min <= now.minute < m_min + 1
                    if fire:
                        key = _notif_dedup_key(username, item_id, 'missing-daily', today_str)
                        if not store.has_fired(key):
                            due_txt = item.get('dueDate') or item.get('due') or ''
                            _push_to_user(username, f'📌 Missing assignment: "{title}"', f'{course} — due {due_txt}'.strip())
                            store.mark_fired(key)


def _notif_scheduler_loop() -> None:
    """Background thread: sweep every 60s. Started once at import; the
    gunicorn master forks one worker, so a module-level thread survives."""
    while True:
        try:
            _notif_scheduler_tick()
        except Exception as exc:
            print(f'[notif] scheduler error: {exc}', file=sys.stderr)
        time.sleep(60)


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


# ---------------------------------------------------------------------------
# AI chat auto-titling (server-side only)
# ---------------------------------------------------------------------------
# The client used to call the DeepSeek proxy from the browser with a
# client-side prompt. The prompt now lives here; the client just posts
# the chat id + first message and we title it server-side.

_AUTO_TITLE_SYSTEM = (
    'You generate very short chat titles (2-5 words). Reply with ONLY the '
    'title text: no quotes, no leading emoji, no trailing punctuation, no '
    'prefix like "Title:".'
)


def _deepseek_auto_title(first_user_message: str):
    """Return a short title for a chat's first message, or None."""
    api_key = os.environ.get('DEEPSEEK_KEY')
    seed = (first_user_message or '').strip()[:400]
    if not seed or not api_key:
        return None
    body = {
        'model': os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat'),
        'messages': [
            {'role': 'system', 'content': _AUTO_TITLE_SYSTEM},
            {'role': 'user', 'content': f'First message in the chat:\n"""{seed}"""\n\nTitle:'},
        ],
        'temperature': 0.4,
        'max_tokens': 20,
        'stream': False,
    }
    req = urllib.request.Request(
        'https://api.deepseek.com/v1/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode('utf-8')
        data = json.loads(raw)
        title = str(data['choices'][0]['message']['content'] or '').strip()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
        print(f'[auto-title] DeepSeek call failed: {type(exc).__name__}: {exc}', file=sys.stderr)
        return None
    # Same cleanup the client used to do: strip quotes, leading emoji,
    # trailing punctuation.
    title = title.strip().strip('"\'`')
    title = re.sub(r'^[\U0001F300-\U0001FAFF\u2600-\u27BF\s]+', '', title)
    title = re.sub(r'[.!?,;:\-\u2013\u2014]+$', '', title).strip()
    if not title:
        return None
    return title[:60]


@app.route('/api/chats/auto-title', methods=['POST'])
def auto_title_chat():
    """POST {chatId, first_user_message} -> titles the chat server-side."""
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    chat_id = (body.get('chatId') or '').strip()
    if not chat_id:
        return jsonify({'error': 'chatId is required'}), 400
    path = _chat_path(username, chat_id)
    chat = _read_json(path, None)
    if not chat:
        return jsonify({'error': 'not_found'}), 404
    title = _deepseek_auto_title(body.get('first_user_message') or '')
    if not title:
        return jsonify({'title': None})
    chat['title'] = title
    chat['updatedAt'] = int(time.time() * 1000)
    _atomic_write_json(path, chat)
    return jsonify({'title': title})


# ---------------------------------------------------------------------------
# Async chat generation: server-side background AI jobs
# ---------------------------------------------------------------------------
#
# Each AI turn runs as a BACKGROUND JOB on the server. The client POSTs a
# message, then polls GET /api/chats/<chat_id>/status. The job keeps running
# even when the user switches chats / dashboard menus / closes the tab, and
# multiple chats can generate at the same time (bounded by
# AI_JOB_MAX_CONCURRENT worker threads).
#
# Persistence model:
#   - The chat file is the single source of truth. Every message (user,
#     assistant, tool history) is appended server-side.
#   - A chat with an in-flight turn carries a `pendingJob` object in its
#     file: {status: queued|running|failed|cancelled, payload, error}.
#     The payload holds everything the pipeline needs, so a retry after a
#     crash/restart re-runs without the client re-posting anything.
#   - On process start, any leftover queued/running jobs are marked failed
#     (their worker thread died with the old process); the client offers a
#     retry via POST /api/chats/<chat_id>/retry.
#   - Cancellation is cooperative: POST cancel sets the file status to
#     cancelled and flags an in-memory Event; the worker checks both before
#     persisting its result.

AI_JOB_MAX_CONCURRENT = int(os.environ.get('AI_JOB_MAX_CONCURRENT', '4'))

_job_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=AI_JOB_MAX_CONCURRENT,
    thread_name_prefix='ai-chat-job',
)
_job_cancel_events: dict[tuple, threading.Event] = {}
_job_cancel_guard = threading.Lock()

_chat_locks: dict[str, threading.Lock] = {}
_chat_locks_guard = threading.Lock()


def _chat_file_lock(username: str, chat_id: str) -> threading.Lock:
    """One lock per chat file; serializes all read-modify-write cycles."""
    key = f'{_safe_username(username)}:{chat_id}'
    with _chat_locks_guard:
        lock = _chat_locks.setdefault(key, threading.Lock())
    return lock


def _register_cancel_event(username: str, chat_id: str) -> threading.Event:
    key = (username, chat_id)
    with _job_cancel_guard:
        evt = _job_cancel_events.setdefault(key, threading.Event())
    return evt


def _clear_cancel_event(username: str, chat_id: str) -> None:
    key = (username, chat_id)
    with _job_cancel_guard:
        _job_cancel_events.pop(key, None)


def _strip_tool_brackets(text):
    """Remove [NAME:args] bracket commands from a reply for display.

    Mirrors the client's stripToolBrackets(), using the server-side tool
    list (schoology.ai.system_prompt._TOOLS) as the name source.
    """
    if not text:
        return text
    try:
        from schoology.ai.system_prompt import _TOOLS
        names = [syntax.split(':')[0] for syntax, _desc in _TOOLS]
    except Exception:  # noqa: BLE001 - cosmetic helper; never fail the job
        names = []
    out = str(text)
    for name in names:
        out = re.sub(r'\[' + re.escape(name) + r'(?::[^\]]*)?\]', '', out)
    return re.sub(r'\n{3,}', '\n\n', out).strip()


def _chat_maybe_update_summary(chat: dict) -> None:
    """Refresh the cross-chat summary once there's enough material."""
    msgs = chat.get('messages') or []
    non_system = [m for m in msgs if m.get('role') != 'system']
    if len(non_system) >= SUMMARIZE_MIN_MESSAGES:
        chat['summary'] = _summarize_chat(msgs)
        chat['summaryUpdatedAt'] = int(time.time() * 1000)


def _job_payload_from_body(body: dict, message: str, prior_messages: list) -> dict:
    return {
        'message': message,
        'prior_messages': prior_messages,
        'grades': body.get('grades') if isinstance(body.get('grades'), list) else [],
        'courses': body.get('courses') if isinstance(body.get('courses'), list) else [],
        'assignments': body.get('assignments') if isinstance(body.get('assignments'), list) else [],
        'posts': body.get('posts') if isinstance(body.get('posts'), list) else [],
        'extras': body.get('extras') if isinstance(body.get('extras'), dict) else {},
        'grade_level': body.get('grade_level'),
    }


def _submit_chat_job(username: str, chat_id: str) -> None:
    """Queue the chat's pendingJob for background execution."""
    _register_cancel_event(username, chat_id)
    _job_executor.submit(_run_chat_job, username, chat_id)


def _run_chat_job(username: str, chat_id: str) -> None:
    """Background worker: run the layered pipeline and persist the reply."""
    lock = _chat_file_lock(username, chat_id)
    path = _chat_path(username, chat_id)

    with lock:
        chat = _read_json(path, None)
        if not chat or not isinstance(chat, dict):
            _clear_cancel_event(username, chat_id)
            return
        pj = chat.get('pendingJob')
        if not pj or pj.get('status') != 'queued':
            # Cancelled (or otherwise superseded) before we started.
            _clear_cancel_event(username, chat_id)
            return
        pj['status'] = 'running'
        pj['startedAt'] = int(time.time() * 1000)
        chat['pendingJob'] = pj
        _atomic_write_json(path, chat)

    payload = pj.get('payload') or {}
    message = (payload.get('message') or '').strip()
    result = None
    error = None
    try:
        from schoology.ai.layers import run_pipeline
        from schoology.ai.dev_auth import is_developer
        result = run_pipeline(
            student_message=message,
            prior_messages=payload.get('prior_messages') or [],
            grades=payload.get('grades') or [],
            courses=payload.get('courses') or [],
            assignments=payload.get('assignments') or [],
            posts=payload.get('posts') or [],
            extras=payload.get('extras') or {},
            grade_level=payload.get('grade_level'),
            is_developer=is_developer(username),
        )
    except Exception as exc:  # noqa: BLE001 - worker must never raise
        error = f'{type(exc).__name__}: {exc}'
        print(f'[CHAT-JOB] pipeline failed for {_safe_username(username)}/{chat_id}: {error}', file=sys.stderr)

    with lock:
        chat = _read_json(path, None)
        if not chat or not isinstance(chat, dict):
            _clear_cancel_event(username, chat_id)
            return
        pj = chat.get('pendingJob') or {}

        # Cooperative cancellation: the user cancelled while the pipeline
        # was running. Drop the result silently.
        cancel_event = None
        with _job_cancel_guard:
            cancel_event = _job_cancel_events.get((username, chat_id))
        if pj.get('status') == 'cancelled' or (cancel_event is not None and cancel_event.is_set()):
            _clear_cancel_event(username, chat_id)
            return

        if error:
            chat['pendingJob'] = {**pj, 'status': 'failed', 'error': error[:500]}
            chat['updatedAt'] = int(time.time() * 1000)
            _atomic_write_json(path, chat)
            _clear_cancel_event(username, chat_id)
            return

        raw = (result.get('content') or '') if isinstance(result, dict) else ''
        display = _strip_tool_brackets(raw)
        chat['messages'] = (chat.get('messages') or []) + [{
            'role': 'assistant',
            'content': raw,
            'display': display,
        }]
        chat['messages'] = chat['messages'][-MAX_MESSAGES_PER_CHAT:]
        chat.pop('pendingJob', None)
        chat['updatedAt'] = int(time.time() * 1000)
        _chat_maybe_update_summary(chat)
        _atomic_write_json(path, chat)
        _clear_cancel_event(username, chat_id)
        print(f'[CHAT-JOB] finished {_safe_username(username)}/{chat_id}', file=sys.stderr)


def _fail_stale_chat_jobs() -> None:
    """Mark queued/running jobs from a previous process as failed.

    Chat files persist across restarts but worker threads don't, so any
    pendingJob left in queued/running state after a boot belongs to a
    dead process. Mark them failed; the client offers a retry.
    """
    try:
        if not AI_CHATS_DIR.exists():
            return
        for user_dir in AI_CHATS_DIR.iterdir():
            if not user_dir.is_dir():
                continue
            for p in user_dir.glob('*.json'):
                if p.name.startswith('_'):
                    continue
                chat = _read_json(p, None)
                if not chat or not isinstance(chat, dict):
                    continue
                pj = chat.get('pendingJob')
                if pj and pj.get('status') in ('queued', 'running'):
                    pj['status'] = 'failed'
                    pj['error'] = 'server_restarted'
                    _atomic_write_json(p, chat)
                    print(f'[CHAT-JOB] marked stale job failed: {p.name}', file=sys.stderr)
    except OSError as exc:
        print(f'[CHAT-JOB] stale-job scan skipped: {exc}', file=sys.stderr)


@app.route('/api/chats/<chat_id>/messages', methods=['POST'])
def chat_submit_message(chat_id):
    """Append a user message + queue a background AI job for this chat.

    Body: {message, prior_messages, grades, courses, assignments, posts,
    extras, grade_level}. Returns 202 {status:'queued'} immediately; the
    pipeline runs in the background. 409 if a job is already active for
    this chat (one generation per chat at a time -- other chats generate
    in parallel).
    """
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    message = (body.get('message') or '').strip()
    if not message:
        return jsonify({'error': 'message required'}), 400
    # The client pre-persists the user message via POST /append
    # (role 'user') before any dashboard-data wait, so the message
    # survives chat switches/reloads mid-collection. When the AI
    # request is finally submitted, it passes skip_append=true so we
    # don't duplicate the stored message -- we only queue the job.
    skip_append = bool(body.get('skip_append'))

    lock = _chat_file_lock(username, chat_id)
    path = _chat_path(username, chat_id)
    with lock:
        chat = _read_json(path, None)
        if not chat:
            return jsonify({'error': 'not_found'}), 404
        pj = chat.get('pendingJob')
        if pj and pj.get('status') in ('queued', 'running'):
            return jsonify({'error': 'busy'}), 409

        # Developer-key proof: answer inline, no pipeline needed.
        from schoology.ai.dev_auth import is_developer_message, mark_developer
        if is_developer_message(message):
            mark_developer(username)
            reply = 'Developer key accepted. You are now verified as a developer.'
            chat['messages'] = (chat.get('messages') or []) + [
                {'role': 'user', 'content': message},
                {'role': 'assistant', 'content': reply, 'display': reply},
            ]
            chat['messages'] = chat['messages'][-MAX_MESSAGES_PER_CHAT:]
            chat['updatedAt'] = int(time.time() * 1000)
            _atomic_write_json(path, chat)
            return jsonify({'status': 'done'})

        prior = [
            {'role': m.get('role'), 'content': m.get('content') or ''}
            for m in (body.get('prior_messages') or [])
            if isinstance(m, dict)
        ]
        chat['messages'] = (chat.get('messages') or [])
        if not skip_append:
            chat['messages'] = chat['messages'] + [
                {'role': 'user', 'content': message}
            ]
            chat['messages'] = chat['messages'][-MAX_MESSAGES_PER_CHAT:]
        chat['pendingJob'] = {
            'status': 'queued',
            'createdAt': int(time.time() * 1000),
            'payload': _job_payload_from_body(body, message, prior),
        }
        chat['updatedAt'] = int(time.time() * 1000)
        _atomic_write_json(path, chat)

    _submit_chat_job(username, chat_id)
    return jsonify({'status': 'queued'}), 202


@app.route('/api/chats/<chat_id>/status', methods=['GET'])
def chat_status(chat_id):
    """Poll endpoint: messages + slim pendingJob status for one chat.

    {messages: [...], pendingJob: {status, error, createdAt} | null,
    updatedAt: ms}. pendingJob is null once the turn is done (the reply
    has been appended to messages).
    """
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    chat = _read_json(_chat_path(username, chat_id), None)
    if not chat:
        return jsonify({'error': 'not_found'}), 404
    pj = chat.get('pendingJob')
    slim = None
    if pj:
        slim = {
            'status': pj.get('status'),
            'error': pj.get('error'),
            'createdAt': pj.get('createdAt'),
        }
    return jsonify({
        'messages': chat.get('messages') or [],
        'pendingJob': slim,
        'updatedAt': chat.get('updatedAt'),
    })


@app.route('/api/chats/<chat_id>/cancel', methods=['POST'])
def chat_cancel(chat_id):
    """Cancel the chat's in-flight generation (cooperative)."""
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    lock = _chat_file_lock(username, chat_id)
    path = _chat_path(username, chat_id)
    with lock:
        chat = _read_json(path, None)
        if not chat:
            return jsonify({'error': 'not_found'}), 404
        pj = chat.get('pendingJob')
        if not pj or pj.get('status') in ('failed', 'cancelled'):
            return jsonify({'status': 'idle'}), 409
        pj['status'] = 'cancelled'
        chat['pendingJob'] = pj
        _atomic_write_json(path, chat)
    with _job_cancel_guard:
        evt = _job_cancel_events.get((username, chat_id))
    if evt is not None:
        evt.set()
    return jsonify({'status': 'cancelled'})


@app.route('/api/chats/<chat_id>/retry', methods=['POST'])
def chat_retry(chat_id):
    """Re-run the last failed/cancelled turn from its stored payload."""
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    lock = _chat_file_lock(username, chat_id)
    path = _chat_path(username, chat_id)
    with lock:
        chat = _read_json(path, None)
        if not chat:
            return jsonify({'error': 'not_found'}), 404
        pj = chat.get('pendingJob')
        if not pj or pj.get('status') not in ('failed', 'cancelled'):
            return jsonify({'error': 'nothing_to_retry'}), 409
        pj['status'] = 'queued'
        pj['error'] = None
        pj['createdAt'] = int(time.time() * 1000)
        chat['pendingJob'] = pj
        _atomic_write_json(path, chat)
    _submit_chat_job(username, chat_id)
    return jsonify({'status': 'queued'}), 202


@app.route('/api/chats/<chat_id>/edit', methods=['POST'])
def chat_edit_message(chat_id):
    """Replace a user message (edit & resend): truncate the chat at
    ``index``, append the edited message, queue a fresh background job.
    Body: {index, content, grades, courses, assignments, posts, extras,
    grade_level}.
    """
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    try:
        index = int(body.get('index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'index must be an integer'}), 400
    content = (body.get('content') or '').strip()
    if not content:
        return jsonify({'error': 'content is required'}), 400

    lock = _chat_file_lock(username, chat_id)
    path = _chat_path(username, chat_id)
    with lock:
        chat = _read_json(path, None)
        if not chat:
            return jsonify({'error': 'not_found'}), 404
        msgs = chat.get('messages') or []
        if index < 0 or index >= len(msgs) or msgs[index].get('role') != 'user':
            return jsonify({'error': 'bad_index'}), 400
        pj = chat.get('pendingJob')
        if pj and pj.get('status') in ('queued', 'running'):
            return jsonify({'error': 'busy'}), 409
        prior = [
            {'role': m.get('role'), 'content': m.get('content') or ''}
            for m in msgs[:index]
        ]
        msgs = msgs[:index] + [{'role': 'user', 'content': content}]
        chat['messages'] = msgs[-MAX_MESSAGES_PER_CHAT:]
        chat['pendingJob'] = {
            'status': 'queued',
            'createdAt': int(time.time() * 1000),
            'payload': _job_payload_from_body(body, content, prior),
        }
        chat['updatedAt'] = int(time.time() * 1000)
        _atomic_write_json(path, chat)
    _submit_chat_job(username, chat_id)
    return jsonify({'status': 'queued'}), 202


@app.route('/api/chats/<chat_id>/append', methods=['POST'])
def chat_append(chat_id):
    """Append a synthetic message (tool history / soft UI notes).

    Body: {role: 'assistant'|'tool', content, name?}. Used by the client
    for tool results and '_Noted'/'_Stopped' notes so everything the user
    sees is persisted server-side.
    """
    username = _require_username()
    if not username:
        return jsonify({'error': 'auth_required'}), 401
    body = request.get_json(silent=True) or {}
    role = (body.get('role') or '').strip()
    if role not in ('assistant', 'tool', 'user'):
        return jsonify({'error': 'role must be assistant, tool, or user'}), 400
    content = str(body.get('content') or '').strip()
    # User-role appends carry the full message (possibly with attached
    # file context); keep a generous cap so pre-persist never truncates
    # what POST /messages would have stored whole.
    cap = 120000 if role == 'user' else 8000
    content = content[:cap]
    if not content:
        return jsonify({'error': 'content is required'}), 400

    lock = _chat_file_lock(username, chat_id)
    path = _chat_path(username, chat_id)
    with lock:
        chat = _read_json(path, None)
        if not chat:
            return jsonify({'error': 'not_found'}), 404
        # Pre-persisting a user message while a generation is already
        # running would leave it stored without a job (and no reply).
        # 409 so the client falls back to the submit path's own busy
        # handling instead of creating a dangling message.
        pj = chat.get('pendingJob')
        if role == 'user' and pj and pj.get('status') in ('queued', 'running'):
            return jsonify({'error': 'busy'}), 409
        msg = {'role': role, 'content': content}
        name = (body.get('name') or '').strip()[:40]
        if role == 'tool' and name:
            msg['name'] = name
        chat['messages'] = (chat.get('messages') or []) + [msg]
        chat['messages'] = chat['messages'][-MAX_MESSAGES_PER_CHAT:]
        chat['updatedAt'] = int(time.time() * 1000)
        _atomic_write_json(path, chat)
    return jsonify({'status': 'ok'})


_fail_stale_chat_jobs()


# Server-side notification scheduler: starts once per process, sweeps every
# 60s for due-event / due-tomorrow / missing-assignment pushes. Only touches
# cached assignments — no Chromium launches from the scheduler itself.
threading.Thread(target=_notif_scheduler_loop, daemon=True, name='schoology-notif-scheduler').start()


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