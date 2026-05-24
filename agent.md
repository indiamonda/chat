# Schoology MCP - Agent Working Notes
**Last Updated**: 2026-05-24
**App Version**: 2026-05-24.6

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
- **Fixed**: `.chat-input-row input` now has `color: var(--text)` for visibility in both themes

### ✅ AI Chat Improvements (2026-05-24)
- Welcome message no longer shows LaTeX/markdown help line
- Replaced typewriter animation with smooth fade-in effect
- `typewriterEffect()` now renders markdown immediately then fades in

### ✅ Emoji Picker (2026-05-24)
- Emoji picker positioned above input button with viewport boundary detection
- Flips right if would go off left edge, flips up if would go off bottom
- `max-height: 300px` with scroll for small screens

### ✅ Playwright Browser Launch Fix (2026-05-24)
- **Root Cause**: Missing `--no-sandbox` flag when running as non-root user (USER nodejs in Dockerfile). Also `--single-process` flag caused crashes in certain containerized environments.
- **Fix**: Replaced `--single-process` with a set of Chromium stability flags in `browser.py` launch args.
- **File**: `/workspaces/chat/schoology-mcp/schoology_mcp/browser.py` lines 64-85

### ✅ AI Chat Fix (2026-05-24)
- **Problem**: AI chat always returned same greeting regardless of user input
- **Root Cause**: DeepSeek proxy worker returns SSE by default; code expected JSON
- **Fix**: Added `stream: false` to API request body in `schoology/index.html`
- **Also**: Added proper error message when AI Worker URL not configured instead of silently falling into demo mode

### ✅ Pre-configured DeepSeek Proxy URL (2026-05-24)
- `loadSettings()` now pre-configures `https://deepseek-proxy.ikunbeautiful.workers.dev` if no custom URL is stored
- No longer requires manual configuration in settings tab

### ✅ Remove DeepSeek URL from Settings Tab (2026-05-24)
- Removed the DeepSeek AI Proxy Worker URL input field from the Settings UI
- URL is now hardcoded/pre-configured in `loadSettings()` - no user-facing configuration needed

### ✅ Fix marked.js "str.replace is not a function" Error (2026-05-24)
- Added `if (typeof text !== 'string') text = String(text || '')` guard in `renderMarkdown()` to ensure text is always a string before calling `.replace()`

### ✅ Playwright Browser Launch Fix (2026-05-24)
- **Root Cause**: `--single-process` flag caused crashes in containerized environments; browser context was being closed unexpectedly
- **Fix**: Replaced `--single-process` with stability flags (`--disable-extensions`, `--disable-background-networking`, etc.) in `browser.py` chromium.launch()
- **File**: `/workspaces/chat/schoology-mcp/schoology_mcp/browser.py` lines 64-85

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

## Chat App (/public/) Features

### ✅ Emoji Picker in Chat Input (2026-05-24)
- Added emoji button (😊) next to chat input in `game.html` and `game-self-hosted.html`
- Emoji picker appears above input, showing 30 common emojis
- Click emoji to insert at cursor position in input field
- Viewport boundary detection: flips position if picker would go off screen
- Closes when clicking outside
- Input width reduced from 280px to 240px to accommodate emoji button

## DeepSeek Proxy Worker (deepseek-proxy.ikunbeautiful.workers.dev/) Source Code

