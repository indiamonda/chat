import { apiGet, apiPost, apiPatch, apiPut, apiDelete, uploadFile, getDefaultAvatarUrl } from './api.js';

let state = {
  user: null,
  users: [],
  group: null,
  panel: 'free_chat',
  dmUserId: null,
  convId: null,
  messages: {},
  socket: null,
  replyTo: null,
  inbox: [],
  supportMessageIdForSolve: null,
};

const GROUP_ID = 'JimmyQrg';

// URL panel param <-> internal panel
const PANEL_TO_URL = { free_chat: 'chat', support: 'support', problem_solving: 'problem', rules: 'rules' };
const URL_TO_PANEL = { chat: 'free_chat', support: 'support', problem: 'problem_solving', rules: 'rules' };

function roomKey(roomType, roomId) {
  return `${roomType}:${roomId}`;
}

function getPath() {
  return window.location.pathname.replace(/\/$/, '') || '/';
}

function interceptLinks(container) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/"]');
    if (!a || a.hasAttribute('target') || a.getAttribute('href').startsWith('/api')) return;
    e.preventDefault();
    navigateTo(a.getAttribute('href'));
  });
}

function parseRoute() {
  const path = getPath();
  const params = new URLSearchParams(window.location.search || '');
  if (path === '/login') return { page: 'login' };
  if (path === '/signup') return { page: 'signup' };
  if (path === '/settings') return { page: 'settings', tab: params.get('tab') || 'profile' };
  if (path === '/inbox') return { page: 'inbox' };
  const chatMatch = path.match(/^\/chat\/([^/]+)$/);
  if (chatMatch) {
    const id = chatMatch[1];
    if (id.toLowerCase() === 'jimmyqrg') {
      const panelParam = params.get('panel') || 'chat';
      const panel = URL_TO_PANEL[panelParam] || 'free_chat';
      return { page: 'chat', group: true, panel };
    }
    return { page: 'chat', dmUserId: id };
  }
  return { page: 'chat', group: true, panel: 'free_chat' };
}

function getPage() {
  const route = parseRoute();
  return route.page;
}

function navigateTo(path) {
  const full = path.startsWith('http') ? path : (path.startsWith('/') ? path : '/' + path);
  if (full.startsWith('http') && new URL(full).origin !== window.location.origin) {
    window.location.href = full;
    return;
  }
  const pathname = full.startsWith('http') ? new URL(full).pathname : full.split('?')[0];
  const search = full.includes('?') ? full.slice(full.indexOf('?')) : '';
  if (window.location.pathname !== pathname || window.location.search !== search) {
    window.history.pushState({}, '', pathname + search);
  }
  applyRoute(parseRoute());
}

export function getState() {
  return state;
}

export function setState(updates) {
  Object.assign(state, updates);
  render();
}

/** Load current user from session. 401 here is expected when not logged in (e.g. on login/signup page). */
export async function loadMe() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.status === 401) {
      state.user = null;
      return null;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    state.user = data.user;
    return data.user;
  } catch {
    state.user = null;
    return null;
  }
}

export async function loadUsers() {
  const { users } = await apiGet('/api/users');
  state.users = users;
  return users;
}

export async function loadGroup() {
  const g = await apiGet('/api/group');
  state.group = g;
  return g;
}

export async function loadMessages(roomType, roomId) {
  const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
  const { messages } = await apiGet(path);
  const key = roomKey(roomType, roomId);
  state.messages[key] = messages || [];
  return state.messages[key];
}

export async function loadDoc(docKey) {
  return apiGet(`/api/docs/${docKey}`);
}

export async function saveDoc(docKey, content, supportMessageId) {
  return apiPut(`/api/docs/${docKey}`, { content, support_message_id: supportMessageId });
}

export async function loadInbox() {
  const { items } = await apiGet('/api/inbox');
  state.inbox = items || [];
  return state.inbox;
}

export function addMessageLocal(msg) {
  const key = roomKey(msg.room_type, msg.room_id);
  if (!state.messages[key]) state.messages[key] = [];
  if (state.messages[key].some(m => m.id === msg.id)) return;
  state.messages[key].push(msg);
  render();
}

export function updateMessageLocal(id, roomType, roomId, patch) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return;
  list[i] = { ...list[i], ...patch };
  render();
}

export function removeMessageContent(id, roomType, roomId) {
  updateMessageLocal(id, roomType, roomId, { content: null, recalled_at: Date.now(), msg_type: 'recalled' });
}

export function deleteMessageLocal(id, roomType, roomId) {
  updateMessageLocal(id, roomType, roomId, { deleted_by_admin: 1, content: null, msg_type: 'deleted' });
}

