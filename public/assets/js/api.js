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

export const DEFAULT_AVATAR = '/assets/default-avatar.svg';
