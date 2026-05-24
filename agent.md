# Schoology MCP - Agent Working Notes
**Last Updated**: 2026-05-24
**App Version**: 2026-05-24.1

## Project Overview
**App URL**: https://jchat.fly.dev/schoology/
**Client Repo**: github.com/indiamonda/schoologyhelp (frontend that sends student credentials)
**Stack**: Express proxy (port 8080) → Flask (port 8081) → MCP/Python/Playwright → Schoology

## Architecture
```
Frontend → Express Proxy (8080) → Flask (8081) → MCP server.py → Playwright → Schoology
```

## Implementation Status

### ✅ Per-Student Authentication
- **schoology/server.py**: Decodes Basic Auth, passes credentials via env vars to MCP subprocess
- **schoology-mcp/server.py**: Uses `_get_username_from_config()` to resolve username from env or config
- **schoology-mcp/browser.py**: Per-student `BrowserContext` keyed by username, username-specific storage state files
- **schoology-mcp/config.py**: Runtime credentials via `_runtime_credentials` dict
- **schoology-mcp/auth.py**: `login()` accepts username/password parameters

### ✅ Error Display Fix
- Frontend shows red error box with exact error message instead of "Contact administrator"

### ✅ Debug Logging
- Added extensive debug prints in `call_mcp_tool_async()` and `get_data_from_mcp_or_mock()`

### ✅ AI Chat Theme Colors (2026-05-24)
- Added `--surface` CSS variable for chat message backgrounds
- `.chat-message.assistant` now uses `var(--surface)` instead of hardcoded `#e5e5ea`
- Light and dark themes both define `--surface` appropriately

### ✅ Playwright Browser Launch Fix (2026-05-24)
- **Root Cause**: Missing `--no-sandbox` flag when running as non-root user (USER nodejs in Dockerfile)
- **Fix**: Added `args=["--no-sandbox", "--disable-setuid-sandbox"]` to `browser.py` chromium.launch()
- **File**: `/workspaces/chat/schoology-mcp/schoology_mcp/browser.py` line 64

## File Locations
- **Flask server**: `/app/schoology/server.py`
- **MCP server**: `/app/schoology-mcp/server.py`
- **MCP config**: `/app/schoology-mcp/schoology_mcp/config.py`
- **MCP browser**: `/app/schoology-mcp/schoology_mcp/browser.py`
- **Express proxy**: `/app/server/index.js`
- **Venv Python**: `/app/schoology-mcp/.venv/bin/python`

## Dockerfile CMD
```dockerfile
CMD ["sh", "-c", "cd /app/schoology; /app/.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 --workers 2 --threads 8 server:app & node /app/server/index.js"]
```

## Deploy Commands (MUST do both steps)
```bash
# Step 1: Build and push image
export FLYCTL_INSTALL="$HOME/.fly" && export PATH="$FLYCTL_INSTALL/bin:$PATH"
flyctl deploy --build-only --push -a jchat --config fly.toml

# Step 2: Deploy the pushed image (image tag from step 1 output, format: registry.fly.io/jchat:deployment-XXXXXXXXXXXXX)
flyctl deploy -a jchat --image registry.fly.io/jchat:deployment-<TAG>
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
- "Don't write fallbacks, write show error messages and fix the thing properly"
- "Use agent.md to store memory so nothing is lost"
- "This app cannot suspend - it powers other applications"
- Error messages should NOT say "contact administrator" - personal project
- Error display: red box with exact error message

## Schoology App (schoology/index.html) Theme System

### CSS Variable Defaults (`:root`)
```css
--bg: #f5f5f7;
--surface: #e5e5ea;        /* Chat message backgrounds */
--text: #1d1d1f;
--text-secondary: #86868b;
--primary: #0070f0;
--success: #34c759;
--warning: #ff9500;
--error: #ff3b30;
```

### Light Theme `[data-theme="light"]`
```css
--bg: #f5f5f7;
--surface: #e5e5ea;
--border: #d1d1d6;
--text: #1d1d1f;
--text-secondary: #86868b;
```

### Dark Theme `[data-theme="dark"]`
```css
--bg: #000000;
--surface: #2c2c2e;
--border: #38383a;
--text: #f5f5f7;
--text-secondary: #98989d;
```

### Theme Toggle
- Toggle element: `#darkModeToggle` checkbox
- Applied via: `document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')`
- Init: `initDarkMode()` reads localStorage or `prefers-color-scheme`

### Chat Message Colors
- `.chat-message.user`: uses `var(--primary)` with white text
- `.chat-message.assistant`: uses `var(--surface)` for background, `var(--text)` for text
- `.chat-message.error`: uses `rgba(255,59,48,0.1)` background with `var(--error)` text

## Known Issues

### MCP Browser Launch (FIXED)
**Symptom**: `BrowserType.launch: Target page, context or browser has been closed`
**Root Cause**: Missing `--no-sandbox` flag when running as non-root user (uid 1001)
**Fix**: Added `args=["--no-sandbox", "--disable-setuid-sandbox"]` to browser launch in `browser.py`

### AI Demo Mode
- Location: `generateDemoResponse()` function, line ~1321
- When no AI worker URL is configured (localStorage `schoology-ai-worker-url`), demo mode is used
- Demo greeting is hardcoded and always the same
- To enable real AI: Set a Cloudflare Worker URL with DeepSeek API in the settings