function connectSocket() {
  const io = window.io;
  if (!io) return;
  const s = io({ withCredentials: true });
  s.on('connect', () => {
    if (state.dmUserId && state.convId) s.emit('dm:join', state.convId, () => {});
  });
  s.on('message', (msg) => addMessageLocal(msg));
  s.on('message:recalled', ({ id }) => {
    const key = state.convId ? roomKey('dm', state.convId) : roomKey('group', GROUP_ID);
    const list = state.messages[key];
    const m = list?.find(x => x.id === id);
    if (m) removeMessageContent(id, m.room_type, m.room_id);
  });
  s.on('message:edited', ({ id, content, edit_history, updated_at }) => {
    const key = state.convId ? roomKey('dm', state.convId) : roomKey('group', GROUP_ID);
    const list = state.messages[key];
    const m = list?.find(x => x.id === id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { content, edit_history, updated_at });
  });
  s.on('message:liked', ({ id, likes }) => {
    const key = state.convId ? roomKey('dm', state.convId) : roomKey('group', GROUP_ID);
    const list = state.messages[key];
    const m = list?.find(x => x.id === id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { likes });
  });
  s.on('message:deleted', ({ id }) => {
    const key = state.convId ? roomKey('dm', state.convId) : roomKey('group', GROUP_ID);
    const list = state.messages[key];
    const m = list?.find(x => x.id === id);
    if (m) deleteMessageLocal(id, m.room_type, m.room_id);
  });
  s.on('kicked', () => {
    alert('You have been kicked from the group.');
    window.location.reload();
  });
  s.on('inbox:item', () => loadInbox().then(render));
  state.socket = s;
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('app-loading');
  const route = parseRoute();

  if (!state.user) {
    document.body.classList.add('auth-page');
    const isSignup = route.page === 'signup';
    const authError = state.authError || '';
    state.authError = null;
    app.innerHTML = renderAuth(isSignup, authError);
    bindAuth(isSignup);
    return;
  }

  document.body.classList.remove('auth-page');
  app.innerHTML = renderMain();
  bindMain();
  interceptLinks(app);
}

function renderAuth(isSignup = false, initialError = '') {
  return `
    <div class="auth-screen auth-ani-1">
      <div class="auth-box auth-ani-2">
        <h1 class="auth-ani-3">JimmyQrg Chat</h1>
        <div class="tabs auth-ani-4">
          <a href="/login" class="tab-link auth-ani-5 ${!isSignup ? 'active' : ''}" data-tab="login">Login</a>
          <a href="/signup" class="tab-link auth-ani-6 ${isSignup ? 'active' : ''}" data-tab="register">Sign up</a>
        </div>
        <form id="auth-form" class="auth-ani-7" novalidate>
          <div id="auth-error" class="error auth-ani-8">${initialError ? escapeHtml(initialError) : ''}</div>
          <div id="auth-fields-login" class="auth-ani-9" style="display:${isSignup ? 'none' : 'block'}">
            <label class="auth-ani-10">Username or email</label>
            <input class="auth-ani-11" name="login_identifier" type="text" autocomplete="username" placeholder="Username or email" />
            <label class="auth-ani-12">Password</label>
            <input class="auth-ani-13" name="login_password" type="password" autocomplete="current-password" />
          </div>
          <div id="auth-fields-register" class="auth-ani-14" style="display:${isSignup ? 'block' : 'none'}">
            <label class="auth-ani-15">Display name</label>
            <input class="auth-ani-16" name="display_name" type="text" autocomplete="name" placeholder="Display name" />
            <label class="auth-ani-17">Username (lowercase letters and numbers only)</label>
            <input class="auth-ani-18" name="reg_username" type="text" autocomplete="username" placeholder="Username" />
            <label class="auth-ani-19">Email</label>
            <input class="auth-ani-20" name="email" type="email" autocomplete="email" placeholder="Email" />
            <label class="auth-ani-21">Password</label>
            <input class="auth-ani-22" name="reg_password" type="password" autocomplete="new-password" placeholder="Password" />
            <label class="auth-ani-23">Confirm password</label>
            <input class="auth-ani-24" name="confirm_password" type="password" autocomplete="new-password" placeholder="Confirm password" />
          </div>
          <button type="submit" id="auth-submit" class="auth-ani-25">${isSignup ? 'Sign up' : 'Login'}</button>
        </form>
      </div>
    </div>
  `;
}

