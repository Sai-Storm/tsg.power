import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';
import './functional.css';

try { document.documentElement.dataset.theme = localStorage.getItem('tsg-theme') === 'light' ? 'light' : 'dark'; } catch { document.documentElement.dataset.theme = 'dark'; }
try { const themeMeta = document.querySelector('meta[name="theme-color"]'); if (themeMeta) themeMeta.setAttribute('content', document.documentElement.dataset.theme === 'light' ? '#f5f7fa' : '#0d2032'); } catch { /* Ignore missing theme meta. */ }

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
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>
  </React.StrictMode>,
);
