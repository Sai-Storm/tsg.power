import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ArrowRight, Bell, Check, ChevronRight, DatabaseZap, LogOut, Menu, Moon, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { getCurrentUser, onAuthStateChange, signInWithGoogle, signInWithPassword, signOut as endSession } from './api/auth.js';
import { isSupabaseConfigured } from './api/supabase.js';
import { navigation } from './data.js';
import { AskHost } from './components/AskDialog.jsx';
import Login, { LoginNotice } from './pages/Login.jsx';
import { initials } from './lib/records.js';
import { initialUser, oauthErrorFromUrl } from './lib/session.js';
import { isAdminRole, isFinanceRole } from './lib/roles.js';
import { useSchemaCheck, useUnreadCount } from './lib/useAppStatus.js';
import { flushOfflineDrafts } from './lib/offlineDrafts.js';

// App shell: sign-in, sidebar, top bar and routes. Each page is loaded only
// when it is first opened, so the first visit downloads far less code.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx'));
const JobProfitability = lazy(() => import('./pages/JobProfitability.jsx'));
const AdvanceOverview = lazy(() => import('./pages/AdvanceOverview.jsx'));
const TeamSchedule = lazy(() => import('./TeamSchedule.jsx'));
const CashBoard = lazy(() => import('./CashBoard.jsx'));
const Receivables = lazy(() => import('./pages/Receivables.jsx'));
const Purchasing = lazy(() => import('./pages/Purchasing.jsx'));
const ManagementReport = lazy(() => import('./pages/ManagementReport.jsx'));
const ModuleRoute = lazy(() => import('./modules/ModulePage.jsx'));

const PAGE_TITLES = { '/reports': 'Reports', '/cash-board': 'Cash board', '/job-profitability': 'Job profitability', '/advance-overview': 'Advance overview', '/receivables': 'Receivables', '/purchasing': 'Purchasing', '/management-report': 'Management report' };

function PageLoading() {
  return <div className="page-loading" role="status" aria-live="polite"><span className="loading-bar"><span /></span>Loading…</div>;
}

