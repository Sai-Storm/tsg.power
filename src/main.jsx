import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';
import './functional.css';

try { document.documentElement.dataset.theme = localStorage.getItem('tsg-theme') === 'light' ? 'light' : 'dark'; } catch { document.documentElement.dataset.theme = 'dark'; }
try { const themeMeta = document.querySelector('meta[name="theme-color"]'); if (themeMeta) themeMeta.setAttribute('content', document.documentElement.dataset.theme === 'light' ? '#c6d9fb' : '#0a2353'); } catch { /* Ignore missing theme meta. */ }

window.__tsgInstallPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  window.__tsgInstallPrompt = event;
  window.dispatchEvent(new Event('tsg-install-available'));
});
window.addEventListener('appinstalled', () => {
  window.__tsgInstallPrompt = null;
  window.dispatchEvent(new Event('tsg-app-installed'));
});
// After a new version is deployed, the old page files are gone. If an open tab
// asks for one, reload once to pick up the new version instead of breaking.
window.addEventListener('vite:preloadError', event => {
  try {
    const last = Number(sessionStorage.getItem('tsg-reloaded-for-update') || 0);
    if (Date.now() - last < 60_000) return;   // already tried; let the error show
    sessionStorage.setItem('tsg-reloaded-for-update', String(Date.now()));
  } catch { /* storage blocked: still try once */ }
  event.preventDefault();
  window.location.reload();
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>
  </React.StrictMode>,
);
