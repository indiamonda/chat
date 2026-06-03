"""Code execution: a thin wrapper around a remote judge service.

By default we hit the public Judge0 CE instance. The endpoint accepts a
language id (per Judge0) and source code, returns stdout/stderr/compile
output. For languages we don't have a judge for, the route returns
{_error: ...} and the frontend falls back to a "describe, don't run"
message.

In-browser Python (Skulpt/Pyodide) and JS/HTML iframes are handled on
the frontend, not here.
"""

import os
import time

import requests
from flask import jsonify, request


# Judge0 language IDs (subset). See https://judge0.com/#languages
LANGUAGE_IDS = {
    "c": 50,            # C (GCC 9.2.0)
    "cpp": 54,          # C++ (GCC 9.2.0)
    "java": 62,         # Java (OpenJDK 13)
    "python": 71,       # Python (3.8.1)
    "javascript": 63,   # JavaScript (Node.js 12.14.0)
    "typescript": 74,   # TypeScript
    "go": 60,           # Go (1.13.5)
    "rust": 73,         # Rust (1.40.0)
    "ruby": 72,
    "php": 68,
    "csharp": 51,
    "kotlin": 78,
    "swift": 83,
    "bash": 46,         # Bash (5.0.11)
}

JUDGE0_URL = os.environ.get("JUDGE0_URL", "https://judge0-ce.p.rapidapi.com")
JUDGE0_KEY = os.environ.get("JUDGE0_KEY", "")  # set via env if you have a RapidAPI key


def _run_on_judge0(language: str, source: str) -> dict:
    lang_id = LANGUAGE_IDS.get(language.lower())
    if not lang_id:
        return {"_error": True, "message": f"language '{language}' not supported"}
    if not JUDGE0_KEY:
        # No RapidAPI key -- try the public free judge instance.
        # Most public instances have rate limits; the request may fail.
        # The free endpoint is the "ce" instance on RapidAPI, which
        # requires a key. As a fallback, we'll return a clear error so
        # the frontend can degrade gracefully.
        return {"_error": True, "message": "code execution requires a JUDGE0_KEY env var (RapidAPI); set one on the server to enable this feature."}
    try:
        # Submit
        r = requests.post(
            f"{JUDGE0_URL}/submissions",
            params={"base64_encoded": "false", "wait": "true"},
            json={
                "language_id": lang_id,
                "source_code": source,
            },
            headers={"X-RapidAPI-Key": JUDGE0_KEY, "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com"},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        return {
            "language": language,
            "stdout": (data.get("stdout") or "").strip(),
            "stderr": (data.get("stderr") or "").strip(),
            "compile_output": (data.get("compile_output") or "").strip(),
            "status": data.get("status", {}).get("description"),
            "time": data.get("time"),
            "memory": data.get("memory"),
        }
    except Exception as exc:
        return {"_error": True, "message": f"judge request failed: {exc}"}


def register_routes(app):
    @app.route("/api/code/run", methods=["POST"])
    def _code_run_route():
        payload = request.get_json(silent=True) or {}
        language = (payload.get("language") or "").strip().lower()
        source = payload.get("source") or ""
        if not language or not source:
            return jsonify({"_error": True, "message": "language and source are required"})
        return jsonify(_run_on_judge0(language, source))

    @app.route("/api/code/languages", methods=["GET"])
    def _code_languages_route():
        return jsonify({"languages": sorted(LANGUAGE_IDS.keys())})
