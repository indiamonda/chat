#!/usr/bin/env python3
"""
Schoology MCP Frontend Server
Bridges the web dashboard to the Schoology MCP server

Keeps a persistent MCP server process per user to avoid browser launch overhead.
"""

import asyncio
import base64
import os
import sys
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
SERVER_PY = str(MCP_DIR / 'server.py')


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


class MCPConnectionPool:
    """No pooling - spawn fresh MCP process for each request.

    The MCP server is designed as a one-shot process. Each tool call
    spawns a new MCP process which handles the call then exits.
    This is slow (~3 min) but works correctly.
    """

    _instance = None

    def __init__(self):
        self._lock = asyncio.Lock()

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _create_session(self, username: str, password: str):
        """Create a new MCP session - spawns a fresh MCP process."""
        from mcp.client.session import ClientSession
        from mcp.client.stdio import StdioServerParameters
        from mcp import stdio_client

        env = {**os.environ.copy()}
        env['SCHOOLOGY_USERNAME'] = username
        if password:
            env['SCHOOLOGY_PASSWORD'] = password

        server_params = StdioServerParameters(
            command=VENV_PYTHON,
            args=[SERVER_PY],
            env=env
        )

        async with stdio_client(server_params) as stdio_transport:
            read_stream, write_stream = stdio_transport
            session = ClientSession(read_stream, write_stream)
            await session.initialize()
            return session

    async def call_tool(self, tool_name: str, arguments: dict, username: str, password: str):
        """Call a tool - spawns a fresh MCP process."""
        async with self._lock:
            session = await self._create_session(username, password)
            result = await session.call_tool(tool_name, arguments or {})
            return result


# Singleton pool instance
_mcp_pool = MCPConnectionPool.get_instance()


async def call_mcp_tool_async(tool_name: str, arguments: dict | None = None, username: str = None, password: str = None):
    """Call a tool on the Schoology MCP server via the persistent session pool.

    Args:
        tool_name: Name of the MCP tool to call
        arguments: Additional arguments for the tool
        username: Student ID for setting runtime credentials
        password: Schoology password for setting runtime credentials
    """
    print(f"[MCP POOL] call_mcp_tool_async called: tool={tool_name}, username={username}", file=sys.stderr)

    if not username:
        raise ValueError("username is required")

    try:
        result = await _mcp_pool.call_tool(tool_name, arguments, username, password)
        print(f"[MCP POOL] MCP tool {tool_name} returned: {type(result).__name__}", file=sys.stderr)
        return result
    except BaseException as e:
        print(f"[MCP POOL] MCP call failed: {type(e).__name__}: {e}", file=sys.stderr)
        return None


def call_mcp_tool(tool_name, username=None, password=None, arguments=None):
    """Synchronous wrapper for calling MCP tools."""
    import sys
    import traceback
    try:
        return asyncio.run(call_mcp_tool_async(tool_name, arguments, username, password))
    except Exception as e:
        print(f"MCP call failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return None


def call_mcp_tool_with_timeout(tool_name, username=None, password=None, timeout_seconds=120):
    """Call MCP with timeout to prevent hanging."""
    import sys
    import traceback
    try:
        return asyncio.run(asyncio.wait_for(
            call_mcp_tool_async(tool_name, None, username, password),
            timeout=timeout_seconds
        ))
    except asyncio.TimeoutError:
        print(f"MCP call timed out after {timeout_seconds}s for {tool_name}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"MCP call failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
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


def get_data_from_mcp_or_mock(tool_name, username=None, password=None):
    """Try MCP first, fall back to error response (no mock data).

    Args:
        tool_name: Name of the MCP tool to call
        username: Student ID for authentication
        password: Schoology password for authentication

    NOTE: First call for a user takes ~90s (cold browser + ClassLink login on 512MB Fly.io).
          Subsequent calls take ~3-5s (warm browser reuse).
    """
    import sys
    print(f"[DEBUG] get_data_from_mcp_or_mock called: tool={tool_name}, username={username}", file=sys.stderr)

    # Use longer timeout for cold start (browser launch + ClassLink login on Fly.io 512MB)
    # Warm requests typically complete in 3-5s
    data = call_mcp_tool_with_timeout(tool_name, username=username, password=password, timeout_seconds=180)
    print(f"[DEBUG] MCP returned: {type(data).__name__} = {data!r:.200}" if data else f"[DEBUG] MCP returned None", file=sys.stderr)

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
        'mcp_available': os.path.exists(VENV_PYTHON) and os.path.exists(SERVER_PY)
    })


@app.route('/api/ready')
def ready():
    """Simple readiness check - returns immediately without calling MCP."""
    return jsonify({'ready': True, 'message': 'Server is running'})


@app.route('/api/grades')
def get_grades():
    """Get current grades."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_grades', username, password)
    return jsonify(data)


@app.route('/api/courses')
def get_courses():
    """Get enrolled courses."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_courses', username, password)
    return jsonify(data)


@app.route('/api/assignments')
def get_assignments():
    """Get upcoming assignments."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_upcoming_assignments', username, password)
    return jsonify(data)


@app.route('/api/posts')
def get_posts():
    """Get recent posts."""
    username, password = decode_auth_header()
    data = get_data_from_mcp_or_mock('get_recent_posts', username, password)
    return jsonify(data)


@app.route('/api/refresh', methods=['POST'])
def refresh_data():
    """Force refresh all data."""
    # Note: Per-student sessions are managed by MCP; no global cache to clear
    return jsonify({'status': 'ok', 'last_updated': datetime.now().isoformat()})


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
    mcp_installed = os.path.exists(VENV_PYTHON) and os.path.exists(SERVER_PY)
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
    venv_exists = (MCP_DIR / '.venv' / 'bin' / 'python').exists()
    env_exists = (MCP_DIR / '.env').exists()
    username, _ = decode_auth_header()
    storage_exists = (MCP_DIR / f'storage_state_{username}.json').exists() if username else (MCP_DIR / 'storage_state.json').exists()

    return jsonify({
        'needs_setup': not venv_exists,
        'needs_credentials': not env_exists,
        'needs_login': not storage_exists,
        'venv_path': str(MCP_DIR / '.venv'),
        'server_path': str(SERVER_PY)
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