function bindAuth(isSignup) {
  const isRegister = !!isSignup;
  document.querySelectorAll('.auth-box .tabs .tab-link').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigateTo(link.getAttribute('href')); });
  });
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const form = e.target;
    errEl.textContent = '';
    if (isRegister) {
      const display_name = (form.display_name?.value || '').trim();
      const username = (form.reg_username?.value || '').trim().toLowerCase();
      const email = (form.email?.value || '').trim();
      const password = form.reg_password?.value || '';
      const confirm = form.confirm_password?.value || '';
      if (!display_name) { errEl.textContent = 'Display name is required'; return; }
      if (!username) { errEl.textContent = 'Username is required'; return; }
      if (!email) { errEl.textContent = 'Email is required'; return; }
      if (!password) { errEl.textContent = 'Password is required'; return; }
      if (password !== confirm) { errEl.textContent = 'Passwords do not match'; return; }
      try {
        const data = await doLogin(true, { username, email, password, display_name });
        if (data.user) {
          state.user = data.user;
          try {
            await loadGroup();
            await loadUsers();
            connectSocket();
            navigateTo('/chat/jimmyqrg');
          } catch (e) {
            state.user = null;
            state.authError = e.message || 'Session could not be established. Please try again.';
            navigateTo('/login');
          }
        } else throw new Error(data.error || 'Sign up failed');
      } catch (err) {
        errEl.textContent = err.message || 'Failed';
      }
      return;
    }
    const usernameOrEmail = (form.login_identifier?.value || '').trim();
    const password = form.login_password?.value || '';
    if (!usernameOrEmail) { errEl.textContent = 'Username or email is required'; return; }
    if (!password) { errEl.textContent = 'Password is required'; return; }
    try {
      const data = await doLogin(false, { username: usernameOrEmail, password });
      if (data.user) {
        state.user = data.user;
        try {
          await loadGroup();
          await loadUsers();
          connectSocket();
          navigateTo('/chat/jimmyqrg');
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo('/login');
        }
      } else throw new Error(data.error || 'Login failed');
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
    }
  });
}

async function doLogin(isRegister, body) {
  const url = isRegister ? '/api/auth/register' : '/api/auth/login';
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  if (data.user) state.user = data.user;
  return data;
}

function renderMain() {
  const page = getPage();
  const panels = state.group?.panels || ['free_chat', 'support', 'problem_solving', 'rules'];
  const panelLabels = { free_chat: 'Free Chat', support: 'Support', problem_solving: 'Problem Solving', rules: 'Rules' };
  const isDocPanel = state.panel === 'problem_solving' || state.panel === 'rules';
  const isGroup = !state.dmUserId;
  if (page === 'settings') return renderSettingsPage();
  if (page === 'inbox') return renderInboxPage();

  return `
    <div class="main-layout">
      <header class="header">
        <a href="/chat/jimmyqrg" class="header-logo">JimmyQrg</a>
        <div class="header-actions">
          <a href="/inbox" class="header-link header-link-inbox">Inbox${((state.inbox || []).filter(i => !i.read_at).length) ? `<span class="header-inbox-badge">${((n) => n > 99 ? '99+' : n)((state.inbox || []).filter(i => !i.read_at).length)}</span>` : ''}</a>
          <a href="/settings?tab=profile" class="header-link">Settings</a>
          ${state.user?.is_allowed ? '<button type="button" id="admin-btn" class="header-link-btn">Admin</button>' : ''}
          <button type="button" id="logout" class="header-link-btn">Logout</button>
          <a href="/settings?tab=profile" class="header-user" title="Profile">
            <img src="${state.user?.avatar_url || getDefaultAvatarUrl(state.user?.id)}" alt="" />
            <span>${escapeHtml(state.user?.display_name || state.user?.username || '')}</span>
          </a>
        </div>
      </header>

      ${isGroup ? `
        <div class="panels-tabs">
          ${panels.map(p => `
            <a href="/chat/jimmyqrg?panel=${PANEL_TO_URL[p] || p}" data-panel="${p}" class="${state.panel === p ? 'active' : ''}">${panelLabels[p] || p}</a>
          `).join('')}
        </div>
      ` : ''}

      <div class="content">
        <aside class="sidebar">
          <h3>Direct messages</h3>
          <ul>
            ${(state.users || []).filter(u => u.id !== state.user?.id).map(u => `
              <li class="${state.dmUserId === u.id ? 'active' : ''}">
                <a href="/chat/${encodeURIComponent(u.id)}">
                  <img src="${u.avatar_url || getDefaultAvatarUrl(u.id)}" alt="" />
                  <span>${escapeHtml(u.display_name || u.username)}</span>
                </a>
              </li>
            `).join('')}
          </ul>
        </aside>

        <main class="chat-area">
          ${isGroup && (state.panel === 'free_chat' || state.panel === 'support') ? renderChatArea() : ''}
          ${isGroup && isDocPanel ? renderDocArea() : ''}
          ${state.dmUserId ? renderChatArea() : ''}
          ${!isGroup && !state.dmUserId && !isDocPanel ? '<div class="empty-state">Select a panel or a user.</div>' : ''}
        </main>
      </div>
    </div>
  `;
}

