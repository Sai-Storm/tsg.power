import { useEffect, useState } from 'react';
import { ArrowRight, Check, Download, ShieldCheck, X } from 'lucide-react';

export function LoginNotice({ notice, onClose }) {
  if (!notice) return null;
  const success = notice.type === 'success';
  return (
    <div className={`login-alert ${success ? 'is-success' : ''}`} role={success ? 'status' : 'alert'} aria-live="polite">
      <span className="login-alert-icon">{success ? <Check size={14} /> : '!'}</span>
      <div className="login-alert-copy">
        <b>{success ? 'Login successful' : 'Login failed'}</b>
        <span>{notice.message}</span>
      </div>
      <button type="button" aria-label="Dismiss message" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

function useInstallPrompt() {
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const [available, setAvailable] = useState(() => Boolean(window.__tsgInstallPrompt));
  const [installed, setInstalled] = useState(isStandalone);
  useEffect(() => {
    const sync = () => {
      setAvailable(Boolean(window.__tsgInstallPrompt));
      setInstalled(isStandalone());
    };
    const installedHandler = () => {
      setAvailable(false);
      setInstalled(true);
    };
    window.addEventListener('tsg-install-available', sync);
    window.addEventListener('tsg-app-installed', installedHandler);
    return () => {
      window.removeEventListener('tsg-install-available', sync);
      window.removeEventListener('tsg-app-installed', installedHandler);
    };
  }, []);
  const install = async () => {
    const prompt = window.__tsgInstallPrompt;
    if (!prompt) return false;
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (choice.outcome === 'accepted') {
      window.__tsgInstallPrompt = null;
      setAvailable(false);
    }
    return choice.outcome === 'accepted';
  };
  return { canInstall: available, installed, install };
}

export default function Login({ onLogin, onGoogleLogin, onLoginError, onClearLoginNotice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const { canInstall, installed, install } = useInstallPrompt();
  const [installMessage, setInstallMessage] = useState('');
  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    onClearLoginNotice();
    try {
      await onLogin({ email, password });
    } catch (err) {
      onLoginError(err.message || 'Could not sign in. Check your details and try again.');
    } finally {
      setBusy(false);
    }
  };
  const google = async () => {
    setGoogleBusy(true);
    onClearLoginNotice();
    try {
      await onGoogleLogin();
    } catch (err) {
      onLoginError(err.message || 'Could not start Google sign-in.');
      setGoogleBusy(false);
    }
  };
  const handleInstall = async () => {
    setInstallMessage('');
    if (canInstall) {
      await install();
      return;
    }
    const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setInstallMessage(
      iOS
        ? 'On iPhone or iPad: tap the Share button, then choose Add to Home Screen.'
        : 'Open your browser menu and choose Install app or Add to Home screen.',
    );
  };
  return (
    <div className="login-screen">
      <div className="login-art">
        <div className="login-art-grid" />
        <div className="login-art-content">
          <div className="login-logo-stage">
            <span className="login-ring r1" aria-hidden="true" />
            <span className="login-ring r2" aria-hidden="true" />
            <div className="login-logo-wrap">
              <img className="login-center-logo" src="/tsg-mark.png" alt="TSG" />
            </div>
          </div>
        </div>
      </div>
      <div className="login-side">
        <div className="login-form-wrap">
          <div className="mobile-login-mark">
            <span className="login-mobile-wrap">
              <img className="login-mobile-logo" src="/tsg-mark.png" alt="TSG" />
            </span>
          </div>
          <div className="eyebrow">WELCOME BACK</div>
          <h2>Sign in</h2>
          <p className="login-subtitle">Use your account to continue.</p>
          <form onSubmit={submit}>
            <label>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Enter your email"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
              />
            </label>
            <button className="primary-button login-submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              <ArrowRight size={16} />
            </button>
          </form>
          <div className="login-divider">
            <span />
            OR
            <span />
          </div>
          <button type="button" className="google-signin" onClick={google} disabled={googleBusy}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path
                fill="#FFC107"
                d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
              />
              <path
                fill="#FF3D00"
                d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
              />
              <path
                fill="#4CAF50"
                d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
              />
              <path
                fill="#1976D2"
                d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.3 5.3C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"
              />
            </svg>
            {googleBusy ? 'Opening Google…' : 'Continue with Google'}
          </button>
          {!installed && (
            <div className="install-app-row">
              <button type="button" className="install-app-button" onClick={handleInstall}>
                <Download size={18} />
                <span>
                  <b>Install app</b>
                  <small>Add TSG to your home screen</small>
                </span>
              </button>
              {installMessage && <p className="install-app-note">{installMessage}</p>}
            </div>
          )}
          <div className="login-security">
            <ShieldCheck size={15} /> Secure sign-in · Accounts managed by your administrator
          </div>
        </div>
        <div className="login-copyright">© 2026 TSG</div>
      </div>
    </div>
  );
}
