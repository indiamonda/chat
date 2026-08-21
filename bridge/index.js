/**
 * OpenClaw ↔ jchat bridge.
 *
 * Connects OUT to the jchat server as the Venory helper bot (authenticated
 * with JCHAT_HELPER_TOKEN) and answers `helper:task` events — which the
 * server only emits for DM messages from OPENCLAW_OWNER_ID — by running the
 * local OpenClaw gateway agent through its OpenAI-compatible HTTP endpoint.
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
import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

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
const MODEL = process.env.OPENCLAW_MODEL || 'openclaw/default';

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

// --- socket connection ------------------------------------------------------
const socket = io(JCHAT_URL, {
  auth: { token: JCHAT_HELPER_TOKEN },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15000,
});

// --- gateway call -----------------------------------------------------------
async function runAgent(task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OPENCLAW_GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: MODEL,
        // Stable per-DM session key: the OpenClaw agent keeps its own
        // conversation memory across messages in the same DM.
        user: `jchat:dm:${task.convId}`,
        messages: [{ role: 'user', content: String(task.content) }],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`gateway ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text || !text.trim()) throw new Error('gateway returned an empty reply');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// --- task handling (serialized per DM, typing indicator) ---------------------
const chains = new Map();   // convId -> Promise (per-DM serialization)
const typingOn = new Map(); // convId -> number of queued tasks

async function handleTask(task) {
  if (!task || !secretsEqual(task.secret, OPENCLAW_BRIDGE_SECRET)) {
    log('ignored task with missing/bad secret');
    return;
  }
  const { taskId, convId } = task;
  log('task', taskId, 'conv', convId);

  const pending = (typingOn.get(convId) || 0) + 1;
  typingOn.set(convId, pending);
  if (pending === 1) socket.emit('typing:start', { roomType: 'dm', roomId: convId });

  const prev = chains.get(convId) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => runAgent(task))
    .then((text) => socket.emit('helper:reply', { taskId, text }))
    .catch((err) => {
      log('task failed:', err.message);
      socket.emit('helper:error', {
        taskId,
        message: `My full assistant hit an error: ${String(err.message).slice(0, 200)}`,
      });
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

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    socket.close();
    process.exit(0);
  });
}

log('bridge starting, target:', JCHAT_URL);