function renderChatArea() {
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  const key = roomKey(roomType, state.dmUserId ? state.convId : state.panel);
  const list = state.messages[key] || [];
  const replyPreview = state.replyTo ? getReplyPreview(state.replyTo) : null;

  return `
    <div class="messages-wrap" data-room-type="${roomType}" data-room-id="${roomId}">
      ${list.length === 0 ? '<div class="messages-empty">No messages yet.</div>' : list.map(m => renderMessage(m, roomType, roomId)).join('')}
    </div>
    ${(roomType === 'group' && (state.panel === 'free_chat' || state.panel === 'support')) || roomType === 'dm' ? `
    <div class="composer" id="composer-drop-zone">
      ${replyPreview ? `
        <div class="composer-reply">
          Replying to ${escapeHtml(replyPreview.sender)}: ${escapeHtml(replyPreview.content?.slice(0, 50) || '')}…
          <button type="button" id="cancel-reply" class="cancel-reply-link">Cancel</button>
        </div>
      ` : ''}
      ${state._pendingFile ? `
        <div class="composer-pending-file" id="pending-file-indicator">
          <span>Attached: ${escapeHtml(state._pendingFile.name)}</span>
          <button type="button" id="clear-pending-file" title="Remove">×</button>
        </div>
      ` : ''}
      <div class="composer-row">
        <div class="composer-input-wrap">
          <textarea id="composer-input" placeholder="Message…" rows="1"></textarea>
          <div class="composer-actions">
            <button type="button" id="attach-file" title="Attach file">📎</button>
            <input type="file" id="file-input" class="hidden-input" accept="image/*,video/*,audio/*,*/*" />
          </div>
        </div>
        <button type="button" class="composer-send" id="send-btn">Send</button>
      </div>
    </div>
    ` : ''}
  `;
}

function getReplyPreview(msg) {
  if (!msg) return null;
  return { sender: msg.display_name || msg.username, content: msg.content };
}

function renderMessage(m, roomType, roomId) {
  const isOwn = m.sender_id === state.user?.id;
  const canRecallEdit = isOwn && m.created_at && (Date.now() - m.created_at) <= 2 * 60 * 1000;
  const isSupport = roomType === 'group' && roomId === 'support';
  const canSolve = state.user?.is_allowed && isSupport;

  if (m.deleted_by_admin) {
    return `
      <div class="message own" data-msg-id="${m.id}">
        <div class="message-body">
          <span class="message-deleted">Message deleted</span>
        </div>
      </div>
    `;
  }

  if (m.recalled_at) {
    return `
      <div class="message" data-msg-id="${m.id}">
        <div class="message-body">
          <span class="message-recalled">${escapeHtml(m.display_name || m.username)} recalled a message</span>
        </div>
      </div>
    `;
  }

  const replyBlock = m.reply_to_id ? `<div class="message-reply-preview" data-reply-to="${m.reply_to_id}">Reply to message</div>` : '';
  let content = '';
  if (m.msg_type === 'image') content = `<img src="${escapeHtml(m.content)}" alt="" />`;
  else if (m.msg_type === 'video') content = `<video src="${escapeHtml(m.content)}" controls></video>`;
  else if (m.msg_type === 'voice') content = `<audio src="${escapeHtml(m.content)}" controls></audio>`;
  else if (m.msg_type === 'file') content = `<a href="${escapeHtml(m.content)}" target="_blank" rel="noopener">File</a>`;
  else content = escapeHtml(m.content || '').replace(/\n/g, '<br>');

  const editHistory = m.edit_history?.length ? `
    <details class="edit-history">
      <summary>Edit history</summary>
      ${m.edit_history.map((v, i) => `<div class="version">${escapeHtml(String(v.content).slice(0, 200))}</div>`).join('')}
    </details>
  ` : '';

  const likeBtn = `<button type="button" class="like-btn" data-msg-id="${m.id}">❤️ ${m.likes > 0 ? m.likes : ''}</button>`;

  return `
    <div class="message ${isOwn ? 'own' : ''}" data-msg-id="${m.id}" data-sender-id="${m.sender_id}">
      <img class="message-avatar" src="${m.avatar_url || getDefaultAvatarUrl(m.sender_id)}" alt="" />
      <div class="message-body">
        <div class="message-header">
          <span class="message-sender">${escapeHtml(m.display_name || m.username)}</span>
          <span class="message-time">${formatTime(m.created_at)}</span>
        </div>
        ${replyBlock}
        <div class="message-content">${content}</div>
        ${editHistory}
        <div class="message-actions">
          ${likeBtn}
        </div>
      </div>
    </div>
  `;
}

