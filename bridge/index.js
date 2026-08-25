/**
 * OpenClaw ↔ jchat bridge.
 *
 * Connects OUT to the jchat server as the Venory helper bot (authenticated
 * with JCHAT_HELPER_TOKEN) and answers `helper:task` events — which the
 * server only emits for DM messages from OPENCLAW_OWNER_ID — by running the
 * local OpenClaw gateway agent through its OpenAI-compatible HTTP endpoint.
 *
 * It also holds a persistent loopback WebSocket to the local gateway so it
 * can stream live `agent` events (working/done lifecycle + tools being used)
 * back to the server as `helper:status`, and so the owner can stop an
 * in-flight response (`helper:stop` → abort the HTTP fetch → `helper:stopped`).
 *
 * Security model:
 *  - OPENCLAW_GATEWAY_TOKEN lives only on this machine (env / bridge.env).
 *  - JCHAT_HELPER_TOKEN + OPENCLAW_BRIDGE_SECRET are shared with the server,
 *    but they grant nothing except "act as the helper bot" on jchat.
 *  - Anyone deploying the same code without these env vars gets an inert
 *    bridge: no gateway URL/token, no server-side routing.
 *
 * Run:  node bridge/index.js     (env from process env or bridge/bridge.env)
 */

import { io } from 'socket.io-client';
import WebSocket from 'ws';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// --- env loading -----------------------------------------------------------
// bridge.env (if present) provides fallbacks; already-set process env wins
// (so launchd/EnvironmentVariables overrides take priority).
const ENV_PATH = new URL('./bridge.env', import.meta.url).pathname;
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const JCHAT_URL = process.env.JCHAT_URL || 'https://jchat.fly.dev';
const JCHAT_HELPER_TOKEN = process.env.JCHAT_HELPER_TOKEN || '';
const OPENCLAW_GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789/v1').replace(/\/+$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const OPENCLAW_BRIDGE_SECRET = process.env.OPENCLAW_BRIDGE_SECRET || '';
const FETCH_TIMEOUT_MS = Number(process.env.OPENCLAW_FETCH_TIMEOUT_MS || 9 * 60 * 1000);
// HTTP body `model` is the *agent target* (openclaw / openclaw/<agentId>).
// The real backend model is switched via the `x-openclaw-model` header.
const MODEL = process.env.OPENCLAW_MODEL || 'openclaw/default';
// Loopback gateway WebSocket (for live agent events). Derive from the HTTP
// URL by dropping the /v1 path and swapping http→ws, unless overridden.
const GATEWAY_WS_URL = process.env.OPENCLAW_GATEWAY_WS_URL
  || OPENCLAW_GATEWAY_URL.replace(/\/v\d+\/?$/, '').replace(/^http/, 'ws');

// Mirror of the server's validated option sets (defense in depth: the server
// already sanitizes these before emitting `helper:task`, but we re-check so a
// bad value can never reach the gateway header/body).
const VALID_MODELS = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'claude-cli/claude-opus-4-8',
]);
const VALID_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max']);

function log(...args) {
  console.log(new Date().toISOString(), '[bridge]', ...args);
}

for (const [name, value] of [
  ['JCHAT_HELPER_TOKEN', JCHAT_HELPER_TOKEN],
  ['OPENCLAW_GATEWAY_TOKEN', OPENCLAW_GATEWAY_TOKEN],
  ['OPENCLAW_BRIDGE_SECRET', OPENCLAW_BRIDGE_SECRET],
]) {
  if (!value) {
    console.error(`[bridge] Missing required env var: ${name}`);
    process.exit(1);
  }
}

function secretsEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- gateway device identity (required for operator WS connects) -----------
// The gateway rejects shared-token-only operator connects with
// DEVICE_IDENTITY_REQUIRED; a device identity (Ed25519 keypair + signed
// connect payload) is required. We keep a persistent keypair next to
// bridge.env so every reconnect uses the same device id.
const DEVICE_PATH = new URL('./device.json', import.meta.url).pathname;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawB64u(publicKeyPem) {
  const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return base64UrlEncode(spki.subarray(spki.length - 32));
}