```js

const ALLOWED_ORIGINS = [
  'https://tintly555.github.io',
  'https://indiamonda.github.io',
  'https://chat.jimmyqrg.com',
  'https://lausd.schoology.com',
  'https://unlinewize.jimmyqrg.com',
  'https://abs-unlinewize.jimmyqrg.com',
  'https://mcraft.fly.dev',
  'https://rammerhead.fly.dev',
  'https://ulw-app.fly.dev',
  'https://jchat.fly.dev',
];

/* Local dev origins — anything on localhost / 127.0.0.1 (any port). */
const LOCALHOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return LOCALHOST_RE.test(origin);
}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const AUTH_SERVER = 'https://chat.jimmyqrg.com';
const ALLOWED_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
const MAX_INPUT_MESSAGES = 64;
const MAX_INPUT_CHARS = 60_000;
const MAX_MAX_TOKENS = 4_096;
const RATE_WINDOW_SEC = 60;
const RATE_MAX = 30;

const ATTACHMENT_MARKERS = [
  '\n\n--- ',
  '\n\n[Image attached:',
];

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Turnstile-Token, X-Recaptcha-Token, X-Sync-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_KV) return { ok: true };
  const key = 'rl:' + ip;
  const now = Math.floor(Date.now() / 1000);
  const raw = await env.RATE_KV.get(key);
  let bucket = raw ? JSON.parse(raw) : { ts: now, n: 0 };
  if (now - bucket.ts >= RATE_WINDOW_SEC) bucket = { ts: now, n: 0 };
  bucket.n += 1;
  await env.RATE_KV.put(key, JSON.stringify(bucket), { expirationTtl: RATE_WINDOW_SEC * 2 });
  if (bucket.n > RATE_MAX) return { ok: false, retryAfter: RATE_WINDOW_SEC - (now - bucket.ts) };
  return { ok: true };
}

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Body must be JSON object';
  if (!Array.isArray(body.messages)) return 'messages must be array';
  if (body.messages.length === 0) return 'messages cannot be empty';
  if (body.messages.length > MAX_INPUT_MESSAGES) return 'Too many messages';
  let totalChars = 0;
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return 'Each message must be object';
    if (!['system','user','assistant'].includes(m.role)) return 'Bad role';
    if (typeof m.content !== 'string') return 'content must be string';
    totalChars += m.content.length;
    if (totalChars > MAX_INPUT_CHARS) return 'Input too large';
  }
  if (body.model && !ALLOWED_MODELS.has(body.model)) return 'Unsupported model';
  if (body.max_tokens && (typeof body.max_tokens !== 'number' || body.max_tokens < 1 || body.max_tokens > MAX_MAX_TOKENS)) return 'Invalid max_tokens';
  return null;
}

function getBearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function resolveUser(token) {
  if (!token) return null;
  let res;
  try {
    res = await fetch(AUTH_SERVER + '/api/auth/me', { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } });
  } catch (_) { return null; }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch (_) { return null; }
  const u = data && data.user;
  if (!u || !u.id) return null;
  return { id: String(u.id), username: u.username || '', email: u.email || '' };
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: true, skipped: true, reason: 'missing_token' };
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  let res;
  try { res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }); }
  catch (_) { return { ok: true, skipped: true, reason: 'siteverify_unreachable' }; }
  let data;
  try { data = await res.json(); } catch (_) { return { ok: false, reason: 'bad_json' }; }
  if (data && data.success === true) return { ok: true };
  return { ok: false, reason: (data && data['error-codes']) || 'verify_failed' };
}

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

async function verifyRecaptcha(token, ip, env) {
  if (!env.RECAPTCHA_SECRET_KEY) return { ok: true, skipped: true };
  if (!token) return { ok: true, skipped: true };
  const form = new URLSearchParams();
  form.set('secret', env.RECAPTCHA_SECRET_KEY);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  let res;
  try { res = await fetch(RECAPTCHA_VERIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }); }
  catch (_) { return { ok: true, skipped: true }; }
  let data;
  try { data = await res.json(); } catch (_) { return { ok: true, skipped: true }; }
  if (data && data.success === true && (data.score === undefined || data.score >= 0.3)) return { ok: true, score: data.score };
  return { ok: false, reason: 'low_score', score: data && data.score };
}

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const ADMIN_USERNAMES = new Set(['jimmyqrg', 'jeko1107', 'glaeesas']);
const COMPLIMENTARY_PREMIUM_USERNAMES = new Set(['tianqiansheng9']);
const COMPLIMENTARY_PLUS_USERNAMES = new Set(['kyle', 'glaeesas', 'glaxyias']);
const BANNED_EMAILS = new Set(['weeee@outlook.com']);

function complimentaryTier(user) {
  if (!user) return null;
  const u = (user.username || '').toLowerCase();
  if (COMPLIMENTARY_PLUS_USERNAMES.has(u)) return 'plus';
  if (COMPLIMENTARY_PREMIUM_USERNAMES.has(u)) return 'premium';
  return null;
}

async function hasPremiumAccess(env, user) {
  if (!user) return false;
  if (ADMIN_USERNAMES.has((user.username || '').toLowerCase())) return true;
  if (complimentaryTier(user)) return true;
  const sub = await readSubscription(env, user.id);
  return isSubscriptionActive(sub);
}

function isUserBanned(user) {
  if (!user) return false;
  if (user.email && BANNED_EMAILS.has(user.email.toLowerCase())) return true;
  return false;
}

function bannedResponse(origin) {
  return jsonResponse({ error: 'banned', message: 'YOU ARE BANNED FROM JIMMYQRG.' }, 403, origin);
}

async function readSubscription(env, userId) {
  if (!env.SUB_KV || !userId) return null;
  const raw = await env.SUB_KV.get('sub:' + userId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function writeSubscription(env, userId, record) {
  if (!env.SUB_KV || !userId) return;
  const merged = { ...record, updated_at: Math.floor(Date.now() / 1000) };
  await env.SUB_KV.put('sub:' + userId, JSON.stringify(merged));
  if (merged.stripe_customer_id) await env.SUB_KV.put('cust:' + merged.stripe_customer_id, userId);
}

function generateRecoveryKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(40);
  crypto.getRandomValues(arr);
  let key = '';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && i % 8 === 0) key += '-';
    key += chars[arr[i] % chars.length];
  }
  return key;
}

async function storeReceiptKey(env, userId, key, tier, sessionId) {
  if (!env.SUB_KV || !userId) return;
  const record = { key, tier, session_id: sessionId, created_at: Math.floor(Date.now() / 1000), revealed: false };
  await env.SUB_KV.put('receipt:' + userId + ':latest', JSON.stringify(record));
  await env.SUB_KV.put('paykey:' + key, userId);
  const historyKey = 'receipts:' + userId;
  let history = [];
  try { const raw = await env.SUB_KV.get(historyKey); if (raw) history = JSON.parse(raw); } catch (_) {}
  history.push({ key, tier, session_id: sessionId, created_at: record.created_at });
  await env.SUB_KV.put(historyKey, JSON.stringify(history));
}

async function lookupPaymentKey(env, key) {
  if (!env.SUB_KV || !key) return null;
  const userId = await env.SUB_KV.get('paykey:' + key);
  return userId || null;
}

function isSubscriptionActive(rec) {
  if (!rec) return false;
  if (!ACTIVE_STATUSES.has(rec.status)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (rec.current_period_end && rec.current_period_end + 86400 < now) return false;
  return true;
}

function stripeForm(obj, prefix) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') parts.push(stripeForm(item, `${key}[${i}]`));
        else parts.push(encodeURIComponent(`${key}[${i}]`) + '=' + encodeURIComponent(String(item)));
      });
    } else if (typeof v === 'object') {
      parts.push(stripeForm(v, key));
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.join('&');
}

async function stripeRequest(env, path, body, method = 'POST') {
  const res = await fetch('https://api.stripe.com/v1' + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: body ? stripeForm(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => { const i = p.indexOf('='); return i === -1 ? [p, ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${rawBody}`));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== sig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < hex.length; i++) mismatch |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return mismatch === 0;
}