function renderDocArea() {
  const docKey = state.panel;
  const canEdit = state.user?.is_allowed;
  const supportId = state.supportMessageIdForSolve || '';
  const content = state._docContent ?? '';
  if (canEdit) {
    return `
    <div class="doc-panel" data-doc-key="${docKey}">
      <div class="doc-toolbar">
        <button type="button" id="save-doc" class="doc-save">Save</button>
      </div>
      <div class="doc-editor">
        <textarea id="doc-content" placeholder="Loading…"></textarea>
      </div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
  }
  return `
    <div class="doc-panel" data-doc-key="${docKey}">
      <div class="doc-view doc-markdown">${markdownToHtml(content)}</div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/** Render Markdown to safe HTML (no raw HTML execution). */
function markdownToHtml(md) {
  if (md == null || md === '') return '';
  const lines = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let inBlock = false;
  let blockContent = [];
  let listItems = [];
  let listOrdered = false;

  function flushBlock() {
    if (blockContent.length) {
      const code = escapeHtml(blockContent.join('\n'));
      out.push(`<pre><code>${code}</code></pre>`);
      blockContent = [];
    }
    inBlock = false;
  }
  function flushList() {
    if (listItems.length) {
      const tag = listOrdered ? 'ol' : 'ul';
      out.push(`<${tag}><li>${listItems.join(`</li><li>`)}</li></${tag}>`);
      listItems = [];
    }
  }
  function inlineMarkdown(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('```')) {
      flushList();
      if (inBlock) {
        flushBlock();
      } else {
        inBlock = true;
      }
      continue;
    }
    if (inBlock) {
      blockContent.push(line);
      continue;
    }
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (olMatch) {
      if (listItems.length && !listOrdered) flushList();
      listOrdered = true;
      listItems.push(inlineMarkdown(olMatch[2]));
      continue;
    }
    if (ulMatch) {
      if (listItems.length && listOrdered) flushList();
      listOrdered = false;
      listItems.push(inlineMarkdown(ulMatch[1]));
      continue;
    }
    flushList();
    if (trimmed.startsWith('### ')) {
      out.push(`<h3>${inlineMarkdown(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      out.push(`<h2>${inlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      out.push(`<h1>${inlineMarkdown(trimmed.slice(2))}</h1>`);
      continue;
    }
    if (trimmed === '') {
      out.push('<p></p>');
      continue;
    }
    out.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }
  flushBlock();
  flushList();
  return out.join('\n');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function bindMain() {
  document.getElementById('logout')?.addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    state.user = null;
    state.socket?.disconnect();
    state.socket = null;
    navigateTo('/login');
  });

  document.getElementById('admin-btn')?.addEventListener('click', () => showAdminModal());

  document.getElementById('cancel-reply')?.addEventListener('click', () => setState({ replyTo: null }));

  const wrap = document.querySelector('.messages-wrap');
  const roomType = wrap?.dataset.roomType;
  const roomId = wrap?.dataset.roomId;
  if (wrap && roomType && roomId) {
    wrap.addEventListener('contextmenu', (e) => {
      const msgEl = e.target.closest('.message[data-msg-id]');
      if (!msgEl) return;
      e.preventDefault();
      const msgId = msgEl.dataset.msgId;
      const senderId = msgEl.dataset.senderId;
      const list = state.messages[roomKey(roomType, roomId)] || [];
      const msg = list.find(m => m.id === msgId);
      if (!msg) return;
      const isOwn = msg.sender_id === state.user?.id;
      const canRecallEdit = isOwn && msg.created_at && (Date.now() - msg.created_at) <= 2 * 60 * 1000;
      const isSupport = roomType === 'group' && roomId === 'support';
      const canSolve = state.user?.is_allowed && isSupport;

      const items = [];
      if (isOwn && canRecallEdit) {
        items.push({ label: 'Recall', action: 'recall' });
        items.push({ label: 'Edit', action: 'edit' });
      }
      if (state.user?.is_allowed && !isOwn) items.push({ label: 'Delete (admin)', action: 'delete', danger: true });
      if (state.user?.is_allowed) items.push({ label: 'Kick user', action: 'kick' });
      if (canSolve) items.push({ label: 'Solve', action: 'solve' });
      items.push({ label: 'Reply', action: 'reply' });

      showContextMenu(e.clientX, e.clientY, items, (action) => {
        if (action === 'recall') state.socket?.emit('message:recall', msgId, () => {});
        if (action === 'edit') promptEdit(msg);
        if (action === 'delete') state.socket?.emit('message:delete', msgId, () => {});
        if (action === 'kick') kickUser(senderId);
        if (action === 'solve') {
          state.supportMessageIdForSolve = msgId;
          navigateTo('/chat/jimmyqrg?panel=problem');
        }
        if (action === 'reply') setState({ replyTo: msg });
      });
    });
  }

  wrap?.addEventListener('click', (e) => {
    const likeBtn = e.target.closest('.like-btn');
    if (likeBtn) {
      e.preventDefault();
      const msgId = likeBtn.dataset.msgId;
      state.socket?.emit('message:like', msgId, () => {});
    }
  });

  const sendBtn = document.getElementById('send-btn');
  const input = document.getElementById('composer-input');
  if (sendBtn && input) {
    const send = () => {
      const text = input.value.trim();
      if (!text && !state._pendingFile) return;
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;
      const reply_to_id = state.replyTo?.id || null;
      if (state._pendingFile) {
        const form = new FormData();
        form.append('file', state._pendingFile);
        form.append('content', text);
        form.append('msg_type', state._pendingFile.type.startsWith('image/') ? 'image' : state._pendingFile.type.startsWith('video/') ? 'video' : state._pendingFile.type.startsWith('audio/') ? 'voice' : 'file');
        if (reply_to_id) form.append('reply_to_id', reply_to_id);
        const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
        fetch(path, { method: 'POST', credentials: 'include', body: form }).then(() => {
          state._pendingFile = null;
          setState({ replyTo: null });
          input.value = '';
          if (roomType === 'dm') loadMessages('dm', roomId).then(render);
        }).catch(console.error);
        return;
      }
      state.socket?.emit('message:send', { roomType, roomId, content: text, reply_to_id }, () => {
        setState({ replyTo: null });
        input.value = '';
      });
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }

  document.getElementById('attach-file')?.addEventListener('click', () => document.getElementById('file-input')?.click());
  document.getElementById('file-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      state._pendingFile = file;
      render();
    }
    e.target.value = '';
  });
  document.getElementById('clear-pending-file')?.addEventListener('click', () => {
    state._pendingFile = null;
    render();
  });

  const dropZone = document.getElementById('composer-drop-zone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) dropZone.classList.add('composer-drag-over');
      });
    });
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('composer-drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('composer-drag-over');
      const file = e.dataTransfer.files?.[0];
      if (file) {
        state._pendingFile = file;
        render();
      }
    });
  }

  const saveDocBtn = document.getElementById('save-doc');
  const docContent = document.getElementById('doc-content');
  const docSupportId = document.getElementById('doc-support-msg-id');
  if (saveDocBtn && docContent) {
    saveDocBtn.addEventListener('click', async () => {
      const docKey = document.querySelector('.doc-panel')?.dataset.docKey;
      if (!docKey) return;
      const content = docContent.value;
      const support_message_id = docSupportId?.value || null;
      try {
        await saveDoc(docKey, content, support_message_id || undefined);
        state.supportMessageIdForSolve = null;
        setState({});
      } catch (e) {
        alert(e.message);
      }
    });
  }

  if (state._docContent !== undefined && docContent && !docContent.value) docContent.value = state._docContent;
}

