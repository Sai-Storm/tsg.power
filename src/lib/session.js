// Signed-in user cached for the browser tab.

export const initialUser = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem('tsg_user') || 'null');
    // Old preview ("demo-") sessions are no longer supported.
    if (saved?.id?.startsWith('demo-')) { sessionStorage.removeItem('tsg_user'); return null; }
    return saved;
  } catch {
    return null;
  }
};

export function saveSessionUser(nextUser) {
  sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
  window.dispatchEvent(new Event('tsg-user-updated'));
}

/** Reads (and removes from the address bar) an OAuth error returned by Google sign-in. */
export function oauthErrorFromUrl() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const description = query.get('error_description') || hash.get('error_description');
  const code = query.get('error') || hash.get('error') || query.get('error_code') || hash.get('error_code');
  if (!description && !code) return '';
  const cleaned = new URL(window.location.href);
  ['error', 'error_code', 'error_description'].forEach(key => cleaned.searchParams.delete(key));
  const hashParams = new URLSearchParams(cleaned.hash.replace(/^#/, ''));
  ['error', 'error_code', 'error_description'].forEach(key => hashParams.delete(key));
  cleaned.hash = hashParams.toString() ? `#${hashParams.toString()}` : '';
  window.history.replaceState({}, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
  if (description) return description;
  if (code === 'access_denied') return 'Google sign-in was cancelled.';
  return `Google sign-in could not be completed${code ? ` (${code})` : ''}. Please try again.`;
}
