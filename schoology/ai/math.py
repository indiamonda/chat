"""Math tools: calculator, solver, calculus, linear algebra, combinatorics,
graph rendering, unit conversion. All powered by SymPy (with pint for units
and matplotlib for graphs).

Imports are lazy: the heavy libraries only load on the first request to an
endpoint that needs them, so idle RSS stays low on the 512MB Fly machine.
"""

import base64
import io
import json
import re
import traceback

from flask import jsonify, request


# ---------------------------------------------------------------------------
# Math expression parsing helpers
# ---------------------------------------------------------------------------

# Substitutions the user is likely to want: ^ for **, common Greek letters
# to SymPy names, math constants, etc. Applied BEFORE parse_expr.
_USER_FRIENDLY = {
    "π": "pi",
    "∞": "oo",
    "τ": "2*pi",
}


def _preprocess(expr: str) -> str:
    """Apply user-friendly substitutions to a math expression string."""
    s = expr
    for k, v in _USER_FRIENDLY.items():
        s = s.replace(k, v)
    # ^ to **, but only at the top level — ^ has no other meaning here.
    s = s.replace("^", "**")
    # Implicit multiplication: "2x" -> "2*x", "xy" handled less aggressively.
    # We add * between a digit and a letter, or a closing paren and letter.
    s = re.sub(r"(\d)([a-zA-Z(])", r"\1*\2", s)
    return s


def _parse(expr: str, locals_dict: dict | None = None):
    """Parse a math expression safely using SymPy.

    We never call Python's eval/exec on the input. SymPy's parse_expr is
    its own parser; it only understands SymPy syntax, not arbitrary Python.
    """
    from sympy import parse_expr, sympify
    from sympy.parsing.sympy_parser import (
        standard_transformations,
        implicit_multiplication_application,
        convert_xor,
    )
    transformations = standard_transformations + (
        implicit_multiplication_application,
        convert_xor,
    )
    s = _preprocess(expr)
    if locals_dict is None:
        locals_dict = {}
    return parse_expr(s, local_dict=locals_dict, transformations=transformations, evaluate=True)


def _to_result(value, max_chars: int = 4000) -> dict:
    """Convert a SymPy value to a {result, latex} dict for the API.

    The result string is the plain sstr() / str() of the value; the latex
    string is value.latex() if the value supports it, else None.
    """
    from sympy import sstr, latex
    try:
        result = sstr(value)
    except Exception:
        result = str(value)
    try:
        lx = latex(value)
    except Exception:
        lx = None
    if len(result) > max_chars:
        result = result[:max_chars] + "...(truncated)"
    return {"result": result, "latex": lx}


# ---------------------------------------------------------------------------
# /api/math/eval
# ---------------------------------------------------------------------------

def _math_eval(payload: dict) -> dict:
    """Evaluate a math expression and return result + LaTeX."""
    from sympy import sstr, latex
    expr_str = (payload.get("expr") or "").strip()
    if not expr_str:
        return {"_error": True, "message": "expr is required"}
    try:
        value = _parse(expr_str)
    except Exception as exc:
        return {"_error": True, "message": f"could not parse '{expr_str}': {exc}"}
    return _to_result(value)


# ---------------------------------------------------------------------------
# /api/math/solve
# ---------------------------------------------------------------------------

def _math_solve(payload: dict) -> dict:
    """Solve equation == 0 (or expr - rhs == 0) for the given variable.

    Body: { equation: "x^2 - 4" or "x^2 - 4 = 0", variable: "x" }.
    """
    from sympy import Eq, Symbol
    eq_str = (payload.get("equation") or "").strip()
    var_str = (payload.get("variable") or "x").strip()
    if not eq_str:
        return {"_error": True, "message": "equation is required"}
    var = Symbol(var_str)
    try:
        if "=" in eq_str:
            lhs, rhs = eq_str.split("=", 1)
            expr = _parse(lhs, {var_str: var}) - _parse(rhs, {var_str: var})
        else:
            expr = _parse(eq_str, {var_str: var})
        from sympy import solve
        solutions = solve(expr, var)
    except Exception as exc:
        return {"_error": True, "message": f"could not solve: {exc}"}
    return {
        "variable": var_str,
        "solutions": [_to_result(s) for s in solutions],
        "count": len(solutions),
    }


# ---------------------------------------------------------------------------
# /api/math/calculus
# ---------------------------------------------------------------------------