function loadOrCreateDeviceIdentity() {
  try {
    if (existsSync(DEVICE_PATH)) {
      const raw = JSON.parse(readFileSync(DEVICE_PATH, 'utf8'));
      if (raw?.deviceId && raw?.publicKeyPem && raw?.privateKeyPem) return raw;
    }
  } catch (err) {
    log('device.json unreadable, regenerating:', err.message);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = pubDer.subarray(pubDer.length - 32);
  const identity = {
    version: 1,
    deviceId: createHash('sha256').update(rawPub).digest('hex'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  try {
    mkdirSync(dirname(DEVICE_PATH), { recursive: true });
    writeFileSync(DEVICE_PATH, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    log('failed to persist device.json:', err.message);
  }
  log('generated gateway device identity:', identity.deviceId);
  return identity;
}

const DEVICE_IDENTITY = loadOrCreateDeviceIdentity();
const DEVICE_PRIVATE_KEY = createPrivateKey(DEVICE_IDENTITY.privateKeyPem);
const DEVICE_PUBLIC_KEY_B64U = publicKeyRawB64u(DEVICE_IDENTITY.publicKeyPem);

/** Build the signed `device` object the gateway requires on connect. */
function buildSignedDevice(role, scopes, token, nonce) {
  const signedAt = Date.now();
  const payload = [
    'v3', DEVICE_IDENTITY.deviceId, 'gateway-client', 'backend', role,
    scopes.join(','), String(signedAt), token, nonce, 'macos', '',
  ].join('|');
  const signature = sign(null, Buffer.from(payload, 'utf8'), DEVICE_PRIVATE_KEY);
  return {
    id: DEVICE_IDENTITY.deviceId,
    publicKey: DEVICE_PUBLIC_KEY_B64U,
    signature: base64UrlEncode(signature),
    signedAt,
    nonce,
  };
}

// --- socket connection (to jchat) ------------------------------------------
const socket = io(JCHAT_URL, {
  auth: { token: JCHAT_HELPER_TOKEN },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15000,
});

// --- gateway WebSocket (loopback, live agent events) ------------------------
let gw = null;
let gwReady = false;
let gwReconnectTimer = null;

function connectGatewayWs() {
  if (gw && (gw.readyState === WebSocket.OPEN || gw.readyState === WebSocket.CONNECTING)) return;
  try {
    gw = new WebSocket(GATEWAY_WS_URL);
  } catch (err) {
    log('gateway ws create error:', err.message);
    scheduleGatewayReconnect();
    return;
  }
  gw.on('open', () => log('gateway ws open'));
  gw.on('error', (e) => log('gateway ws error:', e.message));
  gw.on('close', () => {
    log('gateway ws closed');
    gwReady = false;
    scheduleGatewayReconnect();
  });
  gw.on('message', (raw) => handleGatewayMessage(raw));
}

function scheduleGatewayReconnect() {
  if (gwReconnectTimer) clearTimeout(gwReconnectTimer);
  gwReconnectTimer = setTimeout(connectGatewayWs, 3000);
}

function handleGatewayMessage(raw) {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.event === 'connect.challenge') {
    const nonce = m.payload?.nonce || '';
    const scopes = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals'];
    gw.send(JSON.stringify({
      type: 'req',
      id: 'gw-connect',
      method: 'connect',
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: 'gateway-client', version: '1.0.0', platform: 'macos', mode: 'backend' },
        role: 'operator',
        scopes,
        caps: [], commands: [], permissions: {},
        device: buildSignedDevice('operator', scopes, OPENCLAW_GATEWAY_TOKEN, nonce),
        auth: { token: OPENCLAW_GATEWAY_TOKEN },
        locale: 'en-US',
        userAgent: 'jchat-bridge/1.0.0',
      },
    }));
  } else if (m.type === 'res' && m.id === 'gw-connect') {
    if (m.ok) {
      gwReady = true;
      log('gateway ws connected (operator)');
      gwRpc('sessions.subscribe', {}, 8000)
        .then(() => log('subscribed to gateway session index changes'))
        .catch((err) => log('sessions.subscribe failed:', err.message));
      scheduleListPush();
    } else {
      log('gateway ws connect rejected:', JSON.stringify(m.error || m).slice(0, 300));
    }
  } else if (m.type === 'res' && rpcWaiters.has(m.id)) {
    rpcWaiters.get(m.id)(m);
  } else if (m.event === 'sessions.changed') {
    scheduleListPush();
  } else if (m.event === 'session.message') {
    handleSessionMessage(m.payload);
  } else if (m.event === 'agent') {
    handleAgentEvent(m.payload);
  }
}

/** Extract the DM conversation id from an agent session key.
 *  Shape: agent:main:openai-user:jchat:dm:<convId> */
function convIdFromSessionKey(sessionKey) {
  const m = String(sessionKey || '').match(/^agent:main:openai-user:jchat:dm:(.+)$/);
  return m ? m[1] : null;
}

function handleAgentEvent(p) {
  if (!p || !p.sessionKey) return;
  // Session-switched tasks surface agent events under the switched session
  // key; DM tasks surface them under the derived DM session key.
  let taskId = activeBySession.get(p.sessionKey);
  if (!taskId) {
    const convId = convIdFromSessionKey(p.sessionKey);
    if (convId) taskId = activeByConv.get(convId);
  }
  if (!taskId) return; // no in-flight task for this session
  const status = mapAgentEvent(p);
  if (!status) return;
  socket.emit('helper:status', { taskId, ...status });
}

/** Map a raw `agent` event to a compact `helper:status` payload.
 *  Returns null for streams we don't surface in the UI (thinking text, etc.). */
function mapAgentEvent(p) {
  const d = p?.data || {};
  const s = p?.stream;
  if (s === 'lifecycle') {
    if (d.phase === 'start') return { kind: 'lifecycle', status: 'working' };
    if (d.phase === 'finishing' || d.phase === 'end') return { kind: 'lifecycle', status: 'done' };
    return null;
  }
  if (s === 'item' && d.kind === 'tool') {
    if (d.phase === 'start') {
      return { kind: 'tool', status: 'running', id: d.itemId, name: d.name, title: d.title, meta: d.meta };
    }
    if (d.phase === 'end') {
      return { kind: 'tool', status: d.status || 'completed', id: d.itemId, name: d.name, title: d.title };
    }
    return null;
  }
  return null;
}

// --- gateway HTTP call ------------------------------------------------------
const GATEWAY_MAX_ATTEMPTS = 3; // 1 initial + 2 retries on transient network errors
const GATEWAY_RETRY_DELAY_MS = 1500;

/** True for transient, connection-level failures worth retrying on a fresh
 *  connection. HTTP error statuses and empty replies are NOT retried. */
function isTransientFetchError(err) {
  const msg = String(err?.message || '');
  const code = String(err?.code || err?.cause?.code || '');
  if (/fetch failed/i.test(msg)) return true;
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT'].includes(code);
}

/** Perform a JSON POST to the gateway over raw node http/https, resolving
 *  { status, body }. Unlike `fetch` (undici), this has NO built-in 5-minute
 *  header/body timeout — the only deadline is our own FETCH_TIMEOUT_MS abort,
 *  so long agent runs are no longer cut off mid-flight. This is the fix for
 *  the historical "fetch failed at ~5 minutes → silent DeepSeek fallback"
 *  ("sometimes basic Venory") bug. */
function gatewayRequestJson(urlStr, headers, body, controller) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    const req = mod({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });

    req.on('error', (e) => finish(reject, e));

    timer = setTimeout(() => {
      finish(reject, Object.assign(new Error(`gateway timed out after ${FETCH_TIMEOUT_MS}ms`), { name: 'TimeoutError' }));
      req.destroy();
    }, FETCH_TIMEOUT_MS);

    const onAbort = () => {
      finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
      req.destroy();
    };
    if (controller.signal.aborted) return onAbort();
    controller.signal.addEventListener('abort', onAbort, { once: true });

    req.write(body);
    req.end();
  });
}

