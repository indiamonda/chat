# Schoology MCP - Agent Working Notes

## Project Overview
**App URL**: https://jchat.fly.dev/schoology/
**Client Repo**: github.com/indiamonda/schoologyhelp (frontend that sends student credentials)
**Stack**: Express proxy (port 8080) → Flask (port 8081) → MCP/Python/Playwright → Schoology

## Problem Statement
- Students log in with their own PAUSD credentials via the frontend
- Frontend sends credentials as `Authorization: Basic <base64(username:password)>`
- Proxy forwards to Flask on port 8081
- Flask needs to pass per-student credentials to MCP subprocess
- MCP uses Playwright to scrape real Schoology data

## Architecture
```
Frontend → Express Proxy (8080) → Flask (8081) → MCP server.py → Playwright → Schoology
```

## Implementation Status (2026-05-23)

### ✅ Step 1-5 Complete: Per-Student Authentication
- **schoology/server.py**: Decodes Basic Auth, passes credentials via env vars to MCP subprocess
- **schoology-mcp/server.py**: Uses `_get_username_from_config()` to resolve username from env or config
- **schoology-mcp/browser.py**: Per-student `BrowserContext` keyed by username, username-specific storage state files
- **schoology-mcp/config.py**: Runtime credentials via `_runtime_credentials` dict
- **schoology-mcp/auth.py**: `login()` accepts username/password parameters

### ✅ Step 6 Complete: Error Display Fix
- Frontend shows red error box with exact error message instead of "Contact administrator"
- Changed `.error-display` CSS to red background/border

### ✅ Step 7 Complete: Debug Logging
- Added extensive debug prints in `call_mcp_tool_async()` and `get_data_from_mcp_or_mock()`
- Logs show MCP command path, initialization, and return values

## Current Issues

### Issue: Flask/Gunicorn Not Starting (FIXED)
**Symptom**: `ECONNREFUSED 127.0.0.1:8081` - Flask not listening
**Root Cause**: IndentationError in server.py line 200 (duplicate code block)
**Fix**: Removed duplicate `if isinstance(data, dict)` block that caused syntax error

### Issue: MCP Subprocess Hangs/Timeouts
**Symptom**: 502 errors, MCP calls never return
**Likely Causes**:
1. Python venv path wrong: `/app/schoology-mcp/.venv/bin/python`
2. First MCP call initializes browser (slow, ~30s)
3. Single gunicorn worker blocking

**Current Fixes**:
- Gunicorn with 2 workers, 8 threads
- 120s timeout on proxy requests
- `SCHOOLOGY_HEADLESS=true` and `SCHOOLOGY_KEEPALIVE=false` env vars set

## File Locations
- **Flask server**: `/app/schoology/server.py`
- **MCP server**: `/app/schoology-mcp/server.py`
- **MCP config**: `/app/schoology-mcp/schoology_mcp/config.py`
- **MCP browser**: `/app/schoology-mcp/schoology_mcp/browser.py`
- **Express proxy**: `/app/server/index.js`
- **Venv Python**: `/app/schoology-mcp/.venv/bin/python`

## Dockerfile CMD (current)
```dockerfile
CMD ["sh", "-c", "cd /app/schoology; /app/.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 --workers 2 --threads 8 server:app & node /app/server/index.js"]
```

## Deploy Command
```bash
flyctl deploy --build-only --push -a jchat --image-label deployment-7a1f3fc639a82ccc25928f1803028654 --config fly.toml
```

## Debug Commands
- Check logs: `flyctl logs -a jchat --tail 100`
- SSH to machine: `flyctl ssh console -a jchat`

## MCP Debug Log Prefixes
- `[MCP DEBUG] VENV_PYTHON=` - shows Python path
- `[MCP DEBUG] Starting MCP with cmd:` - shows command
- `[MCP DEBUG] MCP session initialized` - session ready
- `[MCP DEBUG] MCP tool X returned: Y` - tool result

## Known Gotchas
1. **No `exec`** in CMD - use `&` to run both gunicorn and node in foreground
2. **Use `cd /app/schoology`** before gunicorn because gunicorn needs to find the module
3. **MCP first call is slow** - Playwright browser launches on first use (~30s)
4. **Credentials in env vars** - SCHOOLOGY_USERNAME and SCHOOLOGY_PASSWORD passed to subprocess
5. **localStorage stores credentials** - frontend restores them on session restore

## User Preferences
- "Don't write fallbacks, fix the thing properly"
- "Use agent.md to store memory so nothing is lost"
- "This app cannot suspend - it powers other applications"
- Error messages should NOT say "contact administrator" - personal project
- Error display: red box with exact error message