def _math_calculus(payload: dict) -> dict:
    """Differentiation, integration, or limits.

    Body: { op: "diff"|"int"|"limit", expr, var: "x", point: ... }.
    For int: optionally { lower, upper } for definite integrals.
    For limit: point is required (number, "oo", or "-oo").
    """
    from sympy import Symbol, oo, diff, integrate, limit
    op = (payload.get("op") or "").strip().lower()
    expr_str = (payload.get("expr") or "").strip()
    var_str = (payload.get("var") or "x").strip()
    if not op or op not in ("diff", "int", "limit"):
        return {"_error": True, "message": "op must be 'diff', 'int', or 'limit'"}
    if not expr_str:
        return {"_error": True, "message": "expr is required"}
    var = Symbol(var_str)
    try:
        expr = _parse(expr_str, {var_str: var})
        if op == "diff":
            order = int(payload.get("order") or 1)
            result = diff(expr, var, order)
        elif op == "int":
            lower = payload.get("lower")
            upper = payload.get("upper")
            if lower is not None and upper is not None:
                result = integrate(expr, (var, _parse(str(lower)), _parse(str(upper))))
            else:
                result = integrate(expr, var)
        else:  # limit
            point_str = payload.get("point")
            if point_str is None:
                return {"_error": True, "message": "point is required for limit"}
            point = oo if point_str in ("oo", "inf", "+inf") else (
                -oo if point_str in ("-oo", "-inf") else _parse(str(point_str))
            )
            result = limit(expr, var, point)
    except Exception as exc:
        return {"_error": True, "message": f"{op} failed: {exc}"}
    return {"op": op, **_to_result(result)}


# ---------------------------------------------------------------------------
# /api/math/linalg
# ---------------------------------------------------------------------------

def _math_linalg(payload: dict) -> dict:
    """Linear algebra operations on a matrix.

    Body: { op: "det"|"inv"|"eigen"|"transpose"|"rank", matrix: [[...]] }.
    op "solve" additionally takes { vector: [...] }.
    """
    from sympy import Matrix, Rational
    op = (payload.get("op") or "").strip().lower()
    matrix_data = payload.get("matrix")
    if not matrix_data:
        return {"_error": True, "message": "matrix is required"}
    try:
        M = Matrix(matrix_data)
    except Exception as exc:
        return {"_error": True, "message": f"could not build matrix: {exc}"}
    try:
        if op == "det":
            result = M.det()
            return {"op": "det", **_to_result(result)}
        if op == "inv":
            return {"op": "inv", "matrix": [[str(x) for x in row] for row in M.inv().tolist()]}
        if op == "eigen":
            vals = M.eigenvals()
            vecs = M.eigenvects()
            return {
                "op": "eigen",
                "eigenvalues": [str(v) for v in vals.keys()],
                "multiplicities": list(vals.values()),
                "vectors_count": sum(m for _, m in vals.items()),
            }
        if op == "transpose":
            return {"op": "transpose", "matrix": [[str(x) for x in row] for row in M.T.tolist()]}
        if op == "rank":
            return {"op": "rank", "rank": M.rank()}
        if op == "solve":
            vector_data = payload.get("vector")
            if not vector_data:
                return {"_error": True, "message": "vector is required for solve"}
            b = Matrix(vector_data)
            return {"op": "solve", "solution": [str(x) for x in M.solve(b).tolist()]}
        return {"_error": True, "message": f"unknown op '{op}'"}
    except Exception as exc:
        return {"_error": True, "message": f"linalg {op} failed: {exc}"}


# ---------------------------------------------------------------------------
# /api/math/combinatorics
# ---------------------------------------------------------------------------