function showContextMenu(x, y, items, onSelect) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  items.forEach(({ label, action, danger }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (danger) btn.classList.add('danger');
    btn.addEventListener('click', () => { onSelect(action); menu.remove(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function promptEdit(msg) {
  const newContent = prompt('Edit message:', msg.content);
  if (newContent === null) return;
  state.socket?.emit('message:edit', { id: msg.id, content: newContent }, () => {});
}

function kickUser(userId) {
  fetch('/api/admin/kick', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  }).then(r => r.json()).then(() => {}).catch(console.error);
}

function showAdminModal() {
  const users = (state.users || []).filter(u => u.id !== state.user?.id);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 480px;">
      <h3>Admin</h3>
      <div class="admin-panel">
        <h4>Users</h4>
        <ul id="admin-user-list">
          ${users.map(u => `
            <li>
              <span>${escapeHtml(u.display_name || u.username)} ${u.id === 'jimmyqrg' ? '(admin)' : ''}</span>
              <span>
                ${u.id !== 'jimmyqrg' ? `
                  <button type="button" data-action="kick" data-user-id="${u.id}">Kick</button>
                  <button type="button" data-action="allowed" data-user-id="${u.id}" data-allowed="${u.is_allowed ? '1' : '0'}">${u.is_allowed ? 'Revoke' : 'Grant'} allowed</button>
                ` : ''}
              </span>
            </li>
          `).join('')}
        </ul>
      </div>
      <div class="admin-panel" style="margin-top: 1rem;">
        <h4>Send to inbox</h4>
        <select id="admin-inbox-user">
          <option value="">Select user</option>
          ${users.map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
        </select>
        <input type="text" id="admin-inbox-title" placeholder="Title" style="width:100%; margin-top:0.5rem;" />
        <textarea id="admin-inbox-body" placeholder="Body" style="width:100%; margin-top:0.5rem; min-height: 60px;"></textarea>
        <button type="button" id="admin-inbox-send" class="admin-send">Send</button>
      </div>
      <div class="admin-panel" style="margin-top: 1rem;">
        <h4>Broadcast to all</h4>
        <input type="text" id="admin-broadcast-title" placeholder="Title" style="width:100%; margin-top:0.5rem;" />
        <textarea id="admin-broadcast-body" placeholder="Body" style="width:100%; margin-top:0.5rem; min-height: 60px;"></textarea>
        <button type="button" id="admin-broadcast-send" class="admin-send">Broadcast</button>
      </div>
      <div class="modal-actions">
        <button type="button" id="admin-close" class="modal-close">Close</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('admin-close')?.addEventListener('click', () => overlay.remove());
  document.getElementById('admin-user-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const userId = btn.dataset.userId;
    if (btn.dataset.action === 'kick') kickUser(userId);
    if (btn.dataset.action === 'allowed') {
      const allowed = btn.dataset.allowed !== '1';
      try {
        await apiPost('/api/admin/users/' + userId + '/allowed', { allowed });
        await loadUsers();
        overlay.remove();
        showAdminModal();
      } catch (err) { alert(err.message); }
    }
  });
  document.getElementById('admin-inbox-send')?.addEventListener('click', async () => {
    const to = document.getElementById('admin-inbox-user').value;
    const title = document.getElementById('admin-inbox-title').value;
    const body = document.getElementById('admin-inbox-body').value;
    if (!to) return;
    try {
      await apiPost('/api/inbox/send', { to_user_id: to, title, body });
      overlay.remove();
    } catch (e) { alert(e.message); }
  });
  document.getElementById('admin-broadcast-send')?.addEventListener('click', async () => {
    const title = document.getElementById('admin-broadcast-title').value;
    const body = document.getElementById('admin-broadcast-body').value;
    try {
      await apiPost('/api/inbox/broadcast', { title, body });
      overlay.remove();
    } catch (e) { alert(e.message); }
  });
  document.body.appendChild(overlay);
}

function renderSettingsPage() {
  const tab = new URLSearchParams(window.location.search || '').get('tab') || 'profile';
  return `
    <div class="main-layout">
      <header class="header">
        <a href="/chat/jimmyqrg" class="header-logo">JimmyQrg</a>
        <div class="header-actions">
          <a href="/inbox" class="header-link header-link-inbox">Inbox${((state.inbox || []).filter(i => !i.read_at).length) ? `<span class="header-inbox-badge">${((n) => n > 99 ? '99+' : n)((state.inbox || []).filter(i => !i.read_at).length)}</span>` : ''}</a>
          <a href="/chat/jimmyqrg" class="header-link">Chat</a>
          <button type="button" id="logout" class="header-link-btn">Logout</button>
          <a href="/settings?tab=profile" class="header-user" title="Profile">
            <img src="${state.user?.avatar_url || getDefaultAvatarUrl(state.user?.id)}" alt="" />
            <span>${escapeHtml(state.user?.display_name || state.user?.username || '')}</span>
          </a>
        </div>
      </header>
      <div class="content" style="justify-content:center">
        <div class="settings-page">
          <h2>Settings</h2>
          <div class="settings-tabs">
            <a href="/settings?tab=profile" class="tab-link ${tab === 'profile' ? 'active' : ''}">Profile</a>
          </div>
          <form id="profile-form" class="settings-form">
            <label>Avatar</label>
            <img src="${state.user?.avatar_url || getDefaultAvatarUrl(state.user?.id)}" alt="" class="avatar-preview" id="avatar-preview" />
            <label class="file-label">
              <span class="file-label-text">Choose image</span>
              <input type="file" name="avatar" accept="image/*" class="file-input" />
            </label>
            <label>Display name</label>
            <input type="text" name="display_name" value="${escapeHtml(state.user?.display_name || '')}" />
            <button type="submit">Save</button>
          </form>
          <h3 class="settings-section-title">Change password</h3>
          <form id="password-form" class="settings-form">
            <label>Current password</label>
            <input type="password" name="current_password" autocomplete="current-password" placeholder="Current password" />
            <label>New password</label>
            <input type="password" name="new_password" autocomplete="new-password" placeholder="At least 6 characters" />
            <label>Confirm new password</label>
            <input type="password" name="new_password_confirm" autocomplete="new-password" placeholder="Confirm new password" />
            <p id="password-form-message" class="settings-form-message" aria-live="polite"></p>
            <button type="submit">Change password</button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderInboxPage() {
  return `
    <div class="main-layout">
      <header class="header">
        <a href="/chat/jimmyqrg" class="header-logo">JimmyQrg</a>
        <div class="header-actions">
          <a href="/settings?tab=profile" class="header-link">Settings</a>
          <a href="/chat/jimmyqrg" class="header-link">Chat</a>
          <button type="button" id="logout" class="header-link-btn">Logout</button>
          <a href="/settings?tab=profile" class="header-user" title="Profile">
            <img src="${state.user?.avatar_url || getDefaultAvatarUrl(state.user?.id)}" alt="" />
            <span>${escapeHtml(state.user?.display_name || state.user?.username || '')}</span>
          </a>
        </div>
      </header>
      <div class="content" style="justify-content:center">
        <div class="inbox-page">
          <h2>Inbox</h2>
          <div id="inbox-list">
            ${(state.inbox || []).length === 0
              ? '<div class="inbox-empty">No mail yet.</div>'
              : (state.inbox || []).map(item => `
              <div class="inbox-item ${item.read_at ? '' : 'unread'}" data-id="${item.id}" data-related="${escapeHtml(item.related_id || '')}" data-extra="${escapeHtml(item.related_extra || '')}">
                <div class="type">${escapeHtml(item.type)}</div>
                <div class="title">${escapeHtml(item.title || '')}</div>
                <div class="body">${escapeHtml(item.body || '')}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function applyRoute(route) {
  if (!state.user && (route.page === 'login' || route.page === 'signup')) {
    render();
    return;
  }
  if (route.page === 'settings') {
    setState({ panel: '', dmUserId: null });
    render();
    bindSettings();
    return;
  }
  if (route.page === 'inbox') {
    setState({ panel: '', dmUserId: null });
    loadInbox().then(() => { render(); bindInbox(); });
    return;
  }
  if (route.page === 'chat') {
    state.panel = route.panel || 'free_chat';
    state.dmUserId = route.dmUserId || null;
    state.convId = null;
    if (route.dmUserId) {
      apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
        state.convId = conversation_id;
        loadMessages('dm', conversation_id).then(() => {
          state.socket?.emit('dm:join', conversation_id, () => {});
          render();
          bindMain();
        });
      }).catch(() => { render(); bindMain(); });
      return;
    }
    state.convId = null;
    if (state.panel === 'free_chat' || state.panel === 'support') {
      loadMessages('group', state.panel).then(() => { render(); bindMain(); });
    } else if (state.panel === 'problem_solving' || state.panel === 'rules') {
      loadDoc(state.panel).then(({ doc }) => {
        state._docContent = doc?.content ?? '';
        render();
        bindMain();
        const ta = document.getElementById('doc-content');
        if (ta) ta.value = state._docContent ?? '';
      });
    } else {
      render();
      bindMain();
    }
  }
}

async function init() {
  window.addEventListener('popstate', () => applyRoute(parseRoute()));

  const user = await loadMe();
  const route = parseRoute();

  if (!user) {
    if (route.page !== 'login' && route.page !== 'signup') {
      navigateTo('/login');
      return;
    }
    render();
    return;
  }

  await loadGroup();
  await loadUsers();
  await loadInbox();
  connectSocket();

  const path = getPath();
  if (path === '/' || path === '') {
    navigateTo('/chat/jimmyqrg');
    return;
  }
  applyRoute(route);
}

function bindSettings() {
  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        credentials: 'include',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.user = data.user;
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = data.user?.avatar_url || getDefaultAvatarUrl(data.user?.id);
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const msgEl = document.getElementById('password-form-message');
    const current = form.current_password?.value?.trim() || '';
    const newPass = form.new_password?.value?.trim() || '';
    const confirm = form.new_password_confirm?.value?.trim() || '';
    if (!current || !newPass) {
      if (msgEl) { msgEl.textContent = 'Please fill in current and new password.'; msgEl.dataset.type = 'error'; }
      return;
    }
    if (newPass.length < 6) {
      if (msgEl) { msgEl.textContent = 'New password must be at least 6 characters.'; msgEl.dataset.type = 'error'; }
      return;
    }
    if (newPass !== confirm) {
      if (msgEl) { msgEl.textContent = 'New password and confirmation do not match.'; msgEl.dataset.type = 'error'; }
      return;
    }
    if (msgEl) msgEl.textContent = '';
    try {
      await apiPatch('/api/users/password', { current_password: current, new_password: newPass });
      if (msgEl) { msgEl.textContent = 'Password changed.'; msgEl.dataset.type = 'success'; }
      form.reset();
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message || 'Failed to change password.'; msgEl.dataset.type = 'error'; }
    }
  });
}

function bindInbox() {
  document.getElementById('inbox-list')?.addEventListener('click', async (e) => {
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    const id = item.dataset.id;
    const relatedId = item.dataset.related;
    const extraStr = item.dataset.extra;
    await fetch(`/api/inbox/${id}/read`, { method: 'POST', credentials: 'include' });
    await loadInbox();
    render();
    bindInbox();
    try {
      const extra = extraStr ? JSON.parse(extraStr) : {};
      if (extra.panel === 'problem_solving') navigateTo('/chat/jimmyqrg?panel=problem');
    } catch (_) {}
  });
}

init();
