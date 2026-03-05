import { apiGet, apiPost, apiPatch, apiPut, apiDelete, uploadFile, getDefaultAvatarUrl } from './api.js';

if (typeof window !== 'undefined' && window.katex) {
  window.renderKatex = function (latex, displayMode) {
    return window.katex.renderToString(latex, { throwOnError: false, displayMode: !!displayMode });
  };
}

function applyTheme(theme) {
  const t = theme || state.theme || 'jimmyqrg';
  document.documentElement.setAttribute('data-theme', t);
}

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
  friend_ids: [],
  supportMessageIdForSolve: null,
  leftBarExpanded: typeof localStorage !== 'undefined' && localStorage.getItem('leftBarExpanded') === '1',
  panelSearchOpen: false,
  profileUserId: null,
  editingDocKey: null,
  editingMessageId: null,
  messageVersionIndex: {},
  panelColumnExpanded: false,
  lastSeenByRoom: {},
  convByUserId: {},
  convIdToUserId: {},
  lastMessageAtByUserId: {},
  language: typeof localStorage !== 'undefined' ? (localStorage.getItem('language') || 'en') : 'en',
  theme: typeof localStorage !== 'undefined' ? (localStorage.getItem('theme') || 'jimmyqrg') : 'jimmyqrg',
  _recording: false,
  _recordingStream: null,
  _recordingRecorder: null,
  _recordingChunks: [],
  commandMode: typeof localStorage !== 'undefined' && localStorage.getItem('commandMode') === '1',
};
applyTheme();
if (typeof document !== 'undefined' && document.documentElement) document.documentElement.setAttribute('lang', state.language || 'en');

/** Map our language code to Google Translate code (zh -> zh-CN). */
function toGoogleTranslateCode(lang) {
  if (lang === 'zh') return 'zh-CN';
  return lang || 'en';
}

/** Trigger Google Translate to the given language. Call after render when language !== 'en'. */
function applyGoogleTranslate() {
  const lang = state.language || 'en';
  if (lang === 'en') return;
  const code = toGoogleTranslateCode(lang);
  const sel = document.querySelector('.goog-te-combo');
  if (sel && sel.value !== code) {
    sel.value = code;
    sel.dispatchEvent(new Event('change'));
  }
}

const GROUP_ID = 'JimmyQrg';

// URL panel param <-> internal panel
const PANEL_TO_URL = { free_chat: 'chat', support: 'support', problem_solving: 'problem', rules: 'rules', announcements: 'announcements' };
const URL_TO_PANEL = { chat: 'free_chat', support: 'support', problem: 'problem_solving', rules: 'rules', announcements: 'announcements' };

function roomKey(roomType, roomId) {
  return `${roomType}:${roomId}`;
}

function currentRoomKey() {
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  return roomId ? roomKey(roomType, roomId) : null;
}

function getNewCount(roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list || !list.length) return 0;
  const seen = state.lastSeenByRoom[key] || 0;
  return list.filter(m => (m.created_at || 0) > seen).length;
}

/** Group chat: show red dot only (no amount). */
function hasNewGroupMessages() {
  const panels = state.group?.panels || [];
  return panels.some(p => (p === 'free_chat' || p === 'support') && getNewCount('group', p) > 0);
}

/** Private chat: show total new count on Chat icon and per-user in list. */
function getTotalNewDmCount() {
  let total = 0;
  for (const key of Object.keys(state.messages || {})) {
    if (key.startsWith('dm:')) total += getNewCount('dm', key.slice(4));
  }
  return total;
}

function getUnreadInboxCount() {
  return (state.inbox || []).filter(i => !i.read_at).length;
}

function getPath() {
  return window.location.pathname.replace(/\/$/, '') || '/';
}

function interceptLinks(container) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const messageAvatarWrap = e.target.closest('.message-avatar-wrap');
    if (messageAvatarWrap) {
      const id = messageAvatarWrap.dataset.senderId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else showProfileModal(id);
      }
      return;
    }
    const panelAvatarWrap = e.target.closest('.panel-user-avatar-wrap');
    if (panelAvatarWrap) {
      const id = panelAvatarWrap.dataset.userId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else showProfileModal(id);
      }
      return;
    }
    const a = e.target.closest('a[href^="/"]');
    if (!a || a.hasAttribute('target') || a.getAttribute('href').startsWith('/api')) return;
    e.preventDefault();
    navigateTo(a.getAttribute('href'));
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const messageAvatarWrap = e.target.closest('.message-avatar-wrap');
    if (messageAvatarWrap) {
      const id = messageAvatarWrap.dataset.senderId;
      if (id) {
        e.preventDefault();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else showProfileModal(id);
      }
      return;
    }
    const panelAvatarWrap = e.target.closest('.panel-user-avatar-wrap');
    if (panelAvatarWrap) {
      const id = panelAvatarWrap.dataset.userId;
      if (id) {
        e.preventDefault();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else showProfileModal(id);
      }
    }
  });
}

function parseRoute() {
  const path = getPath();
  const params = new URLSearchParams(window.location.search || '');
  const redirect = params.get('redirect') || null;
  if (path === '/login') return { page: 'login', redirect };
  if (path === '/signup') return { page: 'signup', redirect };
  if (path === '/settings') return { page: 'settings', tab: params.get('tab') || 'profile' };
  if (path === '/inbox') return { page: 'inbox' };
  if (path === '/manage' || path === '/manage/') return { page: 'admin', adminTab: params.get('tab') || 'action' };
  if (path === '/chat') return { page: 'chat', section: 'dms' }; // DM user list, no conversation selected
  const chatMatch = path.match(/^\/chat\/([^/]+)$/);
  if (chatMatch) {
    const id = chatMatch[1];
    if (id.toLowerCase() === 'group') {
      const panelParam = params.get('panel') || 'chat';
      const panel = URL_TO_PANEL[panelParam] || 'free_chat';
      return { page: 'chat', group: true, panel };
    }
    return { page: 'chat', dmUserId: id };
  }
  return { page: 'chat', group: true, panel: 'free_chat' };
}

/** Primary nav for app shell: home (group), chat (DMs), inbox, admin, settings */
function getPrimaryNav(route) {
  if (route.page === 'admin') return 'admin';
  if (route.page === 'settings') return 'settings';
  if (route.page === 'inbox') return 'inbox';
  if (route.page === 'chat') return route.group ? 'home' : 'chat';
  return 'home';
}

function getPage() {
  const route = parseRoute();
  return route.page;
}

/** Build auth path with optional redirect param. Use when navigating to login/signup. */
function authPath(page, redirectPath) {
  const base = page === 'signup' ? '/signup' : '/login';
  if (!redirectPath) return base;
  const enc = encodeURIComponent(redirectPath.startsWith('/') ? redirectPath : '/' + redirectPath);
  return `${base}?redirect=${enc}`;
}

