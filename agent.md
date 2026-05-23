# Schoology MCP Per-Student Authentication Plan

## Problem
- Students log in with their own PAUSD credentials via the frontend (github.com/indiamonda/schoologyhelp/)
- Frontend sends credentials as `Authorization: Basic <base64(username:password)>`
- Proxy forwards these headers to Flask on port 8081
- Flask ignores the credentials and calls MCP with global config credentials
- MCP uses `config.USERNAME` and `config.get_password()` which are set globally at server start
- Result: mock data always returned because MCP can't use per-student credentials

## Architecture
```
Frontend → Express Proxy → Flask (schoology/server.py) → MCP (schoology-mcp/server.py) → Playwright → Schoology
```

## Solution
Modify the architecture to support per-student credentials:

### 1. Flask server.py changes
- Decode Basic Auth header from incoming requests
- Pass credentials to MCP via a temp .env file or environment variable injection
- MCP needs to be called per-student with their credentials
- Cache key should include student username (not just tool name)

### 2. schoology-mcp/server.py changes
- Accept `username` and `password` arguments in each tool call
- Create per-student browser contexts (not shared global client)
- Store sessions per-student (storage_state_{username}.json)

### 3. schoology-mcp/browser.py changes
- Accept credentials in constructor or login method
- Support multiple concurrent student sessions
- Use username-specific storage state files

### 4. schoology-mcp/config.py changes
- Allow overriding USERNAME/password at runtime per-request

## Files to Modify
1. `/workspaces/chat/schoology/server.py` - Decode Basic Auth, pass to MCP
2. `/workspaces/chat/schoology-mcp/server.py` - Accept credentials in tool calls
3. `/workspaces/chat/schoology-mcp/browser.py` - Per-student sessions
4. `/workspaces/chat/schoology-mcp/config.py` - Runtime credential override

## Implementation Steps

### Step 1: ✅ Modify schoology-mcp/config.py to support runtime credential override
Added `_runtime_credentials` dict and `set_runtime_credentials()`, `get_runtime_credentials()`, `clear_runtime_credentials()` functions.

### Step 2: ✅ Modify schoology-mcp/auth.py to accept runtime credentials
- `login()` now accepts `username` and `password` parameters
- `_submit_credentials()` accepts username/password as arguments instead of using config directly
- Uses runtime credentials if available, falls back to config

### Step 3: ✅ Modify schoology-mcp/browser.py for per-student sessions
- `SchoologyClient` now manages per-student `BrowserContext`s keyed by username
- `_storage_path()` returns username-specific storage state file path
- `fetch()` now requires `username` parameter
- Removed global keepalive loop (each student context is independent)

### Step 4: ✅ Modify schoology-mcp/server.py to use runtime credentials
- Added `_get_username_from_config()` to resolve username from runtime or config
- All tool calls now pass username to `client.fetch()`
- MCP tools read credentials from runtime via `config.get_runtime_credentials()`

### Step 5: ✅ Modify schoology/server.py (Flask) to decode Basic Auth and pass credentials
- Added `decode_auth_header()` to parse `Authorization: Basic <base64>` header
- `call_mcp_tool_async()` now accepts username/password and sets runtime credentials
- All API endpoints decode auth header and pass credentials to MCP
- Cache is per-student (keyed by username in storage_state filename)
- `/api/clear-session` and `/api/status` use per-student session files