function messageHasAttachments(msg) {
  if (!msg || msg.role !== 'user') return false;
  const c = String(msg.content || '');
  return ATTACHMENT_MARKERS.some(marker => c.includes(marker));
}

async function handleChat(request, env, origin) {
  if (!env.DEEPSEEK_KEY) return jsonResponse({ error: 'Server not configured: DEEPSEEK_KEY missing' }, 500, origin);
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);

  const syncKey = request.headers.get('X-Sync-Key');
  const isServerCall = env.SYNC_KEY && syncKey === env.SYNC_KEY;

  if (!isServerCall) {
    const tsToken = request.headers.get('X-Turnstile-Token');
    const rcToken = request.headers.get('X-Recaptcha-Token');
    const tsIp = request.headers.get('CF-Connecting-IP') || '';
    const tsResult = await verifyTurnstile(tsToken, tsIp, env);
    if (!tsResult.ok) return jsonResponse({ error: 'captcha_failed', message: 'Bot check failed — please refresh the page.' }, 403, origin);
    const rcResult = await verifyRecaptcha(rcToken, tsIp, env);
    if (!rcResult.ok) return jsonResponse({ error: 'captcha_failed', message: 'Bot check failed — please refresh the page.' }, 403, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await checkRateLimit(env, ip);
  if (!rl.ok) return new Response(JSON.stringify({ error: 'rate_limited', retry_after: rl.retryAfter }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter), ...corsHeaders(origin) } });

  const banToken = getBearer(request);
  if (banToken) {
    const banUser = await resolveUser(banToken);
    if (isUserBanned(banUser)) return bannedResponse(origin);
  }

  let body;
  try { body = await request.json(); } catch (_) { return jsonResponse({ error: 'Invalid JSON' }, 400, origin); }
  const err = validateBody(body);
  if (err) return jsonResponse({ error: err }, 400, origin);

  const latestUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
  if (latestUserMsg && messageHasAttachments(latestUserMsg)) {
    const token = getBearer(request);
    const user = await resolveUser(token);
    if (!user) return jsonResponse({ error: 'auth_required', message: 'Please sign in to upload files.' }, 401, origin);
    if (isUserBanned(user)) return bannedResponse(origin);
    if (!ADMIN_USERNAMES.has((user.username || '').toLowerCase())) {
      const ok = await hasPremiumAccess(env, user);
      if (!ok) return jsonResponse({ error: 'subscription_required', message: 'File uploads require an active subscription.', feature: 'file_uploads' }, 402, origin);
    }
  }

  const payload = {
    model: body.model || 'deepseek-chat',
    messages: body.messages,
    stream: body.stream !== false,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 2048,
  };

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.DEEPSEEK_KEY}`, 'Content-Type': 'application/json', 'Accept': payload.stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { return jsonResponse({ error: 'Upstream fetch failed', detail: String(e) }, 502, origin); }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...corsHeaders(origin) } });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': payload.stream ? 'text/event-stream; charset=utf-8' : (upstream.headers.get('Content-Type') || 'application/json'), 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', ...corsHeaders(origin) },
  });
}

async function handleSubStatus(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  const token = getBearer(request);
  const user = await resolveUser(token);
  if (!user) return jsonResponse({ active: false, anonymous: true }, 200, origin);
  if (isUserBanned(user)) return bannedResponse(origin);
  if (ADMIN_USERNAMES.has((user.username || '').toLowerCase())) return jsonResponse({ active: true, status: 'admin', current_period_end: null, cancel_at_period_end: false, user: { id: user.id, username: user.username } }, 200, origin);
  const comp = complimentaryTier(user);
  if (comp) return jsonResponse({ active: true, status: 'complimentary', tier: comp, current_period_end: null, cancel_at_period_end: false, user: { id: user.id, username: user.username } }, 200, origin);
  const sub = await readSubscription(env, user.id);
  return jsonResponse({ active: isSubscriptionActive(sub), status: sub ? sub.status : 'none', tier: sub ? (sub.tier || 'premium') : null, current_period_end: sub ? sub.current_period_end : null, cancel_at_period_end: sub ? !!sub.cancel_at_period_end : false, user: { id: user.id, username: user.username } }, 200, origin);
}

async function handleCheckout(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  const tsToken = request.headers.get('X-Turnstile-Token');
  const rcToken = request.headers.get('X-Recaptcha-Token');
  const tsIp = request.headers.get('CF-Connecting-IP') || '';
  const tsResult = await verifyTurnstile(tsToken, tsIp, env);
  if (!tsResult.ok) return jsonResponse({ error: 'captcha_failed', message: 'Bot check failed — please refresh the page.' }, 403, origin);
  const rcResult = await verifyRecaptcha(rcToken, tsIp, env);
  if (!rcResult.ok) return jsonResponse({ error: 'captcha_failed', message: 'Bot check failed — please refresh the page.' }, 403, origin);
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Stripe not configured on server' }, 500, origin);
  const token = getBearer(request);
  const user = await resolveUser(token);
  if (!user) return jsonResponse({ error: 'auth_required', message: 'Sign in first.' }, 401, origin);
  if (isUserBanned(user)) return bannedResponse(origin);
  let body;
  try { body = await request.json().catch(() => ({})); } catch (_) { body = {}; }
  const returnUrl = (body && body.return_url) || env.SUB_RETURN_URL || (origin ? origin + '/?upgraded=1' : 'https://jimmyqrg.com/?upgraded=1');
  const plan = (body && body.plan === 'yearly') ? 'yearly' : 'monthly';
  const tier = (body && body.tier === 'plus') ? 'plus' : 'premium';
  const PRICE_MAP = { 'premium-monthly': env.STRIPE_PRICE_ID_MONTHLY, 'premium-yearly': env.STRIPE_PRICE_ID_YEARLY, 'plus-monthly': env.STRIPE_PRICE_ID_PLUS_MONTHLY, 'plus-yearly': env.STRIPE_PRICE_ID_PLUS_YEARLY };
  const priceId = PRICE_MAP[tier + '-' + plan];
  if (!priceId) return jsonResponse({ error: 'Price not configured for ' + tier + ' ' + plan }, 500, origin);
  const existing = await readSubscription(env, user.id);
  const params = { mode: 'subscription', ui_mode: 'embedded', 'line_items[0][price]': priceId, 'line_items[0][quantity]': 1, return_url: returnUrl + (returnUrl.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}', 'metadata[jqrg_user_id]': user.id, 'metadata[jqrg_tier]': tier, 'subscription_data[metadata][jqrg_user_id]': user.id, 'subscription_data[metadata][jqrg_tier]': tier, 'client_reference_id': user.id };
  if (existing && existing.stripe_customer_id) params.customer = existing.stripe_customer_id;
  else if (user.email) params.customer_email = user.email;
  let session;
  try { session = await stripeRequest(env, '/checkout/sessions', params); } catch (e) { return jsonResponse({ error: 'stripe_error', message: e.message }, 502, origin); }
  return jsonResponse({ clientSecret: session.client_secret, id: session.id }, 200, origin);
}

async function handleConfig(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  return jsonResponse({ stripe_publishable_key: env.STRIPE_PUBLISHABLE_KEY || null, tiers: { premium: { name: 'Premium', monthly: { price: '$5.99/mo', available: !!env.STRIPE_PRICE_ID_MONTHLY }, yearly: { price: '$59.99/yr', available: !!env.STRIPE_PRICE_ID_YEARLY } }, plus: { name: 'Premium Plus', monthly: { price: '$10.99/mo', available: !!env.STRIPE_PRICE_ID_PLUS_MONTHLY }, yearly: { price: '$80.99/yr', available: !!env.STRIPE_PRICE_ID_PLUS_YEARLY } } } }, 200, origin);
}

async function handleBillingPortal(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  const token = getBearer(request);
  const user = await resolveUser(token);
  if (!user) return jsonResponse({ error: 'auth_required' }, 401, origin);
  if (isUserBanned(user)) return bannedResponse(origin);
  const sub = await readSubscription(env, user.id);
  if (!sub || !sub.stripe_customer_id) return jsonResponse({ error: 'no_subscription' }, 404, origin);
  let returnUrl;
  try { const body = await request.json().catch(() => ({})); returnUrl = (body && body.return_url) || env.SUB_RETURN_URL || (origin ? origin + '/' : 'https://jimmyqrg.com/'); } catch (_) { returnUrl = env.SUB_RETURN_URL || (origin ? origin + '/' : 'https://jimmyqrg.com/'); }
  let session;
  try { session = await stripeRequest(env, '/billing_portal/sessions', { customer: sub.stripe_customer_id, return_url: returnUrl }); } catch (e) { return jsonResponse({ error: 'stripe_error', message: e.message }, 502, origin); }
  return jsonResponse({ url: session.url }, 200, origin);
}

async function handlePaymentKeyVerify(request, env, origin) {
  if (!env.WORKER_RECOVERY_SECRET) return jsonResponse({ error: 'recovery_disabled' }, 503, origin);
  const presented = request.headers.get('X-Recovery-Secret') || '';
  if (presented !== env.WORKER_RECOVERY_SECRET) return jsonResponse({ error: 'forbidden' }, 403, origin);
  let body;
  try { body = await request.json(); } catch (_) { body = null; }
  const key = body && typeof body.key === 'string' ? body.key.trim() : '';
  if (!key || key.length < 20 || key.length > 80) return jsonResponse({ valid: false, reason: 'bad_key_format' }, 200, origin);
  const userId = await lookupPaymentKey(env, key);
  if (!userId) return jsonResponse({ valid: false }, 200, origin);
  return jsonResponse({ valid: true, user_id: userId }, 200, origin);
}

async function handleReceiptKey(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  const token = getBearer(request);
  const user = await resolveUser(token);
  if (!user) return jsonResponse({ error: 'auth_required' }, 401, origin);
  if (isUserBanned(user)) return bannedResponse(origin);
  const kvKey = 'receipt:' + user.id + ':latest';
  const raw = env.SUB_KV ? await env.SUB_KV.get(kvKey) : null;
  if (!raw) return jsonResponse({ error: 'no_receipt', message: 'No pending receipt key found.' }, 404, origin);
  let record;
  try { record = JSON.parse(raw); } catch (_) { return jsonResponse({ error: 'no_receipt' }, 404, origin); }
  if (record.revealed) return jsonResponse({ error: 'already_revealed', message: 'This recovery key has already been shown. It cannot be displayed again.' }, 410, origin);
  record.revealed = true;
  await env.SUB_KV.put(kvKey, JSON.stringify(record));
  return jsonResponse({ key: record.key, tier: record.tier, created_at: record.created_at }, 200, origin);
}

async function handleStripeWebhook(request, env, origin) {
  if (!env.STRIPE_WEBHOOK_SECRET) return jsonResponse({ error: 'Webhook secret not configured' }, 500, origin);
  const sigHeader = request.headers.get('Stripe-Signature') || '';
  const raw = await request.text();
  const ok = await verifyStripeSignature(raw, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return jsonResponse({ error: 'invalid_signature' }, 400, origin);
  let event;
  try { event = JSON.parse(raw); } catch (_) { return jsonResponse({ error: 'bad_json' }, 400, origin); }
  const obj = event && event.data && event.data.object;
  if (!obj) return jsonResponse({ received: true }, 200, origin);

  async function findUserId() {
    if (obj.metadata && obj.metadata.jqrg_user_id) return obj.metadata.jqrg_user_id;
    if (obj.client_reference_id) return obj.client_reference_id;
    const customerId = obj.customer;
    if (customerId && env.SUB_KV) { const u = await env.SUB_KV.get('cust:' + customerId); if (u) return u; }
    return null;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = await findUserId();
      if (!userId) break;
      const subId = obj.subscription;
      const tier = (obj.metadata && obj.metadata.jqrg_tier) || 'premium';
      let subStatus = 'active', periodEnd = null, cancelAtEnd = false;
      if (subId) { try { const s = await stripeRequest(env, '/subscriptions/' + subId, null, 'GET'); subStatus = s.status; periodEnd = s.current_period_end; cancelAtEnd = !!s.cancel_at_period_end; } catch (_) {} }
      await writeSubscription(env, userId, { status: subStatus, tier, stripe_customer_id: obj.customer || null, stripe_subscription_id: subId || null, current_period_end: periodEnd, cancel_at_period_end: cancelAtEnd });
      const receiptKey = generateRecoveryKey();
      await storeReceiptKey(env, userId, receiptKey, tier, obj.id || '');
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const userId = await findUserId();
      if (!userId) break;
      const tier = (obj.metadata && obj.metadata.jqrg_tier) || 'premium';
      await writeSubscription(env, userId, { status: obj.status, tier, stripe_customer_id: obj.customer || null, stripe_subscription_id: obj.id || null, current_period_end: obj.current_period_end || null, cancel_at_period_end: !!obj.cancel_at_period_end });
      break;
    }
    case 'customer.subscription.deleted': {
      const userId = await findUserId();
      if (!userId) break;
      await writeSubscription(env, userId, { status: 'canceled', stripe_customer_id: obj.customer || null, stripe_subscription_id: obj.id || null, current_period_end: obj.current_period_end || null, cancel_at_period_end: !!obj.cancel_at_period_end });
      break;
    }
  }
  return jsonResponse({ received: true }, 200, origin);
}

async function handlePortalAnnouncements(request, env, origin) {
  if (!env.SYNC_KEY) return jsonResponse({ error: 'SYNC_KEY not configured' }, 500, origin);
  const syncKey = request.headers.get('X-Sync-Key');
  if (!syncKey || syncKey !== env.SYNC_KEY) return jsonResponse({ error: 'forbidden' }, 403, origin);
  const ua = request.headers.get('User-Agent') || '';
  const SYNC_UA_RE = /^JimmyQrg-Chat-Sync\//;
  if (!SYNC_UA_RE.test(ua)) return jsonResponse({ error: 'forbidden' }, 403, origin);
  const PORTAL_URL = 'https://indiamonda.github.io';
  let resp;
  try { resp = await fetch(PORTAL_URL, { headers: { 'User-Agent': 'JimmyQrg-Chat-Sync/1' } }); } catch (e) { return jsonResponse({ error: 'upstream_failed', detail: String(e) }, 502, origin); }
  if (!resp.ok) return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/html' } });
  return new Response(resp.body, { status: 200, headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/html', 'Cache-Control': 'no-cache' } });
}

async function handleBotReport(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  if (env.RATE_KV) {
    const today = new Date().toISOString().slice(0, 10);
    const key = 'botlog:' + today;
    const raw = await env.RATE_KV.get(key);
    let entries = [];
    try { entries = raw ? JSON.parse(raw) : []; } catch (_) { entries = []; }
    if (entries.length < 1000) {
      entries.push({ score: body.score, hits: body.hits, ua: (body.ua || '').slice(0, 300), ip: request.headers.get('CF-Connecting-IP') || '', ts: body.ts || Date.now() });
      await env.RATE_KV.put(key, JSON.stringify(entries), { expirationTtl: 7 * 86400 });
    }
  }
  return jsonResponse({ received: true }, 200, origin);
}

async function handleProxySessionCreate(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  const token = getBearer(request);
  const user = await resolveUser(token);
  if (!user) return jsonResponse({ error: 'auth_required' }, 401, origin);
  if (isUserBanned(user)) return bannedResponse(origin);
  const isAdmin = ADMIN_USERNAMES.has((user.username || '').toLowerCase());
  if (!isAdmin && !complimentaryTier(user)) {
    const sub = await readSubscription(env, user.id);
    if (!isSubscriptionActive(sub)) return jsonResponse({ error: 'subscription_required' }, 403, origin);
  }
  let body;
  try { body = await request.json(); } catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400, origin); }
  const targetUrl = (body && body.url) || '';
  if (!targetUrl || typeof targetUrl !== 'string') return jsonResponse({ error: 'url is required' }, 400, origin);
  const sid = generateSessionId();
  if (env.RATE_KV) await env.RATE_KV.put(PROXY_SESSION_PREFIX + sid, JSON.stringify({ url: targetUrl, userId: user.id, createdAt: Date.now() }), { expirationTtl: PROXY_SESSION_TTL });
  return jsonResponse({ session_id: sid, expires_in: PROXY_SESSION_TTL }, 200, origin);
}

async function handleProxySessionVerify(request, env, origin, sessionId) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  if (!sessionId || !env.RATE_KV) return jsonResponse({ valid: false }, 200, origin);
  const key = PROXY_SESSION_PREFIX + sessionId;
  const raw = await env.RATE_KV.get(key);
  if (!raw) return jsonResponse({ valid: false }, 200, origin);
  await env.RATE_KV.delete(key);
  let data;
  try { data = JSON.parse(raw); } catch (_) { return jsonResponse({ valid: false }, 200, origin); }
  return jsonResponse({ valid: true, url: data.url }, 200, origin);
}

async function handleUlwGate(request, env, origin) {
  if (origin && !isAllowedOrigin(origin)) return jsonResponse({ error: 'Forbidden origin' }, 403, origin);
  const token = getBearer(request);
  const user = await resolveUser(token);
  if (!user) return jsonResponse({ allowed: true, tier: 'free', reason: 'no_auth_required' }, 200, origin);
  if (isUserBanned(user)) return jsonResponse({ allowed: false, reason: 'banned' }, 200, origin);
  return jsonResponse({ allowed: true, tier: 'free', user: { id: user.id, username: user.username } }, 200, origin);
}

const BAD_UA = /headlesschrome|phantomjs|puppeteer|playwright|selenium|cypress|goguardian|securly|lightspeed|iboss|bluecoat|forcepoint|fortiguard|barracuda|webroot|kaspersky|sophos|cisco[\s-]?umbrella|mcafee|paloalto|zscaler|crawler|spider|scraper|bot\//i;

export default {
  async fetch(request, env) {
    const cookies = request.headers.get('Cookie') || '';
    if (cookies.includes('__sb_blocked=1')) {
      return new Response('<!doctype html><title>StudyBoard — Online Learning Platform</title><body><h1>StudyBoard Learning Platform</h1><p>Educational workspace for K-12 and higher education learners.</p></body>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const ua = (request.headers.get('User-Agent') || '').toLowerCase();
    if (BAD_UA.test(ua)) {
      return new Response('<!doctype html><title>StudyBoard — Online Learning Platform</title><body><h1>StudyBoard Learning Platform</h1><p>Educational workspace for K-12 and higher education learners.</p></body>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname === '/health' || url.pathname === '/') return jsonResponse({ ok: true, service: 'deepseek-proxy', ts: Date.now() }, 200, origin);
    if (url.pathname === '/v1/chat' && request.method === 'POST') return handleChat(request, env, origin);
    if (url.pathname === '/v1/subscription-status' && request.method === 'GET') return handleSubStatus(request, env, origin);
    if (url.pathname === '/v1/config' && request.method === 'GET') return handleConfig(request, env, origin);
    if (url.pathname === '/v1/checkout' && request.method === 'POST') return handleCheckout(request, env, origin);
    if (url.pathname === '/v1/billing-portal' && request.method === 'POST') return handleBillingPortal(request, env, origin);
    if (url.pathname === '/v1/receipt-key' && request.method === 'POST') return handleReceiptKey(request, env, origin);
    if (url.pathname === '/v1/payment-key/verify' && request.method === 'POST') return handlePaymentKeyVerify(request, env, origin);
    if (url.pathname === '/v1/stripe-webhook' && request.method === 'POST') return handleStripeWebhook(request, env, origin);
    if (url.pathname === '/v1/proxy-session' && request.method === 'POST') return handleProxySessionCreate(request, env, origin);
    if (url.pathname.startsWith('/v1/proxy-session/') && request.method === 'GET') { const sid = url.pathname.slice('/v1/proxy-session/'.length); return handleProxySessionVerify(request, env, origin, sid); }
    if (url.pathname === '/v1/ulw-gate' && request.method === 'GET') return handleUlwGate(request, env, origin);
    if (url.pathname === '/v1/bot-report' && request.method === 'POST') return handleBotReport(request, env, origin);
    if (url.pathname === '/v1/portal-announcements' && request.method === 'GET') return handlePortalAnnouncements(request, env, origin);
    if (url.pathname === '/__healthz') return jsonResponse({ ok: true, ts: Date.now() }, 200, origin);
    return jsonResponse({ error: 'Not found' }, 404, origin);
  },
};
```