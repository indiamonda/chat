"""Gunicorn config -- assigns each worker a stable index env var.

`pre_fork` runs in the master process before each worker is forked.
Setting `GUNICORN_WORKER_INDEX` in the master's env causes the child
to inherit it on fork, so each worker can read its own index via
`os.environ.get("GUNICORN_WORKER_INDEX")` to decide which mode to run
in (e.g. host the long-lived MCP daemon vs. fall back to per-request
subprocesses).

Incrementing a module-level counter in the master guarantees the
indices are 0, 1, 2, ... in fork order.
"""

import os

_worker_index = 0


def pre_fork(server, worker):
    global _worker_index
    os.environ["GUNICORN_WORKER_INDEX"] = str(_worker_index)
    _worker_index += 1