export default function App() {
  const [user, setUser] = useState(initialUser);
  // While Supabase restores the session (reload, new tab, Google redirect) show a splash instead of flashing the login page.
  const [authChecking, setAuthChecking] = useState(() => isSupabaseConfigured && !initialUser());
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [loginNotice, setLoginNotice] = useState(null);
  const [globalSearch, setGlobalSearch] = useState('');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('tsg-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  const location = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#c6d9fb' : '#0a2353');
    try { localStorage.setItem('tsg-theme', theme); } catch { /* Theme preference is session-only when storage is unavailable. */ }
  }, [theme]);
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = event => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape); };
  }, [menuOpen]);

  const notify = message => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
  const showLoginNotice = (type, message) => {
    const id = Date.now();
    setLoginNotice({ id, type, message });
    window.setTimeout(() => setLoginNotice(current => (current?.id === id ? null : current)), type === 'success' ? 4000 : 6000);
  };
  const login = async credentials => {
    const nextUser = await signInWithPassword(credentials.email, credentials.password);
    sessionStorage.removeItem('tsg_token');
    sessionStorage.removeItem('tsg_refresh_token');
    sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
    setUser(nextUser);
    showLoginNotice('success', `Welcome back, ${nextUser.name.split(' ')[0]}.`);
  };
  const loginWithGoogle = async () => { sessionStorage.setItem('tsg-login-pending', 'google'); await signInWithGoogle(); };
  const logout = () => {
    endSession().catch(() => {});
    ['tsg_user', 'tsg_token', 'tsg_refresh_token'].forEach(key => sessionStorage.removeItem(key));
    setUser(null);
  };

  useEffect(() => {
    const sync = () => setUser(initialUser());
    window.addEventListener('tsg-user-updated', sync);
    return () => window.removeEventListener('tsg-user-updated', sync);
  }, []);
  useEffect(() => {
    if (user && sessionStorage.getItem('tsg-login-pending') === 'google') {
      sessionStorage.removeItem('tsg-login-pending');
      showLoginNotice('success', `Welcome back, ${user.name.split(' ')[0]}.`);
    }
  }, [user]);
  // Daily reminders and alerts (also scheduled in the database when pg_cron is
  // on). Each one is sent at most once a day, so calling them on login is safe.
  useEffect(() => {
    if (!isFinanceRole(user?.role)) return;
    apiRequest('/advances/reminders', { method: 'POST' }).catch(() => {});
    apiRequest('/alerts/daily', { method: 'POST' }).catch(() => {});
  }, [user?.id, user?.role]);
  // Expenses saved on the phone while offline upload once the connection is back.
  useEffect(() => {
    if (!user?.id) return undefined;
    const sync = () => flushOfflineDrafts().then(count => { if (count) notify(`${count} expense${count === 1 ? '' : 's'} saved offline ${count === 1 ? 'was' : 'were'} uploaded.`); }).catch(() => {});
    sync();
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [user?.id]);
  const unread = useUnreadCount(user);
  const schemaProblem = useSchemaCheck(user);
  useEffect(() => {
    let active = true;
    const redirectError = oauthErrorFromUrl();
    const pendingGoogle = sessionStorage.getItem('tsg-login-pending') === 'google';
    if (redirectError) { sessionStorage.removeItem('tsg-login-pending'); showLoginNotice('error', redirectError); }
    getCurrentUser().then(nextUser => {
      if (active && nextUser) { sessionStorage.setItem('tsg_user', JSON.stringify(nextUser)); setUser(nextUser); return; }
      if (active && pendingGoogle && !redirectError) { sessionStorage.removeItem('tsg-login-pending'); showLoginNotice('error', 'Google sign-in did not complete. Please try again.'); }
    }).catch(() => {
      if (active && pendingGoogle) { sessionStorage.removeItem('tsg-login-pending'); showLoginNotice('error', 'Google sign-in could not be completed. Please try again.'); }
    }).finally(() => { if (active) setAuthChecking(false); });
    const listener = onAuthStateChange((nextUser, event) => {
      if (!active) return;
      setAuthChecking(false);
      if (event === 'SIGNED_OUT' || !nextUser) { sessionStorage.removeItem('tsg_user'); setUser(null); return; }
      sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
      setUser(nextUser);
    });
    return () => { active = false; listener.unsubscribe(); };
  }, []);

  if (!user && authChecking) return <div className="login-screen" style={{ display: 'grid', placeItems: 'center' }} aria-busy="true"><img src="/tsg-mark.png" alt="TSG" style={{ width: 72, opacity: 0.9 }} /></div>;
  if (!user) return <>
    <Login onLogin={login} onGoogleLogin={loginWithGoogle} onLoginError={message => showLoginNotice('error', message)} onClearLoginNotice={() => setLoginNotice(null)} />
    <LoginNotice notice={loginNotice} onClose={() => setLoginNotice(null)} />
    <AskHost />
  </>;

  const isAdmin = isAdminRole(user.role);
  const isFinance = isFinanceRole(user.role);
  const currentPage = navigation.find(item => item.path === location.pathname)?.label || PAGE_TITLES[location.pathname] || 'Dashboard';
  const matchingModules = navigation.filter(item => item.path && item.roles?.includes(user.role) && item.label.toLowerCase().includes(globalSearch.trim().toLowerCase())).slice(0, 6);
  const financeOnly = element => (isFinance ? element : <Navigate to="/" replace />);
  const unreadLabel = unread > 99 ? '99+' : String(unread);

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand">
        <img className="brand-logo" src="/tsg-logo.png" alt="TSG Power Engineering Co., Ltd." />
        <button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={18} /></button>
      </div>
      <div className="nav-label">WORKSPACE</div>
      <nav className="nav-list">
        {navigation.filter(item => item.roles?.includes(user.role)).map((item, i) => (item.section
          ? <div className="nav-section" key={`${item.section}-${i}`}>{item.section}</div>
          : <NavLink key={item.path} to={item.path} end={item.path === '/'} onClick={() => setMenuOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.path === '/notifications' && unread > 0 && <i className="nav-count" aria-label={`${unread} unread`}>{unreadLabel}</i>}
          </NavLink>))}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-version">TSG Management System <span>v1.0.0</span></div></div>
    </aside>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}

    <main className="main-panel">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><b>{currentPage}</b></div>
        </div>
        <div className="global-module-search">
          <Search size={16} />
          <input aria-label="Search modules" placeholder="Find a module…" value={globalSearch} onChange={event => setGlobalSearch(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') setGlobalSearch(''); if (event.key === 'Enter' && matchingModules[0]) { window.location.assign(matchingModules[0].path); setGlobalSearch(''); } }} />
          {globalSearch && <button aria-label="Clear search" onClick={() => setGlobalSearch('')}><X size={14} /></button>}
          {globalSearch && <div className="module-search-results">
            {matchingModules.length
              ? matchingModules.map(item => <Link key={item.path} to={item.path} onClick={() => setGlobalSearch('')}><item.icon size={17} /><span>{item.label}</span><ArrowRight size={14} /></Link>)
              : <span>No matching modules</span>}
          </div>}
        </div>
        <div className="topbar-right">
          <div className="today-label"><span className="today-dot" />System operational</div>
          <Link to="/notifications" className="top-icon" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}><Bell size={19} />{unread > 0 && <i className="top-count">{unreadLabel}</i>}</Link>
          <button className="top-icon theme-toggle" onClick={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button>
          <div className="top-divider" />
          <button className="profile-button" onClick={logout} title="Sign out">
            <div className="avatar">{user.avatar ? <img src={user.avatar} alt={`${user.name} profile`} /> : initials(user.name)}</div>
            <div className="profile-copy"><b>{user.name}</b><span>{user.role} account</span></div>
            <LogOut size={16} className="logout-icon" />
          </button>
        </div>
      </header>

      <div className="page-content">
        {schemaProblem && <div className="schema-banner" role="alert">
          <DatabaseZap size={20} />
          <div>
            <b>Database update needed</b>
            {isAdmin
              ? <span>The app was updated but the database was not (database version {schemaProblem.current}, needs {schemaProblem.required}). Run the newest files in <code>supabase/migrations</code> in the Supabase SQL Editor, then reload. Some pages will show errors until then.</span>
              : <span>The system is being updated. Some pages may not work until an administrator finishes the update.</span>}
          </div>
        </div>}
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<Dashboard user={user} />} />
            <Route path="/profile" element={<ProfilePage user={user} notify={notify} />} />
            <Route path="/schedule" element={<TeamSchedule user={user} />} />
            <Route path="/cash-board" element={financeOnly(<CashBoard user={user} notify={notify} />)} />
            <Route path="/reports" element={financeOnly(<ReportsPage notify={notify} />)} />
            <Route path="/job-profitability" element={financeOnly(<JobProfitability notify={notify} />)} />
            <Route path="/advance-overview" element={financeOnly(<AdvanceOverview />)} />
            <Route path="/receivables" element={financeOnly(<Receivables notify={notify} />)} />
            <Route path="/purchasing" element={financeOnly(<Purchasing notify={notify} />)} />
            <Route path="/management-report" element={financeOnly(<ManagementReport />)} />
            <Route path="*" element={<ModuleRoute user={user} notify={notify} />} />
          </Routes>
        </Suspense>
        <footer className="page-footer"><span>© 2026 TSG Power Engineering</span><span>Secure operations <ShieldCheck size={13} /></span></footer>
      </div>
    </main>
    <LoginNotice notice={loginNotice} onClose={() => setLoginNotice(null)} />
    <AskHost />
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}
