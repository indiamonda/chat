const base = '';

export async function api(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || res.statusText);
  }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

export function apiGet(path) {
  return api(path);
}

export function apiPost(path, body) {
  return api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

export function apiPatch(path, body) {
  return api(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
}

export function apiPut(path, body) {
  return api(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
}

export function apiDelete(path) {
  return api(path, { method: 'DELETE' });
}

export async function uploadFile(path, file, extra = {}) {
  const form = new FormData();
  form.append('file', file);
  Object.entries(extra).forEach(([k, v]) => {
    if (v != null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
  });
  const res = await fetch(base + path, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const AVATAR_COLOR_COUNT = 108;

/** Deterministic 32-bit hash so the same user id always yields the same color everywhere. */
function simpleHash(str) {
  if (!str) return 0;
  let h = 0;
  const s = String(str).trim();
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Generate 100+ distinct hex colors (HSL hue spread + slight S/L variation for variety). */
function getAvatarColors(n) {
  const colors = [];
  const golden = 0.618033988749895;
  for (let i = 0; i < n; i++) {
    const hue = (i * golden * 360) % 360;
    const sat = 52 + (simpleHash(String(i)) % 28);
    const light = 42 + (simpleHash(String(i + n)) % 26);
    colors.push(hslToHex(hue, sat, light));
  }
  return colors;
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const avatarColors = getAvatarColors(AVATAR_COLOR_COUNT);

/** Darken a hex color for avatar background (person shape stays in main color). */
function darkenHex(hex, factor = 0.35) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Returns a default avatar as data URL: person silhouette (like default-avatar-0) with one of 108 colors. Same user id always gets the same color across devices and time. */
export function getDefaultAvatarUrl(userIdOrUsername) {
  const key = userIdOrUsername != null ? String(userIdOrUsername).trim() : '';
  const i = key ? simpleHash(key) % AVATAR_COLOR_COUNT : 0;
  const fill = avatarColors[i];
  const bg = darkenHex(fill);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="32" fill="${bg}"/><circle cx="32" cy="26" r="12" fill="${fill}"/><ellipse cx="32" cy="58" rx="20" ry="14" fill="${fill}"/></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** Fallback when no user id/username is available. */
export const DEFAULT_AVATAR = getDefaultAvatarUrl('default');
