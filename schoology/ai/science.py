"""Science reference data: periodic table and physical constants.

Both are static JSON shipped with the package -- no API calls, no model
weight downloads. Lookup is in-memory after the first read.
"""

import json
from pathlib import Path

from flask import jsonify, request

DATA_DIR = Path(__file__).parent / "science_data"

_ELEMENTS = None
_CONSTANTS = None


def _load_elements():
    global _ELEMENTS
    if _ELEMENTS is None:
        with open(DATA_DIR / "elements.json", "r", encoding="utf-8") as f:
            _ELEMENTS = json.load(f)["elements"]
    return _ELEMENTS


def _load_constants():
    global _CONSTANTS
    if _CONSTANTS is None:
        with open(DATA_DIR / "constants.json", "r", encoding="utf-8") as f:
            _CONSTANTS = json.load(f)["constants"]
    return _CONSTANTS


def _find_element(token: str):
    """Find an element by symbol, name, or atomic number."""
    token = token.strip()
    elements = _load_elements()
    for e in elements:
        if e["symbol"].lower() == token.lower():
            return e
    for e in elements:
        if e["name"].lower() == token.lower():
            return e
    try:
        n = int(token)
        for e in elements:
            if e["number"] == n:
                return e
    except ValueError:
        pass
    return None


def register_routes(app):
    @app.route("/api/element/<token>", methods=["GET"])
    def _element_route(token):
        e = _find_element(token)
        if not e:
            return jsonify({"_error": True, "message": f"unknown element '{token}'"}), 404
        return jsonify(e)

    @app.route("/api/physics/constant/<name>", methods=["GET"])
    def _constant_route(name):
        consts = _load_constants()
        # Try direct key, then symbol, then case-insensitive name match.
        if name in consts:
            return jsonify({"key": name, **consts[name]})
        for k, v in consts.items():
            if v.get("symbol", "").lower() == name.lower():
                return jsonify({"key": k, **v})
        for k, v in consts.items():
            if name.lower() in v.get("name", "").lower():
                return jsonify({"key": k, **v})
        return jsonify({"_error": True, "message": f"unknown constant '{name}'"}), 404