/** Get redirect target from current URL, or default path. */
function getRedirectOrDefault(defaultPath = '/chat/group') {
  const params = new URLSearchParams(window.location.search || '');
  const r = params.get('redirect');
  return (r && r.startsWith('/')) ? r : defaultPath;
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
  const list = state.messages[key];
  if (currentRoomKey() === key && list.length) {
    const maxAt = Math.max(...list.map(m => m.created_at || 0));
    state.lastSeenByRoom[key] = Math.max(state.lastSeenByRoom[key] || 0, maxAt);
  }
  return list;
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

/** Load conversation list so DM list order (last chat time > new count > alpha) and per-user badges work. */
export async function loadConversations() {
  const { conversations } = await apiGet('/api/conversations').catch(() => ({ conversations: [] }));
  state.lastMessageAtByUserId = {};
  (conversations || []).forEach((c) => {
    state.convByUserId[c.other_user_id] = c.conversation_id;
    state.convIdToUserId[c.conversation_id] = c.other_user_id;
    if (c.last_message_at != null) state.lastMessageAtByUserId[c.other_user_id] = c.last_message_at;
  });
  return conversations || [];
}

export async function loadFriends() {
  try {
    const { friend_ids } = await apiGet('/api/friends');
    state.friend_ids = friend_ids || [];
    return state.friend_ids;
  } catch {
    state.friend_ids = [];
    return [];
  }
}

function isFriend(userId) {
  return state.friend_ids && state.friend_ids.includes(userId);
}

export function addMessageLocal(msg) {
  const key = roomKey(msg.room_type, msg.room_id);
  if (!state.messages[key]) state.messages[key] = [];
  if (state.messages[key].some(m => m.id === msg.id)) return;
  state.messages[key].push(msg);
  if (currentRoomKey() === key) {
    state.lastSeenByRoom[key] = Math.max(state.lastSeenByRoom[key] || 0, msg.created_at || 0);
  }
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

/** Remove a message from the list entirely (admin delete – no trace). */
export function removeMessageLocal(id, roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return;
  list.splice(i, 1);
  render();
}

/** Find a message by id in state.messages (group messages live under group:free_chat / group:support, not group:JimmyQrg). */
function findMessageInState(msgId) {
  if (!msgId) return null;
  for (const key of Object.keys(state.messages || {})) {
    const m = state.messages[key].find(x => x.id === msgId);
    if (m) return m;
  }
  return null;
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
    const m = findMessageInState(id);
    if (m) removeMessageContent(id, m.room_type, m.room_id);
  });
  s.on('message:edited', ({ id, content, edit_history, updated_at }) => {
    const m = findMessageInState(id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { content, edit_history, updated_at });
  });
  s.on('message:liked', ({ id, likes }) => {
    const m = findMessageInState(id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { likes });
  });
  s.on('message:deleted', ({ id }) => {
    const m = findMessageInState(id);
    if (m) removeMessageLocal(id, m.room_type, m.room_id);
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
    const redirect = route.redirect || null;
    const authError = state.authError || '';
    state.authError = null;
    const isAuthSwitch = state.authPrevSignup != null && state.authPrevSignup !== isSignup && app.querySelector('.auth-screen');
    if (isAuthSwitch) {
      authTransition(app, state.authPrevSignup, isSignup, authError, redirect);
    } else {
      app.innerHTML = renderAuth(isSignup, authError, redirect);
      bindAuth(isSignup);
    }
    state.authPrevSignup = isSignup;
    return;
  }

  document.body.classList.remove('auth-page');
  app.innerHTML = renderMain();
  bindMain();
  if (route.page === 'settings') bindSettings();
  if ((state.language || 'en') !== 'en') setTimeout(applyGoogleTranslate, 200);
}

function renderAuth(isSignup = false, initialError = '', redirect = null) {
  const switchHref = authPath(isSignup ? 'login' : 'signup', redirect);
  return `
    <div class="auth-screen auth-ani-1">
      <div class="auth-box auth-ani-2">
        <h1 class="auth-ani-3">JimmyQrg Chat</h1>
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
          <p class="auth-switch auth-ani-26">
            ${isSignup ? 'Already have an account? ' : "Don't have an account? "}
            <a href="${switchHref}" class="auth-switch-link">${isSignup ? 'Log in' : 'Sign up'}</a>
          </p>
        </form>
      </div>
    </div>
  `;
}

function authTransition(container, fromSignup, toSignup, authError, redirect) {
  const box = container.querySelector('.auth-box');
  const form = container.querySelector('#auth-form');
  if (!box || !form) return;
  const formContent = form;
  const beforeHeight = box.offsetHeight;

  formContent.classList.add('auth-content-vanish');
  formContent.offsetHeight;

  formContent.addEventListener('transitionend', function onVanish(e) {
    if (e.target !== formContent || e.propertyName !== 'opacity') return;
    formContent.removeEventListener('transitionend', onVanish);

    const errEl = form.querySelector('#auth-error');
    const fieldsLogin = form.querySelector('#auth-fields-login');
    const fieldsRegister = form.querySelector('#auth-fields-register');
    const submitBtn = form.querySelector('#auth-submit');
    const switchP = form.querySelector('.auth-switch');

    if (errEl) errEl.textContent = authError || '';
    if (fieldsLogin) fieldsLogin.style.display = toSignup ? 'none' : 'block';
    if (fieldsRegister) fieldsRegister.style.display = toSignup ? 'block' : 'none';
    if (submitBtn) submitBtn.textContent = toSignup ? 'Sign up' : 'Login';
    if (switchP) {
      switchP.innerHTML = toSignup ? 'Already have an account? ' : "Don't have an account? ";
      const link = document.createElement('a');
      link.href = authPath(toSignup ? 'login' : 'signup', redirect);
      link.className = 'auth-switch-link';
      link.textContent = toSignup ? 'Log in' : 'Sign up';
      switchP.appendChild(link);
    }

    const afterHeight = box.offsetHeight;
    if (beforeHeight !== afterHeight) {
      box.style.height = beforeHeight + 'px';
      box.style.overflow = 'hidden';
      box.style.transition = 'height 0.25s ease';
      box.offsetHeight;
      box.style.height = afterHeight + 'px';
      box.addEventListener('transitionend', function onResize(e) {
        if (e.target !== box || e.propertyName !== 'height') return;
        box.removeEventListener('transitionend', onResize);
        box.style.height = '';
        box.style.overflow = '';
        box.style.transition = '';
        formContent.classList.remove('auth-content-vanish');
        formContent.classList.add('auth-content-appear');
        formContent.offsetHeight;
        formContent.addEventListener('transitionend', function onAppear(ev) {
          if (ev.target !== formContent || ev.propertyName !== 'opacity') return;
          formContent.removeEventListener('transitionend', onAppear);
          formContent.classList.remove('auth-content-appear');
        });
      });
    } else {
      formContent.classList.remove('auth-content-vanish');
      formContent.classList.add('auth-content-appear');
      formContent.offsetHeight;
      formContent.addEventListener('transitionend', function onAppear(ev) {
        if (ev.target !== formContent || ev.propertyName !== 'opacity') return;
        formContent.removeEventListener('transitionend', onAppear);
        formContent.classList.remove('auth-content-appear');
      });
    }
  });

  bindAuth(toSignup);
}

function bindAuth(isSignup) {
  const isRegister = !!isSignup;
  document.querySelectorAll('.auth-box .auth-switch-link').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigateTo(link.getAttribute('href')); });
  });
  const form = document.getElementById('auth-form');
  if (!form) return;
  form.onsubmit = async (e) => {
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
            await loadFriends();
            connectSocket();
          navigateTo(getRedirectOrDefault());
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo(authPath('login', getPath()));
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
          await loadFriends();
          connectSocket();
          navigateTo(getRedirectOrDefault());
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo(authPath('login', getPath()));
        }
      } else throw new Error(data.error || 'Login failed');
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
    }
  };
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
  const route = parseRoute();
  const page = route.page;
  const primaryNav = getPrimaryNav(route);
  const panels = state.group?.panels || ['announcements', 'free_chat', 'support', 'problem_solving', 'rules'];
  const panelLabels = { free_chat: 'Free Chat', support: 'Support', problem_solving: 'Problem Solving', rules: 'Rules', announcements: 'Announcements' };
  const isDocPanel = state.panel === 'problem_solving' || state.panel === 'rules' || state.panel === 'announcements';
  const isGroup = !!route.group;
  const expanded = state.leftBarExpanded;

  const panelExpanded = state.panelColumnExpanded;
  return `
    <div class="app-shell">
      <div class="app-shell-inner">
      <div class="panel-column ${panelExpanded ? 'panel-column-expanded' : ''}" id="panel-column">
        <button type="button" class="panel-column-toggle" id="panel-column-toggle" title="${panelExpanded ? 'Close panels' : 'Open panels'}" aria-label="${panelExpanded ? 'Close panels' : 'Open panels'}">
          <span class="left-bar-icon" aria-hidden="true">${panelExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}</span>
        </button>
        <div class="panel-column-overlay" id="panel-column-overlay" aria-hidden="true"></div>
        <div class="panel-column-content">
        ${primaryNav === 'home' ? `
        <div class="panel-list">
          <h3 class="panel-list-title">JimmyQrg</h3>
          <ul class="panel-list-ul">
            ${panels.map(p => {
              const isChat = p === 'free_chat' || p === 'support';
              const hasNew = isChat && getNewCount('group', p) > 0;
              return `<li><a href="/chat/group?panel=${PANEL_TO_URL[p] || p}" class="panel-list-link ${state.panel === p ? 'active' : ''}"># ${escapeHtml(panelLabels[p] || p)}${hasNew ? '<span class="panel-list-badge panel-list-badge-dot" aria-label="New"></span>' : ''}</a></li>`;
            }).join('')}
          </ul>
        </div>
        ` : ''}
        ${primaryNav === 'chat' ? `
        <div class="panel-list panel-list-users">
          <div class="panel-list-header">
            <h3 class="panel-list-title">Chat</h3>
            <button type="button" class="panel-search-btn" id="panel-search-btn" title="Search users">${ICON_SEARCH}</button>
          </div>
          <div class="panel-search-bar ${state.panelSearchOpen ? 'open' : ''}" id="panel-search-bar">
            <input type="search" id="panel-user-search" placeholder="Search users…" />
          </div>
          <ul class="panel-list-ul" id="panel-user-list">
            ${(function() {
              const users = (state.users || []).filter(u => u.id !== state.user?.id);
              const convId = (uid) => state.convByUserId[uid];
              const lastMessageAt = (uid) => { const fromApi = state.lastMessageAtByUserId?.[uid]; if (fromApi != null) return fromApi; const c = convId(uid); if (!c) return 0; const list = state.messages['dm:' + c]; return list?.length ? Math.max(...list.map(m => m.created_at || 0)) : 0; };
              const newCount = (uid) => { const c = convId(uid); return c ? getNewCount('dm', c) : 0; };
              const name = (u) => (u.display_name || u.username || '').toLowerCase();
              /* Private chat list order: last chat time (recent first) > new message count (high first) > alphabetical */
              users.sort((a, b) => {
                const at = lastMessageAt(a.id), bt = lastMessageAt(b.id);
                if (bt !== at) return bt - at;
                const an = newCount(a.id), bn = newCount(b.id);
                if (bn !== an) return bn - an;
                return name(a).localeCompare(name(b));
              });
              return users.map(u => {
                const friend = isFriend(u.id);
                const defAv = getDefaultAvatarUrl(u.id);
                const avSrc = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAv;
                const n = newCount(u.id);
                const badge = n > 0 ? `<span class="panel-list-badge panel-list-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : '';
                return `
              <li><a href="${friend ? `/chat/${encodeURIComponent(u.id)}` : '#'}" class="panel-list-link ${state.dmUserId === u.id ? 'active' : ''}" data-user-id="${escapeHtml(u.id)}" data-username="${escapeHtml((u.username || '').toLowerCase())}" data-display="${escapeHtml(name(u))}" data-friend="${friend ? '1' : '0'}">
                <span class="panel-user-avatar-wrap" data-user-id="${escapeHtml(u.id)}" title="View profile"><img src="${avSrc}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="panel-user-avatar" /></span>
                <span class="panel-list-link-text">${escapeHtml(u.display_name || u.username)}</span>${badge}
              </a></li>
            `; }).join('');
            })()}
          </ul>
        </div>
        ` : ''}
        ${primaryNav === 'admin' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">Admin</h3>
          <a href="/manage?tab=action" class="panel-tab ${(route.adminTab || 'action') === 'action' ? 'active' : ''}">Action</a>
          <a href="/manage?tab=users" class="panel-tab ${route.adminTab === 'users' ? 'active' : ''}">Users</a>
          <a href="/manage?tab=recalled" class="panel-tab ${route.adminTab === 'recalled' ? 'active' : ''}">Recalled</a>
          <a href="/manage?tab=timeout" class="panel-tab ${route.adminTab === 'timeout' ? 'active' : ''}">Time out</a>
        </div>
        ` : ''}
        ${primaryNav === 'settings' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">Settings</h3>
          <a href="/settings?tab=general" class="panel-tab ${route.tab === 'general' ? 'active' : ''}">General</a>
          <a href="/settings?tab=profile" class="panel-tab ${(route.tab || 'profile') === 'profile' ? 'active' : ''}">Profile</a>
          <a href="/settings?tab=account" class="panel-tab ${route.tab === 'account' ? 'active' : ''}">Account</a>
        </div>
        ` : ''}
        ${primaryNav === 'inbox' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">Inbox</h3>
        </div>
        ` : ''}
        </div>
      </div>

      <div class="main-content">
        <div class="main-content-body">
          ${primaryNav === 'home' ? (isGroup && (state.panel === 'free_chat' || state.panel === 'support') ? renderChatArea() : isGroup && isDocPanel ? renderDocArea() : '<div class="empty-state">Select a panel.</div>') : ''}
          ${primaryNav === 'chat' ? (state.dmUserId ? renderChatArea() : '<div class="empty-state">Select a conversation.</div>') : ''}
          ${primaryNav === 'inbox' ? renderInboxContent() : ''}
          ${primaryNav === 'admin' ? renderAdminContent() : ''}
          ${primaryNav === 'settings' ? renderSettingsContent() : ''}
        </div>
      </div>
      </div>

      <aside class="left-bar ${expanded ? 'left-bar-expanded' : ''}" id="left-bar">
        <div class="left-bar-avatar">
          <a href="/settings?tab=profile" class="left-bar-avatar-link" title="Profile">
            <img src="${(state.user?.avatar_url && String(state.user.avatar_url).trim()) ? state.user.avatar_url : getDefaultAvatarUrl(state.user?.id)}" data-fallback="${getDefaultAvatarUrl(state.user?.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
          </a>
        </div>
        <nav class="left-bar-nav" aria-label="Main">
          <a href="/chat/group" class="left-bar-item ${primaryNav === 'home' ? 'active' : ''}" title="Home (JimmyQrg group chat)">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_HOME}</span>${hasNewGroupMessages() ? '<span class="left-bar-badge left-bar-badge-dot" aria-label="New messages"></span>' : ''}</span>
            <span class="left-bar-label">Home</span>
          </a>
          <a href="/chat" class="left-bar-item ${primaryNav === 'chat' ? 'active' : ''}" title="Chat (private messages)">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_CHAT}</span>${(function(){ const n = getTotalNewDmCount(); return n > 0 ? `<span class="left-bar-badge left-bar-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : ''; })()}</span>
            <span class="left-bar-label">Chat</span>
          </a>
          <a href="/inbox" class="left-bar-item ${primaryNav === 'inbox' ? 'active' : ''}" title="Inbox">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_INBOX}</span>${(function(){ const n = getUnreadInboxCount(); return n > 0 ? `<span class="left-bar-badge left-bar-badge-count" aria-label="${n} unread">${n > 99 ? '99+' : n}</span>` : ''; })()}</span>
            <span class="left-bar-label">Inbox</span>
          </a>
          ${state.user?.is_allowed ? `
          <a href="/manage" class="left-bar-item ${primaryNav === 'admin' ? 'active' : ''}" title="Admin">
            <span class="left-bar-icon" aria-hidden="true">${ICON_ADMIN}</span>
            <span class="left-bar-label">Admin</span>
          </a>
          ` : ''}
          <a href="/settings?tab=profile" class="left-bar-item ${primaryNav === 'settings' ? 'active' : ''}" title="Settings">
            <span class="left-bar-icon" aria-hidden="true">${ICON_SETTINGS}</span>
            <span class="left-bar-label">Settings</span>
          </a>
        </nav>
        <div class="left-bar-bottom">
          <button type="button" class="left-bar-expand" id="left-bar-expand" title="${expanded ? 'Collapse' : 'Expand'}">
            <span class="left-bar-icon" aria-hidden="true">${expanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}</span>
            <span class="left-bar-label">${expanded ? 'Collapse' : 'Expand'}</span>
          </button>
        </div>
      </aside>
      ${state._recording ? `
      <div id="recording-overlay" class="recording-overlay">
        <div class="recording-overlay-backdrop"></div>
        <div class="recording-overlay-content">
          <p class="recording-overlay-title">Recording</p>
          <div class="recording-overlay-actions">
            <button type="button" id="recording-cancel" class="btn-secondary">Cancel</button>
            <button type="button" id="recording-send" class="btn-primary">Send</button>
          </div>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

const ICON_HOME = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
const ICON_CHAT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_INBOX = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const ICON_ADMIN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const ICON_SETTINGS = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-1.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h1.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v1.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-1.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_CHEVRON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_CHEVRON_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_SEARCH = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_MIC = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const ICON_COMMAND = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6 9 12 15 18"/><path d="M9 6h6"/></svg>';

function renderChatArea() {
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  const key = roomKey(roomType, state.dmUserId ? state.convId : state.panel);
  const list = state.messages[key] || [];
  const replyPreview = state.replyTo ? getReplyPreview(state.replyTo) : null;

  return `
    <div class="messages-wrap" data-room-type="${roomType}" data-room-id="${roomId}">
      ${list.length === 0 ? '<div class="messages-empty">No messages yet.</div>' : renderMessagesWithTimestamps(list, roomType, roomId)}
    </div>
    ${(roomType === 'group' && (state.panel === 'free_chat' || state.panel === 'support')) || roomType === 'dm' ? `
    <div class="composer ${roomType === 'dm' && !isFriend(state.dmUserId) ? 'composer-no-files' : ''}" id="composer-drop-zone" data-can-send-files="${roomType === 'dm' ? isFriend(state.dmUserId) : true}">
      ${replyPreview ? `
        <div class="composer-reply">
          Replying to ${escapeHtml(replyPreview.sender)}: ${escapeHtml(replyPreview.content?.slice(0, 50) || '')}…
          <button type="button" id="cancel-reply" class="cancel-reply-link">Cancel</button>
        </div>
      ` : ''}
      ${state._pendingFile ? `
        <div class="composer-pending-file" id="pending-file-indicator">
          <span>Attached: ${escapeHtml(state._pendingFile.name)}</span>
          <button type="button" id="clear-pending-file" title="Remove"><span class="icon icon-sm" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></span></button>
        </div>
      ` : ''}
      <div class="composer-row">
        <div class="composer-input-wrap">
          <textarea id="composer-input" placeholder="Message…" rows="1"></textarea>
          <div class="composer-actions">
            ${roomType === 'group' ? `<button type="button" id="composer-command-mode" class="composer-command-btn ${state.commandMode ? 'composer-command-btn-on' : ''}" title="${state.commandMode ? 'Command mode on (e.g. /games, /wordle, /file &lt;id&gt;)' : 'Command mode off (send as text)'}" aria-label="Toggle command mode" aria-pressed="${state.commandMode}"><span class="icon" aria-hidden="true">${ICON_COMMAND}</span></button>` : ''}
            <button type="button" id="composer-mic" title="Record voice message" ${(roomType === 'dm' && !isFriend(state.dmUserId)) ? 'disabled' : ''}><span class="icon" aria-hidden="true">${ICON_MIC}</span></button>
            <button type="button" id="attach-file" title="Attach file"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span></button>
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

const TS_INTERVAL_MS = 3 * 60 * 1000; // show timestamp when last one was 3+ min ago or none

function formatTimestampForDivider(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTimestamp(ts) {
  const text = escapeHtml(formatTimestampForDivider(ts));
  return `
    <div class="message-timestamp">
      <span class="message-timestamp-line"></span>
      <span class="message-timestamp-text">${text}</span>
      <span class="message-timestamp-line"></span>
    </div>
  `;
}

function isMediaMessage(m) {
  if (!(m.content || '').trim().startsWith('/uploads/')) return false;
  const k = getFileKind(m);
  return k === 'video' || k === 'image' || k === 'gif';
}
function getMediaMessageIds(list) {
  return (list || []).filter(isMediaMessage).map(m => m.id);
}

function getFileKind(msg) {
  const type = (msg.msg_type || '').toLowerCase();
  const url = (msg.content || '').toLowerCase();
  if (type === 'video' || /\.(mp4|webm|mov|ogg)(\?|$)/.test(url)) return 'video';
  if (type === 'audio' || type === 'voice' || /\.(mp3|wav|ogg|webm|m4a)(\?|$)/.test(url)) return 'audio';
  if (type === 'image' || type === 'gif' || /\.(gif|jpg|jpeg|png|webp)(\?|$)/.test(url)) return url.includes('.gif') ? 'gif' : 'image';
  return 'file';
}

function renderFileBlock(msg, mediaContext) {
  const url = (msg.content || '').trim();
  if (!url.startsWith('/uploads/')) return `<div class="message-content">${escapeHtml(url)}</div>`;
  const kind = getFileKind(msg);
  const safeUrl = escapeHtml(url).replace(/"/g, '&quot;');
  const { mediaIds = [], currentIndex = -1 } = mediaContext || {};
  const prevId = currentIndex > 0 ? mediaIds[currentIndex - 1] : null;
  const nextId = currentIndex >= 0 && currentIndex < mediaIds.length - 1 ? mediaIds[currentIndex + 1] : null;

  if (kind === 'video') {
    return `
      <div class="message-file message-file-video" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}"
           data-prev-media-id="${prevId || ''}" data-next-media-id="${nextId || ''}" role="button" tabindex="0">
        <video class="message-file-video-thumb" src="${safeUrl}" preload="metadata" muted playsinline></video>
        <span class="message-file-video-play" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
        <a href="${safeUrl}" download class="message-file-download message-file-download-video" onclick="event.stopPropagation()" title="Download">${ICON_DOWNLOAD}</a>
      </div>`;
  }
  if (kind === 'image' || kind === 'gif') {
    return `
      <div class="message-file message-file-image" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}"
           data-prev-media-id="${prevId || ''}" data-next-media-id="${nextId || ''}" role="button" tabindex="0">
        <img class="message-file-image-img" src="${safeUrl}" alt="" loading="lazy" />
        <a href="${safeUrl}" download class="message-file-download message-file-download-image" onclick="event.stopPropagation()" title="Download">${ICON_DOWNLOAD}</a>
      </div>`;
  }
  if (kind === 'audio') {
    return `
      <div class="message-file message-file-audio" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}">
        <div class="message-file-audio-wrap">
          <audio class="message-file-audio-el" src="${safeUrl}" preload="metadata"></audio>
          <div class="message-file-audio-progress-wrap">
            <input type="range" class="message-file-audio-progress" min="0" max="100" value="0" title="Seek" />
          </div>
          <p class="message-file-audio-time">Current: <span class="message-file-audio-current">00:00</span> / Total: <span class="message-file-audio-total">00:00</span></p>
          <a href="${safeUrl}" download class="message-file-audio-download" title="Download">${ICON_DOWNLOAD}</a>
        </div>
      </div>`;
  }
  return `
    <div class="message-file message-file-other" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}">
      <div class="message-file-other-wrap">
        <button type="button" class="message-file-other-icon" title="View file content" aria-label="View file">${ICON_FILE}</button>
        <a href="${safeUrl}" download class="message-file-other-download" title="Download">${ICON_DOWNLOAD}</a>
      </div>
    </div>`;
}

const ICON_DOWNLOAD = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
const ICON_FILE = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>';

function renderMessagesWithTimestamps(list, roomType, roomId) {
  let lastTs = null;
  const mediaIds = getMediaMessageIds(list);
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const t = m.created_at || 0;
    if (t && (lastTs == null || t - lastTs >= TS_INTERVAL_MS)) {
      parts.push(renderTimestamp(t));
      lastTs = t;
    } else if (t) lastTs = t;
    const mediaIndex = mediaIds.indexOf(m.id);
    parts.push(renderMessage(m, roomType, roomId, { mediaIds, mediaIndex }));
  }
  return parts.join('');
}

function renderMessage(m, roomType, roomId, context = {}) {
  const isOwn = m.sender_id === state.user?.id;
  const isFileMessage = (m.content || '').trim().startsWith('/uploads/');

  if (m.deleted_by_admin) {
    return `
      <div class="message message-system" data-msg-id="${m.id}" data-sender-id="${m.sender_id || ''}">
        <span class="message-system-text">Message deleted</span>
      </div>
    `;
  }

  if (m.recalled_at) {
    const name = escapeHtml(m.display_name || m.username);
    return `
      <div class="message message-system message-recalled-line" data-msg-id="${m.id}" data-sender-id="${m.sender_id || ''}">
        <span class="message-system-text"><span class="message-recalled-name">${name}</span> recalled a message</span>
      </div>
    `;
  }

  const versions = [...(m.edit_history || []).map(h => h.content), m.content || ''];
  const versionIndex = Math.max(0, Math.min((state.messageVersionIndex[m.id] ?? versions.length - 1), versions.length - 1));
  const displayContent = versions[versionIndex];
  const mediaContext = { mediaIds: context.mediaIds || [], currentIndex: context.mediaIndex ?? -1 };
  const content = isFileMessage ? renderFileBlock(m, mediaContext) : renderMessageContent(displayContent || '');
  const replyBlock = m.reply_to_id ? `<div class="message-reply-preview" data-reply-to="${m.reply_to_id}">Reply to message</div>` : '';
  const likeCount = (m.likes || 0) > 0 ? `<span class="message-like-count">${m.likes}</span>` : '';
  const likeIcon = `<button type="button" class="message-like-btn" data-msg-id="${m.id}" title="Like" aria-label="Like"><span class="message-like-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span></button>`;

  const chevronLeft = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`;
  const chevronRight = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`;
  const editHistoryUI = !isFileMessage && versions.length > 1
    ? `<span class="message-edit-history" data-msg-id="${m.id}">
        <button type="button" class="message-edit-history-btn" data-msg-id="${m.id}" data-dir="prev" title="Older version" aria-label="Older version" ${versionIndex <= 0 ? 'disabled' : ''}>${chevronLeft}</button>
        <span class="message-edit-history-label">${versionIndex + 1}/${versions.length}</span>
        <button type="button" class="message-edit-history-btn" data-msg-id="${m.id}" data-dir="next" title="Newer version" aria-label="Newer version" ${versionIndex >= versions.length - 1 ? 'disabled' : ''}>${chevronRight}</button>
      </span>`
    : '';

  const isEditing = !isFileMessage && state.editingMessageId === m.id;
  const contentBlock = isEditing
    ? `<div class="message-edit-area">
        <textarea class="message-edit-input" data-msg-id="${m.id}" rows="3">${escapeHtml(m.content || '')}</textarea>
        <div class="message-edit-actions">
          <button type="button" class="message-edit-save" data-msg-id="${m.id}">Save</button>
          <button type="button" class="message-edit-cancel" data-msg-id="${m.id}">Cancel</button>
        </div>
      </div>`
    : `<div class="message-content message-content-file">${content}</div>`;

  const defaultAvatar = getDefaultAvatarUrl(m.sender_id);
  const avatarSrc = (m.avatar_url && String(m.avatar_url).trim()) ? m.avatar_url : defaultAvatar;
  const senderName = escapeHtml(m.display_name || m.username);
  return `
    <div class="message-row" data-msg-id="${m.id}">
      <div class="message ${isOwn ? 'own' : ''}" data-msg-id="${m.id}" data-sender-id="${m.sender_id}">
        <div class="message-avatar-wrap" data-sender-id="${escapeHtml(m.sender_id || '')}" title="View profile" role="button" tabindex="0">
          <span class="message-sender">${senderName}</span>
          <img class="message-avatar" src="${avatarSrc}" data-fallback="${defaultAvatar.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
        </div>
        <div class="message-body">
          ${replyBlock}
          ${contentBlock}
        </div>
      </div>
      <div class="message-like-wrap">
        ${editHistoryUI}
        ${likeIcon}
        ${likeCount}
      </div>
    </div>
  `;
}

function renderDocArea() {
  const docKey = state.panel;
  const canEdit = state.user?.can_edit_docs;
  const isEditing = canEdit && state.editingDocKey === docKey;
  const supportId = state.supportMessageIdForSolve || '';
  const content = state._docContent ?? '';
  if (isEditing) {
    return `
    <div class="doc-panel" data-doc-key="${docKey}">
      <div class="doc-toolbar">
        <button type="button" id="save-doc" class="doc-save">Save</button>
        <button type="button" id="cancel-doc-edit" class="doc-cancel">Cancel</button>
      </div>
      <div class="doc-editor">
        <textarea id="doc-content" placeholder="Loading…">${escapeHtml(content)}</textarea>
      </div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
  }
  return `
    <div class="doc-panel" data-doc-key="${docKey}">
      ${canEdit ? `
      <div class="doc-toolbar">
        <button type="button" id="start-doc-edit" class="doc-edit-btn">Edit</button>
      </div>
      ` : ''}
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

/** Parse $\language="name" ... \$ blocks. Returns array of { type: 'text'|'block', content, language? }. */
function parseLanguageBlocks(str) {
  if (str == null || str === '') return [{ type: 'text', content: '' }];
  const s = String(str);
  const re = /\$\s*language\s*=\s*"([^"]+)"\s*\n([\s\S]*?)\\\$/g;
  const segments = [];
  let lastEnd = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastEnd) {
      segments.push({ type: 'text', content: s.slice(lastEnd, m.index) });
    }
    segments.push({ type: 'block', language: m[1].trim().toLowerCase(), content: m[2].replace(/\n$/, '') });
    lastEnd = re.lastIndex;
  }
  if (lastEnd < s.length) {
    segments.push({ type: 'text', content: s.slice(lastEnd) });
  }
  return segments.length ? segments : [{ type: 'text', content: s }];
}

