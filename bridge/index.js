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
import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
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
    gw.send(JSON.stringify({
      type: 'req',
      id: 'gw-connect',
      method: 'connect',
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: 'gateway-client', version: '1.0.0', platform: 'macos', mode: 'backend' },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals'],
        caps: [], commands: [], permissions: {},
        auth: { token: OPENCLAW_GATEWAY_TOKEN },
        locale: 'en-US',
        userAgent: 'jchat-bridge/1.0.0',
      },
    }));
  } else if (m.type === 'res' && m.id === 'gw-connect') {
    if (m.ok) {
      gwReady = true;
      log('gateway ws connected (operator)');
    } else {
      log('gateway ws connect rejected:', JSON.stringify(m.error || m).slice(0, 300));
    }
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
  const convId = convIdFromSessionKey(p.sessionKey);
  if (!convId) return;
  const taskId = activeByConv.get(convId);
  if (!taskId) return; // no in-flight task for this DM
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
  const json = JSON.stringify({
    model: MODEL,
    // Stable per-DM session key: the OpenClaw agent keeps its own
    // conversation memory across messages in the same DM.
    user: `jchat:dm:${task.convId}`,
    messages: [{ role: 'user', content }],
    stream: false,
  });
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
const controllers = new Map();    // taskId -> AbortController (for helper:stop)

async function handleTask(task) {
  if (!task || !secretsEqual(task.secret, OPENCLAW_BRIDGE_SECRET)) {
    log('ignored task with missing/bad secret');
    return;
  }
  const { taskId, convId } = task;
  log('task', taskId, 'conv', convId);

  const controller = new AbortController();
  controllers.set(taskId, controller);

  const pending = (typingOn.get(convId) || 0) + 1;
  typingOn.set(convId, pending);
  if (pending === 1) socket.emit('typing:start', { roomType: 'dm', roomId: convId });

  const prev = chains.get(convId) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => {
      activeByConv.set(convId, taskId);
      return runAgent(task, controller);
    })
    .then((text) => socket.emit('helper:reply', { taskId, text }))
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
