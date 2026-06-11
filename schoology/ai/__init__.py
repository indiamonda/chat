"""AI Assistant tool package.

Each module exposes a ``register_routes(app)`` function that adds a
family of /api/... endpoints to the Flask app. ``register_routes(app)``
in this __init__ aggregates them.

All new code lives under schoology/; this package is the only safe
place to add AI tools. schoology-mcp/ stays untouched.
"""

from .math import register_routes as register_math_routes
from .geometry import register_routes as register_geometry_routes
from .knowledge import register_routes as register_knowledge_routes
from .science import register_routes as register_science_routes
from .files import register_routes as register_files_routes
from .code import register_routes as register_code_routes
from .integrations import register_routes as register_integrations_routes
from .basics import register_routes as register_basics_routes
from .web import register_routes as register_web_routes
from .social import register_routes as register_social_routes
from ..gate import register_routes as register_gate_routes


def register_routes(app):
    """Register all AI tool routes on the Flask app.

    Called once from schoology/server.py after the existing route block.
    Order doesn't matter -- Flask routes are registered, not invoked.
    """
    register_math_routes(app)
    register_geometry_routes(app)
    register_knowledge_routes(app)
    register_science_routes(app)
    register_files_routes(app)
    register_code_routes(app)
    register_integrations_routes(app)
    register_basics_routes(app)
    register_web_routes(app)
    register_social_routes(app)
    register_gate_routes(app)