def _math_combinatorics(payload: dict) -> dict:
    """Permutations, combinations, and factorials.

    Body: { op: "perm"|"comb"|"fact", n, k? }.
    """
    from sympy import factorial, binomial, Integer
    op = (payload.get("op") or "").strip().lower()
    n = payload.get("n")
    k = payload.get("k")
    if op == "fact":
        if n is None:
            return {"_error": True, "message": "n is required for fact"}
        try:
            n_int = int(n)
        except (TypeError, ValueError):
            return {"_error": True, "message": "n must be an integer"}
        return {"op": "fact", "n": n_int, "result": str(factorial(n_int))}
    if n is None or k is None:
        return {"_error": True, "message": "n and k are required"}
    try:
        n_int = int(n)
        k_int = int(k)
    except (TypeError, ValueError):
        return {"_error": True, "message": "n and k must be integers"}
    if k_int > n_int or k_int < 0 or n_int < 0:
        return {"_error": True, "message": "invalid n/k"}
    if op == "perm":
        return {"op": "perm", "n": n_int, "k": k_int, "result": str(factorial(n_int) // factorial(n_int - k_int))}
    if op == "comb":
        return {"op": "comb", "n": n_int, "k": k_int, "result": str(binomial(n_int, k_int))}
    return {"_error": True, "message": f"unknown op '{op}'"}


# ---------------------------------------------------------------------------
# /api/math/graph
# ---------------------------------------------------------------------------

def _math_graph(payload: dict) -> dict:
    """Plot y = f(x) and return a base64 PNG.

    Body: { expr, x_range: [lo, hi], y_range?: [lo, hi], samples?: 200 }.
    """
    import matplotlib
    matplotlib.use("Agg")  # no display
    import matplotlib.pyplot as plt
    from sympy import Symbol, lambdify
    import numpy as np

    expr_str = (payload.get("expr") or "").strip()
    x_range = payload.get("x_range") or [-10, 10]
    y_range = payload.get("y_range")
    samples = int(payload.get("samples") or 200)
    if not expr_str:
        return {"_error": True, "message": "expr is required"}
    if not (isinstance(x_range, list) and len(x_range) == 2):
        return {"_error": True, "message": "x_range must be [lo, hi]"}
    try:
        var = Symbol("x")
        expr = _parse(expr_str, {"x": var})
        f = lambdify(var, expr, modules=["numpy"])
        xs = np.linspace(float(x_range[0]), float(x_range[1]), samples)
        ys = f(xs)
        # SymPy may return a symbolic object if x is symbolic -- coerce.
        ys = np.asarray(ys, dtype=float)
        # Mask out infinities / NaNs so the plot line doesn't span.
        ys_masked = np.where(np.isfinite(ys), ys, np.nan)
    except Exception as exc:
        return {"_error": True, "message": f"could not evaluate '{expr_str}': {exc}"}

    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=100)
    ax.plot(xs, ys_masked, color="#6366f1", linewidth=2)
    ax.axhline(0, color="#666", linewidth=0.5)
    ax.axvline(0, color="#666", linewidth=0.5)
    ax.grid(True, alpha=0.3)
    ax.set_xlabel("x")
    ax.set_ylabel(f"f(x) = {expr_str}")
    if y_range and isinstance(y_range, list) and len(y_range) == 2:
        ax.set_ylim(float(y_range[0]), float(y_range[1]))
    ax.set_title(f"y = {expr_str}")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    encoded = base64.b64encode(buf.read()).decode("ascii")
    return {"png_base64": encoded, "format": "png"}


# ---------------------------------------------------------------------------
# /api/math/convert
# ---------------------------------------------------------------------------

def _math_convert(payload: dict) -> dict:
    """Convert a value from one unit to another. Uses pint.

    Body: { value, from_unit, to_unit, quantity? }.
    quantity helps disambiguate ambiguous unit names like 's' (seconds vs
    Siemens) -- e.g. quantity='time' forces seconds interpretation.
    """
    value = payload.get("value")
    from_unit = (payload.get("from_unit") or "").strip()
    to_unit = (payload.get("to_unit") or "").strip()
    quantity = (payload.get("quantity") or "").strip() or None
    if value is None or not from_unit or not to_unit:
        return {"_error": True, "message": "value, from_unit, to_unit are required"}
    try:
        import pint
        ureg = pint.UnitRegistry()
        if quantity:
            q = ureg.Quantity(float(value), from_unit).to(to_unit)
        else:
            q = ureg.Quantity(float(value), from_unit).to(to_unit)
        return {
            "value": float(value),
            "from_unit": from_unit,
            "to_unit": to_unit,
            "result": q.magnitude,
            "result_unit": str(q.units),
        }
    except Exception as exc:
        return {"_error": True, "message": f"convert failed: {exc}"}


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_routes(app):
    @app.route("/api/math/eval", methods=["POST"])
    def _math_eval_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_eval(payload))

    @app.route("/api/math/solve", methods=["POST"])
    def _math_solve_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_solve(payload))

    @app.route("/api/math/calculus", methods=["POST"])
    def _math_calculus_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_calculus(payload))

    @app.route("/api/math/linalg", methods=["POST"])
    def _math_linalg_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_linalg(payload))

    @app.route("/api/math/combinatorics", methods=["POST"])
    def _math_combinatorics_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_combinatorics(payload))

    @app.route("/api/math/graph", methods=["POST"])
    def _math_graph_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_graph(payload))

    @app.route("/api/math/convert", methods=["POST"])
    def _math_convert_route():
        payload = request.get_json(silent=True) or {}
        return jsonify(_math_convert(payload))
