# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is the **`jchat` Fly.io app** — a single deployment that hosts **multiple independent applications** under one container:

1. **JimmyQrg Chat** (`server/index.js`, `public/`, `index.html`) — the main group chat + DMs + admin tools app. Express on port 8080.
2. **Schoology Dashboard** (`schoology/`) — a Flask app on port 8081 that proxies upstream `schoology-mcp` to fetch grades/courses/assignments, plus a full AI Assistant (math, Wikipedia, files, code, integrations, web). Fronted by the Node proxy at `/schoology/api/*` → `http://127.0.0.1:8081/...`.
3. **Schoology MCP** (`schoology-mcp/`) — vendored copy of [dajun666/schoology-mcp](https://github.com/dajun666/schoology-mcp), used by the schoology dashboard to drive a headless Playwright browser against Schoology.

Production: `https://jchat.fly.dev`. Live logs: `fly logs -a jchat`.

## HARD CONSTRAINT — read first

> **"this repo also powers other applications, when you edit schoology, you cannot affect any other applications"** — user, 2026-05.

- `schoology/` is the **only safe place to make schoology-related changes**. The rest of the repo (chat, public/, server/) is the main app and must not be touched for schoology bugs.
- `schoology-mcp/` is **shared** with other consumers — do not edit it for dashboard bugs. To update it: copy from upstream (`rsync -a --delete --exclude='.git' --exclude='.venv' --exclude='__pycache__' /tmp/schoology-mcp-new/ ./schoology-mcp/`), then audit for breaking changes (single-tenant switch, tool renames) and adjust `schoology/server.py` + `schoology/run_tool.py` + `schoology/index.html` accordingly.
- The Dockerfile, `fly.toml`, Node proxy, and `public/` files serve **both** the main chat and the schoology dashboard. A change there must be checked against both.

If a schoology bug tempts you to edit anything outside `schoology/`, stop and ask first.

## Common commands

**Local dev (main chat only — schoology dashboard needs the full Docker image):**
```bash
npm install
npm run init-db
npm run dev          # http://localhost:3000
```

**Deploy to Fly:**
```bash
fly deploy -a jchat                          # one-step; fly builds + pushes + releases
# OR the two-step pattern documented in agent.md (used when build-only was needed):
flyctl deploy --build-only --push -a jchat --config fly.toml
flyctl deploy -a jchat --image registry.fly.io/jchat:deployment-<TAG>
```

**Inspect / debug:**
```bash
fly logs -a jchat --tail 100
fly ssh console -a jchat                       # in-container shell
fly status -a jchat
fly volumes list -a jchat
```

**Local Python for schoology changes:**
```bash
cd schoology
../.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 server:app   # uses the venv created by the Dockerfile
```

## Architecture details that matter

### Container layout (Dockerfile `CMD`)
```sh
cd /app/schoology; \
  /app/.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 --workers 2 --threads 8 -c /app/schoology/gunicorn.conf.py server:app \
  & node /app/server/index.js
```
- One container, two processes. The Node app on **8080** is public; the Flask app on **8081** is internal-only and reached only through the Node proxy.
- Persistent volume `/data` is mounted for SQLite (`chat.db`), schoology session cookies, and AI assistant file uploads. 1 GB volume in `sjc` region.
- 512 MB RAM, shared CPU. Memory is tight: Whisper `tiny` + CLIP + Playwright chromium + a per-user daemon pool all fight for it. Watch RSS.

### gunicorn: two workers, two roles
- **Worker 0** runs a long-lived `run_tool.py` per authenticated user (the "daemon pool"). Each daemon holds a warm Playwright browser for that student. The pool is keyed by username, LRU-evicted at `DAEMON_POOL_MAX=5`. `GUNICORN_WORKER_INDEX` is set in the master env by `schoology/gunicorn.conf.py:pre_fork` so children know which role they're playing.
- **Worker 1** runs per-request subprocesses (cold start, fallback) using the same env-var credential handoff. Use this for >5 concurrent students and accept the cold-start cost.
- **Why per-user daemons:** upstream `schoology-mcp` is single-tenant — it reads `SCHOOLOGY_USERNAME`/`SCHOOLOGY_PASSWORD` from its own process env at spawn and keeps one headless browser per process. The pool is how we serve multiple students from one Flask worker.
- **Why `/data/schoology_storage.json`:** image redeploys lose `/root/.cache/...`, so the storage state env-var points to the persistent volume.

### Node → Flask proxy (`server/index.js`)
Non-obvious bugs already fixed and worth not re-introducing:
- Don't re-serialize `req.body={}` for GET/HEAD and send it as a JSON body — gunicorn keep-alive reads `{}` as the next request line and returns 400.
- Don't try to JSON-stringify a multipart body and forward it — you have to `req.pipe(proxyReq)` raw, and `return` before `proxyReq.end()`.
The `proxyRequest` helper handles both. New `/schoology/api/*` endpoints are safer to add; the proxy just forwards.

### AI Assistant architecture (`schoology/index.html` + `schoology/ai/`)
- **Tool protocol** is bracket commands emitted by the model: `[CALC:expr]`, `[WIKI:topic]`, `[FILE:id|name|type|size]`, etc. A `TOOL_REGISTRY` at the top of `schoology/index.html` is the single source of truth: the system prompt, welcome message, `generateDemoResponse` help branch, and `handleAICommands` dispatcher all read from it. Adding a new tool = one registry entry.
- **Tool results go into `state.chatHistory`** with `role: 'tool'` so the model sees them on the next turn. Cap each at 2,000 chars in history; the full result stays in the chat UI.
- **File upload** is real: `handleFileUpload` POSTs to `/api/file/ingest`, gets a `file_id`, and on send appends `[FILE:id|name|type|size]` markers. `/api/file/context` expands markers into extracted text (PDF, OCR, Whisper transcription, etc.) before the model sees the message. Files are stored in `/data/ai_uploads/<uuid>` and auto-purged after 1 hour.
- **New AI routes** live in `schoology/ai/*.py` (math, geometry, knowledge, science, files, code, integrations, basics, web) and self-register via `register_routes(app)` from `schoology/ai/__init__.py`. `schoology/server.py` calls `register_ai_routes(app)` once near the bottom of its route block.
- **Auth** for AI routes is the same `decode_auth_header()` Basic-auth pattern as the rest of the API.
- **No rate limiting in v1**; most routes hit free public APIs with their own quotas (Wikipedia, Open-Meteo, MyMemory, arXiv). GitHub is 60/hr unauth.

### Theme system in `schoology/`
CSS variables on `:root` / `[data-theme="light"]` / `[data-theme="dark"]`. `--surface` is used for chat message backgrounds. Toggle: `#darkModeToggle` checkbox; init: `initDarkMode()` reads localStorage or `prefers-color-scheme`.

### Error display convention
> "Don't write fallbacks, write show error messages and fix the thing properly" — user.
> Error messages should NOT say "contact administrator" (personal project).
Errors render as a red box with the exact message — no generic "something went wrong" replacements.

## Environment variables (production)

| Var | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | yes | signs chat session cookies |
| `DATA_DIR` | no | default `/data`; SQLite + schoology storage + AI uploads |
| `SCHOOLOGY_STORAGE_STATE` | no | default `/data/schoology_storage.json` |
| `SCHOOLOGY_HEADLESS` | no | default `true` |
| `SCHOOLOGY_KEEPALIVE` | no | default `false` |
| `DAEMON_POOL_MAX` | no | default `5`; cap on per-user daemons in worker 0 |
| `JUDGE0_KEY` | no | enables `[RUN:lang code]` for C/C++/Rust/Go/Java |
| `JUDGE0_URL` | no | default `https://judge0-ce.p.rapidapi.com` |

## Where to find what

- **Chat app entry points**: `server/index.js` + `public/assets/js/main.js` + `server/db.js` (see README.md).
- **Schoology dashboard UI**: `schoology/index.html` (single large file; `TOOL_REGISTRY` is at the top).
- **Schoology Flask**: `schoology/server.py` (daemon pool, all `/api/*` routes, AI registration).
- **Schoology AI routes**: `schoology/ai/__init__.py` (aggregator) + one file per tool family.
- **gunicorn config**: `schoology/gunicorn.conf.py` (`pre_fork` sets `GUNICORN_WORKER_INDEX`).
- **Project memory** (curated, persists across sessions): `~/.claude/projects/-Users-Benran-Documents-GitHub-chat/memory/` — `schoology-architecture.md` for the per-user daemon pool + upstream tool surface; `server-proxy-pitfalls.md` for the two non-obvious Node proxy bugs.
- **Working notes** (free-form, session-scratch): `agent.md` at repo root.

## Do not

- Do not edit `schoology-mcp/` for dashboard bugs. Update only when upstream changes.
- Do not add "fallback" error handlers that swallow the real message. Show the actual error and fix the cause.
- Do not add `exec` to the Dockerfile `CMD` — `&` is the right pattern for running gunicorn and node in one container.
- Do not assume the chat app can be suspended — `agent.md` says "this app cannot suspend - it powers other applications".
- Do not use demo/placeholder data in production paths (e.g. schoology grades). The `generateDemoResponse` AI fallback is for the AI tab only, and even there, "DO NOT USE DEMO INFORMATION UNLESS IS IN THE DEMO MODE".
