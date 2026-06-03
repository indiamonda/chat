"""Geometry tools: Desmos and GeoGebra embeds.

We don't run the math for these -- we just hand the model/user a working
embed URL inside an iframe. The Desmos embed API is a public iframe
endpoint; the GeoGebra embed is similar.
"""

import html
import urllib.parse

from flask import jsonify, request


_DESMOS_EXPR_HELP = (
    "Available: e.g. y=sin(x), x^2+y^2=4 (implicit), parametric (t,sin t), "
    "polar (r,theta), or point lists like (1,2),(3,4)."
)


def _desmos_html(expr: str) -> str:
    """Return a self-contained HTML page embedding a Desmos calculator
    with the given expression pre-loaded.
    """
    safe_expr = html.escape(expr or "")
    # The Desmos embed API accepts a `?embed=true&expr=...` URL.
    # We use the public calculator.html endpoint, which is allowed for
    # embedding.
    encoded = urllib.parse.quote(expr or "")
    embed_src = f"https://www.desmos.com/calculator/embed?expr={encoded}"
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Desmos</title>
<style>html,body{{margin:0;height:100%;}} iframe{{border:0;width:100%;height:100%;}}</style>
</head><body>
<iframe src="{embed_src}" title="Desmos graph: {safe_expr}" sandbox="allow-scripts allow-same-origin"></iframe>
</body></html>"""


def _geogebra_html(cmd: str) -> str:
    """Return HTML for a GeoGebra applet with a command pre-loaded.

    GeoGebra's "simple" embed takes commands like:
      Circle((0,0), 2)
      f(x) = sin(x)
      Polygon((0,0),(1,0),(1,1))
    """
    safe_cmd = html.escape(cmd or "")
    encoded = urllib.parse.quote(cmd or "")
    # Use the material embed endpoint which is the public one.
    # The simple ggb iframe approach: append cmd via URL hash isn't great;
    # for now we render a small launcher with the command text shown.
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>GeoGebra</title>
<style>html,body{{margin:0;height:100%;font-family:system-ui;}} iframe{{border:0;width:100%;height:100%;}}</style>
</head><body>
<iframe src="https://www.geogebra.org/material/iframe/id/dynamic" title="GeoGebra" sandbox="allow-scripts allow-same-origin"></iframe>
<div style="position:fixed;left:8px;bottom:8px;background:rgba(255,255,255,0.9);padding:6px 10px;border-radius:6px;font-size:13px;max-width:90%;">
  Type in GeoGebra: <code>{safe_cmd}</code>
</div>
</body></html>"""


def register_routes(app):
    @app.route("/api/geometry/desmos", methods=["GET"])
    def _desmos_route():
        expr = request.args.get("expr", "")
        if not expr:
            return jsonify({"_error": True, "message": "expr query param required"})
        return _desmos_html(expr), 200, {"Content-Type": "text/html; charset=utf-8"}

    @app.route("/api/geometry/geogebra", methods=["GET"])
    def _geogebra_route():
        cmd = request.args.get("cmd", "")
        if not cmd:
            return jsonify({"_error": True, "message": "cmd query param required"})
        return _geogebra_html(cmd), 200, {"Content-Type": "text/html; charset=utf-8"}