async function runAgentOnce(task, controller) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
  };
  if (task.model && VALID_MODELS.has(task.model)) {
    headers['x-openclaw-model'] = task.model;
  }
  let content = String(task.content);
  if (task.effort && VALID_EFFORTS.has(task.effort)) {
    // Thinking-level directive on its own line; OpenClaw strips it from the
    // message and applies the requested reasoning effort for this session.
    content = `/think:${task.effort}\n\n${content}`;
  }
  const sessionKey = resolveTaskSessionKey(task);
  const payload = {
    model: MODEL,
    messages: [{ role: 'user', content }],
    stream: false,
  };
  if (sessionKey === dmSessionKey(task.convId)) {
    // Default: stable per-DM session key — the OpenClaw agent keeps its own
    // conversation memory across messages in the same DM.
    payload.user = `jchat:dm:${task.convId}`;
  } else {
    // Session switch: explicit routing to the owner-selected session.
    headers['x-openclaw-session-key'] = sessionKey;
  }
  recordSent(sessionKey, content);
  const json = JSON.stringify(payload);
  headers['Content-Length'] = Buffer.byteLength(json);
  const { status, body } = await gatewayRequestJson(
    `${OPENCLAW_GATEWAY_URL}/chat/completions`, headers, json, controller
  );
  if (status < 200 || status >= 300) {
    throw new Error(`gateway ${status}: ${body.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('gateway returned a non-JSON reply'); }
  const text = data.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('gateway returned an empty reply');
  return text.trim();
}

async function runAgent(task, controller) {
  let lastErr;
  for (let attempt = 0; attempt < GATEWAY_MAX_ATTEMPTS; attempt++) {
    if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (attempt > 0) {
      log('gateway retry', attempt + 1, '/', GATEWAY_MAX_ATTEMPTS, 'after', lastErr?.message || lastErr);
      await new Promise((r) => setTimeout(r, GATEWAY_RETRY_DELAY_MS));
    }
    try {
      return await runAgentOnce(task, controller);
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || attempt >= GATEWAY_MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr;
}

// --- task handling (serialized per DM, typing indicator) ---------------------
const chains = new Map();         // convId -> Promise (per-DM serialization)
const typingOn = new Map();       // convId -> number of queued tasks
const activeByConv = new Map();   // convId -> taskId (running task, for agent events)
const activeBySession = new Map(); // gateway sessionKey -> taskId (session-switched tasks)
const controllers = new Map();    // taskId -> AbortController (for helper:stop)

// --- gateway session awareness (session switching + live relay) ---------------
let rpcSeq = 1;
const rpcWaiters = new Map();     // rpc id -> resolver
let currentSessionKey = '';       // '' = owner's DM session (default)
let dmConvId = '';                // owner's DM conv id (from server sync; relay target)
let relaySubKey = null;           // gateway session key subscribed for message events
let listPushTimer = null;
const recentSent = new Map();     // sessionKey -> { text, at } (user msgs we sent via tasks)
const recentReplies = new Map();  // sessionKey -> { text, at } (assistant replies we delivered)
const relayRate = new Map();      // sessionKey -> [timestamps]
const RELAY_WINDOW_MS = 60 * 1000;
const RELAY_MAX_PER_WINDOW = 20;
const SESSION_LIST_MAX = 30;

/** Call an RPC on the gateway WS (request/response pair). */
function gwRpc(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!gw || gw.readyState !== WebSocket.OPEN) {
      return reject(new Error('gateway ws not open'));
    }
    const id = `br-${rpcSeq++}`;
    const timer = setTimeout(() => {
      rpcWaiters.delete(id);
      reject(new Error(`${method} rpc timed out`));
    }, timeoutMs);
    rpcWaiters.set(id, (res) => {
      clearTimeout(timer);
      rpcWaiters.delete(id);
      if (res.ok) resolve(res.payload);
      else reject(Object.assign(new Error(res?.error?.message || `${method} failed`), { rpcError: res?.error }));
    });
    try {
      gw.send(JSON.stringify({ type: 'req', id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      rpcWaiters.delete(id);
      reject(err);
    }
  });
}

function dmSessionKey(convId) {
  return convId ? `agent:main:openai-user:jchat:dm:${convId}` : '';
}

function isReservedSessionKey(key) {
  return /^(subagent|cron|acp):/.test(key) || /:(subagent|cron|acp):/.test(key);
}

function isRoutableSessionKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (!/^agent:main(:|$)/.test(key)) return false;
  if (isReservedSessionKey(key)) return false;
  return true;
}

function shortSessionLabel(key) {
  const m = String(key || '').match(/^agent:main:(.+)$/);
  const base = m ? m[1] : String(key || '');
  return base.length > 28 ? `${base.slice(0, 25)}…` : base;
}

/** Compact gateway transcript messages to { role, text, seq, at } for the
 *  session-history view (user/assistant text only, deduped by seq). The
 *  leading `/think:<level>` line the bridge prepends to routed DM messages
 *  is stripped so the view matches what the owner actually sent. */
function compactHistoryMessages(messages) {
  const out = [];
  const seenSeqs = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = typeof m?.role === 'string' ? m.role : '';
    if (role !== 'user' && role !== 'assistant') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p) => p && typeof p === 'object' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
    if (!text || !text.trim()) continue;
    const seq = typeof m?.__openclaw?.seq === 'number' ? m.__openclaw.seq : 0;
    if (seq > 0 && seenSeqs.has(seq)) continue;
    if (seq > 0) seenSeqs.add(seq);
    const at = typeof m.timestamp === 'number' && m.timestamp > 0 ? m.timestamp
      : (typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : 0);
    out.push({
      role,
      text: text.replace(/^\s*\/think:[a-z]+\s*\n*/i, '').trim(),
      seq,
      at: Number.isFinite(at) ? at : 0,
    });
  }
  return out;
}

function resolveTaskSessionKey(task) {
  const s = typeof task?.agentSession === 'string' ? task.agentSession.trim() : '';
  if (s && !isReservedSessionKey(s)) return s;
  return dmSessionKey(task?.convId);
}

/** Curated session list for the owner UI: routable rows + previews, most
 *  recently active first, excluding the owner's DM session itself. */
async function buildSessionList() {
  const payload = await gwRpc('sessions.list', { agentId: 'main' }, 20000);
  const rows = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const dmKey = dmSessionKey(dmConvId);
  let sessions = rows
    .filter((s) => isRoutableSessionKey(s.key))
    .map((s) => {
      const isDm = dmKey ? s.key === dmKey : false;
      return {
        key: s.key,
        // The owner's own DM session is the jchat conversation itself; give
        // it the same label the picker uses so the entry's live state
        // (activity dot, preview, updatedAt) shows up there too.
        label: isDm ? 'This DM (jchat)' : ((typeof s.displayName === 'string' && s.displayName) ? s.displayName : shortSessionLabel(s.key)),
        isDm,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : (typeof s.lastActivityAt === 'number' ? s.lastActivityAt : 0),
        status: s.status || (s.hasActiveRun ? 'running' : 'done'),
        hasActiveRun: !!s.hasActiveRun,
        model: typeof s.model === 'string' ? s.model : '',
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SESSION_LIST_MAX);
  // One-shot previews (first user/assistant text item per session).
  try {
    const keys = sessions.slice(0, 20).map((s) => s.key);
    if (keys.length) {
      const prev = await gwRpc('sessions.preview', { keys, limit: 4, maxChars: 160 }, 20000);
      const byKey = new Map((prev?.previews || []).map((p) => [p.key, p]));
      for (const s of sessions) {
        const items = byKey.get(s.key)?.items || [];
        const hit = items.find((it) => (it.role === 'user' || it.role === 'assistant') && it.text);
        if (hit) s.preview = String(hit.text).replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    }
  } catch (err) {
    log('session preview fetch failed:', err.message);
  }
  return sessions;
}

/** Debounced push of the fresh session list to the jchat server (drives the
 *  owner's picker + "updates when activity happens" requirement). */
function scheduleListPush() {
  if (listPushTimer) return;
  listPushTimer = setTimeout(async () => {
    listPushTimer = null;
    if (!socket.connected || !gwReady) return;
    try {
      const sessions = await buildSessionList();
      log(`session list push: ${sessions.length} sessions`);
      socket.emit('helper:sessions:update', { sessions });
    } catch (err) {
      log('session list push failed:', err.message);
    }
  }, 1500);
}

/** Apply the server's authoritative session selection (from helper:session:sync
 *  or the agentSession field on tasks) and re-subscribe message events. */
function applySessionSync(p) {
  const raw = typeof p?.sessionKey === 'string' ? p.sessionKey.trim() : '';
  currentSessionKey = (raw && !isReservedSessionKey(raw)) ? raw : '';
  if (typeof p?.dmConvId === 'string' && p.dmConvId) dmConvId = p.dmConvId;
  const want = (currentSessionKey && currentSessionKey !== dmSessionKey(dmConvId)) ? currentSessionKey : null;
  if (want === relaySubKey) return;
  if (relaySubKey) {
    gwRpc('sessions.messages.unsubscribe', { key: relaySubKey }).catch(() => {});
  }
  relaySubKey = null;
  if (want) {
    gwRpc('sessions.messages.subscribe', { key: want })
      .then(() => {
        relaySubKey = want;
        log('relay subscribed to:', want);
      })
      .catch((err) => log('relay subscribe failed:', err.message));
  }
}

function recordSent(sessionKey, content) {
  const norm = String(content).replace(/^\s*\/think:[a-z]+\s*\n*\s*/i, '').trim();
  recentSent.set(sessionKey, { text: norm, at: Date.now() });
  if (recentSent.size > 64) {
    const now = Date.now();
    for (const [k, v] of recentSent) if (now - v.at > 10 * 60 * 1000) recentSent.delete(k);
  }
}

function recordReply(sessionKey, text) {
  recentReplies.set(sessionKey, { text: String(text).trim(), at: Date.now() });
  if (recentReplies.size > 64) {
    const now = Date.now();
    for (const [k, v] of recentReplies) if (now - v.at > 10 * 60 * 1000) recentReplies.delete(k);
  }
}

/** Relay activity from the *switched* gateway session into the owner's DM as
 *  Venory messages, so the chat app stays in sync with that session. Own
 *  bridge tasks are deduped (the DM already shows those). */
async function handleSessionMessage(p) {
  if (!p?.sessionKey || !p?.message) return;
  if (!currentSessionKey || p.sessionKey !== currentSessionKey) return; // stale subscription
  if (p.sessionKey === dmSessionKey(dmConvId)) return; // the DM is that session's UI
  const msg = p.message || {};
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') return;
  const text = typeof msg.content === 'string' ? msg.content : (typeof msg.text === 'string' ? msg.text : '');
  if (!text || !text.trim()) return;
  const now = Date.now();
  const clean = text.replace(/\s+/g, ' ').trim();
  const norm = clean.replace(/^\/think:[a-z]+\s*/i, '').trim();
  log('session msg:', p.sessionKey, role, norm.slice(0, 60));
  // Per-session rate cap so a busy session can't flood the DM or live view.
  const stamps = (relayRate.get(p.sessionKey) || []).filter((t) => now - t < RELAY_WINDOW_MS);
  if (stamps.length >= RELAY_MAX_PER_WINDOW) {
    relayRate.set(p.sessionKey, stamps);
    log('relay rate cap hit for', p.sessionKey);
    return;
  }
  stamps.push(now);
  relayRate.set(p.sessionKey, stamps);
  // Live session view: forward every user/assistant message on the switched
  // session (including messages this bridge itself sent/received), so the
  // owner's page can show the session's real transcript while viewing it.
  socket.emit('helper:session:live', {
    convId: dmConvId,
    sessionKey: p.sessionKey,
    role,
    text: norm.slice(0, 2000),
  });
  // DM relay: only external activity + messages not already shown in the DM.
  if (role === 'user') {
    const sent = recentSent.get(p.sessionKey);
    if (sent && now - sent.at < 5 * 60 * 1000 && sent.text === norm) return; // our own task
  } else {
    const activeTaskId = activeBySession.get(p.sessionKey);
    if (activeTaskId && controllers.has(activeTaskId)) return; // reply path handles it
    const rep = recentReplies.get(p.sessionKey);
    if (rep && now - rep.at < 3 * 60 * 1000 && rep.text === clean) return; // just delivered
  }
  if (!dmConvId) return;
  const label = shortSessionLabel(p.sessionKey);
  const prefix = role === 'user' ? `📡 [${label}] you: ` : `📡 [${label}] `;
  socket.emit('helper:session:msg', { convId: dmConvId, text: prefix + clean.slice(0, 400) });
}

async function handleTask(task) {
  if (!task || !secretsEqual(task.secret, OPENCLAW_BRIDGE_SECRET)) {
    log('ignored task with missing/bad secret');
    return;
  }
  const { taskId, convId } = task;
  log('task', taskId, 'conv', convId);

  const controller = new AbortController();
  controllers.set(taskId, controller);

  const sessionKey = resolveTaskSessionKey(task);
  if (typeof task?.agentSession === 'string') {
    // Server-authoritative session selection; apply immediately so live
    // agent events for this session map to this task, and so the relay
    // subscription self-heals if the connect-time sync was missed.
    currentSessionKey = task.agentSession;
    applySessionSync({ sessionKey: task.agentSession, dmConvId: task.convId });
  }

  const pending = (typingOn.get(convId) || 0) + 1;
  typingOn.set(convId, pending);
  if (pending === 1) socket.emit('typing:start', { roomType: 'dm', roomId: convId });

  const prev = chains.get(convId) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => {
      activeByConv.set(convId, taskId);
      activeBySession.set(sessionKey, taskId);
      return runAgent(task, controller);
    })
    .then((text) => {
      recordReply(sessionKey, text);
      socket.emit('helper:reply', { taskId, text });
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        log('task stopped:', taskId);
        socket.emit('helper:stopped', { taskId });
      } else {
        log('task failed:', err.message);
        socket.emit('helper:error', {
          taskId,
          message: `My full assistant hit an error: ${String(err.message).slice(0, 200)}`,
        });
      }
    })
    .finally(() => {
      controllers.delete(taskId);
      if (activeByConv.get(convId) === taskId) activeByConv.delete(convId);
      if (activeBySession.get(sessionKey) === taskId) activeBySession.delete(sessionKey);
    });
  chains.set(convId, run);

  await run;
  if (chains.get(convId) === run) chains.delete(convId);
  const left = (typingOn.get(convId) || 1) - 1;
  if (left <= 0) {
    typingOn.delete(convId);
    socket.emit('typing:stop', { roomType: 'dm', roomId: convId });
  } else {
    typingOn.set(convId, left);
  }
}

// --- socket lifecycle --------------------------------------------------------
socket.on('connect', () => log('connected to', JCHAT_URL, 'as helper bridge'));
socket.on('disconnect', (reason) => log('disconnected:', reason));
socket.on('connect_error', (err) => log('connect error:', err.message));
socket.on('helper:task', (task) => {
  handleTask(task);
});
socket.on('helper:stop', (p) => {
  const controller = controllers.get(p?.taskId);
  if (controller) controller.abort();
});
// Owner session picker: server asks the bridge to build the session list.
socket.on('helper:sessions:get', async (p) => {
  const reqId = p?.reqId;
  if (!reqId) return;
  if (!gwReady) {
    socket.emit('helper:sessions:result', { reqId, ok: false, error: 'gateway offline' });
    return;
  }
  try {
    const sessions = await buildSessionList();
    socket.emit('helper:sessions:result', { reqId, ok: true, sessions });
  } catch (err) {
    socket.emit('helper:sessions:result', { reqId, ok: false, error: err.message });
  }
});
// Owner session history: server asks the bridge to fetch a session's recent
// messages from the gateway (sessions.get) so the chat page can replace the
// DM view with that session's conversation. The sessions themselves keep
// running on the Mac — this only reads their transcripts.
socket.on('helper:sessions:history', async (p) => {
  const reqId = p?.reqId;
  const key = typeof p?.key === 'string' ? p.key.trim() : '';
  if (!reqId || !key) return;
  if (!gwReady) {
    socket.emit('helper:sessions:history:result', { reqId, ok: false, error: 'gateway offline' });
    return;
  }
  try {
    const limit = Number.isFinite(p?.limit) ? Math.max(1, Math.min(500, Math.floor(p.limit))) : 300;
    const res = await gwRpc('sessions.get', { key, limit }, 20000);
    const messages = compactHistoryMessages(res?.messages);
    socket.emit('helper:sessions:history:result', { reqId, ok: true, key, messages });
  } catch (err) {
    socket.emit('helper:sessions:history:result', { reqId, ok: false, error: err.message });
  }
});
// Server pushes the persisted session selection (on bridge connect and on
// change) so routing + relay subscriptions stay in sync.
socket.on('helper:session:sync', (p) => applySessionSync(p));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    try { gw?.close(); } catch (_) {}
    socket.close();
    process.exit(0);
  });
}

log('bridge starting, target:', JCHAT_URL);
connectGatewayWs();
