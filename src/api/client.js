const API_URL = import.meta.env.VITE_API_URL || '/api';

export async function apiRequest(path, options = {}) {
  const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const send = token => fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...(!multipart ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  let token = sessionStorage.getItem('tsg_token');
  let response = await send(token);
  if (response.status === 401 && sessionStorage.getItem('tsg_refresh_token')) {
    const refreshResponse = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: sessionStorage.getItem('tsg_refresh_token') }),
    });
    if (refreshResponse.ok) {
      const refreshed = await refreshResponse.json();
      token = refreshed.accessToken || refreshed.access_token || refreshed.token;
      if (token) { sessionStorage.setItem('tsg_token', token); response = await send(token); }
    }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

export async function signIn(username, password) {
  return apiRequest('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export async function exportModule(module, format, filters = {}) {
  const query = new URLSearchParams({ ...filters, format }).toString();
  const token = sessionStorage.getItem('tsg_token');
  const response = await fetch(`${API_URL}/${module}?${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('Export is not available until the API is connected.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${module}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