/** Sanitize HTML to a safe subset of tags (no script, no event handlers). */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const allowedTags = new Set(['p', 'div', 'span', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const allowedAttrs = { a: ['href'] };
  function serialize(n) {
    if (n.nodeType === Node.TEXT_NODE) return escapeHtml(n.textContent);
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = n.tagName.toLowerCase();
    if (!allowedTags.has(tag)) return Array.from(n.childNodes).map(serialize).join('');
    const attrs = allowedAttrs[tag];
    let attrStr = '';
    if (attrs && tag === 'a') {
      const href = n.getAttribute('href');
      if (href) attrStr = ' href="' + escapeHtml(href).replace(/"/g, '&quot;') + '"';
    }
    const inner = Array.from(n.childNodes).map(serialize).join('');
    if (tag === 'br') return '<br>';
    return '<' + tag + attrStr + '>' + inner + '</' + tag + '>';
  }
  return Array.from(doc.body.childNodes).map(serialize).join('');
}

/** Render LaTeX block to HTML using KaTeX if available. */
function renderLatexBlock(latex) {
  if (typeof window.renderKatex === 'function') {
    try {
      return window.renderKatex(latex, true);
    } catch (e) {
      return '<pre class="language-block-error">' + escapeHtml(latex) + '</pre>';
    }
  }
  return '<pre class="language-block-latex"><code>' + escapeHtml(latex) + '</code></pre>';
}

/** Process message content: apply language blocks then markdown. */
function renderMessageContent(raw) {
  if (raw == null || raw === '') return '';
  const segments = parseLanguageBlocks(raw);
  const parts = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      parts.push(markdownToHtml(seg.content));
    } else {
      const lang = seg.language;
      const content = seg.content;
      if (lang === 'markdown') {
        parts.push(markdownToHtml(content));
      } else if (lang === 'html') {
        parts.push('<div class="language-block-html">' + sanitizeHtml(content) + '</div>');
      } else if (lang === 'latex') {
        parts.push('<div class="language-block-latex">' + renderLatexBlock(content) + '</div>');
      } else {
        parts.push('<pre class="language-block-raw"><code>' + escapeHtml(content) + '</code></pre>');
      }
    }
  }
  return parts.join('');
}

