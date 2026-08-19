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
  /app/.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 --workers 1 --threads 8 -c /app/schoology/gunicorn.conf.py server:app \
  & node /app/server/index.js
```
- One container, two processes. The Node app on **8080** is public; the Flask app on **8081** is internal-only and reached only through the Node proxy.
- Persistent volume `/data` is mounted for SQLite (`chat.db`), schoology session cookies, and AI assistant file uploads. 1 GB volume in `sjc` region.
- 512 MB RAM, shared CPU. Memory is tight: Whisper `tiny` + CLIP + Playwright chromium + a per-user daemon pool all fight for it. Watch RSS.

### gunicorn: single worker, per-user daemon pool
- **Single worker** (`--workers 1`, `--threads 8`) — previously 2 workers, but each gunicorn worker is its own daemon pool, so 2 workers × 4 parallel dashboard sections = up to 8 Chromium instances on 512MB Fly → OOM. One worker is enough for the current user base (~8 people, 2 concurrent typical). The per-user spawn lock inside `_get_daemon()` coalesces concurrent requests for the same user so we never have more than one in-flight Chromium spawn per (worker, user).
- **Long-lived `run_tool.py` per authenticated user**. Each daemon holds a warm Playwright browser for that student. The pool is keyed by username, LRU-evicted at `DAEMON_POOL_MAX=100`. `GUNICORN_WORKER_INDEX` is set in the master env by `schoology/gunicorn.conf.py:pre_fork` (still useful for telemetry/logging).
- **Why per-user daemons:** upstream `schoology-mcp` is single-tenant — it reads `SCHOOLOGY_USERNAME`/`SCHOOLOGY_PASSWORD` from its own process env at spawn and keeps one headless browser per process. The pool is how we serve multiple students from one Flask worker.
- **Why `/data/schoology_storage.json`:** image redeploys lose `/root/.cache/...`, so the storage state env-var points to the persistent volume.

### Schoology daemon pool subtleties (read this before editing `schoology/server.py`)
- **Per-user spawn lock** (`_spawn_locks` + `spawn_lock` in `_get_daemon`): without it, 4 parallel dashboard sections for the same user would each spawn their own daemon → 4 Chromium instances during the spawn window → OOM. The first caller holds the lock, the rest wait, then find the daemon in the pool.
- **TOCTOU race** in `_kill_daemon(username)`: the pool is keyed by username, not by `DaemonClient` object. If caller A spawns a fresh daemon and caller B's pre-flight fails on the *old* daemon, B's `_kill_daemon(username)` would pop A's brand-new daemon from the pool. Always prefer `_kill_daemon_object(target)` which only kills a specific instance and verifies it's still in the pool before popping.
- **Daemon stdin "closed file" check** in `DaemonClient.call()`: when Chromium dies, Python's `BufferedWriter` flags its `stdin` closed and subsequent writes raise `ValueError` (not `BrokenPipeError`). The pre-flight checks `proc.poll() is None` AND `stdin.closed` AND catches `ValueError` on write — without all three, dead-daemon cycles surface as 500s.
- **Drain-on-timeout** in `DaemonClient.call()`: when the per-call timeout (200s) fires on a slow cold-start, the daemon is NOT killed. Instead the orphan response line is drained inside the lock so the next caller can use the warm daemon. Killing on timeout was the cause of cascading 500s across the 4 dashboard sections.
- **Tombstoned daemons**: `close()` sets `proc = None`. The next caller holding a tombstoned `DaemonClient` would crash on `proc.poll()`. `_get_daemon` re-spawns if it finds `proc is None`; `call()` raises EOFError as a safety net.

### Node → Flask proxy (`server/index.js`)
Non-obvious bugs already fixed and worth not re-introducing:
- Don't re-serialize `req.body={}` for GET/HEAD and send it as a JSON body — gunicorn keep-alive reads `{}` as the next request line and returns 400.
- Don't try to JSON-stringify a multipart body and forward it — you have to `req.pipe(proxyReq)` raw, and `return` before `proxyReq.end()`.
The `proxyRequest` helper handles both. New `/schoology/api/*` endpoints are safer to add; the proxy just forwards.

### Game Multiplayer — Zone No Light (`server/index.js` `/game` namespace)
A real-time multiplayer FPS built on Socket.IO's `/game` namespace, unrelated to schoology. Lives entirely in `server/index.js` (~line 1749+).

- **Room registry**: `globalRoomRegistry` (a `Map<roomKey, {mode, code, hostId, map, playerCount, createdAt, updatedAt}>`) plus the per-socket `gameRooms` Map. The registry expires rooms after 5 min of inactivity (`ROOM_EXPIRY_MS`).
- **Room key format** encodes the room origin and mode:
  - `qp:<mode>:<CODE>` — quickplay room
  - `cr:<mode>:<CODE>` — user-created (private) room
  - The mode prefix matters for matching: `quickplay(mode)` matches any `qp:<mode>:` room with the same mode, regardless of code.
- **Per-mode player caps** (`ROOM_MAX_PLAYERS`): `crossfire: 2`, `arena-coop: 6`, `boss-coop: 4`, `training-coop: 4`. Rooms at cap are skipped by quickplay and rejected with `{error: 'Room is full'}` by `joinByCode`.
- **Map field**: rooms carry an optional `map` string (capped at 64 chars by `normalizeCreateArgs`). Map is **not** used for matching (a quickplay player joins whatever map the host chose); the host's `map` is returned in the callback so the client loads the right map.
- **`normalizeCreateArgs(arg)`** accepts both old (bare string mode) and new (`{mode, map}`) client shapes — preserves backward compat for older Zone No Light clients.
- **Socket handlers** (`socket.on(...)` in the `/game` namespace):
  - `quickplay(arg, cb)` → tries to join an open room in the mode; if none, creates one. Returns `{room, roomCode, roomKey, count, map}`.
  - `createRoom(arg, cb)` → always creates a new `cr:<mode>:<CODE>` room. Returns `{code, roomCode, roomKey, map}`.
  - `joinByCode({code, mode}, cb)` → mode-agnostic lookup by code across all rooms. Returns `{ok, code, roomCode, roomKey, map}`.
  - `getRooms(cb)` → lists open rooms (for the lobby browser).
  - `move(data)`, `chat(...)`, `shoot(...)`, etc. — gameplay events scoped to the current room.
  - Server broadcasts `roomListUpdate` (via `io.emit`) on registry changes.
- **Teleport command** (`/tp`): disabled in quickplay rooms (`!roomKey.startsWith('qp:')`). In private rooms, supports source selectors (`@s`, `@a`, `@e`, `@p`, `@r`, or player name) and destination selectors — see `parseTeleportCommand` and `executeTeleport` in `server/index.js`.

### AI Assistant architecture (`schoology/index.html` + `schoology/ai/`)
- **Tool protocol** is bracket commands emitted by the model: `[CALC:expr]`, `[WIKI:topic]`, `[FILE:id|name|type|size]`, etc. As of 2026-08 the tool DESCRIPTIONS live SERVER-SIDE in `schoology/ai/system_prompt.py::build_tools_prompt()` (injected into Layer 3/4 prompts); the client-side `TOOL_REGISTRY` in `schoology/index.html` keeps only the executors (regex + handler + user-facing blurbs), no prompt text. Adding a new tool = one entry in BOTH the server tool list and the client executor registry, plus the backend route in `schoology/ai/<family>.py`.
- **All AI prompts are server-side only** (2026-08 change). The client no longer builds or sends system prompts: the old `buildContextMessages` / `buildToolsPrompt` / `buildCalendarPromptSection` / `buildContextExtrasSystemMessage` and the legacy worker-proxy streaming path were removed. `sendChatMessage()` posts only `{message, prior_messages, grades, courses, assignments, posts, extras, grade_level}` to `/api/chat/layered`. Chat auto-titling (`POST /api/chats/auto-title`), soft-fail grade re-detection (`POST /api/grade/redetect`), and the agent password check (`POST /api/agent-verify`) all run server-side now.
- **Tool results go into `state.currentMessages`** with `role: 'tool'` so the model sees them on the next turn. Cap each at 2,000 chars in history; the full result stays in the chat UI.
- **File upload** is real: `handleFileUpload` POSTs to `/api/file/ingest`, gets a `file_id`, and on send appends `[FILE:id|name|type|size]` markers. `/api/file/context` expands markers into extracted text (PDF, OCR, Whisper transcription, etc.) before the model sees the message. Files are stored in `/data/ai_uploads/<uuid>` and auto-purged after 1 hour.
- **New AI routes** live in `schoology/ai/*.py` (math, geometry, knowledge, science, files, code, integrations, basics, web) and self-register via `register_routes(app)` from `schoology/ai/__init__.py`. `schoology/server.py` calls `register_ai_routes(app)` once near the bottom of its route block.
- **Auth** for AI routes is the same `decode_auth_header()` Basic-auth pattern as the rest of the API.
- **No rate limiting in v1**; most routes hit free public APIs with their own quotas (Wikipedia, Open-Meteo, MyMemory, arXiv). GitHub is 60/hr unauth.
- **Adding a new tool** = one entry in `build_tools_prompt()` in `schoology/ai/system_prompt.py` (server prompt) + one entry in the client `TOOL_REGISTRY` executor table (regex + executor + userBlurb; NO prompt field -- prompts never ship to the client). Then add the implementation in `schoology/ai/<family>.py` and register it via `register_routes(app)`. Don't sprinkle the tool name across files.
- **AI tone**: the assistant is the student's FRIEND (warm, casual, supportive). Tone rules live in `schoology/ai/system_prompt.py` (SYSTEM_PROMPT + POLICY_BLOCK_FOR_LAYER_5) and in the Layer 3/4/5 templates in `schoology/ai/layers.py`; Layer 5 may EDIT a compliant-but-cold draft to warm it up.
- **Developer/admin key**: proving the developer key sends it as a chat message; `schoology/ai/dev_auth.py` verifies it via Argon2id (hash stored, key never stored). The hash was rotated 2026-08-18.
- **Multi-chat state** is server-persisted per user. See "Multi-chat AI assistant" below for storage layout, endpoints, and the heuristic remember/cross-chat context system.
- **Dashboard section cache** (`localStorage`): each section's last successful response is persisted under `schoology_section_cache_<username>_<section>`. `hydrateFromCache()` reads it on dashboard open and renders instantly while `loadSection()` runs in the background — without this, the user stares at skeletons for 60-90s on every cold start. The cache is per-user; don't surface another user's data.

### Multi-chat AI assistant (`schoology/index.html` + `schoology/server.py`)
A user can have many chats; each chat has its own history. A "global memory" of user-asked-to-remember facts is shared across all chats, and a short summary of every other chat is injected into context for cross-chat awareness.

- **Storage layout** (on the `/data` volume, see `AI_CHATS_DIR` in `schoology/server.py`):
  - `<DATA_DIR>/ai_chats/<username>/<chatId>.json` — one file per chat
  - `<DATA_DIR>/ai_chats/<username>/_memory.json` — global memory items
  - `<DATA_DIR>/ai_chats/<username>/_last_chat.json` — last opened chatId (restore-on-load)
  - Writes go through `_atomic_write_json()` (`tmp` file + `os.replace`) so a partial write can't corrupt the persistent volume.

- **Server endpoints** (all in `schoology/server.py`, all use `decode_auth_header()`):
  - `GET /api/chats` — list metadata (id, title, summary, messageCount) sorted by `updatedAt` desc
  - `POST /api/chats` — create new chat (cap 50 per user; oldest dropped)
  - `GET /api/chats/<id>` — full chat or 404
  - `PUT /api/chats/<id>` — update title and/or messages; re-summarizes via heuristic when `len(messages) >= 4`
  - `DELETE /api/chats/<id>` — 204
  - `POST /api/chats/context` body `{chatId}` — returns `{otherSummaries, globalMemory}` for context injection
  - `GET/POST/DELETE /api/memory[/<id>]` — global memory CRUD (cap 50 items; oldest dropped)
  - `GET/POST /api/chats/last` — persist and retrieve last-opened chat for restore-on-load

- **Frontend state** (in `schoology/index.html`):
  - `state.chats: []` — list of chat metadata
  - `state.currentChatId: null` — open chat
  - `state.currentMessages: []` — messages of the open chat (loaded lazily via `loadCurrentChat`)
  - `state.globalMemory: []` — remembered facts
  - `loadChats()` always ensures one default chat exists (creates one if list is empty) so the sidebar is never blank.
  - `sendChatMessage()` POSTs `/api/chats` on first send to mint an id, then PUTs the updated messages on every reply. After the first assistant reply, `aiNameChat()` auto-titles the chat if the user hasn't renamed it -- via `POST /api/chats/auto-title` (DeepSeek call + title prompt are SERVER-SIDE).
  - Saves are debounced 500ms via `scheduleSaveCurrentChat()` so rapid sends don't hammer the server.
  - **Demo mode** (`state.demoMode === true`) bypasses all `/api/chats` and `/api/memory` calls and uses one localStorage chat under `schoology_chat_history_<username>`. The sidebar shows a "(demo mode)" notice in that case.

- **Heuristic remember detection** (`detectRemember()` in `schoology/index.html`):
  - Trigger keywords (case-insensitive, matched as substrings): `remember`, `don't forget`, `do not forget`, `note that`, `keep in mind`, `from now on`, `always remember`.
  - If any keyword matches, the full user message is POSTed to `/api/memory` with `sourceChatId`, and the assistant reply gets a subtle "📌 Noted." inline.
  - This is local, no LLM call — keeps latency/cost low for what runs on every send.

- **Cross-chat context injection** (`buildContextMessages()` + `fetchChatContextExtras()`):
  - On every send, the frontend fetches `POST /api/chats/context {chatId}` and prepends a second system message after the main prompt, capped at 20 memory items and 8 other-chat summaries (most recent first by `updatedAt`).
  - The wording tells the model these summaries are "for awareness only — do NOT proactively reference unless the user asks", so the AI doesn't accidentally mention "yesterday's homework help" unprompted.

- **Summarization** is intentionally a simple non-LLM heuristic (`_summarize_chat` in `server.py`): join user messages, truncate to ~400 chars. The same shape as the previous client-side `generateSummary()`. If the user later wants LLM-generated summaries, this is the place to add it.

### Schoology basic-info pattern (`/api/basic-info`)
`/api/basic-info` in `schoology/server.py` is the "first-paint identity" call. Upstream `schoology-mcp` removed the `get_profile` tool, so the route returns **HTTP 200 with `{"removed": true, "message": "..."}`** — NOT 410 Gone.
- 410 logs as a "Failed to load resource" browser console error (no functional impact, but noisy and bad UX).
- The frontend (`loadBasicInfo()` in `schoology/index.html`) checks `data.removed` and treats it as a soft skip: dashboard still loads using whatever `get_courses` / `get_grades` return. The identity strip is skipped; student name is unknown on first paint.
- **Student header UI** is intentionally minimal: just "Welcome! {name}" — student ID and grade are NOT shown in the UI even when the data is present, but stay in `state.student` for the AI to use. The header element is `<div class="student-info" id="studentInfo" style="display: none;">` containing only `<span id="studentName">—</span>`; the surrounding `renderStudentHeader()` produces the "Welcome! {name}" line.

### Auth-header gotcha (read this before adding any `/schoology/api/*` fetch)
`getAuthHeader()` in `schoology/index.html` returns the **object** `{Authorization: 'Basic ...'}`, not the string value:
```js
return { 'Authorization': 'Basic ' + base64Encode(...) };
```
The correct call is:
```js
const auth = getAuthHeader();
if (auth && auth.Authorization) headers['Authorization'] = auth.Authorization;
```
The **wrong** pattern (which has shipped before and produced silent 401s across `/api/chats`, `/api/memory`, AND pre-existing `/api/file/ingest` and the tool-executor fetch (aiFetch)):
```js
const auth = getAuthHeader();
headers['Authorization'] = auth;  // coerces object to "[object Object]"
```
Flask's `decode_auth_header()` then sees no `Basic ` prefix and returns 401; the symptom also cascades to 500s on `/api/grades` etc. because the MCP daemon gets `None` credentials. Three call sites in `schoology/index.html` already use the correct pattern: `_apiFetch` (multi-chat), `aiFetch` (tool executors), and the file upload `fetch` — keep new code aligned with these.

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
| `DAEMON_POOL_MAX` | no | default `100`; per-user daemon pool cap (set high; current user base is ~8 people, 2 concurrent is typical) |
| `JUDGE0_KEY` | no | enables `[RUN:lang code]` for C/C++/Rust/Go/Java |
| `JUDGE0_URL` | no | default `https://judge0-ce.rapidapi.com` |

## Translation system (`public/assets/translation/data.json`)
- 39 languages (en, zh, zh-Hans, zh-Hant, ja, ko, es, fr, de, hi, ar, bn, pt, ru, ur, id, sw, tr, vi, it, th, pl, uk, nl, ro, sv, hu, el, he, fa, am, ta, te, mr, pa, gu, kn, ml, jv).
- Source of truth at runtime: `data.json`. The inline `STRINGS` in `main.js` only has `en` + `zh` (and is what `scripts/build-translations.cjs` extracts). `t(key)` falls back to `en`, then the key itself.
- **`build-translations.cjs` overwrites the inline en+zh and the zh-Hant fallback table only** — it does NOT preserve the other 37 languages in data.json. If you re-run it, all non-{en, zh, zh-Hant} translations in data.json get lost. To keep them, either edit data.json directly (don't re-run the build) or modify the build script to merge.
- Translation keys are contextually chosen, not literally translated: e.g. "key" in the security/recovery sense maps to 凭证/証拠/증거/Key, not the literal 键/キー/키.
| `JUDGE0_KEY` | no | enables `[RUN:lang code]` for C/C++/Rust/Go/Java |
| `JUDGE0_URL` | no | default `https://judge0-ce.p.rapidapi.com` |

## Where to find what

- **Chat app entry points**: `server/index.js` + `public/assets/js/main.js` + `server/db.js` (see README.md).
- **Game (Zone No Light) multiplayer**: `server/index.js` `/game` namespace, ~line 1749+ (`globalRoomRegistry`, `quickplay`/`createRoom`/`joinByCode`, teleport, etc.).
- **Schoology dashboard UI**: `schoology/index.html` (single large file; `TOOL_REGISTRY` is at the top; multi-chat sidebar + memory + cross-chat context live here).
- **Schoology Flask**: `schoology/server.py` (daemon pool, all `/api/*` routes, AI registration, multi-chat + memory endpoints).
- **Schoology AI routes**: `schoology/ai/__init__.py` (aggregator) + one file per tool family.
- **gunicorn config**: `schoology/gunicorn.conf.py` (`pre_fork` sets `GUNICORN_WORKER_INDEX`).
- **Project memory** (curated, persists across sessions): `~/.claude/projects/-Users-Benran-Documents-GitHub-chat/memory/` — `schoology-architecture.md` for the per-user daemon pool + upstream tool surface; `server-proxy-pitfalls.md` for the two non-obvious Node proxy bugs; `dm-voice-architecture.md` for the 1:1 WebRTC voice implementation.
- **Seeded accounts** (auto-created on every server boot, idempotent — see `server/db.js` and `schoology/index.html`): the `jimmyqrg` admin (placeholder password, claimed on first signup), the `helper` bot, and the `sezitoushangyibadao` private account (display name `色字头上一把刀`, password `xyz12345`, email `sezitoushangyibadao@chat.local`, `is_private=1`). Private users are hidden from everyone except `jimmyqrg` on profile / DM / mention-search / friend paths; groups still display their messages.
- **Private-user enforcement** (`server/db.js` + `server/index.js`): `is_private=1` rows are filtered from `/api/users` list, `/api/users/mention-search`, and from the DM-open gate (`/api/conversations/with/:userId`). The frontend shows a `private-user-notice` placeholder when the server returns `{ private_user: true, error: 'This user is private' }`. `canSeePrivateUser(viewer, targetId)` is the single helper; add it to any new endpoint that exposes a user.
- **Theme-aware logos** (`schoology/index.html`): two stacked `<img>` tags per logo, dark variant + `logo-light` variant, swapped via CSS `[data-theme="light"] .header-logo-dark { display: none }`. The favicon is intentionally NOT theme-swapped.
- **Working notes** (free-form, session-scratch): `agent.md` at repo root.

## Do not

- Do not edit `schoology-mcp/` for dashboard bugs. Update only when upstream changes.
- Do not add "fallback" error handlers that swallow the real message. Show the actual error and fix the cause.
- Do not add `exec` to the Dockerfile `CMD` — `&` is the right pattern for running gunicorn and node in one container.
- Do not assume the chat app can be suspended — `agent.md` says "this app cannot suspend - it powers other applications".
- Do not use demo/placeholder data in production paths (e.g. schoology grades). The `generateDemoResponse` AI fallback is for the AI tab only, and even there, "DO NOT USE DEMO INFORMATION UNLESS IS IN THE DEMO MODE".
- Do not write `headers['Authorization'] = auth` from `getAuthHeader()` — it returns an **object**, not a string. Use `auth.Authorization`. See "Auth-header gotcha" above; this bug shipped before and produced silent 401s across `/api/chats`, `/api/memory`, `/api/file/ingest`, and the tool-executor fetch (aiFetch).
- Do not return HTTP 410 for removed-upstream endpoints. 410 logs as a browser console error; return 200 with a `{"removed": true}` body and let the frontend soft-skip. See "Schoology basic-info pattern" above.
