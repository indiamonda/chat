#!/usr/bin/env python3
"""
Schoology MCP Frontend Server
Bridges the web dashboard to the Schoology MCP server
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.')
CORS(app)

# Get the directory where this script is located
SCRIPT_DIR = Path(__file__).parent
MCP_DIR = SCRIPT_DIR.parent / 'schoology-mcp'
VENV_PYTHON = str(MCP_DIR / '.venv' / 'bin' / 'python')
SERVER_PY = str(MCP_DIR / 'server.py')

# Cache for MCP responses
cache = {
    'grades': None,
    'courses': None,
    'assignments': None,
    'posts': None,
    'last_updated': None
}
cache_lock = None

def call_mcp_tool(tool_name, arguments=None):
    """
    Call a tool on the Schoology MCP server.
    """
    try:
        # Try to use the MCP server if available
        result = subprocess.run(
            ['claude', 'mcp', 'call', 'schoology', '--tool', tool_name],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(MCP_DIR)
        )

        if result.returncode == 0:
            return json.loads(result.stdout)
        else:
            # MCP server not available, return None
            return None
    except Exception as e:
        print(f"MCP call failed: {e}")
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


def get_data_from_mcp_or_mock(tool_name):
    """Try MCP first, fall back to mock data."""
    data = call_mcp_tool(tool_name)
    if data is not None:
        return data

    mock = get_mock_data()
    return mock.get(tool_name.replace('get_', '').replace('_', ''), [])


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


@app.route('/api/grades')
def get_grades():
    """Get current grades."""
    global cache
    if cache['grades'] is None:
        cache['grades'] = get_data_from_mcp_or_mock('get_grades')
        cache['last_updated'] = datetime.now().isoformat()
    return jsonify(cache['grades'])


@app.route('/api/courses')
def get_courses():
    """Get enrolled courses."""
    global cache
    if cache['courses'] is None:
        cache['courses'] = get_data_from_mcp_or_mock('get_courses')
        cache['last_updated'] = datetime.now().isoformat()
    return jsonify(cache['courses'])


@app.route('/api/assignments')
def get_assignments():
    """Get upcoming assignments."""
    global cache
    if cache['assignments'] is None:
        cache['assignments'] = get_data_from_mcp_or_mock('get_upcoming_assignments')
        cache['last_updated'] = datetime.now().isoformat()
    return jsonify(cache['assignments'])


@app.route('/api/posts')
def get_posts():
    """Get recent posts."""
    global cache
    if cache['posts'] is None:
        cache['posts'] = get_data_from_mcp_or_mock('get_recent_posts')
        cache['last_updated'] = datetime.now().isoformat()
    return jsonify(cache['posts'])


@app.route('/api/refresh', methods=['POST'])
def refresh_data():
    """Force refresh all data."""
    global cache
    cache['grades'] = None
    cache['courses'] = None
    cache['assignments'] = None
    cache['posts'] = None
    return jsonify({'status': 'ok', 'last_updated': datetime.now().isoformat()})


@app.route('/api/clear-session', methods=['POST'])
def clear_session():
    """Clear the Schoology session."""
    storage_state = MCP_DIR / 'storage_state.json'
    if storage_state.exists():
        storage_state.unlink()
    return jsonify({'status': 'ok'})


@app.route('/api/status')
def get_status():
    """Get connection status."""
    mcp_installed = os.path.exists(VENV_PYTHON) and os.path.exists(SERVER_PY)
    storage_state = MCP_DIR / 'storage_state.json'

    return jsonify({
        'mcp_installed': mcp_installed,
        'session_exists': storage_state.exists(),
        'last_updated': cache.get('last_updated')
    })


@app.route('/api/setup-status')
def setup_status():
    """Check what setup is needed."""
    venv_exists = (MCP_DIR / '.venv' / 'bin' / 'python').exists()
    env_exists = (MCP_DIR / '.env').exists()
    storage_exists = (MCP_DIR / 'storage_state.json').exists()

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

    app.run(host='0.0.0.0', port=8080, debug=True)