/** Render Markdown to safe HTML (no raw HTML execution). Supports # headers, **bold**, *italic*, `code`, > blockquote, -, * lists, ``` blocks, [links](url). */
function markdownToHtml(md) {
  if (md == null || md === '') return '';
  const lines = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let inBlock = false;
  let blockContent = [];
  let listItems = [];
  let listOrdered = false;
  let blockquoteLines = [];

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
  function flushBlockquote() {
    if (blockquoteLines.length) {
      const html = blockquoteLines.map(l => `<p>${inlineMarkdown(l)}</p>`).join('');
      out.push(`<blockquote>${html}</blockquote>`);
      blockquoteLines = [];
    }
  }
  function linkifyPlainText(segment) {
    if (!segment || /^<a\s|^<\/a>/.test(segment)) return segment;
    const safeHref = (u) => u.replace(/"/g, '&quot;');
    return segment
      .replace(/(https?:\/\/[^\s<>"']+)/g, (_, url) =>
        `<a href="${safeHref(url)}" target="_blank" rel="noopener">${url}</a>`)
      .replace(/(?<![\/">])(www\.[^\s<>"']+)/g, (_, url) =>
        `<a href="${safeHref('https://' + url)}" target="_blank" rel="noopener">${url}</a>`)
      .replace(/\b([a-zA-Z0-9][-a-zA-Z0-9]*\.(?:com|org|net|io|co|edu|gov|dev|app)(?:\/[^\s<>"']*)?)/g, (_, url) =>
        `<a href="${safeHref('https://' + url)}" target="_blank" rel="noopener">${url}</a>`);
  }

  function inlineMarkdown(s) {
    const escaped = escapeHtml(s);
    const withMarkdown = escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`([^`]*)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const parts = withMarkdown.split(/(<a\s[^>]*>|<\/a>)/g);
    for (let i = 0; i < parts.length; i++) {
      if (!/^<a\s|^<\/a>/.test(parts[i])) {
        parts[i] = linkifyPlainText(parts[i]);
      }
    }
    return parts.join('');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('```')) {
      flushBlockquote();
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
    if (blockquoteLines.length && !trimmed.startsWith('>')) {
      flushBlockquote();
    }
    const blockquoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      flushList();
      blockquoteLines.push(blockquoteMatch[1]);
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
  flushBlockquote();
  return out.join('\n');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function showProfileModal(userId) {
  if (!userId || userId === state.user?.id) return;
  try {
    const { profile } = await apiGet(`/api/users/${encodeURIComponent(userId)}/profile`);
    const friend = isFriend(userId);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay profile-modal-overlay';
    overlay.innerHTML = `
      <div class="modal profile-modal">
        <button type="button" class="profile-modal-close" aria-label="Close">&times;</button>
        <div class="profile-modal-header">
          <img src="${(profile.avatar_url && String(profile.avatar_url).trim()) ? profile.avatar_url : getDefaultAvatarUrl(profile.id)}" data-fallback="${getDefaultAvatarUrl(profile.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="profile-modal-avatar" />
          <h3 class="profile-modal-name">${escapeHtml(profile.display_name || profile.username)}</h3>
          <p class="profile-modal-username">@${escapeHtml(profile.username)}</p>
          ${profile.description ? `<p class="profile-modal-description">${escapeHtml(profile.description)}</p>` : ''}
          ${profile.website ? `<p class="profile-modal-website"><a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">${escapeHtml(profile.website)}</a></p>` : ''}
        </div>
        <div class="profile-modal-actions">
          <button type="button" class="btn-primary profile-btn-message">Send Message</button>
          ${!friend ? `<button type="button" class="btn-secondary profile-btn-friend-request">Send Friend Request</button>` : ''}
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.profile-modal-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.profile-btn-message')?.addEventListener('click', () => { overlay.remove(); navigateTo(`/chat/${encodeURIComponent(userId)}`); });
    const frBtn = overlay.querySelector('.profile-btn-friend-request');
    if (frBtn) {
      frBtn.addEventListener('click', async () => {
        try {
          await apiPost('/api/friends/request', { to_user_id: userId });
          frBtn.textContent = 'Request sent';
          frBtn.disabled = true;
        } catch (err) {
          alert(err.message || 'Failed to send friend request');
        }
      });
    }
    document.body.appendChild(overlay);
  } catch (err) {
    alert(err.message || 'Could not load profile');
  }
}

function showWordleModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay wordle-modal-overlay';
  overlay.innerHTML = `
    <div class="wordle-modal">
      <button type="button" class="wordle-modal-close" aria-label="Close">&times;</button>
      <iframe src="https://jimmyqrg.github.io/wordle" title="Wordle" class="wordle-iframe"></iframe>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.wordle-modal-close')?.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function getStepOptions(durationSeconds) {
  if (durationSeconds <= 60) return [5];
  if (durationSeconds <= 180) return [5, 10];
  return [5, 10, 15];
}

function openMediaPopup(msgId, url, kind, prevId, nextId, roomType, roomId) {
  const list = state.messages[roomKey(roomType, roomId)] || [];
  const mediaList = list.filter(isMediaMessage);
  const safeUrl = (u) => escapeHtml(u || '').replace(/"/g, '&quot;');
  const overlay = document.createElement('div');
  overlay.className = 'media-popup-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  function setMedia(msg) {
    if (!msg) return;
    const u = (msg.content || '').trim();
    const k = getFileKind(msg);
    const prev = mediaList[mediaList.findIndex(m => m.id === msg.id) - 1];
    const next = mediaList[mediaList.findIndex(m => m.id === msg.id) + 1];
    const prevId = prev?.id || '';
    const nextId = next?.id || '';
    const contentEl = overlay.querySelector('.media-popup-content');
    const controlsEl = overlay.querySelector('.media-popup-controls');
    if (!contentEl || !controlsEl) return;
    contentEl.innerHTML = '';
    if (k === 'video') {
      const steps = [5, 10, 15];
      const stepBtns = steps.map(s => `<button type="button" class="media-popup-step" data-sec="${s}" title="Back ${s}s">−${s}s</button>`).join('');
      const stepFwd = steps.map(s => `<button type="button" class="media-popup-step-fwd" data-sec="${s}" title="Forward ${s}s">+${s}s</button>`).join('');
      const vid = document.createElement('video');
      vid.className = 'media-popup-video';
      vid.src = u;
      vid.controls = false;
      vid.playsInline = true;
      contentEl.appendChild(vid);
      controlsEl.innerHTML = `
        <div class="media-popup-controls-row">
          <button type="button" class="media-popup-prev" ${!prevId ? 'disabled' : ''} data-msg-id="${prevId}" title="Previous">Previous</button>
          <span class="media-popup-step-group">${stepBtns}</span>
          <button type="button" class="media-popup-play" title="Play (K)">Play</button>
          <span class="media-popup-step-group">${stepFwd}</span>
          <button type="button" class="media-popup-next" ${!nextId ? 'disabled' : ''} data-msg-id="${nextId}" title="Next">Next</button>
          <a href="${safeUrl(u)}" download class="media-popup-download" title="Download">${ICON_DOWNLOAD}</a>
        </div>
      `;
      overlay.querySelector('.media-popup-prev')?.addEventListener('click', () => { if (prev) setMedia(prev); });
      overlay.querySelector('.media-popup-next')?.addEventListener('click', () => { if (next) setMedia(next); });
      overlay.querySelector('.media-popup-play')?.addEventListener('click', () => { vid.paused ? vid.play() : vid.pause(); });
      overlay.querySelectorAll('.media-popup-step').forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.max(0, vid.currentTime - parseInt(btn.dataset.sec, 10)); }));
      overlay.querySelectorAll('.media-popup-step-fwd').forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.min(vid.duration, vid.currentTime + parseInt(btn.dataset.sec, 10)); }));
      vid.addEventListener('loadedmetadata', () => {
        const dur = vid.duration;
        const opts = getStepOptions(dur);
        const row = controlsEl.querySelector('.media-popup-controls-row');
        if (row) {
          const backGroup = row.querySelector('.media-popup-step-group');
          const fwdGroup = row.querySelectorAll('.media-popup-step-group')[1];
          if (backGroup) backGroup.innerHTML = opts.map(s => `<button type="button" class="media-popup-step" data-sec="${s}">−${s}s</button>`).join('');
          if (fwdGroup) fwdGroup.innerHTML = opts.map(s => `<button type="button" class="media-popup-step-fwd" data-sec="${s}">+${s}s</button>`).join('');
          [...(row.querySelectorAll('.media-popup-step'))].forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.max(0, vid.currentTime - parseInt(btn.dataset.sec, 10)); }));
          [...(row.querySelectorAll('.media-popup-step-fwd'))].forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.min(vid.duration, vid.currentTime + parseInt(btn.dataset.sec, 10)); }));
        }
      });
      vid.addEventListener('play', () => { const b = overlay.querySelector('.media-popup-play'); if (b) b.textContent = 'Pause'; });
      vid.addEventListener('pause', () => { const b = overlay.querySelector('.media-popup-play'); if (b) b.textContent = 'Play'; });
      overlay._imageShowUI = null;
      overlay._imageHideUI = null;
    } else {
      controlsEl.innerHTML = `
        <div class="media-popup-image-ui media-popup-controls-row" role="toolbar">
          <button type="button" class="media-popup-prev" ${!prevId ? 'disabled' : ''} data-msg-id="${prevId}">Previous</button>
          <button type="button" class="media-popup-next" ${!nextId ? 'disabled' : ''} data-msg-id="${nextId}">Next</button>
          <a href="${safeUrl(u)}" download class="media-popup-download">${ICON_DOWNLOAD}</a>
        </div>
      `;
      controlsEl.classList.add('media-popup-image-ui');
      controlsEl.style.opacity = '0';
      const img = document.createElement('img');
      img.className = 'media-popup-image';
      img.src = u;
      img.alt = '';
      contentEl.appendChild(img);
      let scale = 1;
      let uiTimer = null;
      const isTouch = 'ontouchstart' in window;
      function showUI() {
        controlsEl.style.opacity = '1';
        if (uiTimer) clearTimeout(uiTimer);
        uiTimer = setTimeout(hideUI, 2000);
      }
      function hideUI() {
        controlsEl.style.opacity = '0';
        if (uiTimer) clearTimeout(uiTimer);
      }
      overlay._imageShowUI = showUI;
      overlay._imageHideUI = hideUI;
      overlay.querySelector('.media-popup-image-overlay')?.addEventListener('click', showUI);
      contentEl.addEventListener('click', showUI);
      contentEl.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.max(0.25, Math.min(4, scale + (e.deltaY > 0 ? -0.1 : 0.1))); img.style.transform = `scale(${scale})`; });
      overlay.querySelector('.media-popup-prev')?.addEventListener('click', () => { if (prev) setMedia(prev); });
      overlay.querySelector('.media-popup-next')?.addEventListener('click', () => { if (next) setMedia(next); });
    }
  }

  const initialMsg = list.find(m => m.id === msgId) || { content: url, msg_type: kind === 'video' ? 'video' : 'image' };
  const isVideo = kind === 'video';
  overlay.innerHTML = `
    <div class="media-popup">
      <button type="button" class="media-popup-close" aria-label="Close">&times;</button>
      <div class="media-popup-content"></div>
      <div class="media-popup-image-overlay"></div>
      <div class="media-popup-controls"></div>
    </div>
  `;
  const close = () => {
    overlay.querySelector('.media-popup-video')?.pause();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === ' ') e.preventDefault();
    if (e.key === 'k' || e.key === 'K') {
      const v = overlay.querySelector('.media-popup-video');
      if (v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    }
  };
  overlay.querySelector('.media-popup-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.classList.contains('media-popup-close')) close(); });
  document.addEventListener('keydown', onKey);
  setMedia(initialMsg);
  if (isVideo) {
    const v = overlay.querySelector('.media-popup-video');
    if (v) v.play().catch(() => {});
  }
  overlay.addEventListener('keydown', () => { overlay._imageShowUI?.(); });
  overlay.addEventListener('mousemove', (e) => {
    if (e.target.closest('.media-popup-content') || e.target.closest('.media-popup-controls')) overlay._imageShowUI?.();
  });
  overlay.addEventListener('mouseleave', () => {
    if (!('ontouchstart' in window)) overlay._imageHideUI?.();
  });
  document.body.appendChild(overlay);
}

async function openFileContentModal(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    const text = await res.text();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay file-content-modal-overlay';
    overlay.innerHTML = `
      <div class="modal file-content-modal">
        <button type="button" class="file-content-modal-close" aria-label="Close">&times;</button>
        <pre class="file-content-modal-body">${escapeHtml(text)}</pre>
        <a href="${escapeHtml(url).replace(/"/g, '&quot;')}" download class="file-content-modal-download">Download</a>
      </div>
    `;
    const onEscape = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEscape); } };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onEscape); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.file-content-modal-close')?.addEventListener('click', close);
    document.addEventListener('keydown', onEscape);
    document.body.appendChild(overlay);
  } catch (e) {
    alert('Could not load file content');
  }
}

function bindMain() {
  document.querySelector('.panel-column-content')?.addEventListener('click', (e) => {
    if (e.target.closest('a') && state.panelColumnExpanded) {
      state.panelColumnExpanded = false;
      setState({});
    }
  });

  document.getElementById('panel-search-btn')?.addEventListener('click', () => {
    setState({ panelSearchOpen: !state.panelSearchOpen });
  });

  const panelSearchInput = document.getElementById('panel-user-search');
  const panelUserList = document.getElementById('panel-user-list');
  if (panelSearchInput && panelUserList) {
    panelSearchInput.addEventListener('input', () => {
      const q = (panelSearchInput.value || '').trim().toLowerCase();
      panelUserList.querySelectorAll('a.panel-list-link').forEach((a) => {
        const match = !q || (a.dataset.username || '').includes(q) || (a.dataset.display || '').includes(q);
        a.closest('li').style.display = match ? '' : 'none';
      });
    });
    panelUserList.addEventListener('click', (e) => {
      const a = e.target.closest('a.panel-list-link[data-friend="0"]');
      if (a) {
        e.preventDefault();
        showProfileModal(a.dataset.userId);
      }
    });
  }

  document.getElementById('cancel-reply')?.addEventListener('click', () => setState({ replyTo: null }));

  const wrap = document.querySelector('.messages-wrap');
  const roomType = wrap?.dataset.roomType;
  const roomId = wrap?.dataset.roomId;
  if (wrap && roomType && roomId) {
    requestAnimationFrame(() => {
      wrap.scrollTop = wrap.scrollHeight;
    });
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
      const canSolve = state.user?.can_edit_docs && isSupport;

      const items = [];
      if (isOwn && canRecallEdit) {
        items.push({ label: 'Recall', action: 'recall' });
        items.push({ label: 'Edit', action: 'edit' });
      }
      if (state.user?.can_delete_messages) items.push({ label: 'Delete (admin)', action: 'delete', danger: true });
      if (state.user?.can_kick) items.push({ label: 'Kick user', action: 'kick' });
      if (canSolve) items.push({ label: 'Solve', action: 'solve' });
      const fileUrl = (msg.content || '').trim();
      if (fileUrl.startsWith('/uploads/')) items.push({ label: 'Get file id', action: 'get-file-id' });
      items.push({ label: 'Reply', action: 'reply' });

      showContextMenu(e.clientX, e.clientY, items, (action) => {
        if (action === 'get-file-id') {
          const fileId = fileUrl.slice('/uploads/'.length);
          if (fileId && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(fileId).then(() => {}).catch(() => {});
          }
          return;
        }
        if (action === 'recall') {
          if (confirm('Are you sure you want to recall this message?')) state.socket?.emit('message:recall', msgId, () => {});
        } else if (action === 'edit') startInlineEdit(msg);
        else if (action === 'delete') {
          if (confirm('Are you sure you want to delete this message?')) state.socket?.emit('message:delete', msgId, () => {});
        }
        if (action === 'kick') kickUser(senderId);
        if (action === 'solve') {
          state.supportMessageIdForSolve = msgId;
          navigateTo('/chat/group?panel=problem');
        }
        if (action === 'reply') setState({ replyTo: msg });
      });
    });
  }

  wrap?.addEventListener('click', (e) => {
    const videoEl = e.target.closest('.message-file-video');
    if (videoEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      openMediaPopup(videoEl.dataset.msgId, videoEl.dataset.url, 'video', videoEl.dataset.prevMediaId || null, videoEl.dataset.nextMediaId || null, roomType, roomId);
      return;
    }
    const imageEl = e.target.closest('.message-file-image');
    if (imageEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      openMediaPopup(imageEl.dataset.msgId, imageEl.dataset.url, 'image', imageEl.dataset.prevMediaId || null, imageEl.dataset.nextMediaId || null, roomType, roomId);
      return;
    }
    const otherIcon = e.target.closest('.message-file-other-icon');
    if (otherIcon) {
      e.preventDefault();
      e.stopPropagation();
      const url = otherIcon.closest('.message-file-other')?.dataset?.url;
      if (url) openFileContentModal(url);
      return;
    }
    const likeBtn = e.target.closest('.message-like-btn');
    if (likeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = likeBtn.dataset.msgId;
      state.socket?.emit('message:like', msgId, () => {});
      return;
    }
    const saveBtn = e.target.closest('.message-edit-save');
    if (saveBtn) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = saveBtn.dataset.msgId;
      const textarea = document.querySelector(`.message-edit-input[data-msg-id="${msgId}"]`);
      const newContent = textarea?.value?.trim() ?? '';
      if (newContent) {
        state.socket?.emit('message:edit', { id: msgId, content: newContent }, () => {});
      }
      setState({ editingMessageId: null });
      return;
    }
    const cancelBtn = e.target.closest('.message-edit-cancel');
    if (cancelBtn) {
      e.preventDefault();
      e.stopPropagation();
      setState({ editingMessageId: null });
      return;
    }
    const historyBtn = e.target.closest('.message-edit-history-btn');
    if (historyBtn && !historyBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = historyBtn.dataset.msgId;
      const dir = historyBtn.dataset.dir;
      const list = state.messages[roomKey(roomType, roomId)] || [];
      const msg = list.find(m => m.id === msgId);
      if (!msg) return;
      const versions = [...(msg.edit_history || []).map(h => h.content), msg.content || ''];
      const current = state.messageVersionIndex[msgId] ?? versions.length - 1;
      const next = dir === 'prev' ? Math.max(0, current - 1) : Math.min(versions.length - 1, current + 1);
      setState({ messageVersionIndex: { ...state.messageVersionIndex, [msgId]: next } });
    }
  });

  wrap?.addEventListener('loadedmetadata', (e) => {
    if (e.target.classList?.contains('message-file-audio-el')) {
      const el = e.target;
      const totalSpan = el.closest('.message-file-audio')?.querySelector('.message-file-audio-total');
      if (totalSpan) totalSpan.textContent = formatAudioTime(el.duration);
    }
  });
  wrap?.addEventListener('timeupdate', (e) => {
    if (e.target.classList?.contains('message-file-audio-el')) {
      const el = e.target;
      const block = el.closest('.message-file-audio');
      const currentSpan = block?.querySelector('.message-file-audio-current');
      const progress = block?.querySelector('.message-file-audio-progress');
      if (currentSpan) currentSpan.textContent = formatAudioTime(el.currentTime);
      if (progress && Number.isFinite(el.duration)) progress.value = (el.currentTime / el.duration) * 100;
    }
  });
  wrap?.addEventListener('input', (e) => {
    if (e.target.classList?.contains('message-file-audio-progress')) {
      const range = e.target;
      const block = range.closest('.message-file-audio');
      const audio = block?.querySelector('.message-file-audio-el');
      if (audio && Number.isFinite(audio.duration)) audio.currentTime = (Number(range.value) / 100) * audio.duration;
    }
  });

  if (state.editingMessageId) {
    requestAnimationFrame(() => {
      const ta = document.querySelector(`.message-edit-input[data-msg-id="${state.editingMessageId}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setState({ editingMessageId: null });
            ta.removeEventListener('keydown', onKey);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const newContent = ta.value.trim();
            if (newContent) state.socket?.emit('message:edit', { id: state.editingMessageId, content: newContent }, () => {});
            setState({ editingMessageId: null });
            ta.removeEventListener('keydown', onKey);
          }
        };
        ta.addEventListener('keydown', onKey);
      }
    });
  }

  const sendBtn = document.getElementById('send-btn');
  const input = document.getElementById('composer-input');
  if (sendBtn && input) {
    const send = () => {
      if (state._sendingMessage) return;
      const text = input.value.trim();
      if (!text && !state._pendingFile) return;
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;

      if (roomType === 'group' && state.commandMode && text.startsWith('/')) {
        const cmd = text.split(/\s/)[0].toLowerCase();
        if (cmd === '/games') {
          window.open('https://jimmyqrg.github.io/page');
          input.value = '';
          return;
        }
        if (cmd === '/wordle') {
          showWordleModal();
          input.value = '';
          return;
        }
        if (cmd === '/request-admin') {
          apiPost('/api/inbox/request-admin').then(() => {
            input.value = '';
          }).catch((err) => alert(err.message || 'Request failed'));
          return;
        }
        if (cmd === '/file') {
          const fileId = text.slice(5).trimStart();
          if (!fileId) {
            alert('Usage: /file <file_id>');
            return;
          }
          state._sendingMessage = true;
          const reply_to_id = state.replyTo?.id || null;
          state.socket?.emit('message:send', { roomType, roomId, content: `/uploads/${fileId}`, msg_type: 'file', reply_to_id }, (res) => {
            state._sendingMessage = false;
            if (res?.error) { alert(res.error); return; }
            if (res?.message) addMessageLocal(res.message);
            setState({ replyTo: null });
            input.value = '';
          });
          return;
        }
      }

      state._sendingMessage = true;
      const reply_to_id = state.replyTo?.id || null;
      const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
      const done = () => { state._sendingMessage = false; };
      if (state._pendingFile) {
        if (!canSendFiles) {
          alert('Add as friend to send files');
          state._pendingFile = null;
          render();
          state._sendingMessage = false;
          return;
        }
        const form = new FormData();
        form.append('file', state._pendingFile);
        form.append('content', text);
        form.append('msg_type', state._pendingFile.type.startsWith('image/') ? 'image' : state._pendingFile.type.startsWith('video/') ? 'video' : state._pendingFile.type.startsWith('audio/') ? 'audio' : 'file');
        if (reply_to_id) form.append('reply_to_id', reply_to_id);
        const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
        fetch(path, { method: 'POST', credentials: 'include', body: form }).then(() => {
          state._pendingFile = null;
          setState({ replyTo: null });
          input.value = '';
          if (roomType === 'dm') loadMessages('dm', roomId).then(render);
        }).catch(console.error).finally(done);
        return;
      }
      state.socket?.emit('message:send', { roomType, roomId, content: text, reply_to_id }, (res) => {
        done();
        if (res?.error) {
          alert(res.error);
          return;
        }
        if (res?.message) addMessageLocal(res.message);
        setState({ replyTo: null });
        input.value = '';
      });
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }

  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-file');
  const canSendFiles = document.getElementById('composer-drop-zone')?.dataset.canSendFiles !== 'false';
  if (fileInput) fileInput.disabled = !canSendFiles;
  if (attachBtn) {
    attachBtn.disabled = !canSendFiles;
    attachBtn.title = canSendFiles ? 'Attach file' : 'Add as friend to send files';
  }
  document.getElementById('attach-file')?.addEventListener('click', () => {
    if (!canSendFiles) {
      alert('Add as friend to send files');
      return;
    }
    document.getElementById('file-input')?.click();
  });
  document.getElementById('file-input')?.addEventListener('change', (e) => {
    if (!canSendFiles) return;
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

  document.getElementById('composer-command-mode')?.addEventListener('click', () => {
    state.commandMode = !state.commandMode;
    try { localStorage.setItem('commandMode', state.commandMode ? '1' : '0'); } catch (_) {}
    const btn = document.getElementById('composer-command-mode');
    if (btn) {
      btn.classList.toggle('composer-command-btn-on', state.commandMode);
      btn.setAttribute('aria-pressed', state.commandMode);
      btn.title = state.commandMode ? 'Command mode on (e.g. /games, /wordle, /file <id>)' : 'Command mode off (send as text)';
    }
  });
  document.getElementById('composer-mic')?.addEventListener('click', async () => {
    if (state._recording) return;
    const roomType = state.dmUserId ? 'dm' : 'group';
    const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
    if (!canSendFiles) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state._recordingStream = stream;
      state._recordingChunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) state._recordingChunks.push(e.data); };
      recorder.start();
      state._recordingRecorder = recorder;
      setState({ _recording: true });
    } catch (err) {
      console.error('Microphone access failed', err);
    }
  });

  function stopRecording(discard = true) {
    if (state._recordingKeydownHandler) {
      document.removeEventListener('keydown', state._recordingKeydownHandler);
      state._recordingKeydownHandler = null;
    }
    if (state._recordingRecorder && state._recordingRecorder.state !== 'inactive') {
      state._recordingRecorder.stop();
    }
    if (state._recordingStream) {
      state._recordingStream.getTracks().forEach((t) => t.stop());
    }
    state._recording = false;
    state._recordingStream = null;
    state._recordingRecorder = null;
    const chunks = state._recordingChunks || [];
    state._recordingChunks = [];
    setState({});
    return discard ? null : chunks;
  }

  document.getElementById('recording-send')?.addEventListener('click', () => {
    const chunks = stopRecording(false);
    if (!chunks || chunks.length === 0) return;
    const roomType = state.dmUserId ? 'dm' : 'group';
    const roomId = state.dmUserId ? state.convId : state.panel;
    const reply_to_id = state.replyTo?.id || null;
    const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
    if (!canSendFiles) return;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
    const form = new FormData();
    form.append('file', file);
    form.append('content', '');
    form.append('msg_type', 'voice');
    if (reply_to_id) form.append('reply_to_id', reply_to_id);
    const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
    fetch(path, { method: 'POST', credentials: 'include', body: form }).then((r) => r.json()).then((data) => {
      if (data.message) addMessageLocal(data.message);
      setState({ replyTo: null });
      if (roomType === 'dm') loadMessages('dm', roomId).then(render);
    }).catch(console.error);
  });

  document.getElementById('recording-cancel')?.addEventListener('click', () => {
    stopRecording(true);
  });

  const recordingOverlay = document.getElementById('recording-overlay');
  if (recordingOverlay && !state._recordingKeydownHandler) {
    const keydown = (e) => {
      if (!state._recording) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        stopRecording(true);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('recording-send')?.click();
      }
    };
    state._recordingKeydownHandler = keydown;
    document.addEventListener('keydown', keydown);
  }

  const dropZone = document.getElementById('composer-drop-zone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files') && canSendFiles) dropZone.classList.add('composer-drag-over');
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
      if (!canSendFiles) {
        alert('Add as friend to send files');
        return;
      }
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
        const { doc: fresh } = await loadDoc(docKey);
        state._docContent = fresh?.content ?? content;
        state.editingDocKey = null;
        setState({});
      } catch (e) {
        alert(e.message);
      }
    });
  }

  const cancelDocEdit = document.getElementById('cancel-doc-edit');
  if (cancelDocEdit) {
    cancelDocEdit.addEventListener('click', () => {
      state.editingDocKey = null;
      setState({});
    });
  }

  const startDocEdit = document.getElementById('start-doc-edit');
  if (startDocEdit) {
    startDocEdit.addEventListener('click', () => {
      const docKey = document.querySelector('.doc-panel')?.dataset.docKey;
      if (docKey) {
        state.editingDocKey = docKey;
        setState({});
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

function startInlineEdit(msg) {
  setState({ editingMessageId: msg.id });
}

function kickUser(userId) {
  fetch('/api/admin/kick', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  }).then(r => r.json()).then(() => {}).catch(console.error);
}

function renderAdminContent() {
  const adminTab = new URLSearchParams(window.location.search || '').get('tab') || 'action';
  const users = state.users || [];
  const otherUsers = users.filter(u => u.id !== state.user?.id);
  return `
        <div class="admin-main">
          ${adminTab === 'action' ? `
          ${state.user?.can_send_inbox ? `
          <div class="admin-section">
            <h2 class="admin-section-title">Send to inbox</h2>
            <p class="admin-section-desc">Send a message to a specific user's inbox.</p>
            <div class="admin-form">
              <label>User</label>
              <select id="admin-inbox-user">
                <option value="">Select user</option>
                ${otherUsers.map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
              </select>
              <label>Title</label>
              <input type="text" id="admin-inbox-title" placeholder="Title" />
              <label>Body</label>
              <textarea id="admin-inbox-body" placeholder="Message body" rows="4"></textarea>
              <button type="button" id="admin-inbox-send" class="btn-primary">Send</button>
            </div>
          </div>
          ` : ''}
          ${state.user?.can_broadcast ? `
          <div class="admin-section">
            <h2 class="admin-section-title">Broadcast to all</h2>
            <p class="admin-section-desc">Send a message to every user's inbox.</p>
            <div class="admin-form">
              <label>Title</label>
              <input type="text" id="admin-broadcast-title" placeholder="Title" />
              <label>Body</label>
              <textarea id="admin-broadcast-body" placeholder="Message body" rows="4"></textarea>
              <button type="button" id="admin-broadcast-send" class="btn-primary">Broadcast</button>
            </div>
          </div>
          ` : ''}
          ${state.user?.can_timeout ? `
          <div class="admin-section">
            <h2 class="admin-section-title">Time out user</h2>
            <p class="admin-section-desc">Prevent a user from sending messages in the JimmyQrg group chat for a set time.</p>
            <div class="admin-form">
              <label>User</label>
              <select id="admin-timeout-user">
                <option value="">Select user</option>
                ${otherUsers.filter(u => u.id !== 'jimmyqrg').map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
              </select>
              <label>Duration</label>
              <input type="text" id="admin-timeout-duration" placeholder="e.g. 5 minute, 1 hour, forever" />
              ${state.user?.id === 'jimmyqrg' ? `<label class="admin-timeout-locked"><input type="checkbox" id="admin-timeout-locked" /> Only I can release</label>` : ''}
              <button type="button" id="admin-timeout-submit" class="btn-primary">Time out</button>
            </div>
            <div id="admin-timeout-list" class="admin-timeout-list"></div>
          </div>
          ` : ''}
          ${!state.user?.can_send_inbox && !state.user?.can_broadcast && !state.user?.can_timeout ? '<p class="admin-section-desc">You have no action permissions. Ask an admin to grant Send mail, Broadcast, or Time out.</p>' : ''}
          ` : ''}
          ${adminTab === 'recalled' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">Recalled messages</h2>
            <p class="admin-section-desc">Messages that were recalled by users in the group chat.</p>
            <div id="admin-recalled-list" class="admin-recalled-list"></div>
          </div>
          ` : ''}
          ${adminTab === 'timeout' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">Time out user</h2>
            <p class="admin-section-desc">Prevent a user from sending messages in the JimmyQrg group chat.</p>
            <div class="admin-form">
              <label>User</label>
              <select id="admin-timeout-user-tab">
                <option value="">Select user</option>
                ${otherUsers.filter(u => u.id !== 'jimmyqrg').map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
              </select>
              <label>Duration</label>
              <input type="text" id="admin-timeout-duration-tab" placeholder="e.g. 5 minute, 1 hour, forever" />
              ${state.user?.id === 'jimmyqrg' ? `<label class="admin-timeout-locked"><input type="checkbox" id="admin-timeout-locked-tab" /> Only I can release</label>` : ''}
              <button type="button" id="admin-timeout-submit-tab" class="btn-primary">Time out</button>
            </div>
            <div id="admin-timeout-list-tab" class="admin-timeout-list"></div>
          </div>
          ` : ''}
          ${adminTab === 'users' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">Users</h2>
            <p class="admin-section-desc">Add users to the admin list here. After adding someone, set what they are allowed to do (e.g. send mail, broadcast, edit docs).</p>
            <div class="admin-users-list" id="admin-user-list">
              ${users.map(u => {
                const canManage = state.user?.can_manage_users;
                const permLabels = { can_send_inbox: 'Send mail', can_broadcast: 'Broadcast', can_edit_docs: 'Edit docs', can_kick: 'Kick users', can_delete_messages: 'Delete messages', can_manage_users: 'Manage users', can_timeout: 'Time out' };
                const permKeys = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout'];
                const isAdmin = u.id === 'jimmyqrg';
                const showPerms = canManage && !isAdmin && u.is_allowed;
                const defAvU = getDefaultAvatarUrl(u.id);
                const avSrcU = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAvU;
                return `
                <div class="admin-user-card" data-user-id="${u.id}">
                  <img src="${avSrcU}" data-fallback="${defAvU.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="admin-user-avatar" />
                  <div class="admin-user-info">
                    <span class="admin-user-name">${escapeHtml(u.display_name || u.username)}</span>
                    <span class="admin-user-meta">${isAdmin ? 'Admin' : (u.is_allowed ? 'On admin list' : 'Member')}</span>
                  </div>
                  ${!isAdmin ? `
                  <div class="admin-user-actions">
                    ${canManage ? `<button type="button" class="btn-small" data-action="allowed" data-user-id="${u.id}" data-allowed="${u.is_allowed ? '1' : '0'}">${u.is_allowed ? 'Remove from list' : 'Add to list'}</button>` : ''}
                    ${state.user?.can_kick ? `<button type="button" class="btn-small btn-danger" data-action="kick" data-user-id="${u.id}">Kick</button>` : ''}
                  </div>
                  ${showPerms ? `
                  <div class="admin-user-perms">
                    ${permKeys.map(k => `<label class="admin-perm-check"><input type="checkbox" data-action="perm" data-user-id="${u.id}" data-perm="${k}" ${u[k] ? 'checked' : ''} /> ${escapeHtml(permLabels[k])}</label>`).join('')}
                  </div>
                  ` : ''}
                  ` : ''}
                </div>
              `}).join('')}
            </div>
          </div>
          ` : ''}
        </div>
  `;
}

async function loadAdminRecalled() {
  const el = document.getElementById('admin-recalled-list');
  if (!el) return;
  try {
    const { messages } = await apiGet('/api/admin/recalled-messages');
    el.innerHTML = messages.length === 0
      ? '<p class="admin-section-desc">No recalled messages.</p>'
      : `<ul class="admin-recalled-ul">${messages.map(m => `
        <li class="admin-recalled-item">
          <strong>${escapeHtml(m.display_name || m.username)}</strong>
          <span class="admin-recalled-time">${formatTime(m.recalled_at)}</span>
          <p class="admin-recalled-content">${escapeHtml((m.content || '').slice(0, 200))}</p>
        </li>
      `).join('')}</ul>`;
  } catch (err) {
    el.innerHTML = '<p class="admin-section-desc">Failed to load.</p>';
  }
}

async function loadAdminTimeouts() {
  const el = document.getElementById('admin-timeout-list');
  const elTab = document.getElementById('admin-timeout-list-tab');
  const listEl = el || elTab;
  if (!listEl) return;
  try {
    const { timeouts } = await apiGet('/api/admin/timeouts');
    const html = timeouts.length === 0
      ? '<p class="admin-section-desc">No active timeouts.</p>'
      : `<ul class="admin-timeout-ul">${timeouts.map(t => `
        <li class="admin-timeout-item">
          <span>${escapeHtml(t.display_name || t.username)}</span>
          <span class="admin-timeout-meta">${t.expires_at ? 'until ' + formatTime(t.expires_at) : 'forever'} ${t.locked_release ? '(locked)' : ''}</span>
          ${(!t.locked_release || state.user?.id === 'jimmyqrg') ? `<button type="button" class="btn-small admin-timeout-release" data-timeout-id="${t.id}">Release</button>` : ''}
        </li>
      `).join('')}</ul>`;
    if (el) el.innerHTML = html;
    if (elTab) elTab.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = '<p class="admin-section-desc">Failed to load.</p>';
  }
}

function bindAdmin() {
  loadAdminRecalled();
  loadAdminTimeouts();

  document.getElementById('admin-timeout-submit')?.addEventListener('click', async () => {
    const userId = document.getElementById('admin-timeout-user')?.value;
    const duration = document.getElementById('admin-timeout-duration')?.value?.trim();
    const locked = document.getElementById('admin-timeout-locked')?.checked;
    if (!userId) { alert('Select a user'); return; }
    try {
      await apiPost('/api/admin/timeout', { user_id: userId, duration: duration || 'forever', locked_release: !!locked });
      document.getElementById('admin-timeout-duration').value = '';
      loadAdminTimeouts();
    } catch (err) { alert(err.message); }
  });
  document.getElementById('admin-timeout-submit-tab')?.addEventListener('click', async () => {
    const userId = document.getElementById('admin-timeout-user-tab')?.value;
    const duration = document.getElementById('admin-timeout-duration-tab')?.value?.trim();
    const locked = document.getElementById('admin-timeout-locked-tab')?.checked;
    if (!userId) { alert('Select a user'); return; }
    try {
      await apiPost('/api/admin/timeout', { user_id: userId, duration: duration || 'forever', locked_release: !!locked });
      document.getElementById('admin-timeout-duration-tab').value = '';
      loadAdminTimeouts();
    } catch (err) { alert(err.message); }
  });

  document.querySelector('.admin-timeout-list')?.closest('.admin-section')?.addEventListener('click', async (e) => {
    const releaseBtn = e.target.closest('.admin-timeout-release');
    if (releaseBtn) {
      const id = releaseBtn.dataset.timeoutId;
      try {
        await apiPost(`/api/admin/timeout/${id}/release`, {});
        loadAdminTimeouts();
      } catch (err) { alert(err.message); }
    }
  });
  document.getElementById('admin-timeout-list-tab')?.closest('.admin-section')?.addEventListener('click', async (e) => {
    const releaseBtn = e.target.closest('.admin-timeout-release');
    if (releaseBtn) {
      const id = releaseBtn.dataset.timeoutId;
      try {
        await apiPost(`/api/admin/timeout/${id}/release`, {});
        loadAdminTimeouts();
      } catch (err) { alert(err.message); }
    }
  });

  document.getElementById('admin-user-list')?.addEventListener('click', async (e) => {
    const card = e.target.closest('.admin-user-card');
    if (card && !e.target.closest('button')) {
      const userId = card.dataset.userId;
      if (userId) showProfileModal(userId);
      return;
    }
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      const userId = btn.dataset.userId;
      if (btn.dataset.action === 'kick') kickUser(userId);
      if (btn.dataset.action === 'allowed') {
        const allowed = btn.dataset.allowed !== '1';
        try {
          await apiPost('/api/admin/users/' + userId + '/allowed', { allowed });
          await loadUsers();
          render();
          bindAdmin();
        } catch (err) { alert(err.message); }
      }
    }
  });
  document.getElementById('admin-user-list')?.addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-action="perm"]');
    if (!cb) return;
    const userId = cb.dataset.userId;
    const perm = cb.dataset.perm;
    const value = !!cb.checked;
    try {
      await apiPatch('/api/admin/users/' + userId + '/permissions', { [perm]: value });
      await loadUsers();
      render();
      bindAdmin();
    } catch (err) { alert(err.message); }
  });
  document.getElementById('admin-inbox-send')?.addEventListener('click', async () => {
    const to = document.getElementById('admin-inbox-user')?.value;
    const title = document.getElementById('admin-inbox-title')?.value ?? '';
    const body = document.getElementById('admin-inbox-body')?.value ?? '';
    if (!to) { alert('Select a user'); return; }
    try {
      await apiPost('/api/inbox/send', { to_user_id: to, title, body });
      alert('Sent.');
    } catch (e) { alert(e.message); }
  });
  document.getElementById('admin-broadcast-send')?.addEventListener('click', async () => {
    const title = document.getElementById('admin-broadcast-title')?.value ?? '';
    const body = document.getElementById('admin-broadcast-body')?.value ?? '';
    try {
      await apiPost('/api/inbox/broadcast', { title, body });
      alert('Broadcast sent.');
    } catch (e) { alert(e.message); }
  });
}

function renderSettingsPage() {
  return `<div class="settings-page-wrap">${renderSettingsContent()}</div>`;
}

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

function renderSettingsContent() {
  const tab = new URLSearchParams(window.location.search || '').get('tab') || 'profile';
  return `
    <div class="settings-page">
      ${tab === 'general' ? `
      <div class="settings-general">
        <h3 class="settings-section-title">Theme</h3>
        <p class="settings-account-desc">Choose the visual theme for the app.</p>
        <label class="settings-form-label">Theme</label>
        <select id="settings-theme" class="settings-select">
          <option value="jimmyqrg" ${state.theme === 'jimmyqrg' ? 'selected' : ''}>JimmyQrg</option>
          <option value="simple" ${state.theme === 'simple' ? 'selected' : ''}>Simple</option>
          <option value="comic" ${state.theme === 'comic' ? 'selected' : ''}>Comic</option>
        </select>
        <h3 class="settings-section-title">System Language</h3>
        <p class="settings-account-desc">Choose the display language for the app.</p>
        <label class="settings-form-label">Language</label>
        <select id="settings-language" class="settings-select">
          ${LANGUAGE_OPTIONS.map(o => `<option value="${o.value}" ${state.language === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      ` : ''}
      ${tab === 'profile' ? `
      <form id="profile-form" class="settings-form">
        <label>Avatar</label>
        <div class="settings-avatar-drop-zone" id="settings-avatar-drop-zone">
          <img src="${state._pendingAvatarObjectUrl || ((state.user?.avatar_url && String(state.user.avatar_url).trim()) ? state.user.avatar_url : getDefaultAvatarUrl(state.user?.id))}" data-fallback="${getDefaultAvatarUrl(state.user?.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="avatar-preview" id="avatar-preview" />
          <span class="settings-avatar-drop-hint">Drop image here or choose below</span>
        </div>
        <label class="file-label">
          <span class="file-label-text">Choose image</span>
          <input type="file" name="avatar" accept="image/*" class="file-input" />
        </label>
        <label>Display name</label>
        <input type="text" name="display_name" value="${escapeHtml(state.user?.display_name || '')}" />
        <label>Description</label>
        <textarea name="description" rows="3" placeholder="A short bio or description">${escapeHtml(state.user?.description || '')}</textarea>
        <label>Website</label>
        <input type="url" name="website" placeholder="https://..." value="${escapeHtml(state.user?.website || '')}" />
        <button type="submit">Save</button>
      </form>
      ` : ''}
      ${tab === 'account' ? `
      <div class="settings-account">
        <div class="settings-account-block">
          <h3 class="settings-section-title">Password</h3>
          <p class="settings-account-desc">Change your password. Your current password is required.</p>
          <button type="button" id="open-password-modal" class="btn-secondary">Change password</button>
        </div>
        <div class="settings-account-block">
          <h3 class="settings-section-title">Sign out</h3>
          <p class="settings-account-desc">Sign out of your account on this device.</p>
          <button type="button" id="sign-out-btn" class="btn-danger">Sign out</button>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

function renderInboxContent() {
  return `
    <div class="inbox-page">
      <h2>Inbox</h2>
      <div id="inbox-list">
        ${(state.inbox || []).length === 0
          ? '<div class="inbox-empty">No mail yet.</div>'
          : (state.inbox || []).map(item => `
          <div class="inbox-item ${item.read_at ? '' : 'unread'}" data-id="${item.id}" data-type="${escapeHtml(item.type)}" data-related="${escapeHtml(item.related_id || '')}" data-extra="${escapeHtml(item.related_extra || '')}">
            <div class="type">${escapeHtml(item.type)}</div>
            <div class="title">${escapeHtml(item.title || '')}</div>
            <div class="body">${escapeHtml(item.body || '')}</div>
            ${item.type === 'friend_request' && !item.read_at ? `
            <div class="inbox-item-actions">
              <button type="button" class="btn-small btn-primary inbox-accept-fr" data-inbox-id="${item.id}">Accept</button>
              <button type="button" class="btn-small inbox-reject-fr" data-inbox-id="${item.id}">Reject</button>
            </div>
            ` : ''}
          </div>
        `).join('')}
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
    loadInbox().then(() => { render(); bindInbox(); }).catch((err) => {
      console.warn('Load inbox failed', err);
      render();
      bindInbox();
    });
    return;
  }
  if (route.page === 'admin') {
    if (!state.user?.is_allowed) {
          navigateTo(getRedirectOrDefault());
      return;
    }
    setState({ panel: '', dmUserId: null });
    render();
    bindAdmin();
    return;
  }
  if (route.page === 'chat') {
    state.panel = route.panel || 'free_chat';
    state.editingDocKey = null;
    state.dmUserId = route.dmUserId || null;
    state.convId = null;
    loadConversations().then(() => {
      if (route.section === 'dms') {
        setState({});
        render();
        bindMain();
        return;
      }
      if (route.dmUserId) {
        apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
          state.convId = conversation_id;
          state.convByUserId[route.dmUserId] = conversation_id;
          state.convIdToUserId[conversation_id] = route.dmUserId;
          return loadMessages('dm', conversation_id).then(() => {
            state.socket?.emit('dm:join', conversation_id, () => {});
            render();
            bindMain();
          });
        }).catch((err) => {
          console.warn('Load conversation/messages failed', err);
          render();
          bindMain();
        });
        return;
      }
      state.convId = null;
      if (state.panel === 'free_chat' || state.panel === 'support') {
        loadMessages('group', state.panel).then(() => { render(); bindMain(); }).catch((err) => {
          console.warn('Load messages failed', err);
          render();
          bindMain();
        });
      } else if (state.panel === 'problem_solving' || state.panel === 'rules' || state.panel === 'announcements') {
        const loadPanelDoc = () => loadDoc(state.panel).then(({ doc }) => {
          state._docContent = doc?.content ?? '';
          render();
          bindMain();
        });
        if (state.panel === 'announcements') {
          apiPost('/api/docs/announcements/sync').then(() => loadPanelDoc(), () => loadPanelDoc());
        } else {
          loadPanelDoc().catch((err) => {
            console.warn('Load doc failed', err);
            render();
            bindMain();
          });
        }
      } else {
        render();
        bindMain();
      }
    }).catch((err) => {
      console.warn('Load conversations failed', err);
      if (route.section === 'dms') { setState({}); render(); bindMain(); return; }
      if (route.dmUserId) {
        apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
          state.convId = conversation_id;
          state.convByUserId[route.dmUserId] = conversation_id;
          state.convIdToUserId[conversation_id] = route.dmUserId;
          return loadMessages('dm', conversation_id).then(() => { state.socket?.emit('dm:join', conversation_id, () => {}); render(); bindMain(); });
        }).catch(() => { render(); bindMain(); });
      } else {
        render();
        bindMain();
      }
    });
  }
}

async function init() {
  const loadingEl = document.querySelector('.loading-text');
  if (loadingEl) loadingEl.textContent = 'Loading…';

  window.addEventListener('popstate', () => applyRoute(parseRoute()));

  // Single delegated listener for in-app links (do not re-attach on every render)
  const appEl = document.getElementById('app');
  if (appEl) {
    interceptLinks(appEl);
    // Delegated listeners for expand/toggle: update state + toggle class on existing DOM (no setState)
    // so first click works and CSS transition/animation run on the same element
    appEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('#panel-column-toggle');
      const expand = e.target.closest('#left-bar-expand');
      const overlay = e.target.closest('#panel-column-overlay');
      if (toggle) {
        e.preventDefault();
        state.panelColumnExpanded = !state.panelColumnExpanded;
        const panel = document.getElementById('panel-column');
        if (panel) panel.classList.toggle('panel-column-expanded', state.panelColumnExpanded);
        const btn = document.getElementById('panel-column-toggle');
        if (btn) {
          btn.title = state.panelColumnExpanded ? 'Close panels' : 'Open panels';
          btn.setAttribute('aria-label', btn.title);
          const icon = btn.querySelector('.left-bar-icon');
          if (icon) icon.innerHTML = state.panelColumnExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
        }
      } else if (expand) {
        e.preventDefault();
        state.leftBarExpanded = !state.leftBarExpanded;
        try { localStorage.setItem('leftBarExpanded', state.leftBarExpanded ? '1' : '0'); } catch (_) {}
        const bar = document.getElementById('left-bar');
        if (bar) bar.classList.toggle('left-bar-expanded', state.leftBarExpanded);
        const expandBtn = document.getElementById('left-bar-expand');
        if (expandBtn) {
          expandBtn.title = state.leftBarExpanded ? 'Collapse' : 'Expand';
          const icon = expandBtn.querySelector('.left-bar-icon');
          const label = expandBtn.querySelector('.left-bar-label');
          if (icon) icon.innerHTML = state.leftBarExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
          if (label) label.textContent = state.leftBarExpanded ? 'Collapse' : 'Expand';
        }
      } else if (overlay) {
        e.preventDefault();
        state.panelColumnExpanded = false;
        const panel = document.getElementById('panel-column');
        if (panel) panel.classList.remove('panel-column-expanded');
        const btn = document.getElementById('panel-column-toggle');
        if (btn) {
          btn.title = 'Open panels';
          btn.setAttribute('aria-label', 'Open panels');
          const icon = btn.querySelector('.left-bar-icon');
          if (icon) icon.innerHTML = ICON_CHEVRON_RIGHT;
        }
      }
    });
  }

  const user = await loadMe();
  const route = parseRoute();

  if (!user) {
    if (route.page !== 'login' && route.page !== 'signup') {
      navigateTo(authPath('login', getPath()));
      return;
    }
    render();
    return;
  }

  await loadGroup();
  await loadUsers();
  await loadInbox();
  await loadFriends();
  connectSocket();

  const path = getPath();
  if (path === '/' || path === '') {
    navigateTo(getRedirectOrDefault());
    return;
  }
  applyRoute(route);
}

function showPasswordModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 400px;">
      <h3>Change password</h3>
      <p class="modal-hint">Your current password is required.</p>
      <form id="password-modal-form">
        <label>Current password</label>
        <input type="password" name="current_password" autocomplete="current-password" placeholder="Current password" />
        <label>New password</label>
        <input type="password" name="new_password" autocomplete="new-password" placeholder="At least 6 characters" />
        <label>Confirm new password</label>
        <input type="password" name="new_password_confirm" autocomplete="new-password" placeholder="Confirm new password" />
        <p id="password-modal-message" class="settings-form-message" aria-live="polite"></p>
        <div class="modal-actions">
          <button type="button" id="password-modal-cancel" class="modal-close">Cancel</button>
          <button type="submit" class="btn-primary">Change password</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#password-modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#password-modal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const msgEl = overlay.querySelector('#password-modal-message');
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn?.disabled) return;
    const currentInput = form.querySelector('input[name="current_password"]');
    const newInput = form.querySelector('input[name="new_password"]');
    const confirmInput = form.querySelector('input[name="new_password_confirm"]');
    const current = (currentInput?.value ?? '').trim();
    const newPass = (newInput?.value ?? '').trim();
    const confirm = (confirmInput?.value ?? '').trim();
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
    if (submitBtn) submitBtn.disabled = true;
    try {
      const payload = { current_password: current, new_password: newPass };
      await apiPatch('/api/users/password', payload);
      if (msgEl) { msgEl.textContent = 'Password changed.'; msgEl.dataset.type = 'success'; }
      form.reset();
      setTimeout(() => overlay.remove(), 800);
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message || 'Failed to change password.'; msgEl.dataset.type = 'error'; }
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function bindSettings() {
  document.getElementById('settings-theme')?.addEventListener('change', (e) => {
    const theme = e.target.value;
    state.theme = theme;
    if (typeof localStorage !== 'undefined') localStorage.setItem('theme', theme);
    applyTheme(theme);
    setState({});
  });
  document.getElementById('settings-language')?.addEventListener('change', (e) => {
    const lang = e.target.value;
    state.language = lang;
    if (typeof localStorage !== 'undefined') localStorage.setItem('language', lang);
    if (document.documentElement) document.documentElement.setAttribute('lang', lang);
    applyGoogleTranslate();
    setState({});
  });
  document.getElementById('open-password-modal')?.addEventListener('click', showPasswordModal);
  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    state.user = null;
    state.socket?.disconnect();
    state.socket = null;
    navigateTo('/login');
  });
  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    if (state._pendingAvatarFile) {
      formData.set('avatar', state._pendingAvatarFile);
      state._pendingAvatarFile = null;
      if (state._pendingAvatarObjectUrl) {
        URL.revokeObjectURL(state._pendingAvatarObjectUrl);
        state._pendingAvatarObjectUrl = null;
      }
    }
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        credentials: 'include',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.user = data.user;
      setState({});
    } catch (err) {
      alert(err.message);
    }
  });

  const profileForm = document.getElementById('profile-form');
  const avatarFileInput = profileForm?.querySelector('input[name="avatar"]');
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (state._pendingAvatarObjectUrl) URL.revokeObjectURL(state._pendingAvatarObjectUrl);
      state._pendingAvatarFile = file;
      state._pendingAvatarObjectUrl = URL.createObjectURL(file);
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = state._pendingAvatarObjectUrl;
      setState({});
    });
  }

  const settingsAvatarDrop = document.getElementById('settings-avatar-drop-zone');
  if (settingsAvatarDrop) {
    ['dragenter', 'dragover'].forEach((ev) => {
      settingsAvatarDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) settingsAvatarDrop.classList.add('settings-avatar-drag-over');
      });
    });
    settingsAvatarDrop.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!settingsAvatarDrop.contains(e.relatedTarget)) settingsAvatarDrop.classList.remove('settings-avatar-drag-over');
    });
    settingsAvatarDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settingsAvatarDrop.classList.remove('settings-avatar-drag-over');
      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (state._pendingAvatarObjectUrl) URL.revokeObjectURL(state._pendingAvatarObjectUrl);
      state._pendingAvatarFile = file;
      state._pendingAvatarObjectUrl = URL.createObjectURL(file);
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = state._pendingAvatarObjectUrl;
      setState({});
    });
  }

}

function bindInbox() {
  document.getElementById('inbox-list')?.addEventListener('click', async (e) => {
    const acceptBtn = e.target.closest('.inbox-accept-fr');
    const rejectBtn = e.target.closest('.inbox-reject-fr');
    if (acceptBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = acceptBtn.dataset.inboxId;
      try {
        await apiPost('/api/friends/accept', { inbox_id: inboxId });
        await loadInbox();
        await loadFriends();
        render();
        bindInbox();
      } catch (err) { alert(err.message); }
      return;
    }
    if (rejectBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = rejectBtn.dataset.inboxId;
      try {
        await apiPost('/api/friends/reject', { inbox_id: inboxId });
        await loadInbox();
        render();
        bindInbox();
      } catch (err) { alert(err.message); }
      return;
    }
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
      if (extra.panel === 'problem_solving') navigateTo('/chat/group?panel=problem');
    } catch (_) {}
  });
}

init();
