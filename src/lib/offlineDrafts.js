// Advance expenses saved without a connection (on site, poor signal).
// They are kept on this device in IndexedDB, receipt photos included, and
// uploaded as normal drafts as soon as the connection is back.
import { apiRequest } from '../api/client.js';

const DB_NAME = 'tsg-offline';
const STORE = 'advance-drafts';
const CHANGED = 'tsg-offline-drafts';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot save offline.')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = work(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const announce = () => window.dispatchEvent(new Event(CHANGED));

/** True when an error means "no connection" rather than "the server said no". */
export function isOfflineError(error) {
  return (typeof navigator !== 'undefined' && navigator.onLine === false)
    || /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(String(error?.message || error || ''));
}

export async function saveOfflineDraft(advanceId, fields, files = []) {
  await withStore('readwrite', store => store.add({ advanceId: String(advanceId), fields, files, savedAt: new Date().toISOString() }));
  announce();
}

export async function offlineDrafts(advanceId) {
  try {
    const all = await withStore('readonly', store => store.getAll());
    return (all || []).filter(item => !advanceId || item.advanceId === String(advanceId));
  } catch { return []; }
}

export async function removeOfflineDraft(key) {
  await withStore('readwrite', store => store.delete(key));
  announce();
}

export function onOfflineDraftsChanged(listener) {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}

let flushing = null;
/** Uploads every saved draft. Returns how many were uploaded. */
export function flushOfflineDrafts() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
    const pending = await offlineDrafts();
    let uploaded = 0;
    for (const item of pending) {
      const body = new FormData();
      Object.entries(item.fields || {}).forEach(([key, value]) => body.append(key, value == null ? '' : String(value)));
      (item.files || []).forEach(file => body.append('receipt_files', file, file.name || 'receipt.jpg'));
      try {
        await apiRequest(`/advances/${encodeURIComponent(item.advanceId)}/draft`, { method: 'POST', body });
        await removeOfflineDraft(item.key);
        uploaded += 1;
      } catch (error) {
        if (isOfflineError(error)) break; // still offline: try again later
        // The server refused it (e.g. the advance was closed meanwhile): keep it
        // so the person can see it and delete it themselves.
        await withStore('readwrite', store => store.put({ ...item, error: error.message }));
        announce();
      }
    }
    if (uploaded) window.dispatchEvent(new Event('tsg-offline-uploaded'));
    return uploaded;
  })().finally(() => { flushing = null; });
  return flushing;
}
