import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Download, FileDown, Filter, LogOut, Menu, Moon, MoreHorizontal, Plus, Search, ShieldCheck, Sun, Trash2, Wrench, X, FileText as FileTextIcon } from 'lucide-react';
import { apiRequest, exportModule } from './api/client.js';
import { getCurrentUser, onAuthStateChange, signInWithGoogle, signInWithPassword, signOut as endSession } from './api/auth.js';
import { moduleInfo, navigation } from './data.js';
import { emptyItems, emptyMaterials, emptyRequestItems, formSchemas } from './formSchemas.js';

const initialUser = () => { try { const saved = JSON.parse(sessionStorage.getItem('tsg_user') || 'null'); if (saved?.id?.startsWith('demo-')) { sessionStorage.removeItem('tsg_user'); return null; } return saved; } catch { return null; } };
const initials = (name = '') => name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();
const accountAvatarKey = 'tsg-demo-account-avatars';
const readAccountAvatars = () => { try { return JSON.parse(localStorage.getItem(accountAvatarKey) || '{}'); } catch { return {}; } };
const accountAvatar = username => readAccountAvatars()[String(username || '').toLowerCase()] || '';
const saveAccountAvatar = (username, photo) => { const avatars = readAccountAvatars(); const key = String(username || '').toLowerCase(); if (photo) avatars[key] = photo; else delete avatars[key]; try { localStorage.setItem(accountAvatarKey, JSON.stringify(avatars)); } catch { /* Storage full — keep the picture in the current session only. */ } };
const rowAvatar = row => row?._record?.avatar || row?._record?.profile_picture || '';

function App() {
  const [user, setUser] = useState(initialUser);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [globalSearch, setGlobalSearch] = useState('');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('tsg-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  const location = useLocation();
  useEffect(() => { document.documentElement.dataset.theme = theme; const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', theme === 'light' ? '#c6d9fb' : '#0a2353'); try { localStorage.setItem('tsg-theme', theme); } catch { /* Theme preference is session-only when storage is unavailable. */ } }, [theme]);
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = event => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape); };
  }, [menuOpen]);
  const notify = message => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
  const login = async credentials => {
    const nextUser = await signInWithPassword(credentials.email, credentials.password);
    sessionStorage.removeItem('tsg_token');
    sessionStorage.removeItem('tsg_refresh_token');
    sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
    setUser(nextUser);
    notify(`Login successful — welcome back, ${nextUser.name.split(' ')[0]}`);
  };
  const loginWithGoogle = async () => { sessionStorage.setItem('tsg-login-pending', 'google'); await signInWithGoogle(); };
  const logout = () => { endSession().catch(() => {}); sessionStorage.removeItem('tsg_user'); sessionStorage.removeItem('tsg_token'); sessionStorage.removeItem('tsg_refresh_token'); setUser(null); };
  useEffect(() => { const sync = () => setUser(initialUser()); window.addEventListener('tsg-user-updated', sync); return () => window.removeEventListener('tsg-user-updated', sync); }, []);
  useEffect(() => { if (user && sessionStorage.getItem('tsg-login-pending') === 'google') { sessionStorage.removeItem('tsg-login-pending'); notify(`Login successful — welcome back, ${user.name.split(' ')[0]}`); } }, [user]);
  useEffect(() => {
    let active = true;
    getCurrentUser().then(nextUser => { if (active && nextUser) { sessionStorage.setItem('tsg_user', JSON.stringify(nextUser)); setUser(nextUser); } }).catch(() => {});
    const listener = onAuthStateChange((nextUser, event) => {
      if (!active) return;
      if (event === 'SIGNED_OUT' || !nextUser) { sessionStorage.removeItem('tsg_user'); setUser(null); return; }
      sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
      setUser(nextUser);
    });
    return () => { active = false; listener.unsubscribe(); };
  }, []);

  if (!user) return <Login onLogin={login} onGoogleLogin={loginWithGoogle} />;
  const currentPage = navigation.find(item => item.path === location.pathname)?.label || (location.pathname === '/reports' ? 'Reports' : 'Dashboard');
  const matchingModules = navigation.filter(item => item.path && item.roles?.includes(user.role) && item.label.toLowerCase().includes(globalSearch.trim().toLowerCase())).slice(0, 6);
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><img className="brand-logo" src="/tsg-logo.png" alt="TSG Power Engineering Co., Ltd." /><button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="nav-label">WORKSPACE</div>
      <nav className="nav-list">{navigation.filter(item => item.roles?.includes(user.role)).map((item, i) => item.section
        ? <div className="nav-section" key={`${item.section}-${i}`}>{item.section}</div>
        : <NavLink key={item.path} to={item.path} end={item.path === '/'} onClick={() => setMenuOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.path === '/notifications' && <i className="nav-dot" />}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-version">TSG Management System <span>v1.0.0</span></div></div>
    </aside>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><b>{currentPage}</b></div></div><div className="global-module-search"><Search size={16}/><input aria-label="Search modules" placeholder="Find a module…" value={globalSearch} onChange={event => setGlobalSearch(event.target.value)} onKeyDown={event => { if(event.key==='Escape') setGlobalSearch(''); if(event.key==='Enter'&&matchingModules[0]) { window.location.assign(matchingModules[0].path); setGlobalSearch(''); } }}/>{globalSearch&&<button aria-label="Clear search" onClick={()=>setGlobalSearch('')}><X size={14}/></button>}{globalSearch&&<div className="module-search-results">{matchingModules.length?matchingModules.map(item=><Link key={item.path} to={item.path} onClick={()=>setGlobalSearch('')}><item.icon size={17}/><span>{item.label}</span><ArrowRight size={14}/></Link>):<span>No matching modules</span>}</div>}</div><div className="topbar-right"><div className="today-label"><span className="today-dot" />System operational</div><Link to="/notifications" className="top-icon" aria-label="Notifications"><Bell size={19} /><i /></Link><button className="top-icon theme-toggle" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button><div className="top-divider" /><button className="profile-button" onClick={logout} title="Sign out"><div className="avatar">{user.avatar ? <img src={user.avatar} alt={`${user.name} profile`} /> : initials(user.name)}</div><div className="profile-copy"><b>{user.name}</b><span>{user.role} account</span></div><LogOut size={16} className="logout-icon" /></button></div></header>
      <div className="page-content"><Routes>
        <Route path="/" element={<Dashboard user={user} />} />
        <Route path="/reports" element={user.role === 'Admin' ? <ReportsPage user={user} notify={notify} /> : <Navigate to="/" replace />} />
        <Route path="*" element={<ModuleRoute user={user} notify={notify} />} />
      </Routes><footer className="page-footer"><span>© 2026 TSG Power Engineering</span><span>Secure operations <ShieldCheck size={13} /></span></footer></div>
    </main>
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </div>;
}

function useInstallPrompt() {
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const [available, setAvailable] = useState(() => Boolean(window.__tsgInstallPrompt));
  const [installed, setInstalled] = useState(isStandalone);
  useEffect(() => {
    const sync = () => { setAvailable(Boolean(window.__tsgInstallPrompt)); setInstalled(isStandalone()); };
    const installedHandler = () => { setAvailable(false); setInstalled(true); };
    window.addEventListener('tsg-install-available', sync);
    window.addEventListener('tsg-app-installed', installedHandler);
    return () => { window.removeEventListener('tsg-install-available', sync); window.removeEventListener('tsg-app-installed', installedHandler); };
  }, []);
  const install = async () => {
    const prompt = window.__tsgInstallPrompt;
    if (!prompt) return false;
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (choice.outcome === 'accepted') { window.__tsgInstallPrompt = null; setAvailable(false); }
    return choice.outcome === 'accepted';
  };
  return { canInstall: available, installed, install };
}

function Login({ onLogin, onGoogleLogin }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [googleBusy, setGoogleBusy] = useState(false);
  const { canInstall, installed, install } = useInstallPrompt(); const [installMessage, setInstallMessage] = useState('');
  const showLoginError = message => { setError(message); window.setTimeout(() => setError(current => current === message ? '' : current), 5000); };
  const submit = async e => { e.preventDefault(); setBusy(true); setError(''); try { await onLogin({ email, password }); } catch (err) { showLoginError(err.message || 'Could not sign in. Check your details and try again.'); } finally { setBusy(false); } };
  const google = async () => { setGoogleBusy(true); setError(''); try { await onGoogleLogin(); } catch (err) { showLoginError(err.message || 'Could not start Google sign-in.'); setGoogleBusy(false); } };
  const handleInstall = async () => {
    setInstallMessage('');
    if (canInstall) { await install(); return; }
    const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setInstallMessage(iOS ? 'On iPhone or iPad: tap the Share button, then choose Add to Home Screen.' : 'Open your browser menu and choose Install app or Add to Home screen.');
  };
  return <div className="login-screen">{error && <div className="login-alert" role="alert"><span className="login-alert-icon">!</span><div className="login-alert-copy"><b>Login failed</b><span>{error}</span></div><button type="button" aria-label="Dismiss message" onClick={() => setError('')}><X size={16} /></button></div>}<div className="login-art"><div className="login-art-grid" /><div className="login-art-content"><img className="login-center-logo" src="/tsg-logo.png" alt="TSG Power Engineering Co., Ltd." /></div></div><div className="login-side"><div className="login-form-wrap"><div className="mobile-login-mark"><img className="brand-logo" src="/tsg-logo.png" alt="TSG Power Engineering Co., Ltd." /></div><div className="eyebrow">WELCOME BACK</div><h2>Sign in</h2><p className="login-subtitle">Use your account to continue.</p><form onSubmit={submit}><label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your email" /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" /></label><button className="primary-button login-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={16} /></button></form><div className="login-divider"><span />OR<span /></div><button type="button" className="google-signin" onClick={google} disabled={googleBusy}><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.3 5.3C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>{googleBusy ? 'Opening Google…' : 'Continue with Google'}</button>{!installed && <div className="install-app-row"><button type="button" className="install-app-button" onClick={handleInstall}><Download size={18} /><span><b>Install app</b><small>Add TSG to your home screen</small></span></button>{installMessage && <p className="install-app-note">{installMessage}</p>}</div>}<div className="login-security"><ShieldCheck size={15} /> Secure sign-in · Accounts managed by your administrator</div></div><div className="login-copyright">© 2026 TSG Power Engineering</div></div></div>;
}

function resolveDashboardMetric(data, aliases = []) {
  for (const key of aliases) {
    const value = key.split('.').reduce((node, part) => node?.[part], data);
    if (value == null) continue;
    const scalar = typeof value === 'object' ? value.total ?? value.count ?? value.amount ?? value.value : value;
    if (scalar != null) return scalar;
  }
  return null;
}
function getDashboardSeries(data, names) {
  for (const name of names) {
    const series = name.split('.').reduce((node, part) => node?.[part], data);
    if (Array.isArray(series)) return series;
  }
  return [];
}
function sameDisplayName(left, right) {
  const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}
function MetricCard({ stat, value, delta, index }) {
  return <Link to={stat.target} className={`stat-card metric-card ${stat.color}`} style={{ animationDelay: `${index * 55}ms` }}>
    <div className="metric-card-head"><div className={`stat-icon ${stat.color}`}><stat.icon size={20} strokeWidth={1.9} /></div><span className="metric-trend"><ArrowUpRight size={15} /></span></div>
    <div className="stat-label">{stat.label}</div><div className="stat-value">{value}</div>
    <div className="stat-delta">{delta || 'Current period'}</div>
  </Link>;
}
function MiniBarChart({ series, emptyText, cash = false }) {
  if (!series.length) return <div className="chart-empty"><span className="chart-empty-icon"><Activity size={19} /></span><b>No chart data yet</b><span>{emptyText}</span></div>;
  const max = Math.max(1, ...series.flatMap(item => [Number(item.revenue ?? item.income ?? item.value ?? 0), Number(item.expenses ?? item.outflow ?? 0)]));
  return <div className={`mini-bar-chart ${cash ? 'cash-chart' : ''}`}>
    <div className="chart-legend"><span><i className="legend-revenue" />{cash ? 'Inflow' : 'Revenue'}</span>{!cash && <span><i className="legend-expense" />Expenses</span>}</div>
    <div className="bar-chart-plot">{series.map((item,index) => { const first=Number(item.revenue ?? item.income ?? item.value ?? 0); const second=Number(item.expenses ?? item.outflow ?? 0); return <div className="bar-chart-group" key={`${item.month || item.label || index}`}><div className="bar-chart-bars"><span className="revenue-bar" style={{height:`${Math.max(3,first/max*100)}%`}} title={`${cash?'Inflow':'Revenue'}: ${first.toLocaleString('en-US')}`} />{!cash && <span className="expense-bar" style={{height:`${Math.max(3,second/max*100)}%`}} title={`Expenses: ${second.toLocaleString('en-US')}`} />}</div><small>{item.month || item.label || ''}</small></div>; })}</div>
  </div>;
}
function JobStatusDonut({ counts, emptyText }) {
  const palette = ['#2f88f5','#18b89b','#f2ad4b','#8f78f6','#ec7182','#82a0b8'];
  const entries = (Array.isArray(counts) ? counts.map(item => [item.status ?? item.label ?? item.name ?? 'Other', item.count ?? item.total ?? item.value]) : Object.entries(counts || {})).map(([label,value]) => [label, Number(value?.count ?? value?.total ?? value) || 0]).filter(([,value]) => value > 0);
  const total = entries.reduce((sum,[,value]) => sum + value,0);
  if (!total) return <div className="chart-empty"><span className="chart-empty-icon"><BriefcaseIcon size={19} /></span><b>No status data yet</b><span>{emptyText}</span></div>;
  let cursor=0; const stops=entries.map(([,value],i)=>{const start=cursor;cursor+=value/total*100;return `${palette[i%palette.length]} ${start}% ${cursor}%`;}).join(',');
  return <div className="status-chart-wrap"><div className="status-donut" style={{background:`conic-gradient(${stops})`}}><div><b>{total}</b><span>Job orders</span></div></div><div className="status-legend">{entries.map(([label,value],i)=><div key={label}><i style={{background:palette[i%palette.length]}}/><span>{label}</span><b>{value}</b></div>)}</div></div>;
}
function Dashboard({ user }) {
  const demo = user.id?.startsWith('demo-');
  const dashboardQuery = useQuery({ queryKey: ['dashboard', user.role], queryFn: () => apiRequest('/dashboard'), enabled: !demo, staleTime: 30_000 });
  const dashboardData = dashboardQuery.data?.data || dashboardQuery.data || {};
  const liveCounts = dashboardData.counts || dashboardData.stats || dashboardData;
  const dashboardJobsQuery = useQuery({ queryKey: ['dashboard-jobs'], queryFn: () => apiRequest('/jobs?page=1&limit=5'), enabled: !demo, staleTime: 20_000 });
  const myStaffQuery = useQuery({ queryKey: ['dashboard', 'my-staff', user.id], queryFn: () => apiRequest('/staff?page=1&limit=500'), enabled: !demo && user.role === 'Staff', staleTime: 20_000 });
  const myJobsQuery = useQuery({ queryKey: ['dashboard', 'my-jobs', user.id], queryFn: () => apiRequest('/jobs?page=1&limit=5000'), enabled: !demo && user.role === 'Staff', staleTime: 20_000 });
  const invoicesQuery = useQuery({ queryKey: ['dashboard-invoices'], queryFn: () => apiRequest('/invoices?page=1&limit=5'), enabled: !demo && user.role === 'Admin', staleTime: 20_000 });
  const cashQuery = useQuery({ queryKey: ['dashboard-cash', user.role], queryFn: () => apiRequest(`/${user.role === 'Admin' ? 'cash-claims' : apiEndpoint('my-expense-claims')}?page=1&limit=5`), enabled: !demo, staleTime: 20_000 });
  const demoJobs = demo ? readDemoRows('jobs', moduleInfo.jobs) : [];
  const demoInvoices = demo ? readDemoRows('invoices', moduleInfo.invoices) : [];
  const demoCash = demo ? readDemoRows(user.role === 'Admin' ? 'cash-claims' : 'my-expense-claims', moduleInfo[user.role === 'Admin' ? 'cash-claims' : 'my-expense-claims']) : [];
  const quotationRows = demo ? readDemoRows('quotations', moduleInfo.quotations) : [];
  const jobRows = demo ? demoJobs : normalizeList(dashboardJobsQuery.data, moduleInfo.jobs.columns);
  const invoiceRows = demo ? demoInvoices : normalizeList(invoicesQuery.data, moduleInfo.invoices.columns);
  const cashRows = demo ? demoCash : normalizeList(cashQuery.data, moduleInfo[user.role === 'Admin' ? 'cash-claims' : 'my-expense-claims'].columns);
  const myStaffIds = (() => {
    if (demo || user.role !== 'Staff') return [];
    const userId = String(user.id || '');
    const email = String(user.email || '').trim().toLowerCase();
    return lookupRecords('staff', myStaffQuery.data).filter(record => {
      const profileId = record?.profile_id ? String(record.profile_id) : '';
      const staffEmail = String(record?.email || '').trim().toLowerCase();
      return Boolean((userId && profileId === userId) || (email && staffEmail === email) || sameDisplayName(user.name, record?.name));
    }).map(record => String(record?.id || '')).filter(Boolean);
  })();
  const myJobRecords = demo || user.role !== 'Staff' ? [] : lookupRecords('jobs', myJobsQuery.data);
  const isClosedJob = record => /completed|closed|cancel/i.test(String(record?.status || ''));
  const assignedEmployeeIds = record => (Array.isArray(record?.assigned_employees) ? record.assigned_employees : []).map(item => String(item?.id ?? item?.staff_id ?? item ?? ''));
  const isAssignedToUser = record => {
    if (myStaffIds.includes(String(record?.assigned_to || '')) || myStaffIds.includes(String(record?.team_leader || ''))) return true;
    if (assignedEmployeeIds(record).some(id => myStaffIds.includes(id))) return true;
    return sameDisplayName(user.name, record?.assigned_to_name) || sameDisplayName(user.name, record?.team_leader_name);
  };
  const todayIso = new Date().toISOString().slice(0, 10);
  const clientAssignedJobs = myJobRecords.filter(record => isAssignedToUser(record) && !isClosedJob(record)).length;
  const clientTodayJobs = myJobRecords.filter(record => isAssignedToUser(record) && !isClosedJob(record) && String(record?.planned_start_date || record?.job_date || '').slice(0, 10) === todayIso).length;
  const myAssignedJobs = Math.max(Number(resolveDashboardMetric(liveCounts, ['myAssignedJobs', 'assignedJobs', 'assigned_jobs']) || 0), clientAssignedJobs);
  const todaysScheduledJobs = Math.max(Number(resolveDashboardMetric(liveCounts, ['todaysScheduledJobs', 'scheduledToday', 'scheduled_today']) || 0), clientTodayJobs);
  const invoicePayments = user.role === 'Admin' ? cashRows.filter(row => /payment|receipt|received/i.test(String(row[1] || ''))).slice(0,4) : [];
  const jobStatusCounts = demo
    ? demoJobs.reduce((counts,row)=>{const status=String(row[5]||'Unknown');counts[status]=(counts[status]||0)+1;return counts;},{})
    : dashboardData.jobsByStatus || dashboardData.jobStatusCounts || dashboardData.job_status_counts || {};
  const revenueSeries = getDashboardSeries(dashboardData,['monthlyRevenueExpenses','revenueVsExpenses','revenue_expense_trend','analytics.revenueExpenses']);
  const cashFlowSeries = getDashboardSeries(dashboardData,['monthlyCashFlow','cashFlow','cash_flow','analytics.cashFlow']);
  const activeJobs = demo ? demoJobs.filter(row=>!/completed|closed|cancelled/i.test(String(row[5]))).length : resolveDashboardMetric(liveCounts,['activeJobs','active_jobs','jobs.active']);
  const pendingQuotes = demo ? quotationRows.filter(row=>/draft|pending approval/i.test(String(row[5]))).length : resolveDashboardMetric(liveCounts,['pendingQuotations','pending_quotations','quotations.pending']);
  const outstandingAmount = resolveDashboardMetric(liveCounts,['outstandingPayments','unpaidInvoices','unpaidInvoiceTotal','invoices.unpaidTotal']);
  const revenueAmount = resolveDashboardMetric(liveCounts,['totalRevenue','revenue','revenueTotal','income.total']);
  const expensesAmount = resolveDashboardMetric(liveCounts,['totalExpenses','expenses','expenseTotal','expense.total']);
  const cashAmount = resolveDashboardMetric(liveCounts,['netCashBalance','cashBalance','cash_balance','cash.netBalance']);
  const adminStats = [
    {label:'Total revenue',value:revenueAmount ?? (demo?'MMK 1,248,500':'—'),delta:dashboardData.comparisons?.revenue,target:'/reports',icon:ArrowUpRight,color:'blue'},
    {label:'Outstanding payments',value:outstandingAmount ?? (demo?'MMK 482,000':'—'),delta:dashboardData.comparisons?.outstanding,target:'/invoices',icon:ReceiptTextIcon,color:'amber'},
    {label:'Total expenses',value:expensesAmount ?? (demo?'MMK 816,200':'—'),delta:dashboardData.comparisons?.expenses,target:'/cash-claims',icon:ArrowDownRight,color:'violet'},
    {label:'Net cash balance',value:cashAmount ?? (demo?'MMK 864,000':'—'),delta:dashboardData.comparisons?.cash,target:'/cash-claims',icon:WalletIcon,color:'green'},
    {label:'Active job orders',value:activeJobs ?? '—',delta:null,target:'/jobs',icon:BriefcaseIcon,color:'teal'},
    {label:'Pending quotations',value:pendingQuotes ?? '—',delta:null,target:'/quotations',icon:FileTextIcon,color:'blue'},
  ];
  const staffStats = [
    {label:'My assigned jobs',value:myAssignedJobs,delta:null,target:'/jobs',icon:BriefcaseIcon,color:'blue'},
    {label:"Today's schedule",value:todaysScheduledJobs,delta:null,target:'/jobs',icon:ClipboardIcon,color:'violet'},
    {label:'Pending claims',value:resolveDashboardMetric(liveCounts,['myPendingClaims','pendingClaims','pending_claims'])??0,delta:null,target:'/my-expense-claims',icon:ReceiptTextIcon,color:'amber'},
    {label:'Open advance balance',value:resolveDashboardMetric(liveCounts,['myOpenAdvanceBalance','openAdvanceBalance','advance_balance'])??0,delta:null,target:'/my-advances',icon:WalletIcon,color:'green'},
  ];
  const stats = user.role === 'Admin' ? adminStats : staffStats;
  const today = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());
  const moneyText = (value, isMoney = true) => { if(value==null||value==='?')return '—'; if(typeof value==='number')return isMoney?`MMK ${value.toLocaleString('en-US',{maximumFractionDigits:0})}`:value.toLocaleString('en-US'); return String(value); };
  const formatDelta = delta => { if(delta==null)return demo?'Demo snapshot':'Change unavailable'; if(typeof delta==='object'){const change=delta.percent ?? delta.changePercent ?? delta.value;const direction=Number(change)<0?'down':'up';return Number.isFinite(Number(change))?`${Math.abs(Number(change))}% ${direction} vs previous period`:String(delta.label||'Compared with previous period');} return String(delta); };
  const navActions = user.role === 'Admin' ? [['Create job order',BriefcaseIcon,'/jobs',true],['Manage staff',UsersIcon,'/staff'],['Open invoices',WalletIcon,'/invoices'],['Review claims',ReceiptTextIcon,'/cash-claims']] : [['My job orders',BriefcaseIcon,'/jobs'],['New service report',ClipboardIcon,'/service-reports',true],['Request material',PackageCheckIcon,'/material-requests',true],['Submit expense claim',ReceiptTextIcon,'/my-expense-claims',true]];
  const showRowsState = (query, rows) => query.isLoading ? 'Loading records?' : query.isError ? 'Could not load records.' : rows.length ? '' : 'No records to show yet.';
  return <>
    <div className="page-heading dashboard-heading"><div><div className="eyebrow">{user.role==='Admin'?'COMPANY OVERVIEW':'YOUR WORKSPACE'}</div><h1>{user.role==='Admin'?'Operations overview':'My work'}</h1><p>{user.role==='Admin'?'A clear view of service, finance and customer activity.':'Your assigned work and items needing attention.'}</p></div><div className="heading-actions"><span className="date-pill"><Clock3 size={15}/>{today}</span><button className="secondary-button" onClick={()=>window.print()}><Download size={15}/>Export overview</button></div></div>
    {dashboardQuery.isError && <div className="dashboard-api-error" role="status">Live summary is temporarily unavailable. Module data remains available below.</div>}
    <div className="stat-grid">{stats.map((stat,index)=><MetricCard key={stat.label} stat={stat} value={moneyText(stat.value,/revenue|payment|expense|cash|claim|advance/i.test(stat.label))} delta={formatDelta(stat.delta)} index={index}/>)}</div>
    <div className="dashboard-quick"><section className="panel quick-panel"><div className="panel-heading"><div><h2>Quick actions</h2><p>Common tasks</p></div></div><div className="quick-links">{navActions.map(([label,Icon,target,openCreate])=><Link to={target} state={openCreate?{openCreate:true,form:target.replace(/^\//,'')}:undefined} key={label}><span className="quick-icon"><Icon size={18}/></span><span>{label}</span><ArrowRight size={15} className="quick-arrow"/></Link>)}</div></section></div>
    <div className={`analytics-grid ${user.role==='Staff'?'staff-analytics-grid':''}`}>
      {user.role==='Admin'&&<section className="panel analytics-panel revenue-panel"><div className="panel-heading"><div><h2>Revenue vs expenses</h2><p>Monthly financial performance</p></div><Link to="/reports" className="text-link">Reports <ArrowRight size={14}/></Link></div><MiniBarChart series={revenueSeries} emptyText="Monthly totals will appear here when provided by the dashboard API."/></section>}
      <section className="panel analytics-panel job-status-panel"><div className="panel-heading"><div><h2>Job order status</h2><p>Current workload distribution</p></div><Link to="/jobs" className="text-link">All jobs <ArrowRight size={14}/></Link></div><JobStatusDonut counts={jobStatusCounts} emptyText={demo?'No job orders available.':'Status totals were not included in the dashboard response.'}/></section>
      {user.role==='Admin'&&<section className="panel analytics-panel cash-trend-panel"><div className="panel-heading"><div><h2>Monthly cash flow</h2><p>Money received over time</p></div><Link to="/cash-claims" className="text-link">Cash &amp; bank <ArrowRight size={14}/></Link></div><MiniBarChart series={cashFlowSeries} cash emptyText="Monthly totals will appear here when provided by the dashboard API."/></section>}
      {user.role==='Admin'&&<section className="panel invoice-summary-panel"><div className="panel-heading"><div><h2>Outstanding invoices</h2><p>Open customer balances</p></div><Link to="/invoices" className="text-link">View invoices <ArrowRight size={14}/></Link></div><div className="invoice-summary-value">{moneyText(outstandingAmount ?? (demo?'MMK 482,000':'—'))}</div><div className="invoice-summary-meta"><span>{invoiceRows.filter(row=>/unpaid|partial|overdue/i.test(String(row[5]||''))).length} open in recent records</span><span className="summary-status">{invoiceRows.length?`${invoiceRows.length} recent invoices`:invoicesQuery.isLoading?'Loading…':'No invoice records'}</span></div><div className="invoice-mini-list">{invoiceRows.slice(0,3).map(row=><Link to="/invoices" key={row[0]}><span><b>{row[0]}</b><small>{row[1]}</small></span><strong>{row[4]}</strong><Status value={row[5]||'Unpaid'}/></Link>)}{!invoiceRows.length&&<div className="dashboard-empty-line">{showRowsState(invoicesQuery,invoiceRows)}</div>}</div></section>}
    </div>
    <div className="dashboard-grid dashboard-data-grid">
      <section className="panel jobs-panel"><div className="panel-heading"><div><h2>Recent job orders</h2><p>Latest service work across your team.</p></div><Link to="/jobs" className="text-link">View all <ArrowRight size={14}/></Link></div><div className="table-scroll"><table className="data-table dashboard-table"><thead><tr><th>JOB ORDER</th><th>CUSTOMER / MACHINE</th><th>ASSIGNED TO</th><th>STATUS</th><th>DUE</th></tr></thead><tbody>{jobRows.slice(0,5).map(row=><tr key={row._id||row[0]}><td><b className="record-link">{row[0]}</b></td><td>{row[1]}</td><td>{row[2]}</td><td><Status value={row[5]||'New'}/></td><td>{row[3]}</td></tr>)}{!jobRows.length&&<tr><td colSpan={5} className="empty-state">{showRowsState(dashboardJobsQuery,jobRows)}</td></tr>}</tbody></table></div></section>
      {user.role==='Admin'&&<section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent customer payments</h2><p>Latest receipts and invoice payments.</p></div><Link to="/cash-claims" className="text-link">Cash &amp; bank <ArrowRight size={14}/></Link></div><div className="attention-list">{invoicePayments.map(row=><div className="attention-row" key={row[0]}><span className="attention-icon green"><WalletIcon size={17}/></span><div className="attention-copy"><b>{row[2]}</b><small>{row[0]} · {row[3]}</small></div><strong className="payment-amount">{row[4]}</strong></div>)}{!invoicePayments.length&&<div className="dashboard-empty-line">{showRowsState(cashQuery,cashRows)||'No recent customer payments.'}</div>}</div></section>}
    </div>
    <div className="dashboard-pending-row"><section className="panel pending-panel"><div className="panel-heading"><div><h2>{user.role==='Admin'?'Pending approvals':'My outstanding items'}</h2><p>Items requiring attention.</p></div><span className="attention-count">{demo?(user.role==='Admin'?quotationRows.filter(row=>/draft|pending approval/i.test(String(row[5]))).length:0)+cashRows.filter(row=>/submitted|pending approval/i.test(String(row[5]))).length:resolveDashboardMetric(liveCounts,['pendingApprovals','pending_approvals','approvals.pending'])??'—'}</span></div><div className="pending-links">{user.role==='Admin'&&<Link to="/quotations"><FileTextIcon size={17}/><span>Quotations</span><b>{demo?quotationRows.filter(row=>/draft|pending approval/i.test(String(row[5]))).length:resolveDashboardMetric(liveCounts,['pendingQuotations','pending_quotations'])??'—'}</b><ArrowRight size={14}/></Link>}<Link to={user.role==='Admin'?'/cash-claims':'/my-expense-claims'}><ReceiptTextIcon size={17}/><span>Expense claims</span><b>{demo?cashRows.filter(row=>/submitted|pending approval/i.test(String(row[5]))).length:resolveDashboardMetric(liveCounts,['pendingExpenseClaims','pending_expense_claims'])??'—'}</b><ArrowRight size={14}/></Link><Link to="/material-requests"><PackageCheckIcon size={17}/><span>Material requests</span><b>{demo?readDemoRows('material-requests',moduleInfo['material-requests']).filter(row=>/pending/i.test(String(row[5]))).length:resolveDashboardMetric(liveCounts,['pendingMaterialRequests','pending_material_requests'])??'—'}</b><ArrowRight size={14}/></Link></div></section></div>
  </>;
}

function dashboardValue(data, label) {
  const keys = {
    'Total revenue': ['totalRevenue','total_revenue','revenue','revenue.total'], 'Outstanding payments': ['outstandingPayments','outstanding_payments','unpaidInvoices','unpaidInvoiceTotal','invoices.unpaidTotal'], 'Total expenses': ['totalExpenses','total_expenses','expenses','expenses.total'], 'Net cash balance': ['netCashBalance','net_cash_balance','cashBalance','cash_balance'], 'Active job orders': ['activeJobs','active_jobs','jobs.active'], 'Pending quotations': ['pendingQuotations','pending_quotations','quotations.pending'], Customers: ['customers','customerCount'], 'Unpaid invoices': ['unpaidInvoices','unpaidInvoiceTotal','invoices.unpaidTotal'], 'Cash balance': ['cashBalance','cash_balance'], 'My assigned jobs': ['myAssignedJobs','assignedJobs','assigned_jobs'], "Today's schedule": ['todaysScheduledJobs','scheduledToday','scheduled_today'], 'Pending claims': ['myPendingClaims','pendingClaims','pending_claims'], 'Open advance balance': ['myOpenAdvanceBalance','openAdvanceBalance','advance_balance'],
  }[label] || [];
  for (const key of keys) {
    const value = key.split('.').reduce((node, part) => node?.[part], data);
    if (value == null) continue;
    const scalar = typeof value === 'object' ? value.total ?? value.count ?? value.amount : value;
    if (scalar == null) continue;
    if (/revenue|expenses|cash balance|outstanding|unpaid invoices|advance balance/i.test(label) && typeof scalar === 'number') return `MMK ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(scalar)}`;
    return String(scalar);
  }
  return null;
}

function ModuleRoute({ user, notify }) {
  const location = useLocation(); const navigate = useNavigate(); const { pathname } = location; const slug = pathname.replace(/^\//, ''); const info = moduleInfo[slug];
  if (!info) return <Navigate to="/" replace />;
  const item = navigation.find(n => n.path === pathname);
  if (item && !item.roles.includes(user.role)) return <Navigate to="/" replace />;
  const initialCreateForm = location.state?.openCreate ? (location.state.form || slug) : null;
  return <ModulePage key={slug} info={info} slug={slug} user={user} notify={notify} initialCreateForm={initialCreateForm} onCreateHandled={() => navigate(pathname, { replace: true, state: null })} />;
}

function isStatus(value) { return typeof value === 'string' && /^(active|inactive|in stock|received|paid|approved|completed|unread|sent|accepted|in progress|scheduled|submitted|pending|pending approval|draft|open|low stock|overdue|waiting for parts|partially paid|partially issued|unpaid|rejected|cancelled|new|assigned|issued|settled|reviewed|expired|on hold|closed - paid|closed - pending payment|void|credited)$/i.test(value); }
function normalizeCurrency(value) {
  if (typeof value !== 'string') return value;
  if (!/^(₹|INR|Rs\.?|MMK)\s*[\d,]+(?:\.\d+)?$/i.test(value.trim())) return value;
  const amount = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(amount) ? `MMK ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : value;
}
function normalizeRowCurrency(row) { return Array.isArray(row) ? row.map(normalizeCurrency) : row; }
function normalizeCurrencyDeep(value) {
  if (Array.isArray(value)) return value.map(normalizeCurrencyDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /currency/i.test(key) && typeof item === 'string' ? 'MMK' : normalizeCurrencyDeep(item)]));
  return normalizeCurrency(value);
}
function apiEndpoint(slug) { return ({ accounts: 'users', 'my-expense-claims': 'expenses', salary: 'salaries', 'my-salary': 'salaries' })[slug] || slug; }
function readDemoRows(slug, info) {
  if (slug === 'recycle-bin') {
    const entries = JSON.parse(localStorage.getItem('tsg-demo-recycle-bin-entries') || '[]');
    return entries.map(entry => { const row = [entry.moduleTitle, entry.record[0], entry.deletedBy, entry.deletedAt, entry.mode]; Object.defineProperties(row, { _id: { value: entry.id }, _entry: { value: entry } }); return row; });
  }
  if (slug === 'service-reports') {
    const reports = JSON.parse(localStorage.getItem('tsg-demo-service-reports') || '[]');
    if (reports.length) return [...reports.map(item => [item.number, item.job, item.customer_name || '—', new Date(item.delivered_at).toLocaleDateString('en-IN'), 'You', 'Submitted']), ...info.rows];
  }
  if (slug === 'my-salary') {
    try { return (JSON.parse(localStorage.getItem('tsg-demo-salary') || 'null') || info.rows).map(row => attachDemoRecord('salary', normalizeRowCurrency(row))); } catch { return info.rows.map(normalizeRowCurrency); }
  }
  try { return (JSON.parse(localStorage.getItem(`tsg-demo-${slug}`)) || info.rows).map(row => attachDemoRecord(slug, normalizeRowCurrency(row))); } catch { return info.rows.map(normalizeRowCurrency); }
}
function attachDemoRecord(slug, row, record) {
  if (!Array.isArray(row) || !row[0] || row[0] === '?') return row;
  const key = `tsg-demo-record-${slug}-${row[0]}`;
  if (record) localStorage.setItem(key, JSON.stringify(normalizeCurrencyDeep(record)));
  let saved = record;
  if (!saved) { try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch { saved = null; } }
  if (saved) Object.defineProperty(row, '_record', { value: normalizeCurrencyDeep(saved), configurable: true, enumerable: false });
  Object.defineProperty(row, '_id', { value: row[0], configurable: true, enumerable: false });
  return row;
}
function normalizeList(payload, columns) {
  const list = Array.isArray(payload) ? payload : payload?.items || payload?.data || payload?.results || [];
  if (!Array.isArray(list)) return [];
  return list.map(record => {
    if (Array.isArray(record)) return record.map(normalizeCurrency);
    const values = columns.map(label => {
      if (label.toLowerCase() === 'items' && record?.items_display != null) return record.items_display == null ? '—' : normalizeCurrency(String(record.items_display));
      const aliases = { customer: ['customer_name', 'name'], contact: ['contact_person', 'phone'], 'customer · machine': ['machine_name', 'title'], 'job order': ['number', 'job_number'], quotation: ['number', 'quotation_number'], invoice: ['number', 'invoice_number'], request: ['number', 'request_number'], voucher: ['voucher_no', 'number'], report: ['number', 'report_number'], 'assigned to': ['assigned_to_name', 'staff_name'], 'serial number': ['serial_no'], 'on hand': ['qty_on_hand'], 'reorder at': ['reorder_level'], 'valid until': ['valid_until'], 'due date': ['due_date'], 'last login': ['last_login'], 'created': ['created_at'], items: ['items_display'] };
      const alias = aliases[label.toLowerCase()] || [];
      const displayName = alias.filter(key => key.endsWith('_name')).map(key => record?.[key]).find(value => value != null);
      if (displayName != null) return normalizeCurrency(String(displayName));
      const wanted = label.toLowerCase().replace(/[^a-z0-9]/g, '');
      const pair = Object.entries(record || {}).find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
      if (pair) return pair[1] == null ? '—' : normalizeCurrency(String(pair[1]));
      const found = alias.map(key => record?.[key]).find(value => value != null);
      return found == null ? '—' : normalizeCurrency(String(found));
    });
    Object.defineProperty(values, '_id', { value: record?.id ?? record?.uuid ?? record?.[Object.keys(record || {})[0]], enumerable: false });
    Object.defineProperty(values, '_record', { value: record, enumerable: false });
    return values;
  });
}
function toApiRecord(columns, values) {
  return Object.fromEntries(columns.map((column, i) => [column.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), values?.[i] || '']));
}
function toDisplayRow(columns, payload) {
  const aliases = { customer: ['customer_name', 'legal_name', 'customer_id', 'name'], supplier: ['supplier_name', 'name'], machine: ['machine_name', 'name', 'model'], location: ['site_location', 'billing_address', 'address'], asset: ['name'], item: ['name'], code: ['id', 'sku'], quotation: ['number', 'quotation_number'], 'job order': ['number', 'job_number', 'title'], invoice: ['number', 'invoice_number'], request: ['number', 'request_number'], voucher: ['voucher_no', 'number'], report: ['number', 'report_number'], 'customer · machine': ['machine_name', 'title'], contact: ['contact_person', 'phone'], 'due date': ['due_date'], 'serial number': ['serial_no'], amount: ['amount', 'total'], 'assigned to': ['assigned_to_name', 'assigned_to'] };
  return columns.map(label => { const key = label.toLowerCase().replace(/[^a-z0-9]/g, ''); const alias = aliases[label.toLowerCase()] || []; const keys = [...alias.filter(name => name.endsWith('_name')), key, ...alias.filter(name => !name.endsWith('_name'))]; const value = keys.map(name => payload?.[name] ?? payload?.[name.replace(/_([a-z])/g, (_, char) => char.toUpperCase())]).find(item => item != null && item !== ''); return value == null ? '—' : String(value); });
}
function formatMoney(value) { return `MMK ${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function nextSalaryVoucher() {
  const rows = JSON.parse(localStorage.getItem('tsg-demo-salary') || 'null') || moduleInfo.salary.rows;
  const sequence = Math.max(Number(localStorage.getItem('tsg-demo-salary-sequence') || 1000), ...rows.map(row => Number(String(row[0]).match(/^SAL-\d{4}-(\d+)$/)?.[1] || 0)));
  localStorage.setItem('tsg-demo-salary-sequence', String(sequence + 1));
  return `SAL-${new Date().getFullYear()}-${sequence + 1}`;
}
function createDemoSalaryVoucher(record) {
  const ref = record.voucher_no || record.voucher || `SAL-${Date.now()}`;
  const entries = JSON.parse(localStorage.getItem('tsg-demo-cash-claims') || 'null') || moduleInfo['cash-claims'].rows;
  const entry = [ref, 'Salary payment', record.staff_name || record.staff_id || 'Staff member', record.paid_on || new Date().toISOString().slice(0, 10), formatMoney(record.net_pay), 'Paid'];
  localStorage.setItem('tsg-demo-cash-claims', JSON.stringify([entry, ...entries.filter(item => item[0] !== ref)]));
}
function toModuleDemoRow(columns, dialog) {
  const payload = dialog.payload || {};
  if (dialog.module === 'salary') {
    const net = Math.max(0, Number(payload.basic_salary || 0) + Number(payload.allowances || 0) - Number(payload.deductions || 0));
    const staffName = (sampleLookupOptions.staff || []).find(([id]) => id === payload.staff_id)?.[1] || payload.staff_id || 'Staff member';
    return [nextSalaryVoucher(), staffName, payload.salary_month || new Date().toISOString().slice(0, 7), formatMoney(net), payload.paid_on || '—', payload.status || 'Draft'];
  }
  if (dialog.module === 'new-advance') return [`ADV-DEMO-${Date.now()}`, 'Staff advance', payload.staff_id || 'Staff member', payload.date || new Date().toLocaleDateString('en-IN'), formatMoney(payload.amount), 'Pending Approval'];
  if (dialog.module === 'cash-entry') return [`CASH-DEMO-${Date.now()}`, `Cash ${String(payload.type || 'receipt').toUpperCase()}`, payload.counterparty || payload.source_id || payload.reference_type || 'Manual entry', payload.date || new Date().toLocaleDateString('en-IN'), formatMoney(payload.amount), 'Pending Approval'];
  if (dialog.module === 'jobs') {
    const sequence = Math.max(Number(localStorage.getItem('tsg-demo-job-sequence') || 100), ...((JSON.parse(localStorage.getItem('tsg-demo-jobs') || 'null') || moduleInfo.jobs.rows).map(row => Number(String(row[0]).match(/^TSG(\d+)$/)?.[1] || 0))));
    const jobId = `TSG${sequence + 1}`;
    localStorage.setItem('tsg-demo-job-sequence', String(sequence + 1));
    const lookupLabel = (resource, value) => (sampleLookupOptions[resource] || []).find(([id]) => id === value)?.[1] || value || '—';
    return [jobId, `${payload.customer_name || lookupLabel('customers', payload.customer_id)} · ${payload.equipment_type || payload.title || 'Service job'}`, payload.team_leader || payload.assigned_to ? lookupLabel('staff', payload.team_leader || payload.assigned_to) : 'Unassigned', payload.planned_end_date || '—', payload.priority || 'Normal', payload.status || 'Draft'];
  }
  return dialog.values || columns.map((_, i) => payload[columns[i].toLowerCase()] || '—');
}
function requestBody(payload) {
  const values = Object.entries(payload || {});
  const hasFile = values.some(([, value]) => typeof File !== 'undefined' && value instanceof File);
  if (!hasFile) return JSON.stringify(payload);
  const form = new FormData();
  for (const [key, value] of values) {
    if (value == null || value === '') continue;
    if (typeof File !== 'undefined' && value instanceof File) form.append(key, value);
    else if (Array.isArray(value) && value.some(item => typeof File !== 'undefined' && item instanceof File)) value.forEach(item => { if (item instanceof File) form.append(key, item); });
    else if (typeof value === 'object') form.append(key, JSON.stringify(value));
    else form.append(key, String(value));
  }
  return form;
}
function workflowActions(slug, row, columns, role) {
  if (slug === 'accounts') { const status = String(row[columns.findIndex(column => /status/i.test(column))] || '').toLowerCase(); return [{ label: 'Update photo', action: 'update-photo' }, { label: 'Reset password', action: 'reset-password' }, { label: 'Deactivate', action: 'deactivate', status: 'Inactive' }].map(item => item.action === 'deactivate' && status !== 'active' ? { label: 'Activate', action: 'activate', status: 'Active' } : item); }
  if (slug === 'recycle-bin') return [{ label: 'Restore', action: 'restore' }, { label: 'Purge permanently', action: 'purge' }];
  if (slug === 'notifications') { const unread = String(row[columns.findIndex(column => /status/i.test(column))] || '').toLowerCase() === 'unread'; return [...(unread ? [{ label: 'Mark read', action: 'mark-read', status: 'Read' }] : []), { label: 'Delete notification', action: 'delete-notification' }]; }
  if (slug === 'my-advances') { const balance = Number(String(row[5] || '').replace(/[^0-9.]/g, '')); return role === 'Staff' && balance > 0 ? [{ label: 'Submit claim', action: 'claim-advance' }] : []; }
  if (slug === 'salary') { const status = String(row[5] || '').toLowerCase(); return role === 'Admin' && status !== 'paid' ? [{ label: 'Mark as paid', action: 'mark-salary-paid' }] : []; }
  if (slug === 'my-salary') return [];
  if (slug === 'cash-claims' && /advance/i.test(String(row[1]))) {
    const advanceStatus = String(row[5] || '').toLowerCase();
    if (advanceStatus === 'pending approval') return role === 'Admin' ? [{ label: 'Approve', action: 'approve', status: 'Approved' }, { label: 'Reject', action: 'reject', status: 'Rejected' }] : [];
    if (advanceStatus === 'approved') return role === 'Admin' ? [{ label: 'Issue funds', action: 'issue-advance' }] : [];
    if (['issued', 'open', 'partially settled'].includes(advanceStatus)) return role === 'Admin' ? [{ label: 'Settle advance', action: 'settle-advance' }] : [];
  }
  const statusIndex = columns.findIndex(column => /status/i.test(column));
  const status = String(row[statusIndex] || '').toLowerCase();
  if (slug === 'invoices' && ['unpaid', 'partially paid', 'issued'].includes(status)) return [{ label: 'Record payment', action: 'record-payment' }];
  if (slug === 'cash-claims' && /^cash/i.test(String(row[1]))) {
    if (status === 'pending approval') return role === 'Admin' ? [{ label: 'Approve', action: 'approve', status: 'Approved' }, { label: 'Reject', action: 'reject', status: 'Rejected' }] : [];
    if (status === 'approved') return role === 'Admin' ? [{ label: 'Post transaction', action: 'post', status: 'Posted' }] : [];
  }
  if (slug === 'invoices') {
    if (status === 'draft') return [{ label: 'Submit for approval', action: 'status', status: 'Pending Approval' }];
    if (status === 'pending approval') return role === 'Admin' ? [{ label: 'Approve', action: 'status', status: 'Approved' }, { label: 'Reject', action: 'status', status: 'Rejected' }] : [];
    if (status === 'approved') return role === 'Admin' ? [{ label: 'Finalize / issue', action: 'status', status: 'Issued' }] : [];
    if (status === 'issued') return [{ label: 'Record payment', action: 'record-payment' }];
  }
  if (slug === 'jobs' && statusIndex >= 0) {
    if (['draft', 'new'].includes(status)) return role === 'Admin' ? [{ label: 'Submit for approval', action: 'status', status: 'Pending Approval' }, { label: 'Assign / schedule', action: 'assign-job' }] : [];
    if (status === 'pending approval') return role === 'Admin' ? [{ label: 'Approve', action: 'status', status: 'Approved' }, { label: 'Cancel job', action: 'job-cancel' }] : [];
    if (status === 'approved') return role === 'Admin' ? [{ label: 'Assign / schedule', action: 'assign-job' }] : [];
    if (status === 'assigned' || status === 'scheduled') return [{ label: 'Start work', action: 'status', status: 'In Progress' }, { label: 'Add note', action: 'add-note' }];
    if (status === 'in progress') { const workflow = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}')[row[0]] || {}; return [{ label: 'Add note', action: 'add-note' }, ...(!workflow.completionReportId ? [{ label: 'Completion report', action: 'service-report' }] : []), { label: 'Put on hold', action: 'status', status: 'On Hold' }]; }
    if (status === 'on hold' || status === 'waiting for parts') return [{ label: 'Add note', action: 'add-note' }, { label: 'Resume work', action: 'status', status: 'In Progress' }];
    if (status === 'completed') { const workflow = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}')[row[0]] || {}; return role === 'Admin' && workflow.completionReportApproved ? [{ label: 'Generate invoice', action: 'job-invoice' }, { label: 'Completion report', action: 'service-report' }] : [{ label: 'Completion report', action: 'service-report' }]; }
    if (status === 'invoice generated') return role === 'Admin' ? [{ label: 'Close job', action: 'job-close' }] : [];
    if (status === 'closed - pending payment') return role === 'Admin' ? [{ label: 'Close as paid', action: 'job-close' }] : [];
    return [];
  }
  if (slug === 'quotations') {
    if (status === 'draft') return [{ label: 'Submit for approval', action: 'status', status: 'Pending Approval' }];
    if (status === 'pending approval') return role === 'Admin' ? [{ label: 'Approve', action: 'status', status: 'Approved' }, { label: 'Reject', action: 'status', status: 'Rejected' }] : [];
    if (status === 'approved') return role === 'Admin' ? [{ label: 'Issue to customer', action: 'status', status: 'Sent' }] : [];
    if (status === 'sent') return [{ label: 'Mark accepted', action: 'status', status: 'Accepted' }, { label: 'Mark rejected', action: 'status', status: 'Rejected' }];
    if (status === 'accepted') return [{ label: 'Convert to job', action: 'convert-to-job', status: 'Converted to Job' }];
  }
  if (slug === 'service-reports') {
    if (status === 'draft') return [{ label: 'Submit for review', action: 'status', status: 'Submitted' }];
    if (status === 'submitted') return role === 'Admin' ? [{ label: 'Mark reviewed', action: 'status', status: 'Reviewed' }] : [];
    if (status === 'reviewed') return role === 'Admin' ? [{ label: 'Approve report', action: 'status', status: 'Approved' }, { label: 'Reject report', action: 'status', status: 'Rejected' }] : [];
    if (status === 'rejected') return [{ label: 'Resubmit', action: 'status', status: 'Submitted' }];
  }
  if (slug === 'material-requests') {
    if (['pending', 'pending approval'].includes(status)) return role === 'Admin' ? [{ label: 'Approve', action: 'status', status: 'Approved' }, { label: 'Reject', action: 'status', status: 'Rejected' }] : [];
    if (status === 'approved' || status === 'partially issued') return role === 'Admin' ? [{ label: 'Issue materials', action: 'issue-materials' }] : [];
    if (status === 'issued') return role === 'Admin' ? [{ label: 'Record return', action: 'return-materials' }] : [];
  }
  if ((slug === 'cash-claims' || slug === 'my-expense-claims') && status === 'submitted') return role === 'Admin' ? [{ label: 'Approve', action: 'approve', status: 'Approved' }, { label: 'Reject', action: 'reject', status: 'Rejected' }] : [];
  if ((slug === 'cash-claims' || slug === 'my-expense-claims') && status === 'approved') return role === 'Admin' ? [{ label: 'Record reimbursement', action: 'pay', status: 'Paid' }] : [];
  return [];
}

function ModulePage({ info, slug, user, notify, initialCreateForm = null, onCreateHandled }) {
  const queryClient = useQueryClient();
  const isDemo = user.id?.startsWith('demo-');
  const [rows, setRows] = useState(() => readDemoRows(slug, info));
  const [search, setSearch] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState(''); const [page, setPage] = useState(1); const [filterOpen, setFilterOpen] = useState(false);
  const [dialog, setDialog] = useState(null); const [typedConfirm, setTypedConfirm] = useState(''); const [openRowActions, setOpenRowActions] = useState(null);
  const listQuery = useQuery({ queryKey: ['module', slug, search, statusFilter, dateFrom, dateTo, page], queryFn: () => { const params = new URLSearchParams({ page: String(page), limit: '10' }); if (search) params.set('search', search); if (statusFilter) params.set('status', statusFilter); if (dateFrom) params.set('from', dateFrom); if (dateTo) params.set('to', dateTo); if (slug === 'my-salary') params.set('mine', 'true'); return apiRequest(`/${apiEndpoint(slug)}?${params}`); }, enabled: !isDemo, staleTime: 20_000 });
  useEffect(() => { if (isDemo && slug !== 'recycle-bin') localStorage.setItem(`tsg-demo-${slug}`, JSON.stringify(rows)); }, [isDemo, rows, slug]);
  const remoteRows = listQuery.data ? normalizeList(listQuery.data, info.columns) : null;
  const sourceRows = remoteRows || (isDemo ? rows : []);
  const staffRows = user.role === 'Staff' && isDemo ? (slug === 'jobs' ? sourceRows.filter(row => row[2] === 'You') : slug === 'my-salary' ? sourceRows.filter(row => row[1] === user.name || row[1] === 'You') : sourceRows) : sourceRows;
  const visibleRows = staffRows.filter(row => {
    if (!row.join(' ').toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter && !row.some(cell => String(cell).toLowerCase() === statusFilter.toLowerCase())) return false;
    const dateIndex = info.columns.findIndex(col => /date|due|delivered|issued|purchased/i.test(col));
    if (dateIndex >= 0 && (dateFrom || dateTo)) { const date = new Date(row[dateIndex]); if (!Number.isNaN(date.valueOf())) { if (dateFrom && date < new Date(`${dateFrom}T00:00:00`)) return false; if (dateTo && date > new Date(`${dateTo}T23:59:59`)) return false; } }
    return true;
  });
  const canCreate = user.role === 'Admin' ? !['notifications', 'recycle-bin', 'settings'].includes(slug) : ['customers', 'jobs', 'service-reports', 'material-requests', 'my-expense-claims'].includes(slug);
  const canEdit = user.role === 'Admin' ? !['accounts', 'notifications', 'recycle-bin'].includes(slug) : (user.role === 'Staff' && !['my-advances', 'advances'].includes(slug) && ['customers', 'service-reports', 'material-requests', 'my-expense-claims'].includes(slug));
  const showDelete = user.role === 'Admin' ? !['accounts', 'notifications', 'recycle-bin', 'settings'].includes(slug) : user.role === 'Staff' && slug === 'customers';
  const showForceDelete = user.role === 'Admin' && !['accounts', 'notifications', 'recycle-bin', 'settings'].includes(slug);
  const onExport = async format => {
    if (isDemo) {
      if (format === 'pdf') { printReport(info.title, info.columns, visibleRows, { ...(search ? { search } : {}), ...(statusFilter ? { status: statusFilter } : {}), ...(dateFrom ? { from: dateFrom } : {}), ...(dateTo ? { to: dateTo } : {}) }); return; }
      const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const csv = [info.columns, ...visibleRows.map(row => [...row])].map(record => record.map(quote).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${slug}.csv`; anchor.click(); URL.revokeObjectURL(url); return;
    }
    try { await exportModule(apiEndpoint(slug), format, { ...(search ? { search } : {}), ...(statusFilter ? { status: statusFilter } : {}), ...(dateFrom ? { from: dateFrom } : {}), ...(dateTo ? { to: dateTo } : {}) }); } catch (e) { notify(e.message); }
  };
  const create = (requestedForm = slug) => {
    const form = typeof requestedForm === 'string' ? requestedForm : slug;
    const accountMode = form === 'accounts';
    const apiResource = ({ 'cash-claims': 'expenses', 'new-advance': 'advances', 'cash-entry': 'cash-entries' })[form] || apiEndpoint(form);
    const title = ({ 'cash-claims': 'Create expense voucher', 'new-advance': 'Issue staff advance', 'cash-entry': 'Record cash movement' })[form] || `Create ${info.title.replace(/s$/, '').toLowerCase()}`;
    setDialog({ type: 'create', accountMode, fields: accountMode ? null : formSchemas[form], apiResource, title, module: form });
  };
  useEffect(() => { if (initialCreateForm && canCreate) { create(initialCreateForm); onCreateHandled?.(); } }, [initialCreateForm, canCreate, slug]);
  const edit = row => {
    if (slug === 'settings') return setDialog({ type: 'edit', row, fields: [{ key: 'current_value', label: 'Current value', type: 'text', required: true }], apiResource: 'settings', module: 'settings', title: `Edit ${row[0]}` });
    if (slug === 'cash-claims') {
      const kind = String(row?.[1] || '');
      const advance = /advance/i.test(kind);
      const cash = /^cash/i.test(kind);
      return setDialog({ type: 'edit', row, fields: advance ? formSchemas['new-advance'] : cash ? formSchemas['cash-entry'] : formSchemas['cash-claims'], apiResource: advance ? 'advances' : cash ? 'cash-entries' : 'expenses', module: slug, title: `Edit ${advance ? 'advance' : cash ? 'cash entry' : 'expense claim'}` });
    }
    setDialog({ type: 'edit', row, fields: formSchemas[slug], apiResource: apiEndpoint(slug), module: slug, title: `Edit ${info.title.replace(/s$/, '').toLowerCase()}` });
  };
  const remove = (row, force) => setDialog({ type: force ? 'force' : 'delete', row });
  const clearNotifications = async () => {
    if (!window.confirm('Delete all notifications? This cannot be undone.')) return;
    try {
      if (isDemo) persistRows([]);
      else {
        await apiRequest('/notifications?all=true', { method: 'DELETE' });
        await queryClient.invalidateQueries({ queryKey: ['module', 'notifications'] });
      }
      notify('All notifications deleted.');
    } catch (error) { notify(error.message); }
  };
  const persistRows = updater => setRows(old => typeof updater === 'function' ? updater(old) : updater);
  const confirmAction = async () => {
    if (dialog.type === 'force' && typedConfirm !== 'DELETE') return;
    const isRemoving = dialog.type === 'delete' || dialog.type === 'force';
    const recordId = encodeURIComponent(dialog.row?._id || dialog.row?.[0] || '');
    try {
      if (!isDemo) {
        if (dialog.type === 'reset-password') await apiRequest(`/users/${recordId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: dialog.password }) });
        else if (dialog.type === 'account-photo') await apiRequest(`/users/${recordId}`, { method: 'PUT', body: JSON.stringify({ avatar: dialog.photo }) });
        else if (dialog.type === 'my-account') { const payload = { name: dialog.myAccount.name, username: dialog.myAccount.username, avatar: dialog.myAccount.avatar }; if (dialog.myAccount.password) payload.password = dialog.myAccount.password; const updated = await apiRequest(`/users/${encodeURIComponent(dialog.user?.id || user.id)}`, { method: 'PUT', body: JSON.stringify(payload) }); const apiUser = updated?.user || updated || {}; const stored = initialUser() || user; const nextUser = { ...stored, name: apiUser.name || payload.name, username: apiUser.username || payload.username, avatar: apiUser.avatar ?? payload.avatar, role: stored.role }; sessionStorage.setItem('tsg_user', JSON.stringify(nextUser)); window.dispatchEvent(new Event('tsg-user-updated')); }
        else if (dialog.type === 'salary-payment') await apiRequest(`/salaries/${recordId}`, { method: 'PUT', body: JSON.stringify({ status: 'Paid', paid_on: dialog.salaryPayment.date, payment_method: dialog.salaryPayment.method, notes: dialog.salaryPayment.notes }) });
        else if (dialog.type === 'job-invoice') { const jobId = dialog.row?._id || dialog.row?.[0]; const invoice = await apiRequest('/invoices', { method: 'POST', body: JSON.stringify({ job_id: jobId, customer_id: dialog.customerId || dialog.row?._record?.customer_id, date: dialog.invoiceDate, due_date: dialog.dueDate, payment_terms: dialog.paymentTerms, items: [{ description: dialog.row?.[1] || 'Job service', qty: 1, unit_price: dialog.subtotal }], subtotal: dialog.subtotal, additional_charges: dialog.charges, discount: dialog.discount, total: dialog.total, status: 'Issued' }) }); const invoiceId = invoice?.id || invoice?._id || invoice?.number || invoice?.invoice?.id; if (dialog.amountPaid > 0 && invoiceId) await apiRequest(`/invoices/${encodeURIComponent(invoiceId)}/payments`, { method: 'POST', body: JSON.stringify({ amount: dialog.amountPaid, date: dialog.invoiceDate, method: 'Cash' }) }); await apiRequest(`/jobs/${recordId}/status`, { method: 'POST', body: JSON.stringify({ status: 'Invoice Generated' }) }); }
        else if (dialog.type === 'job-close') await apiRequest(`/jobs/${recordId}/close`, { method: 'POST', body: JSON.stringify({ payment_status: dialog.paymentStatus, payment_amount: dialog.paymentAmount, due_date: dialog.dueDate }) });
        else if (dialog.type === 'advance-issue') await apiRequest(`/advances/${recordId}/issue`, { method: 'POST', body: JSON.stringify(dialog.issue) });
        else if (dialog.type === 'job-cancel') await apiRequest(`/jobs/${recordId}`, { method: 'PUT', body: JSON.stringify({ status: 'Cancelled', cancellation_reason: dialog.reason }) });
        else if (dialog.type === 'stock-movement') await apiRequest(`/material-requests/${recordId}/${dialog.movement}`, { method: 'POST', body: JSON.stringify(dialog.movementPayload) });
        else if (dialog.type === 'payment') await apiRequest(`/invoices/${recordId}/payments`, { method: 'POST', body: JSON.stringify(dialog.payment) });
        else if (dialog.type === 'service-report') await apiRequest(`/jobs/${recordId}/service-report`, { method: 'POST', body: requestBody(dialog.serviceReport) });
        else if (dialog.type === 'assign-job') await apiRequest(`/jobs/${recordId}/assign`, { method: 'POST', body: requestBody(dialog.payload) });
        else if (dialog.type === 'job-note') await apiRequest(`/jobs/${recordId}`, { method: 'PUT', body: JSON.stringify({ note: dialog.note }) });
        else if (dialog.type === 'advance-claim') await apiRequest(`/advances/${recordId}/claim`, { method: 'POST', body: JSON.stringify(dialog.claim) });
        else if (dialog.type === 'settle-advance') await apiRequest(`/advances/${recordId}/settle`, { method: 'POST', body: JSON.stringify({ amount: dialog.amount }) });
        else if (dialog.purge) await apiRequest(`/recycle-bin/${recordId}?purge=true`, { method: 'DELETE' });
        else if (isRemoving) await apiRequest(`/${apiEndpoint(slug)}/${recordId}${dialog.type === 'force' ? '?force=true' : ''}`, { method: 'DELETE' });
        else if (dialog.accountMode) await apiRequest('/users', { method: 'POST', body: JSON.stringify(dialog.account) });
        else if (dialog.type === 'create') await apiRequest(`/${dialog.apiResource || apiEndpoint(slug)}`, { method: 'POST', body: requestBody(dialog.payload || toApiRecord(info.columns, dialog.values)) });
        else if (dialog.type === 'edit') await apiRequest(`/${dialog.apiResource || apiEndpoint(slug)}/${recordId}`, { method: 'PUT', body: requestBody(dialog.payload || toApiRecord(info.columns, dialog.values)) });
        await queryClient.invalidateQueries({ queryKey: ['module', slug] });
        if (slug === 'jobs') await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      } else if (dialog.type === 'reset-password') { /* Demo accounts are preview-only. */ }
      else if (dialog.type === 'account-photo') {
        saveAccountAvatar(dialog.accountUsername || dialog.row?.[1], dialog.photo);
        const stored = initialUser();
        if (stored && (String(stored.username || '').toLowerCase() === String(dialog.row?.[1] || '').toLowerCase() || stored.name === dialog.row?.[0])) { sessionStorage.setItem('tsg_user', JSON.stringify({ ...stored, avatar: dialog.photo })); window.dispatchEvent(new Event('tsg-user-updated')); }
      }
      else if (dialog.type === 'salary-payment') {
        const { date, method, notes } = dialog.salaryPayment;
        const net = Number(String(dialog.row?.[3] || '').replace(/[^0-9.-]/g, ''));
        const voucher = /^SAL-/i.test(String(dialog.row?.[0] || '')) ? dialog.row[0] : nextSalaryVoucher();
        const record = { ...(dialog.row?._record || {}), voucher_no: voucher, staff_name: dialog.row?.[1], salary_month: dialog.row?.[2], net_pay: net, paid_on: date, payment_method: method, status: 'Paid', notes };
        const nextRow = attachDemoRecord('salary', [voucher, dialog.row?.[1], dialog.row?.[2], dialog.row?.[3], date, 'Paid'], record);
        persistRows(old => old.map(item => item === dialog.row ? nextRow : item));
        createDemoSalaryVoucher(record);
      }
      else if (dialog.type === 'my-account') {
        const { name, username, avatar } = dialog.myAccount;
        const stored = initialUser() || user;
        const oldUsername = String(stored.username || '');
        if (oldUsername && oldUsername.toLowerCase() !== username.toLowerCase()) saveAccountAvatar(oldUsername, '');
        saveAccountAvatar(username, avatar);
        const nextUser = { ...stored, name, username, avatar };
        sessionStorage.setItem('tsg_user', JSON.stringify(nextUser));
        window.dispatchEvent(new Event('tsg-user-updated'));
        const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        persistRows(old => { const index = old.findIndex(row => String(row[1]).toLowerCase() === oldUsername.toLowerCase() || row[0] === stored.name); if (index >= 0) return old.map((row, i) => i === index ? [name, username, nextUser.role || row[2], row[3], row[4], row[5]] : row); return [[name, username, nextUser.role || 'Admin', 'Today', today, 'Active'], ...old]; });
      }
      else if (dialog.type === 'advance-issue') { persistRows(old => old.map(item => item !== dialog.row ? item : item.map((cell,index) => index === 5 ? 'Issued' : index === 4 ? formatMoney(dialog.issue.amount) : cell))); const advances = JSON.parse(localStorage.getItem('tsg-demo-my-advances') || 'null') || moduleInfo['my-advances'].rows; localStorage.setItem('tsg-demo-my-advances', JSON.stringify([[dialog.row[0], dialog.row[3], `${dialog.row[2]} ? ${dialog.issue.purpose || 'Business advance'}`, formatMoney(dialog.issue.amount), formatMoney(0), formatMoney(dialog.issue.amount)], ...advances])); }
      else if (dialog.type === 'stock-movement') { const inventory = JSON.parse(localStorage.getItem('tsg-demo-inventory') || 'null') || moduleInfo.inventory.rows; const itemIndex = inventory.findIndex(item => item[1] === dialog.movementPayload.item_id || item[0] === dialog.movementPayload.item_id); if (itemIndex < 0) throw new Error('Choose a valid inventory item.'); const updated = [...inventory]; const target = [...updated[itemIndex]]; const onHand = Number(String(target[3]).replace(/[^0-9.]/g, '')); const qty = Number(dialog.movementPayload.quantity); if (dialog.movement === 'issue' && qty > onHand) throw new Error('Issue quantity exceeds available stock.'); const movements = JSON.parse(localStorage.getItem('tsg-demo-stock-movements') || '[]'); const issued = movements.filter(move => move.request_id === dialog.row?.[0] && move.item_id === dialog.movementPayload.item_id && move.type === 'issue').reduce((sum, move) => sum + Number(move.quantity), 0); const returned = movements.filter(move => move.request_id === dialog.row?.[0] && move.item_id === dialog.movementPayload.item_id && move.type === 'return').reduce((sum, move) => sum + Number(move.quantity), 0); if (dialog.movement === 'return' && qty > issued - returned) throw new Error('Return quantity exceeds the amount issued to this request.'); target[3] = `${onHand + (dialog.movement === 'issue' ? -qty : qty)} pcs`; target[5] = Number(String(target[3]).replace(/[^0-9.]/g, '')) <= Number(String(target[4]).replace(/[^0-9.]/g, '')) ? 'Low stock' : 'In stock'; updated[itemIndex] = target; localStorage.setItem('tsg-demo-inventory', JSON.stringify(updated)); localStorage.setItem('tsg-demo-stock-movements', JSON.stringify([{ ...dialog.movementPayload, type: dialog.movement, job_id: dialog.row?.[1], request_id: dialog.row?.[0], by: user.name, at: new Date().toISOString() }, ...movements])); persistRows(old => old.map(item => item !== dialog.row ? item : item.map((cell, index) => index === info.columns.findIndex(col => /status/i.test(col)) ? (dialog.movement === 'issue' ? (qty < Number(dialog.movementPayload.requested_quantity || qty) ? 'Partially Issued' : 'Issued') : 'Partially Issued') : cell))); }
      else if (dialog.type === 'job-invoice') { persistRows(old => old.map(item => item !== dialog.row ? item : item.map((cell, index) => index === info.columns.findIndex(col => /status/i.test(col)) ? 'Invoice Generated' : cell))); const data = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}'); const invoiceId = `INV-DEMO-${Date.now()}`; const jobData = data[dialog.row?.[0]]?.data || {}; data[dialog.row?.[0]] = { ...(data[dialog.row?.[0]] || {}), invoice: { number: invoiceId, total: dialog.total, amountPaid: dialog.amountPaid, dueDate: dialog.dueDate }, invoiceId }; localStorage.setItem('tsg-demo-job-workflows', JSON.stringify(data)); const invoices = JSON.parse(localStorage.getItem('tsg-demo-invoices') || 'null') || moduleInfo.invoices.rows; localStorage.setItem('tsg-demo-invoices', JSON.stringify([[invoiceId, jobData.customer_name || jobData.customer_id || dialog.row?.[1], dialog.invoiceDate, dialog.dueDate, formatMoney(dialog.total), dialog.amountPaid >= dialog.total ? 'Paid' : dialog.amountPaid > 0 ? 'Partially paid' : 'Unpaid'], ...invoices])); }
      else if (dialog.type === 'job-close') { persistRows(old => old.map(item => item !== dialog.row ? item : item.map((cell, index) => index === info.columns.findIndex(col => /status/i.test(col)) ? (dialog.paymentStatus === 'Paid' ? 'Closed - Paid' : 'Closed - Pending Payment') : cell))); const workflows = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}'); const record = workflows[dialog.row?.[0]] || {}; if (record.invoice) { record.invoice.amountPaid = Math.min(record.invoice.total, Number(record.invoice.amountPaid || 0) + Number(dialog.paymentAmount || 0)); workflows[dialog.row[0]] = record; localStorage.setItem('tsg-demo-job-workflows', JSON.stringify(workflows)); const invoices = JSON.parse(localStorage.getItem('tsg-demo-invoices') || 'null') || moduleInfo.invoices.rows; localStorage.setItem('tsg-demo-invoices', JSON.stringify(invoices.map(item => item[0] === record.invoice.number ? item.map((cell, index) => index === 5 ? (record.invoice.amountPaid >= record.invoice.total ? 'Paid' : record.invoice.amountPaid > 0 ? 'Partially paid' : 'Unpaid') : cell) : item))); } }
      else if (dialog.type === 'job-cancel') { persistRows(old => old.map(item => item !== dialog.row ? item : item.map((cell, index) => index === info.columns.findIndex(col => /status/i.test(col)) ? 'Cancelled' : cell))); const notes = JSON.parse(localStorage.getItem(`tsg-demo-job-notes-${recordId}`) || '[]'); localStorage.setItem(`tsg-demo-job-notes-${recordId}`, JSON.stringify([{ note: `Cancelled: ${dialog.reason}`, by: user.name, at: new Date().toLocaleString('en-IN') }, ...notes])); }
      else if (dialog.type === 'payment') persistRows(old => old.map(item => { if (item !== dialog.row) return item; const changed = [...item]; const statusIndex = info.columns.findIndex(col => /status/i.test(col)); const amountIndex = info.columns.findIndex(col => /amount|total/i.test(col)); const total = Number(String(item[amountIndex] || '').replace(/[^0-9.]/g, '')); changed[statusIndex] = Number(dialog.payment.amount) >= total ? 'Paid' : 'Partially paid'; return changed; }))
      else if (dialog.type === 'service-report') { const reportId = `SR-DEMO-${Date.now()}`; const reports = JSON.parse(localStorage.getItem('tsg-demo-service-report-records') || '[]'); const reportRecord = { number: reportId, job: dialog.row[0], status: 'Submitted', ...dialog.serviceReport }; localStorage.setItem('tsg-demo-service-report-records', JSON.stringify([reportRecord, ...reports])); const reportRows = JSON.parse(localStorage.getItem('tsg-demo-service-reports') || 'null') || moduleInfo['service-reports'].rows; localStorage.setItem('tsg-demo-service-reports', JSON.stringify([[reportId, dialog.row[0], dialog.serviceReport.customer_name || '?', new Date(dialog.serviceReport.delivered_at).toLocaleDateString('en-IN'), dialog.serviceReport.technician_name || 'You', 'Submitted'], ...reportRows])); const data = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}'); data[dialog.row[0]] = { ...(data[dialog.row[0]] || {}), completionReportId: reportId, completionReportApproved: false }; localStorage.setItem('tsg-demo-job-workflows', JSON.stringify(data)); }
      else if (dialog.type === 'advance-claim') { persistRows(old => old.map(item => { if (item !== dialog.row) return item; const changed = [...item]; const claimed = Number(String(changed[4]).replace(/[^0-9.]/g, '')) + Number(dialog.claim.amount); const amount = Number(String(changed[3]).replace(/[^0-9.]/g, '')); changed[4] = `MMK ${claimed.toLocaleString('en-US')}`; changed[5] = `MMK ${Math.max(0, amount - claimed).toLocaleString('en-US')}`; return changed; })); const expenseRows = JSON.parse(localStorage.getItem('tsg-demo-my-expense-claims') || 'null') || moduleInfo['my-expense-claims'].rows; localStorage.setItem('tsg-demo-my-expense-claims', JSON.stringify([[`EV-DEMO-${Date.now()}`, dialog.claim.category, dialog.row[0], dialog.claim.date, `MMK ${Number(dialog.claim.amount).toLocaleString('en-US')}`, 'Submitted'], ...expenseRows])); }
      else if (dialog.type === 'assign-job') persistRows(old => old.map(item => { if (item !== dialog.row) return item; const changed = [...item]; const assignedId = dialog.payload.team_leader || dialog.payload.assigned_to; const option = sampleLookupOptions.staff.find(([value]) => value === assignedId); changed[2] = option?.[1] || assignedId || changed[2]; if (dialog.payload.planned_end_date) changed[3] = dialog.payload.planned_end_date; const statusIndex = info.columns.findIndex(col => /status/i.test(col)); if (statusIndex >= 0) changed[statusIndex] = dialog.payload.planned_start_date || dialog.payload.planned_end_date ? 'Scheduled' : 'Assigned'; return changed; }));
      else if (dialog.type === 'job-note') { const key = `tsg-demo-job-notes-${recordId}`; const notes = JSON.parse(localStorage.getItem(key) || '[]'); localStorage.setItem(key, JSON.stringify([{ note: dialog.note, by: user.name, at: new Date().toLocaleString('en-IN') }, ...notes])); }
      else if (dialog.type === 'settle-advance') { persistRows(old => old.map(item => { if (item !== dialog.row) return item; const changed = [...item]; changed[5] = 'Settled'; return changed; })); const advances = JSON.parse(localStorage.getItem('tsg-demo-my-advances') || 'null') || moduleInfo['my-advances'].rows; localStorage.setItem('tsg-demo-my-advances', JSON.stringify(advances.map(item => { if (item[0] !== dialog.row?.[0]) return item; const changed = [...item]; const balance = Math.max(0, Number(String(changed[5]).replace(/[^0-9.]/g, '')) - Number(dialog.amount)); changed[5] = formatMoney(balance); if (!balance) changed[4] = formatMoney(Number(String(changed[3]).replace(/[^0-9.]/g, ''))); return changed; }))); }
      else if (isRemoving) {
        if (dialog.purge) localStorage.setItem('tsg-demo-recycle-bin-entries', JSON.stringify(JSON.parse(localStorage.getItem('tsg-demo-recycle-bin-entries') || '[]').filter(item => item.id !== dialog.row._entry?.id)));
        else { const entries = JSON.parse(localStorage.getItem('tsg-demo-recycle-bin-entries') || '[]'); entries.unshift({ id: `${slug}-${Date.now()}`, module: slug, moduleTitle: info.title, recordId: dialog.row._id || null, record: [...dialog.row], deletedBy: user.name, deletedAt: new Date().toLocaleDateString('en-IN'), mode: dialog.type === 'force' ? 'Force (recoverable)' : 'Restricted' }); localStorage.setItem('tsg-demo-recycle-bin-entries', JSON.stringify(entries)); }
        persistRows(old => old.filter(r => r !== dialog.row));
      }
      else if (dialog.accountMode) { saveAccountAvatar(dialog.account.username, dialog.account.avatar); persistRows(old => [dialog.values, ...old]); }
      else if (dialog.type === 'create') {
        const newRow = toModuleDemoRow(info.columns, dialog);
        attachDemoRecord(dialog.module, newRow, dialog.displayPayload || dialog.payload);
        if (dialog.module === 'jobs') { const workflows = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}'); workflows[newRow[0]] = { data: dialog.displayPayload || dialog.payload }; localStorage.setItem('tsg-demo-job-workflows', JSON.stringify(workflows)); }
        persistRows(old => [newRow, ...old]);
        
      }
      else if (dialog.type === 'edit') persistRows(old => old.map(r => r === dialog.row ? dialog.values : r));
      notify(dialog.type === 'reset-password' ? 'Password reset.' : dialog.type === 'account-photo' ? 'Profile picture updated.' : dialog.type === 'my-account' ? 'Your account has been updated.' : dialog.type === 'salary-payment' ? 'Salary marked as paid. Voucher generated in Cash & claims.' : dialog.type === 'payment' ? 'Payment recorded.' : dialog.type === 'advance-issue' ? 'Advance issued and linked to the employee balance.' : dialog.type === 'stock-movement' ? `Stock ${dialog.movement === 'issue' ? 'issued' : 'return recorded'} and ledger updated.` : dialog.type === 'service-report' ? 'Completion report submitted for manager review.' : dialog.type === 'assign-job' ? 'Job assignment saved.' : dialog.type === 'job-invoice' ? 'Invoice generated.' : dialog.type === 'job-close' ? 'Job closed.' : dialog.type === 'job-cancel' ? 'Job cancelled with reason recorded.' : dialog.type === 'job-note' ? 'Job note saved.' : dialog.type === 'advance-claim' ? 'Advance claim submitted.' : dialog.type === 'settle-advance' ? 'Advance settled.' : dialog.purge ? 'Record permanently purged.' : isRemoving ? 'Record moved to the Recycle Bin.' : dialog.accountMode ? 'User account created.' : dialog.type === 'create' ? 'Record created.' : 'Changes saved.');
      setDialog(null); setTypedConfirm('');
    } catch (error) { notify(error.message); }
  };
  const workflow = async (row, action, nextStatus) => {
    if (action === 'reset-password') { setDialog({ type: 'reset-password', row }); return; }
    if (action === 'update-photo') { setDialog({ type: 'account-photo', row }); return; }
    if (action === 'record-payment') { setDialog({ type: 'payment', row }); return; }
    if (action === 'service-report') { setDialog({ type: 'service-report', row }); return; }
    if (action === 'issue-materials' || action === 'return-materials') { setDialog({ type: 'stock-movement', movement: action === 'issue-materials' ? 'issue' : 'return', row }); return; }
    if (action === 'job-invoice') { setDialog({ type: 'job-invoice', row }); return; }
    if (action === 'job-close') { const record = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}')[row[0]] || {}; if (isDemo && (!record.invoiceId || !record.completionReportId)) { notify('Add a completion report and invoice before closing this job.'); return; } setDialog({ type: 'job-close', row }); return; }
    if (action === 'job-cancel') { setDialog({ type: 'job-cancel', row }); return; }
    if (action === 'add-note') { setDialog({ type: 'job-note', row, title: 'Add job note' }); return; }
    if (action === 'assign-job') { setDialog({ type: 'assign-job', row, title: 'Assign and schedule job', module: 'jobs', fields: [{ ...formSchemas.jobs.find(field => field.key === 'team_leader'), required: true }, formSchemas.jobs.find(field => field.key === 'assigned_to'), formSchemas.jobs.find(field => field.key === 'assigned_employees'), formSchemas.jobs.find(field => field.key === 'planned_start_date'), formSchemas.jobs.find(field => field.key === 'planned_end_date'), formSchemas.jobs.find(field => field.key === 'assigned_vehicle'), formSchemas.jobs.find(field => field.key === 'responsibilities')].filter(Boolean) }); return; }
    if (action === 'mark-salary-paid') { setDialog({ type: 'salary-payment', row }); return; }
    if (action === 'claim-advance') { setDialog({ type: 'advance-claim', row }); return; }
    if (action === 'settle-advance') { setDialog({ type: 'settle-advance', row }); return; }
    if (action === 'issue-advance') { setDialog({ type: 'advance-issue', row }); return; }
    const recordId = encodeURIComponent(row._id || row[0]);
    if (slug === 'notifications' && action === 'delete-notification') {
      if (!window.confirm('Delete this notification permanently?')) return;
      try {
        if (isDemo) persistRows(old => old.filter(item => item !== row));
        else {
          await apiRequest(`/notifications/${recordId}`, { method: 'DELETE' });
          await queryClient.invalidateQueries({ queryKey: ['module', 'notifications'] });
        }
        notify('Notification deleted.');
      } catch (error) { notify(error.message); }
      return;
    }
    if (slug === 'recycle-bin' && action === 'purge') { setDialog({ type: 'force', row, purge: true }); return; }
    try {
      if (!isDemo) {
        const apiModule = slug === 'my-expense-claims' || slug === 'cash-claims' ? 'expenses' : slug;
        if (slug === 'recycle-bin' && action === 'restore') await apiRequest(`/recycle-bin/${recordId}/restore`, { method: 'POST' });
        else if (slug === 'notifications' && action === 'mark-read') await apiRequest(`/notifications/${recordId}`, { method: 'PUT', body: JSON.stringify({ is_read: true }) });
        else if (slug === 'accounts' && ['activate', 'deactivate'].includes(action)) await apiRequest(`/users/${recordId}`, { method: 'PUT', body: JSON.stringify({ is_active: action === 'activate' }) });
        else if (slug === 'jobs') await apiRequest(`/${apiModule}/${recordId}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
        else if (slug === 'cash-claims' && /advance/i.test(String(row[1])) && ['approve', 'reject'].includes(action)) await apiRequest(`/advances/${recordId}/${action}`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
        else if (slug === 'cash-claims' && /^cash/i.test(String(row[1])) && ['approve', 'reject', 'post'].includes(action)) await apiRequest(`/cash-entries/${recordId}/${action}`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
        else if (slug === 'quotations' && action === 'convert-to-job') await apiRequest(`/${apiModule}/${recordId}/convert-to-job`, { method: 'POST' });
        else if (apiModule === 'expenses') await apiRequest(`/${apiModule}/${recordId}/${action}`, { method: 'POST' });
        else await apiRequest(`/${apiModule}/${recordId}`, { method: 'PUT', body: JSON.stringify({ status: nextStatus }) });
        await queryClient.invalidateQueries({ queryKey: ['module', slug] });
        if (slug === 'jobs') await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      } else if (slug === 'recycle-bin' && action === 'restore') {
        const entry = row._entry;
        const storedOriginals = localStorage.getItem(`tsg-demo-${entry.module}`);
        const originalRows = storedOriginals ? JSON.parse(storedOriginals) : (moduleInfo[entry.module]?.rows || []);
        localStorage.setItem(`tsg-demo-${entry.module}`, JSON.stringify([entry.record, ...originalRows]));
        localStorage.setItem('tsg-demo-recycle-bin-entries', JSON.stringify(JSON.parse(localStorage.getItem('tsg-demo-recycle-bin-entries') || '[]').filter(item => item.id !== entry.id)));
        persistRows(old => old.filter(item => item !== row));
  } else if (module === 'salary' || module === 'my-salary') {
    title = 'SALARY SLIP';
    const numeric = value => Number(String(value ?? 0).replace(/[^0-9.-]/g, '')) || 0;
    const money = value => `MMK ${numeric(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    const employee = get('staff_name', 'employee_name', 'staff') || row?.[1] || 'Employee';
    const month = get('salary_month', 'month') || row?.[2] || '?';
    const status = get('status') || row?.[5] || 'Draft';
    const paidOn = get('paid_on', 'payment_date') || row?.[4] || '?';
    const method = get('payment_method', 'method') || '?';
    const net = get('net_pay', 'net_salary', 'net') || row?.[3] || 0;
    const basic = get('basic_salary', 'basic') || net;
    const allowances = get('allowances', 'allowance') || 0;
    const deductions = get('deductions', 'deduction') || 0;
    const gross = get('gross_pay', 'gross') || numeric(basic) + numeric(allowances);
    const voucher = get('voucher_no', 'voucher') || number;
    headerMeta = `${voucher} - ${month}`;
    content = `<div class="invoice-parties"><div class="invoice-card bill-to"><span class="kicker">EMPLOYEE</span><h2>${esc(employee)}</h2><p>Salary month: ${esc(pretty(month))}</p><p>Status: ${esc(pretty(status))}</p></div><div class="invoice-card invoice-info"><div class="invoice-number"><span>SALARY SLIP</span><b>${esc(voucher)}</b></div>${pair('Paid on', paidOn)}${pair('Payment method', method)}${pair('Voucher', voucher)}</div></div>`
      + `<div class="invoice-bottom"><div class="grid">${pair('Basic salary', money(basic))}${pair('Allowances', money(allowances))}${pair('Deductions', money(deductions))}</div><div class="invoice-totals">${pair('Gross pay', money(gross))}<div class="grand-total"><span>Net pay</span><b>${esc(money(net))}</b></div></div></div>`
      + section('Notes', `<p>${esc(pretty(get('notes')) || 'Salary payment processed by TSG Power Engineering.')}</p>`)
      + `<div class="signatures"><span>Prepared by: ________________</span><span>Received by: ________________</span></div>`;
  } else {
        persistRows(old => old.map(item => { if (item !== row) return item; const changed = [...item]; const ix = info.columns.findIndex(col => /status/i.test(col)); if (ix >= 0) changed[ix] = nextStatus; return changed; }));
        if (slug === 'service-reports') { const records = JSON.parse(localStorage.getItem('tsg-demo-service-report-records') || '[]'); localStorage.setItem('tsg-demo-service-report-records', JSON.stringify(records.map(item => item.number === row[0] ? { ...item, status: nextStatus } : item))); const workflows = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}'); const job = row[1]; workflows[job] = { ...(workflows[job] || {}), completionReportApproved: nextStatus === 'Approved' }; localStorage.setItem('tsg-demo-job-workflows', JSON.stringify(workflows)); if (nextStatus === 'Approved') { const jobs = JSON.parse(localStorage.getItem('tsg-demo-jobs') || 'null') || moduleInfo.jobs.rows; localStorage.setItem('tsg-demo-jobs', JSON.stringify(jobs.map(item => item[0] === job ? item.map((cell,index) => index === moduleInfo.jobs.columns.findIndex(col => /status/i.test(col)) ? 'Completed' : cell) : item))); } }
        if (slug === 'quotations' && action === 'convert-to-job') { const customer = moduleInfo.customers.rows.find(item => item[0] === row[1]); const jobDialog = { module: 'jobs', payload: { customer_id: customer?.[1], customer_name: row[1], quotation_id: row[0], quotation_amount: String(row[4]).replace(/[^0-9.]/g, ''), title: `Service from ${row[0]}`, status: 'Pending Approval', priority: 'Normal' } }; const jobRow = toModuleDemoRow(moduleInfo.jobs.columns, jobDialog); const jobs = JSON.parse(localStorage.getItem('tsg-demo-jobs') || 'null') || moduleInfo.jobs.rows; attachDemoRecord('jobs', jobRow, jobDialog.payload); localStorage.setItem('tsg-demo-jobs', JSON.stringify([jobRow, ...jobs])); const workflows = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}'); workflows[jobRow[0]] = { data: jobDialog.payload, quotationId: row[0] }; localStorage.setItem('tsg-demo-job-workflows', JSON.stringify(workflows)); }
      }
      notify(action === 'restore' ? 'Record restored to its module.' : `${info.title.slice(0, -1)} ${action}.`);
    } catch (error) { notify(error.message); }
  };
  const statusValues = [...new Set(staffRows.flatMap(row => row.filter(cell => isStatus(cell))))];
  const totalCount = Number(listQuery.data?.total ?? listQuery.data?.pagination?.total ?? visibleRows.length);
  const pageCount = Math.max(1, Math.ceil(totalCount / 10));
  const pageRows = isDemo ? visibleRows.slice((page - 1) * 10, page * 10) : visibleRows;
  return <><div className="page-heading module-heading"><div><div className="eyebrow">OPERATIONS</div><h1>{info.title}</h1><p>{info.description}</p></div>{slug === 'accounts' && user.role === 'Admin' && <button className="secondary-button" onClick={() => setDialog({ type: 'my-account', user })}><ShieldCheck size={15} />My account</button>}{canCreate && <button className="primary-button" onClick={() => create()}><Plus size={16} />{slug === 'jobs' ? 'Create job order' : slug === 'customers' ? 'Create customer' : `Add ${info.title.replace(/s$/, '').toLowerCase()}`}</button>}{canCreate && slug === "cash-claims" && <><button className="secondary-button" onClick={() => create("cash-entry")}><Plus size={15} />Cash movement</button><button className="secondary-button" onClick={() => create("new-advance")}><Plus size={15} />New advance request</button></>}</div>{slug === 'jobs' && <div className="job-stage-strip">{[['Draft', Wrench], ['Pending Approval', Clock3], ['In Progress', Activity], ['On Hold', Bell], ['Completed', Check], ['Invoice Generated', ReceiptTextIcon]].map(([stage, Icon]) => <button key={stage} className={statusFilter === stage ? 'selected' : ''} onClick={() => { setStatusFilter(statusFilter === stage ? '' : stage); setPage(1); }}><span><Icon size={16} /></span><b>{staffRows.filter(row => String(row[info.columns.findIndex(col => /status/i.test(col))]).toLowerCase() === stage.toLowerCase()).length}</b><small>{stage}</small></button>)}</div>}<section className="panel module-panel"><div className="list-toolbar"><div className="search-box"><Search size={16} /><input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder={`Search ${info.title.toLowerCase()}…`} /></div><div className="list-actions">{slug === 'notifications' && <button className="secondary-button export-button" onClick={clearNotifications}><Trash2 size={15} /> Clear all</button>}<button className={`secondary-button filter-button ${filterOpen ? 'filter-selected' : ''}`} onClick={() => setFilterOpen(value => !value)}><Filter size={15} /> Filters {statusFilter && <span className="filter-count">1</span>}</button>{slug !== 'notifications' && <><span className="toolbar-separator" />{slug !== 'service-reports' && <button className="secondary-button export-button" onClick={() => onExport('xlsx')}><FileDown size={15} /> {isDemo ? 'Download CSV' : 'Export Excel'}</button>}<button className="secondary-button export-button" onClick={() => onExport('pdf')}><Download size={15} /> Export list PDF</button></>}</div></div>{filterOpen && <div className="filter-panel"><label>Status<select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}><option value="">All statuses</option>{statusValues.map(value => <option key={value}>{value}</option>)}</select></label><label>From<input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} /></label><label>To<input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} /></label><button className="row-action-button" onClick={() => { setSearch(""); setStatusFilter(""); setDateFrom(""); setDateTo(""); setPage(1); }}>Clear filters</button><span>Exports use these same filters.</span></div>}{listQuery.isError && <div className="query-error"><b>Couldn’t load {info.title.toLowerCase()}.</b><span>{listQuery.error.message}</span><button className="secondary-button" onClick={() => listQuery.refetch()}>Try again</button></div>}{listQuery.isFetching && <div className="loading-bar"><span /></div>}<div className="table-scroll"><table className="data-table module-table"><thead><tr>{info.columns.map(col => <th key={col}>{col.toUpperCase()}</th>)}<th className="actions-head">ACTIONS</th></tr></thead><tbody>{pageRows.map((row, ri) => { const avatar = slug === 'accounts' ? rowAvatar(row, isDemo) : ''; return <tr key={`${row._id || row[0]}-${ri}`}>{row.map((cell, ci) => <td key={ci}>{isStatus(cell) ? <Status value={cell} /> : ci === 0 && slug === 'accounts' ? <div className="record-user">{avatar ? <img className="record-avatar" src={avatar} alt="" /> : <span className="record-avatar record-avatar-fallback">{initials(cell)}</span>}<b className="record-link">{cell}</b></div> : ci === 0 ? <b className="record-link">{cell}</b> : cell}</td>)}<td><div className="row-actions"><button className="row-view-button" onClick={() => setDialog({ type: 'view', row, module: slug })}>View</button><button className="row-more-button" aria-label={`More actions for ${row[0]}`} title="More actions" aria-expanded={openRowActions?.id === String(row._id || row[0])} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); const id = String(row._id || row[0]); setOpenRowActions(current => current?.id === id ? null : { id, top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 290)), left: Math.max(8, Math.min(rect.right - 205, window.innerWidth - 220)) }); }}><MoreHorizontal size={19} /></button>{openRowActions?.id === String(row._id || row[0]) && createPortal(<><button className="row-actions-dismiss" aria-label="Close actions menu" onClick={() => setOpenRowActions(null)} /><div className="row-action-popover" role="menu" style={{ top: openRowActions.top, left: openRowActions.left }}><strong>{row[0]}</strong><button role="menuitem" onClick={() => { setOpenRowActions(null); setDialog({ type: 'view', row, module: slug }); }}>View details</button>{canEdit && <button role="menuitem" onClick={() => { setOpenRowActions(null); edit(row); }}>Edit record</button>}{slug === 'accounts' && (String(row[1]).toLowerCase() === String(user.username || '').toLowerCase() || row[0] === user.name) && <button role="menuitem" onClick={() => { setOpenRowActions(null); setDialog({ type: 'my-account', user }); }}>Manage my account</button>}{((['invoices','customers','jobs','service-reports','my-expense-claims'].includes(slug) || (['salary','my-salary'].includes(slug) && /^paid$/i.test(String(row[5] || ''))))) && <button role="menuitem" onClick={() => { setOpenRowActions(null); printRecordDocument(slug, row, info.columns); }}>Print / save {documentLabel(slug)} PDF</button>}{workflowActions(slug, row, info.columns, user.role).map(action => <button role="menuitem" key={action.label} onClick={() => { setOpenRowActions(null); workflow(row, action.action, action.status); }}>{action.label}</button>)}{showDelete && <><span className="row-menu-divider" /><button role="menuitem" className="menu-danger" onClick={() => { setOpenRowActions(null); remove(row, false); }}>Delete record</button>{showForceDelete && <button role="menuitem" className="menu-danger" onClick={() => { setOpenRowActions(null); remove(row, true); }}>Force delete</button>}</>}</div></>, document.body)}</div></td></tr>; })}{!visibleRows.length && <tr><td colSpan={info.columns.length + 1} className="empty-state">{listQuery.isLoading ? 'Loading records…' : `No records match “${search}”.`}</td></tr>}</tbody></table></div><div className="table-footer"><span>Showing <b>{visibleRows.length ? (page - 1) * 10 + 1 : 0}–{Math.min(page * 10, totalCount)}</b> of <b>{totalCount}</b> records</span><div className="pagination"><button disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><button className="page-active">{page}</button><button disabled={page >= pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}><ChevronRight size={15} /></button></div></div></section><div className="module-note"><ShieldCheck size={15} /><span>{user.role === 'Admin' ? 'Admin access · Changes are recorded in the audit log.' : slug === 'customers' ? 'Staff access · You can manage customer records.' : 'Staff access · You can only view and update your assigned work.'}</span></div>{dialog && (['job-invoice', 'job-close', 'job-cancel'].includes(dialog.type) ? <JobFinanceDialog key={`${dialog.type}-${dialog.row?.[0]}`} isDemo={isDemo} dialog={dialog} onClose={() => setDialog(null)} onConfirm={payload => { Object.assign(dialog, payload); confirmAction(); }} /> : dialog.type === 'advance-issue' ? <AdvanceIssueDialog key={`${dialog.type}-${dialog.row?.[0]}`} dialog={dialog} onClose={() => setDialog(null)} onConfirm={payload => { Object.assign(dialog, payload); confirmAction(); }} /> : dialog.type === 'salary-payment' ? <SalaryPaymentDialog key={`${dialog.type}-${dialog.row?.[0]}`} dialog={dialog} onClose={() => setDialog(null)} onConfirm={payload => { Object.assign(dialog, payload); confirmAction(); }} /> : dialog.type === 'stock-movement' ? <StockMovementDialog key={`${dialog.type}-${dialog.row?.[0]}`} dialog={dialog} onClose={() => setDialog(null)} onConfirm={payload => { Object.assign(dialog, payload); confirmAction(); }} /> : <Dialog key={`${dialog.type}-${dialog.row?.[0] || dialog.title || slug}`} isDemo={isDemo} dialog={dialog} columns={info.columns} typedConfirm={typedConfirm} setTypedConfirm={setTypedConfirm} onClose={() => { setDialog(null); setTypedConfirm(''); }} onConfirm={confirmAction} />)}</>;
}

function AdvanceIssueDialog({ dialog, onClose, onConfirm }) {
  const requested = Number(String(dialog.row?.[4] || '').replace(/[^0-9.]/g, ''));
  const [amount, setAmount] = useState(String(requested || ''));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('Bank transfer');
  const [purpose, setPurpose] = useState('');
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal"><div className="modal-header"><div><div className="eyebrow">ADVANCE · {dialog.row?.[0]}</div><h2>Issue employee advance</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div><div className="record-fields special-fields"><label>Issue date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>Approved amount<input type="number" min="0.01" max={requested || undefined} step="0.01" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>Payment method<select value={method} onChange={event => setMethod(event.target.value)}><option>Bank transfer</option><option>Cash</option><option>Cheque</option></select></label><label className="wide-field">Payment voucher reference<input value={purpose} onChange={event => setPurpose(event.target.value)} placeholder="Voucher / transfer reference" /></label><p className="wide-field">Issuing the funds creates the employee’s advance balance. Claims and returned cash are settled separately.</p></div><div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={Number(amount) <= 0 || (requested > 0 && Number(amount) > requested) || !purpose.trim()} onClick={() => onConfirm({ issue: { amount: Number(amount), date, method, purpose } })}>Record issue</button></div></section></div>;
}

function SalaryPaymentDialog({ dialog, onClose, onConfirm }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('Bank transfer');
  const [notes, setNotes] = useState('');
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal"><div className="modal-header"><div><div className="eyebrow">SALARY · {dialog.row?.[0]}</div><h2>Mark salary as paid</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div><div className="record-fields special-fields"><div className="job-total-preview wide-field"><span>Net pay</span><b>{dialog.row?.[3] || '—'}</b><small>{dialog.row?.[1]} · {dialog.row?.[2]}</small></div><label>Payment date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>Payment method<select value={method} onChange={event => setMethod(event.target.value)}><option>Bank transfer</option><option>Cash</option><option>Cheque</option></select></label><label className="wide-field">Notes<textarea rows={2} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional payment reference or remarks" /></label><p className="wide-field">Confirming payment marks this salary paid and automatically generates a salary voucher in Cash & claims.</p></div><div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!date} onClick={() => onConfirm({ salaryPayment: { date, method, notes } })}>Confirm payment</button></div></section></div>;
}

function StockMovementDialog({ dialog, onClose, onConfirm }) {
  const items = moduleInfo.inventory.rows;
  const suggested = String(dialog.row?.[3] || '').match(/(.+?)\s*[×x]\s*(\d+(?:\.\d+)?)/i);
  const suggestedItem = items.find(item => suggested && item[0].toLowerCase().includes(suggested[1].trim().toLowerCase()));
  const [itemId, setItemId] = useState(suggestedItem?.[1] || '');
  const [quantity, setQuantity] = useState(suggested?.[2] || '1');
  const [warehouse, setWarehouse] = useState('Main store');
  const [note, setNote] = useState('');
  const title = dialog.movement === 'issue' ? 'Issue materials to job' : 'Return unused materials';
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="modal"><div className="modal-header"><div><div className="eyebrow">MATERIAL REQUEST · {dialog.row?.[0]}</div><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div><div className="record-fields special-fields"><label className="wide-field">Inventory item<select value={itemId} onChange={event => setItemId(event.target.value)}><option value="">Choose item</option>{items.map(item => <option key={item[1]} value={item[1]}>{item[0]} · {item[1]}</option>)}</select></label><label>Quantity<input type="number" min="0.01" step="0.01" value={quantity} onChange={event => setQuantity(event.target.value)} /></label><label>Warehouse<input value={warehouse} onChange={event => setWarehouse(event.target.value)} /></label><label className="wide-field">Movement note<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="Optional issue / return note" /></label></div><div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!itemId || Number(quantity) <= 0} onClick={() => onConfirm({ movementPayload: { item_id: itemId, quantity: Number(quantity), requested_quantity: Number(suggested?.[2] || quantity), warehouse, note } })}>{dialog.movement === 'issue' ? 'Post stock issue' : 'Post stock return'}</button></div></section></div>;
}

function JobFinanceDialog({ dialog, isDemo, onClose, onConfirm }) {
  const isInvoice = dialog.type === 'job-invoice'; const isCancel = dialog.type === 'job-cancel';
  const [reason, setReason] = useState('');
  const [subtotal, setSubtotal] = useState(''); const [charges, setCharges] = useState('0'); const [discount, setDiscount] = useState('0'); const [amountPaid, setAmountPaid] = useState('0');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10)); const [dueDate, setDueDate] = useState(''); const [paymentTerms, setPaymentTerms] = useState('Due on receipt'); const [paymentStatus, setPaymentStatus] = useState('Pending Payment'); const [paymentAmount, setPaymentAmount] = useState('0');
  const total = Math.max(0, Number(subtotal || 0) + Number(charges || 0) - Number(discount || 0));
  const workflow = JSON.parse(localStorage.getItem('tsg-demo-job-workflows') || '{}')[dialog.row?.[0]] || {};
  const complete = !isDemo || Boolean(workflow.completionReportApproved && workflow.invoiceId);
  const dueRemaining = Math.max(0, Number(workflow.invoice?.total || 0) - Number(workflow.invoice?.amountPaid || 0));
  const disabled = isCancel ? !reason.trim() : isInvoice ? Number(subtotal) <= 0 || !dueDate || Number(amountPaid) > total : (paymentStatus === 'Pending Payment' && !dueDate) || (paymentStatus === 'Paid' && isDemo && Number(paymentAmount) < dueRemaining) || (isDemo && Number(paymentAmount) > dueRemaining) || !complete;
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal job-finance-modal"><div className="modal-header"><div><div className="eyebrow">JOB ORDER / {dialog.row?.[0]}</div><h2>{isCancel ? 'Cancel job order' : isInvoice ? 'Create job invoice' : 'Close job order'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{isCancel ? <div className="record-fields special-fields"><label className="wide-field">Reason for cancellation<textarea rows={4} required value={reason} onChange={e => setReason(e.target.value)} placeholder="Explain why this job is being cancelled" /></label></div> : isInvoice ? <div className="record-fields special-fields"><label>Job value<input type="number" min="0.01" step="0.01" value={subtotal} onChange={e => setSubtotal(e.target.value)} placeholder="0.00" /></label><label>Additional charges<input type="number" min="0" step="0.01" value={charges} onChange={e => setCharges(e.target.value)} /></label><label>Discount<input type="number" min="0" step="0.01" value={discount} onChange={e => setDiscount(e.target.value)} /></label><label>Invoice date<input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} /></label><label>Due date<input type="date" required value={dueDate} onChange={e => setDueDate(e.target.value)} /></label><label>Payment terms<select value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)}><option>Due on receipt</option><option>7 days</option><option>15 days</option><option>30 days</option><option>Custom</option></select></label><label>Cash received<input type="number" min="0" step="0.01" value={amountPaid} onChange={e => setAmountPaid(e.target.value)} /></label><div className="job-total-preview"><span>Invoice total</span><b>MMK {total.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b><small>{Number(amountPaid) >= total ? 'Paid in full' : Number(amountPaid) > 0 ? `Balance MMK ${(total - Number(amountPaid)).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'Payment pending'}</small></div></div> : <div className="record-fields special-fields"><div className={`job-checklist ${complete ? 'is-ready' : 'is-incomplete'}`}><b>{complete ? 'Ready to close' : 'Required before closing'}</b><span>{workflow.completionReportApproved || !isDemo ? '[x] Approved completion report' : '[ ] Approved completion report required'}</span><span>{workflow.invoiceId || !isDemo ? '[x] Invoice generated' : '[ ] Invoice required'}</span></div><label>Payment status<select value={paymentStatus} onChange={e => setPaymentStatus(e.target.value)}><option>Pending Payment</option><option>Paid</option></select></label><label>{paymentStatus === 'Paid' ? 'Cash received' : 'Payment received so far'}<input type="number" min="0" step="0.01" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} /></label><label>Payment due date<input type="date" required={paymentStatus === 'Pending Payment'} value={dueDate} onChange={e => setDueDate(e.target.value)} /></label></div>}<div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={disabled} onClick={() => onConfirm(isCancel ? { reason } : isInvoice ? { customerId: dialog.row?._record?.customer_id || workflow.data?.customer_id, subtotal: Number(subtotal), charges: Number(charges), discount: Number(discount), total, amountPaid: Number(amountPaid), invoiceDate, dueDate, paymentTerms } : { paymentStatus, paymentAmount: Number(paymentAmount), dueDate })}>{isCancel ? 'Cancel job' : isInvoice ? 'Generate invoice' : 'Close job'}</button></div></section></div>;
}

function readFormValues(fields, row, columns, isDemo = false) {
  const columnFor = { name: 'Customer', supplier_name: 'Supplier', contact_person: 'Contact', phone: 'Phone', email: 'Email', address: 'Location', tax_number: 'GST number', category: 'Category', job_id: 'Job order', customer_id: 'Customer', machine_id: 'Machine', quotation_id: 'Quotation', assigned_to: 'Assigned to', due_date: 'Due date', date: 'Date', status: 'Status', amount: 'Amount', description: 'Description', purpose: 'Purpose', work_done: 'Work done', findings: 'Findings', parts_used: 'Parts used' };
  return Object.fromEntries(fields.map(field => {
    let value = row?._record?.[field.key] ?? row?._record?.[field.key.replace(/_([a-z])/g, (_, char) => char.toUpperCase())];
    if (value == null && row) { const index = columns.findIndex(label => label.toLowerCase() === String(columnFor[field.key] || field.label).toLowerCase()); if (index >= 0) value = row[index]; }
    if (field.type === 'number' && typeof value === 'string') value = value.replace(/[^0-9.-]/g, '');
    if (field.key === 'type' && typeof value === 'string') value = value.replace(/^cash\s+/i, '');
    if (field.type === 'items') value = Array.isArray(value) ? value : emptyItems();
    if (field.type === 'request-items') value = Array.isArray(value) ? value : emptyRequestItems();
    if (field.type === 'request-items') value = Array.isArray(value) ? value : emptyRequestItems();
    if (field.type === 'materials') value = Array.isArray(value) ? value : emptyMaterials();
    if (field.type === 'lookup-multiple') value = Array.isArray(value) ? value : [];
    if (field.type === 'file') value = '';
    if (field.type === 'lookup' && value != null && isDemo) { const option = (sampleLookupOptions[field.resource] || []).find(([id, label]) => id === value || label === value); if (option) value = option[0]; }
    if ((field.type === 'date' || field.type === 'datetime-local') && value) value = String(value).slice(0, field.type === 'date' ? 10 : 16);
    return [field.key, value ?? field.defaultValue ?? ''];
  }));
}

function Dialog({ dialog, columns, typedConfirm, setTypedConfirm, onClose, onConfirm, isDemo }) {
  const formFields = dialog.fields?.length ? dialog.fields : formSchemas[dialog.module] || [];
  const isDelete = dialog.type === 'delete' || dialog.type === 'force'; const isView = dialog.type === 'view'; const isForm = dialog.type === 'create' || dialog.type === 'edit'; const isAssign = dialog.type === 'assign-job'; const isJobNote = dialog.type === 'job-note'; const isAccountCreate = Boolean(dialog.accountMode); const isAccountPhoto = dialog.type === 'account-photo'; const isMyAccount = dialog.type === 'my-account'; const isReset = dialog.type === 'reset-password'; const isPayment = dialog.type === 'payment'; const isServiceReport = dialog.type === 'service-report'; const isAdvanceClaim = dialog.type === 'advance-claim'; const isSettleAdvance = dialog.type === 'settle-advance';
  const [values, setValues] = useState(dialog.row || []);
  const [fieldValues, setFieldValues] = useState(() => readFormValues(formFields || [], dialog.type === 'edit' ? dialog.row : null, columns, isDemo));
  const isSchemaCreate = (isForm && !isAccountCreate || isAssign) && Boolean(formFields?.length);
  const itemRows = fieldValues.items || [];
  const subtotal = itemRows.reduce((sum, item) => sum + Math.max(0, Number(item.qty || 0) * Number(item.unit_price || 0) - Number(item.discount || 0)), 0);
  const tax = subtotal * Number(fieldValues.tax_rate || 0) / 100;
  const [accountName, setAccountName] = useState(''); const [accountUsername, setAccountUsername] = useState(''); const [accountRole, setAccountRole] = useState('Staff'); const [accountPassword, setAccountPassword] = useState(''); const [accountEmail, setAccountEmail] = useState('');
  const [accountPhoto, setAccountPhoto] = useState(''); const [photo, setPhoto] = useState(() => rowAvatar(dialog.row, isDemo) || dialog.user?.avatar || ''); const [photoError, setPhotoError] = useState('');
  const [myName, setMyName] = useState(dialog.user?.name || ''); const [myUsername, setMyUsername] = useState(dialog.user?.username || String(dialog.user?.name || '').toLowerCase().replace(/\s+/g, '.')); const [myPassword, setMyPassword] = useState(''); const [myPasswordConfirm, setMyPasswordConfirm] = useState('');
  const myAccountInvalid = isMyAccount && (myName.trim().length < 2 || myUsername.trim().length < 3 || Boolean(photoError) || (myPassword !== '' && (myPassword.length < 10 || myPassword !== myPasswordConfirm)));
  const loadPhoto = (file, apply) => { if (!file) { apply(''); setPhotoError(''); return; } if (!/^image\//.test(file.type)) { setPhotoError('Choose an image file (JPG, PNG or WebP).'); return; } if (file.size > 1.5 * 1024 * 1024) { setPhotoError('Choose an image smaller than 1.5 MB.'); return; } const reader = new FileReader(); reader.onload = () => { apply(String(reader.result || '')); setPhotoError(''); }; reader.readAsDataURL(file); };
  const [password, setPassword] = useState('');
  const [amount, setAmount] = useState(''); const [method, setMethod] = useState('Bank transfer'); const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [workDone, setWorkDone] = useState(''); const [findings, setFindings] = useState(''); const [customerComplaint, setCustomerComplaint] = useState(''); const [testResults, setTestResults] = useState(''); const [recommendations, setRecommendations] = useState(''); const [partsUsed, setPartsUsed] = useState(''); const [customerName, setCustomerName] = useState(''); const [technicianName, setTechnicianName] = useState(''); const [customerSignature, setCustomerSignature] = useState(''); const [technicianSignature, setTechnicianSignature] = useState(''); const [reportPhotos, setReportPhotos] = useState([]); const [approvedByCustomer, setApprovedByCustomer] = useState(false); const [serviceStartedAt, setServiceStartedAt] = useState(new Date(Date.now() - 3600000).toISOString().slice(0, 16)); const [serviceFinishedAt, setServiceFinishedAt] = useState(new Date().toISOString().slice(0, 16));
  const [jobNote, setJobNote] = useState('');
  const [claimAmount, setClaimAmount] = useState(''); const [claimCategory, setClaimCategory] = useState('Job'); const [claimDescription, setClaimDescription] = useState(''); const [claimSupplier, setClaimSupplier] = useState('');
  const advanceRecords = isDemo ? (JSON.parse(localStorage.getItem('tsg-demo-my-advances') || 'null') || moduleInfo['my-advances'].rows) : [];
  const settleBalance = isSettleAdvance ? advanceRecords.find(item => item[0] === dialog.row?.[0])?.[5] : null;
  const cashLimit = Number(String(isSettleAdvance ? (settleBalance || dialog.row?._record?.balance || dialog.row?.[4]) : dialog.row?.[5] || '').replace(/[^0-9.]/g, ''));
  const lookupResources = [...new Set((formFields || []).filter(field => ['lookup', 'lookup-multiple', 'materials'].includes(field.type)).map(field => field.resource))];
  const lookupsQuery = useQuery({ queryKey: ['form-lookups', lookupResources], queryFn: async () => Object.fromEntries(await Promise.all(lookupResources.map(async resource => [resource, await apiRequest(`/${resource}?limit=100`)]))), enabled: Boolean(!isDemo && lookupResources.length), staleTime: 60_000 });  useEffect(() => {
    if (!['jobs', 'quotations', 'invoices'].includes(dialog.module)) return;
    const findRecord = (resource, id) => lookupRecords(resource, lookupsQuery.data?.[resource]).find(record => String(record.id ?? record.uuid ?? record.code ?? record.number) === String(id));
    let customer = fieldValues.customer_id ? findRecord('customers', fieldValues.customer_id) : null;
    if (!customer && isDemo && fieldValues.customer_id) { const row = moduleInfo.customers.rows.find(item => item[1] === fieldValues.customer_id); if (row) customer = { id: row[1], name: row[0], contact_person: row[2], address: row[4] }; }
    let quotation = fieldValues.quotation_id ? findRecord('quotations', fieldValues.quotation_id) : null;
    if (!quotation && isDemo && fieldValues.quotation_id) { const row = moduleInfo.quotations.rows.find(item => item[0] === fieldValues.quotation_id && String(item[5]).toLowerCase() === 'approved'); if (row) { const customerRow = moduleInfo.customers.rows.find(item => item[0] === row[1]); quotation = { id: row[0], number: row[0], date: row[2], total: Number(String(row[4]).replace(/[^0-9.]/g, '')), status: 'Approved', customer_id: customerRow?.[1], customer_name: row[1] }; } }
    const quoteCustomer = quotation?.customer_id ? findRecord('customers', quotation.customer_id) : null;
    customer = quoteCustomer || customer;
    const updates = {};
    if (customer) { updates.customer_name = customer.name || customer.legal_name || customer.customer_name || ''; updates.billing_address = customer.billing_address || customer.address || ''; updates.contact_person = customer.contact_person || customer.contact_name || ''; updates.phone = customer.phone || customer.phone_number || ''; updates.email = customer.email || ''; updates.address = customer.address || customer.billing_address || ''; }
    if (quotation && dialog.module === 'jobs') { updates.quotation_date = String(quotation.date || quotation.quotation_date || quotation.created_at || '').slice(0, 10); updates.quotation_amount = String(quotation.total ?? quotation.amount ?? quotation.total_amount ?? ''); updates.customer_approval = 'Approved'; updates.payment_terms = quotation.payment_terms || ''; updates.quoted_items = quotation.items || quotation.line_items || []; if (quotation.customer_id) updates.customer_id = quotation.customer_id; }
    if (Object.keys(updates).length) setFieldValues(old => ({ ...old, ...updates, ...(customer?.address && !old.site_location ? { site_location: customer.address } : {}) }));
  }, [dialog.module, fieldValues.customer_id, fieldValues.quotation_id, lookupsQuery.data, isDemo]);
  const formInvalid = (formFields || []).some(field => {
    const value = fieldValues[field.key];
    const empty = field.type === 'file' ? !(value instanceof File) && !(Array.isArray(value) && value.length) : field.type === 'lookup-multiple' ? !Array.isArray(value) || !value.length : Array.isArray(value) ? !value.some(item => item.description || item.item_id) : String(value ?? '').trim() === '';
    if (field.type === 'request-items' && field.required && (!value.some(item => item.item_id && Number(item.qty) > 0) || value.some(item => item.item_id && Number(item.qty) <= 0))) return true;
    if (field.required && empty) return true;
    if (field.type === 'items' && field.required && (!Array.isArray(value) || !value.some(item => item.description?.trim() && Number(item.qty) > 0 && Number(item.unit_price) >= 0))) return true;
    if (['cash-claims', 'my-expense-claims'].includes(dialog.module) && field.key === 'job_id' && fieldValues.category === 'Job' && empty) return true;
    if (['cash-claims', 'my-expense-claims'].includes(dialog.module) && field.key === 'office_type' && fieldValues.category === 'Office' && empty) return true;
    if (['cash-claims', 'my-expense-claims'].includes(dialog.module) && field.key === 'advance_id' && fieldValues.payment_source === 'From advance' && empty) return true;
    if (field.type === 'number' && value !== '' && value != null && Number(value) < Number(field.min || 0)) return true;
    if (field.type === 'email' && value && !/^\S+@\S+\.\S+$/.test(value)) return true;
    if (dialog.module === 'suppliers' && field.key === 'phone' && !String(value || '').trim() && !String(fieldValues.email || '').trim()) return true;
    if (dialog.module === 'customers' && field.key === 'phone' && !String(value || '').trim() && !String(fieldValues.email || '').trim()) return true;
    if (dialog.module === 'quotations' && field.key === 'valid_until' && fieldValues.date && value && value < fieldValues.date) return true;
    if (dialog.module === 'jobs' && field.key === 'planned_end_date' && fieldValues.planned_start_date && value && value < fieldValues.planned_start_date) return true;
    if (['cash-claims', 'my-expense-claims'].includes(dialog.module) && field.key === 'receipt_file' && !(value instanceof File) && !String(fieldValues.exception_reason || '').trim()) return true;
    return false;
  });
  const specialLabel = isJobNote ? 'JOB NOTE' : isPayment ? 'RECORD CUSTOMER PAYMENT' : isAdvanceClaim ? 'SETTLE STAFF ADVANCE' : isSettleAdvance ? 'CASH SETTLEMENT' : 'COMPLETION REPORT';
  const recordDetails = isView && dialog.row?._record ? Object.entries(dialog.row._record).filter(([key, value]) => !key.startsWith('_') && value != null && value !== '') : null;
  const viewColumns = recordDetails ? recordDetails.map(([key]) => key.replaceAll('_', ' ')) : columns;
  const viewValues = recordDetails ? recordDetails.map(([, value]) => typeof value === 'object' ? JSON.stringify(value) : String(value)) : values;
  const specialTitle = isJobNote ? `Add note · ${dialog.row?.[0]}` : isPayment ? `Payment · ${dialog.row?.[0]}` : isAdvanceClaim ? `New claim · ${dialog.row?.[0]}` : isSettleAdvance ? `Settle · ${dialog.row?.[0]}` : `Complete job · ${dialog.row?.[0]}`;
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal"><div className="modal-header"><div><div className="eyebrow">{isMyAccount ? 'MY ACCOUNT' : isAccountPhoto ? 'ACCOUNT PROFILE' : isPayment || isServiceReport || isAdvanceClaim || isSettleAdvance || isJobNote ? specialLabel : dialog.type === 'force' ? 'FORCE DELETE' : isReset ? 'ADMIN PASSWORD RESET' : isDelete ? 'DELETE RECORD' : isView ? 'RECORD DETAILS' : 'RECORD'}</div><h2>{isMyAccount ? 'Manage my account' : isAccountPhoto ? `Profile picture · ${dialog.row?.[0]}` : isPayment || isServiceReport || isAdvanceClaim || isSettleAdvance || isJobNote ? specialTitle : isAccountCreate ? 'Create user account' : isAssign ? dialog.title : dialog.type === 'create' ? (dialog.title || 'Create new record') : dialog.type === 'edit' ? 'Edit record' : isReset ? `Reset password · ${dialog.row?.[0]}` : isView ? dialog.row?.[0] : isDelete ? 'Delete this record?' : 'Force delete this record?'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{isAccountCreate && <div className="record-fields special-fields"><label>Full name<input value={accountName} onChange={e => setAccountName(e.target.value)} placeholder="Staff member name" /></label><label>Email<input type="email" autoComplete="off" value={accountEmail} onChange={e => setAccountEmail(e.target.value)} placeholder="name@company.com" /></label><label>Username<input autoComplete="off" value={accountUsername} onChange={e => setAccountUsername(e.target.value)} placeholder="Unique username" /></label><label>Role<select value={accountRole} onChange={e => setAccountRole(e.target.value)}><option>Staff</option><option>Admin</option></select></label><label>Initial password<input type="password" autoComplete="new-password" value={accountPassword} onChange={e => setAccountPassword(e.target.value)} placeholder="At least 10 characters" /></label><label className="wide-field">Profile picture<input type="file" accept="image/*" onChange={e => loadPhoto(e.target.files?.[0], setAccountPhoto)} /><small>Optional. JPG, PNG or WebP up to 1.5 MB.</small></label>{accountPhoto && <div className="account-photo-field wide-field"><span className="account-photo-preview"><img src={accountPhoto} alt="Profile preview" /></span><button type="button" className="secondary-button" onClick={() => setAccountPhoto('')}>Remove photo</button></div>}{photoError && <p className="form-error wide-field">{photoError}</p>}<p className="wide-field">Only Admin can create accounts and reset passwords. There is no self-service password recovery.</p></div>}{isAccountPhoto && <div className="account-photo-editor"><span className="account-photo-preview">{photo ? <img src={photo} alt={`${dialog.row?.[0]} profile`} /> : initials(dialog.row?.[0])}</span><label>Profile picture<input type="file" accept="image/*" onChange={e => loadPhoto(e.target.files?.[0], setPhoto)} /><small>JPG, PNG or WebP up to 1.5 MB. A square image works best.</small></label>{photoError && <p className="form-error">{photoError}</p>}{photo && <button type="button" className="secondary-button" onClick={() => { setPhoto(''); setPhotoError(''); }}>Remove photo</button>}</div>}{isMyAccount && <div className="record-fields special-fields"><label>Full name<input value={myName} onChange={e => setMyName(e.target.value)} placeholder="Your full name" /></label><label>Username<input autoComplete="off" value={myUsername} onChange={e => setMyUsername(e.target.value)} placeholder="Your username" /></label><label>Role<input value={dialog.user?.role || 'Admin'} readOnly /></label><label>New password<input type="password" autoComplete="new-password" value={myPassword} onChange={e => setMyPassword(e.target.value)} placeholder="Leave blank to keep current" /></label><label>Confirm new password<input type="password" autoComplete="new-password" value={myPasswordConfirm} onChange={e => setMyPasswordConfirm(e.target.value)} placeholder="Repeat new password" /></label><label className="wide-field">Profile picture<input type="file" accept="image/*" onChange={e => loadPhoto(e.target.files?.[0], setPhoto)} /><small>Optional. JPG, PNG or WebP up to 1.5 MB.</small></label>{photo && <div className="account-photo-field wide-field"><span className="account-photo-preview"><img src={photo} alt="Your profile preview" /></span><button type="button" className="secondary-button" onClick={() => { setPhoto(''); setPhotoError(''); }}>Remove photo</button></div>}{photoError && <p className="form-error wide-field">{photoError}</p>}{myPassword && myPasswordConfirm && myPassword !== myPasswordConfirm && <p className="form-error wide-field">Passwords do not match.</p>}{myPassword && myPassword.length < 10 && <p className="form-error wide-field">Use at least 10 characters for the new password.</p>}<p className="wide-field">You are editing your own administrator account. Leave the password fields blank to keep your current password.</p></div>}{isReset && <div className="record-fields reset-fields"><label>New temporary password<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter a temporary password" /></label><p>The user will need to contact an administrator if they forget this password.</p></div>}{isPayment && <div className="record-fields special-fields"><label>Amount<input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></label><label>Payment date<input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} /></label><label>Payment method<select value={method} onChange={e => setMethod(e.target.value)}><option>Bank transfer</option><option>Cash</option><option>Cheque</option><option>UPI</option></select></label><p>Recording a payment also creates the matching cash-in entry.</p></div>}{(isAdvanceClaim || isSettleAdvance) && <div className="record-fields special-fields"><label>Amount<input type="number" min="0.01" max={cashLimit || undefined} step="0.01" value={claimAmount} onChange={e => setClaimAmount(e.target.value)} placeholder="0.00" /></label>{isAdvanceClaim && <><label>Date<input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} /></label><label>Category<select value={claimCategory} onChange={e => setClaimCategory(e.target.value)}><option>Job</option><option>Office</option></select></label><label>Supplier<input value={claimSupplier} onChange={e => setClaimSupplier(e.target.value)} placeholder="Supplier name" /></label><label className="wide-field">Description<textarea value={claimDescription} onChange={e => setClaimDescription(e.target.value)} rows={2} placeholder="Describe the expense" /></label></>}<p className="wide-field">{isAdvanceClaim ? "The voucher will be linked to this advance and submitted for approval." : "Enter the cash returned to close or reduce this advance."}</p></div>}{isJobNote && <div className="record-fields special-fields"><label className="wide-field">Work note<textarea rows={4} value={jobNote} onChange={e => setJobNote(e.target.value)} placeholder="Add a work update or handover note" /></label></div>}{isServiceReport && <div className="record-fields special-fields"><label>Service start<input type="datetime-local" value={serviceStartedAt} onChange={e => setServiceStartedAt(e.target.value)} /></label><label>Service finish<input type="datetime-local" value={serviceFinishedAt} onChange={e => setServiceFinishedAt(e.target.value)} /></label><label className="wide-field">Customer complaint / reported issue<textarea required value={customerComplaint} onChange={e => setCustomerComplaint(e.target.value)} rows={2} placeholder="What issue did the customer report?" /></label><label className="wide-field">Inspection findings<textarea required value={findings} onChange={e => setFindings(e.target.value)} rows={2} placeholder="Diagnosis, measurements and observations" /></label><label className="wide-field">Work completed<textarea required value={workDone} onChange={e => setWorkDone(e.target.value)} rows={3} placeholder="Describe the work and corrective actions" /></label><label className="wide-field">Materials used<textarea value={partsUsed} onChange={e => setPartsUsed(e.target.value)} rows={2} placeholder="Parts and quantities used" /></label><label className="wide-field">Test results / readings<textarea required value={testResults} onChange={e => setTestResults(e.target.value)} rows={2} placeholder="Record operating checks and readings" /></label><label className="wide-field">Recommendations<textarea value={recommendations} onChange={e => setRecommendations(e.target.value)} rows={2} placeholder="Recommended follow-up work" /></label><label>Technician name<input required value={technicianName} onChange={e => setTechnicianName(e.target.value)} placeholder="Technician completing this report" /></label><label>Customer representative<input required value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Name and designation" /></label><label>Technician signature<input type="file" required accept="image/*,.pdf" onChange={e => setTechnicianSignature(e.target.files?.[0] || '')} /></label><label>Customer sign-off<input type="file" required accept="image/*,.pdf" onChange={e => setCustomerSignature(e.target.files?.[0] || '')} /></label><label className="wide-field">Job photos / attachments<input type="file" multiple accept="image/*,.pdf" onChange={e => setReportPhotos(Array.from(e.target.files || []))} /><small>{reportPhotos.length ? `${reportPhotos.length} file(s) selected` : 'Attach before, during or after photos if available'}</small></label><label className="approval-check"><input type="checkbox" checked={approvedByCustomer} onChange={e => setApprovedByCustomer(e.target.checked)} />Customer accepted the completed service</label><p className="wide-field">Submitting sends this report to the service manager for review. The job stays open until approval.</p></div>}{isDelete && (dialog.type === 'force' ? <><div className="warning-box force-warning"><ShieldCheck size={19} /><p><b>This action is logged and recoverable.</b><br />Dependants and related records may also be affected. Review the record before proceeding.</p></div><div className="confirm-preview"><b>Record to delete</b><span>{dialog.row?.[0]} · {dialog.row?.[1]}</span></div><label className="confirm-label">Type <b>DELETE</b> to confirm<input value={typedConfirm} onChange={e => setTypedConfirm(e.target.value)} placeholder="Type DELETE" autoFocus /></label></> : <div className="warning-box"><div className="warning-symbol">!</div><p><b>This record will be moved to the Recycle Bin.</b><br />It can be restored later by an administrator.</p></div>)}{(isView || (isForm && !isAccountCreate && !isSchemaCreate)) && <div className="record-fields">{columns.map((col, i) => <label key={col}>{col}{isForm ? <input value={values[i] === '—' ? '' : values[i] || ''} onChange={e => setValues(old => old.map((v, j) => i === j ? e.target.value : v))} placeholder={`Enter ${col.toLowerCase()}`} /> : <div className="detail-value">{values[i] || '—'}</div>}</label>)}</div>}{isSchemaCreate && <div className="record-fields schema-fields">{formFields.filter(field => !(['cash-claims', 'my-expense-claims'].includes(dialog.module) && ((field.key === 'job_id' && fieldValues.category === 'Office') || (field.key === 'office_type' && fieldValues.category !== 'Office') || (field.key === 'advance_id' && fieldValues.payment_source !== 'From advance')))).map(field => <FormField key={field.key} field={field} value={fieldValues[field.key]} options={['lookup', 'lookup-multiple', 'materials'].includes(field.type) ? lookupOptions(field.resource, lookupsQuery.data?.[field.resource], field, isDemo) : []} onChange={value => setFieldValues(old => ({ ...old, [field.key]: value }))} />)}{(dialog.module === "quotations" || dialog.module === "invoices") && <div className="total-preview"><span>Subtotal <b>MMK {subtotal.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></span><span>Tax <b>MMK {tax.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></span><span>Total <b>MMK {(subtotal + tax).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></span></div>}</div>}<div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button>{isView && canPrintDocument(dialog.module, dialog.row) && <button className="secondary-button" onClick={() => canPrintDocument(dialog.module, dialog.row) ? printRecordDocument(dialog.module, dialog.row, columns) : printReport(dialog.row?.[0] || 'Record', viewColumns, [viewValues], {})}><Download size={15} />{canPrintDocument(dialog.module, dialog.row) ? `Download ${documentLabel(dialog.module)} PDF` : 'Print / Save PDF'}</button>}{!isView && <button className={dialog.type === 'force' ? 'danger-button' : 'primary-button'} disabled={(dialog.type === 'force' && typedConfirm !== 'DELETE') || myAccountInvalid || (isReset && password.length < 10) || (isAccountCreate && (accountName.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(accountEmail) || accountUsername.trim().length < 3 || accountPassword.length < 10)) || (isPayment && Number(amount) <= 0) || ((isAdvanceClaim || isSettleAdvance) && (Number(claimAmount) <= 0 || (cashLimit > 0 && Number(claimAmount) > cashLimit))) || (isAdvanceClaim && !claimDescription.trim()) || (isJobNote && !jobNote.trim()) || (isServiceReport && (!workDone.trim() || !findings.trim() || !customerComplaint.trim() || !testResults.trim() || !technicianName.trim() || !customerName.trim() || !customerSignature || !technicianSignature || !approvedByCustomer || serviceFinishedAt < serviceStartedAt)) || (isSchemaCreate && formInvalid)} onClick={() => { if (isSchemaCreate) { dialog.displayPayload = { ...fieldValues }; const payload = Object.fromEntries((formFields || []).filter(field => field.type !== 'section' && field.type !== 'readonly').map(field => [field.key, fieldValues[field.key]])); if (dialog.module === "quotations" || dialog.module === "invoices") { payload.subtotal = subtotal; payload.tax = tax; payload.total = subtotal + tax; } dialog.payload = payload; dialog.values = toDisplayRow(columns, { ...dialog.displayPayload, ...payload }); } if (isForm && !isAccountCreate && !isSchemaCreate) dialog.values = values; if (isAccountCreate) { dialog.account = { name: accountName, email: accountEmail, username: accountUsername, role: accountRole, password: accountPassword, avatar: accountPhoto }; dialog.values = [accountName, accountUsername || accountEmail.split('@')[0], accountRole, 'Never', 'Today', 'Active']; } if (isAccountPhoto) { dialog.photo = photo; dialog.accountUsername = dialog.row?.[1]; } if (isMyAccount) { dialog.myAccount = { name: myName.trim(), username: myUsername.trim(), avatar: photo, password: myPassword }; } if (isReset) dialog.password = password; if (isPayment) dialog.payment = { amount: Number(amount), date: paymentDate, method }; if (isAdvanceClaim) dialog.claim = { amount: Number(claimAmount), date: paymentDate, category: claimCategory, supplier_name: claimSupplier, description: claimDescription, advance_id: dialog.row?._id || dialog.row?.[0] }; if (isSettleAdvance) dialog.amount = Number(claimAmount); if (isJobNote) dialog.note = jobNote; if (isServiceReport) dialog.serviceReport = { work_done: workDone, findings, customer_complaint: customerComplaint, test_results: testResults, recommendations, parts_used: partsUsed, technician_name: technicianName, customer_name: customerName, customer_approval: approvedByCustomer, technician_signature: technicianSignature, customer_signature: customerSignature, attachments: reportPhotos, started_at: serviceStartedAt, finished_at: serviceFinishedAt, delivered_at: new Date().toISOString() }; onConfirm(); }}>{isAccountCreate ? 'Create account' : isAccountPhoto ? 'Save photo' : isMyAccount ? 'Save my account' : isAssign ? 'Save assignment' : isJobNote ? 'Save note' : dialog.type === 'create' ? (dialog.title || 'Create record') : dialog.type === 'edit' ? 'Save changes' : isReset ? 'Reset password' : isPayment ? 'Record payment' : isServiceReport ? 'Save completion report' : isAdvanceClaim ? 'Submit claim' : isSettleAdvance ? 'Settle advance' : isDelete ? 'Delete record' : 'Force delete'}</button>}</div></section></div>;
}

function Reports() { return <><div className="page-heading module-heading"><div><div className="eyebrow">INSIGHTS & EXPORTS</div><h1>Reports</h1><p>Understand job performance, cash flow and operating costs.</p></div><button className="secondary-button" onClick={() => window.print()}><Download size={15} /> Export report</button></div><div className="report-cards">{[['Income & expense', 'Compare invoiced income with approved expenses.', 'MMK 1,248,000', 'income'], ['Job profitability', 'Invoice total minus job expenses and parts cost.', 'MMK 324,000', 'profit'], ['Cash balance', 'Opening balance plus cash in less cash out.', 'MMK 864,000', 'cash']].map(([title, desc, amount, key]) => <section className="panel report-card" key={title}><div className="report-card-top"><span className={`report-icon ${key}`}><Activity size={18} /></span><button className="icon-button" aria-label={`Export ${title}`}><Download size={16} /></button></div><h2>{title}</h2><p>{desc}</p><strong>{amount}</strong><span className="report-period">November 2026 <ArrowUpRight size={13} /></span></section>)}</div><section className="panel report-table-panel"><div className="panel-heading"><div><h2>Available reports</h2><p>Choose a report to view details or export your filtered data.</p></div><button className="select-period">This month <ChevronDown size={14} /></button></div>{[['Income and expense', 'Payments received, approved vouchers and supplier payments'], ['Per-job profitability', 'Invoice total, job expenses and parts cost by job'], ['Cash entries and balance', 'Cash in, cash out and calculated net balance'], ['Advance statement', 'Advance issued, vouchers claimed and settlement balance']].map(([title, desc]) => <div className="report-row" key={title}><div className="report-row-icon"><FileDown size={16} /></div><div><b>{title}</b><span>{desc}</span></div><button className="secondary-button" onClick={() => window.print()}>View report <ArrowRight size={14} /></button></div>)}</section></>;
}

const sampleLookupOptions = {
  inventory: [['FLT-0041', 'Air filter assembly'], ['BRG-0012', 'Bearing 6205 ZZ'], ['OIL-0008', 'Compressor oil 5L']],
  'fixed-assets': [['FA-0008', 'Field service van'], ['FA-0007', 'Pressure testing kit']],
  customers: [['CUS-0018', 'Eastern Hydro Works'], ['CUS-0017', 'Meridian Foods Ltd.'], ['CUS-0016', 'Bluepeak Manufacturing'], ['CUS-0015', 'Aster Cold Storage']],
  machines: [['MCH-0012', 'Compressor 2 · Atlas X90'], ['MCH-0011', 'Chiller 1 · CoolPro 450']],
  quotations: [['QT-2026-0140', 'QT-2026-0140 · Bluepeak · Approved']],
  jobs: [['JO-2026-0098', 'JO-2026-0098 · Eastern Hydro'], ['JO-2026-0097', 'JO-2026-0097 · Meridian Foods']],
  staff: [['ST-0012', 'Arjun Nair'], ['ST-0009', 'Ravi Kumar']],
  suppliers: [['SUP-0004', 'Prime Industrial Supply'], ['SUP-0003', 'Southline Components']],
  advances: [['ADV-2026-0018', 'ADV-2026-0018 · Arjun Nair']],
};
function lookupOptions(resource, response, field = {}, isDemo = false) {
  const raw = Array.isArray(response) ? response : response?.items || response?.data || response?.results || [];
  if (raw.length) return raw.filter(record => resource !== 'quotations' || ['approved', 'accepted'].includes(String(record.status || '').toLowerCase())).filter(record => !field.allowedStatuses?.length || field.allowedStatuses.includes(String(record.status || '').toLowerCase())).map(record => ({ value: record.id ?? record.uuid ?? record.code ?? record.number, label: record.name || record.legal_name || record.legal_company_name || record.title || record.number || record.code || record.username || String(record.id) }));
  if (!isDemo) return [];
  return (sampleLookupOptions[resource] || []).map(([value, label]) => ({ value, label }));
}
function lookupRecords(resource, response) { return Array.isArray(response) ? response : response?.items || response?.data || response?.results || []; }
function FormField({ field, value, onChange, options = [] }) {
  const required = field.required || false;
  if (field.type === 'section') return <div className="form-section-heading">{field.label}</div>;
  if (field.type === 'readonly') return <label className="form-field autofilled-field">{field.label}<input value={value || ''} readOnly aria-readonly="true" placeholder={field.placeholder || 'Filled automatically'} /><small>Auto-filled from the selected record or calculated for you.</small></label>;
  if (field.type === 'items') return <div className="line-items-field"><div className="line-items-title">{field.label}{required && <b>*</b>}</div>{(Array.isArray(value) ? value : []).map((item, index) => <div className="line-item-row priced-line" key={index}><input aria-label={`${field.label} item ${index + 1}`} required={required && index === 0} value={item.description || ''} placeholder="Service or material" onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, description: e.target.value } : entry))} /><input aria-label="Quantity" type="number" min="0.01" step="0.01" value={item.qty ?? 1} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, qty: Number(e.target.value) } : entry))} /><input aria-label="Unit" value={item.unit || ''} placeholder="Unit" onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, unit: e.target.value } : entry))} /><input aria-label="Unit price" type="number" min="0" step="0.01" value={item.unit_price ?? ''} placeholder="Unit price" onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, unit_price: Number(e.target.value) } : entry))} /><input aria-label="Line discount" type="number" min="0" step="0.01" value={item.discount ?? 0} placeholder="Discount" onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, discount: Number(e.target.value) } : entry))} /><button type="button" className="row-action-danger" onClick={() => onChange(value.length > 1 ? value.filter((_, i) => i !== index) : [{ description: '', qty: 1, unit: 'pcs', unit_price: '', discount: 0 }])}>Remove</button></div>)}<button type="button" className="secondary-button add-line-item" onClick={() => onChange([...value, { description: '', qty: 1, unit: 'pcs', unit_price: '', discount: 0 }])}><Plus size={13} />Add line</button></div>;
  if (field.type === 'request-items') return <div className="line-items-field"><div className="line-items-title">{field.label}{required && <b>*</b>}</div>{(Array.isArray(value) ? value : []).map((item, index) => <div className="line-item-row request-line" key={index}><select aria-label="Inventory item" value={item.item_id || ''} onChange={e => { const picked = options.find(option => option.value === e.target.value); onChange(value.map((entry, i) => i === index ? { ...entry, item_id: e.target.value, description: picked?.label || '' } : entry)); }}><option value="">Select inventory item</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><input aria-label="Description" value={item.description || ''} placeholder="Specification" onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, description: e.target.value } : entry))} /><input aria-label="Requested quantity" type="number" min="0.01" step="0.01" value={item.qty ?? 1} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, qty: Number(e.target.value) } : entry))} /><input aria-label="Unit" value={item.unit || ''} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, unit: e.target.value } : entry))} /><button type="button" className="row-action-danger" onClick={() => onChange(value.length > 1 ? value.filter((_, i) => i !== index) : [{ item_id: '', description: '', qty: 1, unit: 'pcs' }])}>Remove</button></div>)}<button type="button" className="secondary-button add-line-item" onClick={() => onChange([...value, { item_id: '', description: '', qty: 1, unit: 'pcs' }])}><Plus size={13} />Add requested item</button></div>;
  if (field.type === 'lookup-multiple') return <label className="form-field">{field.label}{required && <b>*</b>}<select multiple required={required} value={Array.isArray(value) ? value : []} onChange={e => onChange(Array.from(e.target.selectedOptions, option => option.value))}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  if (field.type === 'materials') return <div className="line-items-field materials-field"><div className="line-items-title">{field.label}</div>{(Array.isArray(value) ? value : []).map((item, index) => <div className="materials-row" key={index}><select aria-label="Inventory item" value={item.item_id || ''} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, item_id: e.target.value } : entry))}><option value="">Choose inventory item</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{[['required_qty','Required'],['issued_qty','Issued'],['used_qty','Used'],['returned_qty','Returned']].map(([key,label]) => <label key={key}>{label}<input type="number" min="0" step="0.01" value={item[key] ?? 0} onChange={e => onChange(value.map((entry, i) => i === index ? { ...entry, [key]: Number(e.target.value) } : entry))} /></label>)}<button type="button" className="row-action-danger" onClick={() => onChange(value.length > 1 ? value.filter((_, i) => i !== index) : emptyMaterials())}>Remove</button></div>)}<button type="button" className="secondary-button add-line-item" onClick={() => onChange([...value, { item_id: '', required_qty: 1, issued_qty: 0, used_qty: 0, returned_qty: 0 }])}><Plus size={13} />Add material</button></div>;
  if (field.type === 'textarea') return <label className="form-field wide-field">{field.label}{required && <b>*</b>}<textarea required={required} rows={3} value={value || ''} placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`} onChange={e => onChange(e.target.value)} /></label>;
  if (field.type === 'file') return <label className="form-field">{field.label}{required && <b>*</b>}<input type="file" required={required && !field.multiple} multiple={field.multiple} accept={field.accept} onChange={e => onChange(field.multiple ? Array.from(e.target.files || []) : e.target.files?.[0] || '')} /><small>{Array.isArray(value) && value.length ? `${value.length} file(s) selected` : value?.name || 'Choose a file to attach'}</small></label>;
  if (field.type === 'select' || field.type === 'lookup') return <label className="form-field">{field.label}{required && <b>*</b>}<select required={required} value={value || ''} onChange={e => onChange(e.target.value)}><option value="">Choose {field.label.toLowerCase()}</option>{(field.options || options).map(option => { const entry = typeof option === 'string' ? { value: option, label: option } : option; return <option key={entry.value} value={entry.value}>{entry.label}</option>; })}</select></label>;
  return <label className="form-field">{field.label}{required && <b>*</b>}<input type={field.type || 'text'} required={required} min={field.min} max={field.max} step={field.step} value={value || ''} placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`} onChange={e => onChange(e.target.value)} /></label>;
}
const reportCatalog = [
  { id: 'job-register', title: 'Job Register', description: 'Jobs by customer, team, dates and lifecycle status.', icon: BriefcaseIcon, source: 'jobs' },
  { id: 'quotation-register', title: 'Quotation Register', description: 'Quotes, expiry dates, totals and conversion status.', icon: FileDown, source: 'quotations' },
  { id: 'machine-service-history', title: 'Machine Service History', description: 'Registered equipment and linked service activity.', icon: Wrench, source: 'machines' },
  { id: 'invoice-register', title: 'Invoice Register', description: 'Invoices, due dates, received amounts and status.', icon: ReceiptTextIcon, source: 'invoices' },
  { id: 'receivables-aging', title: 'Receivables Aging', description: 'Outstanding invoices and due dates for follow-up.', icon: Clock3, source: 'invoices' },
  { id: 'cash-book', title: 'Cash Book', description: 'Receipts, payments and transaction references.', icon: WalletIcon, source: 'cash-claims' },
  { id: 'income-expense', title: 'Income and Expense', description: 'Cash movements and expenses by period and category.', icon: Activity, source: 'cash-claims' },
  { id: 'advance-outstanding', title: 'Advance Outstanding', description: 'Issued advances, claims and remaining balances.', icon: CircleHelp, source: 'my-advances' },
  { id: 'expense-claims', title: 'Expense Claim Register', description: 'Employee claims, job links and approval status.', icon: ReceiptTextIcon, source: 'my-expense-claims' },
  { id: 'inventory-stock', title: 'Inventory Stock', description: 'On-hand quantity, reorder level and stock state.', icon: BoxesIcon, source: 'inventory' },
  { id: 'material-usage-job', title: 'Material Usage by Job', description: 'Material requests and issued quantities by job.', icon: PackageCheckIcon, source: 'material-requests' },
  { id: 'supplier-register', title: 'Supplier Register', description: 'Supplier details, contact and active records.', icon: UsersIcon, source: 'suppliers' },
  { id: 'fixed-asset-register', title: 'Fixed Asset Register', description: 'Asset cost, assignment, location and status.', icon: BriefcaseIcon, source: 'fixed-assets' },
];
function ReportsPage({ user, notify }) {
  const isDemo = user.id?.startsWith('demo-');
  const [reportId, setReportId] = useState(reportCatalog[0].id);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [customer, setCustomer] = useState(''); const [job, setJob] = useState(''); const [status, setStatus] = useState(''); const [staff, setStaff] = useState(''); const [supplier, setSupplier] = useState('');
  const [remoteRows, setRemoteRows] = useState([]); const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState('');
  const selected = reportCatalog.find(report => report.id === reportId) || reportCatalog[0];
  const sourceInfo = moduleInfo[selected.source];
  const filters = { from, to, customer, job, status, staff, supplier };
  useEffect(() => {
    if (isDemo) { setRemoteRows([]); setLoadError(''); return; }
    let alive = true; setLoading(true); setLoadError('');
    const params = new URLSearchParams({ page: '1', limit: '500' });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    apiRequest(`/${apiEndpoint(selected.source)}?${params}`).then(result => { if (alive) setRemoteRows(normalizeList(result, sourceInfo.columns)); }).catch(error => { if (alive) setLoadError(error.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isDemo, selected.source, from, to, customer, job, status, staff, supplier]);
  const sourceRows = isDemo ? readDemoRows(selected.source, sourceInfo) : remoteRows;
  const dateColumn = sourceInfo.columns.findIndex(column => /date|due|issued|delivered|purchased|received/i.test(column));
  const searchFilters = [customer, job, status, staff, supplier].filter(Boolean).map(value => value.toLowerCase());
  const rows = sourceRows.filter(row => {
    const joined = row.join(' ').toLowerCase();
    if (!searchFilters.every(filter => joined.includes(filter))) return false;
    if (dateColumn >= 0 && (from || to)) {
      const raw = String(row[dateColumn] || ''); const parsed = new Date(raw);
      if (!Number.isNaN(parsed.valueOf())) {
        if (from && parsed < new Date(`${from}T00:00:00`)) return false;
        if (to && parsed > new Date(`${to}T23:59:59`)) return false;
      }
    }
    return true;
  });
  const clearFilters = () => { setFrom(''); setTo(''); setCustomer(''); setJob(''); setStatus(''); setStaff(''); setSupplier(''); };
  const doExport = async format => {
    const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
    if (!isDemo) { try { await exportModule(`reports/${selected.id}`, format, activeFilters); } catch (error) { notify(error.message); } return; }
    if (format === 'pdf') { printReport(selected.title, sourceInfo.columns, rows, activeFilters); return; }
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [sourceInfo.columns, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `TSG-${selected.id}-${new Date().toISOString().slice(0,10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <><div className="page-heading module-heading"><div><div className="eyebrow">INSIGHTS & EXPORTS</div><h1>Reports</h1><p>Filter the register, review matching records, then export that result.</p></div><label className="report-picker">Report<select value={reportId} onChange={event => setReportId(event.target.value)}>{reportCatalog.map(report => <option key={report.id} value={report.id}>{report.title}</option>)}</select></label></div>
    <section className="panel report-filters"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label>Customer<input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Search customer" /></label><label>Job ID<input value={job} onChange={e => setJob(e.target.value)} placeholder="Search job" /></label><label>Status<input value={status} onChange={e => setStatus(e.target.value)} placeholder="Any status" /></label><label>Technician / employee<input value={staff} onChange={e => setStaff(e.target.value)} placeholder="Search staff" /></label><label>Supplier<input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Search supplier" /></label><button className="row-action-button" onClick={clearFilters}>Clear filters</button></section>
    <div className="report-result-bar"><div><span className="report-row-icon"><selected.icon size={18} /></span><div><b>{selected.title}</b><small>{rows.length} matching records ? Generated {new Date().toLocaleString()}</small></div></div><div><button className="secondary-button" disabled={loading || (!isDemo && Boolean(loadError))} onClick={() => doExport('pdf')}><Download size={15} /> Print / Save PDF</button><button className="secondary-button" disabled={loading || (!isDemo && Boolean(loadError))} onClick={() => doExport('xlsx')}><FileDown size={15} /> {isDemo ? 'Download CSV' : 'Export Excel'}</button></div></div>
    {loadError && <div className="query-error"><b>Couldn?t load report records.</b><span>{loadError}</span></div>}
    <section className="panel report-table-panel report-preview"><div className="panel-heading"><div><h2>{selected.title}</h2><p>{selected.description}</p></div><span className="report-count">{loading ? 'Loading?' : `${rows.length} records`}</span></div><div className="table-scroll"><table className="data-table"><thead><tr>{sourceInfo.columns.map(column => <th key={column}>{column.toUpperCase()}</th>)}</tr></thead><tbody>{rows.map((row,index) => <tr key={`${row[0]}-${index}`}>{row.map((cell,i) => <td key={i}>{isStatus(cell) ? <Status value={cell} /> : cell}</td>)}</tr>)}{!loading && !rows.length && <tr><td className="empty-state" colSpan={sourceInfo.columns.length}>No records match these filters.</td></tr>}</tbody></table></div></section>
  </>;
}
const documentLabels = { invoices: 'invoice', customers: 'customer report', jobs: 'job order', 'service-reports': 'service report', 'my-expense-claims': 'expense voucher', salary: 'salary slip', 'my-salary': 'salary slip' };
function documentLabel(module) { return documentLabels[module] || 'record'; }
function canPrintDocument(module, row) { return ['invoices', 'customers', 'jobs', 'service-reports', 'my-expense-claims'].includes(module) || (['salary', 'my-salary'].includes(module) && /^paid$/i.test(String(row?.[5] || ''))); }
function printRecordDocument(module, row, columns) {
  let record = row?._record || {};
  if (module === 'service-reports' && !Object.keys(record).length) { try { record = JSON.parse(localStorage.getItem('tsg-demo-service-report-records') || '[]').find(item => item.number === row?.[0]) || {}; } catch { record = {}; } }
  const normalize = key => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byColumn = Object.fromEntries(columns.map((column, index) => [normalize(column), row?.[index]]));
  const get = (...keys) => {
    for (const key of keys) {
      const normalized = normalize(key);
      const entry = Object.entries(record).find(([name]) => normalize(name) === normalized);
      const value = entry?.[1] ?? byColumn[normalized];
      if (value != null && value !== '') return value;
    }
    return '';
  };
  const esc = value => String(value ?? '?').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const pretty = value => Array.isArray(value) ? value.map(item => typeof item === 'object' ? Object.values(item).filter(Boolean).join(' / ') : item).join(', ') : typeof value === 'object' && value ? Object.values(value).filter(Boolean).join(', ') : String(value ?? '?');
  const pair = (label, value) => `<div class="pair"><span>${esc(label)}</span><b>${esc(pretty(value) || '?')}</b></div>`;
  const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;
  const rows = (items, headers) => `<table><thead><tr>${headers.map(item => `<th>${esc(item)}</th>`).join('')}</tr></thead><tbody>${items.map(item => `<tr>${item.map(cell => `<td>${esc(pretty(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const logo = new URL('/tsg-logo.png', window.location.href).href;
  let title = documentLabel(module).toUpperCase(); let number = row?.[0] || 'Record'; let headerMeta = number; let content = '';
  if (module === 'invoices') {
    title = 'INVOICE';
    const items = get('items', 'line_items', 'invoice_items');
    const amount = get('total', 'amount', 'grand_total') || row?.[4] || 0;
    const status = get('status') || row?.[5] || 'Unpaid';
    const numeric = value => Number(String(value ?? 0).replace(/[^0-9.-]/g, '')) || 0;
    const money = value => `MMK ${numeric(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    const subtotal = get('subtotal') !== '' ? get('subtotal') : amount;
    const tax = get('tax_amount', 'tax');
    const paidValue = get('amount_received', 'amount_paid', 'paid_amount');
    const balanceValue = get('balance_due', 'outstanding_balance');
    const paid = paidValue !== '' ? money(paidValue) : /paid/i.test(String(status)) && !/unpaid|partially/i.test(String(status)) ? money(amount) : 'See payment history';
    const balance = balanceValue !== '' ? money(balanceValue) : /paid/i.test(String(status)) && !/unpaid|partially/i.test(String(status)) ? money(0) : paidValue !== '' ? money(Math.max(0, numeric(amount) - numeric(paidValue))) : 'See payment history';
    const customerName = get('customer_name', 'customer', 'client_name') || row?.[1] || 'Customer';
    const itemRows = Array.isArray(items) && items.length
      ? items.map(item => [item.description || item.name || item.item_name || 'Service', item.qty ?? item.quantity ?? 1, money(item.unit_price ?? item.rate ?? item.price ?? 0), money(item.amount ?? item.total ?? 0)])
      : [[get('description', 'job_title') || 'Service / job work', 1, money(subtotal), money(subtotal)]];
    const invoiceStatus = `<span class="status-pill ${/paid/i.test(String(status)) && !/unpaid|partially/i.test(String(status)) ? 'is-paid' : 'is-open'}">${esc(status)}</span>`;
    headerMeta = `${number} - ${pretty(status)}`;
    content = `<div class="invoice-parties"><div class="invoice-card bill-to"><span class="kicker">BILL TO</span><h2>${esc(customerName)}</h2><p>${esc(pretty(get('billing_address', 'address')))}</p><p>${esc(pretty(get('contact_person')))}${get('phone') ? ` | ${esc(pretty(get('phone')))}` : ''}</p></div><div class="invoice-card invoice-info"><div class="invoice-number"><span>INVOICE</span><b>${esc(number)}</b></div>${pair('Invoice date', get('date', 'invoice_date', 'issued') || row?.[2])}${pair('Due date', get('due_date') || row?.[3])}${pair('Payment terms', get('payment_terms'))}<div class="invoice-status-row"><span>Payment status</span>${invoiceStatus}</div></div></div>`
      + section('Items and services', rows(itemRows, ['Description', 'Qty', 'Rate', 'Amount']))
      + `<div class="invoice-bottom"><div class="payment-note"><b>Payment information</b><p>Please include invoice number ${esc(number)} with your payment.</p>${pair('Status', status)}${pair('Amount received', paid)}</div><div class="invoice-totals">${pair('Subtotal', money(subtotal))}${tax !== '' ? pair('Tax', money(tax)) : ''}<div class="grand-total"><span>Total</span><b>${esc(money(amount))}</b></div><div class="balance-total"><span>Balance due</span><b>${esc(balance)}</b></div></div></div>`
      + section('Notes', `<p>${esc(pretty(get('notes', 'terms', 'description')) || 'Thank you for your business.')}</p>`);
  } else if (module === 'customers') {
    title = 'CUSTOMER REPORT';
    const safeDetails = Object.entries(record).filter(([key, value]) => !key.startsWith('_') && value != null && value !== '' && !Array.isArray(value) && !['password','token'].includes(normalize(key)));
    const displayPairs = safeDetails.length ? safeDetails.map(([key, value]) => pair(key.replaceAll('_', ' '), value)).join('') : columns.map((column, index) => pair(column, row?.[index])).join('');
    const machines = get('machines', 'equipment', 'installed_machines');
    const jobs = get('jobs', 'job_orders', 'service_history');
    content = section('Customer details', `<div class="grid">${displayPairs}</div>`)
      + section('Installed equipment', Array.isArray(machines) && machines.length ? rows(machines.map(item => [item.name || item.machine_name || item.model, item.type || item.equipment_type, item.serial_number || item.serial, item.location || item.site_location]), ['Machine', 'Type', 'Serial number', 'Location']) : `<p>${esc(pretty(machines || get('machine_count') || row?.[3] || 'No equipment details recorded'))}</p>`)
      + section('Job / service history', Array.isArray(jobs) && jobs.length ? rows(jobs.map(item => [item.number || item.job_number || item.id, item.date || item.created_at, item.description || item.title, item.status]), ['Job', 'Date', 'Service', 'Status']) : `<p>${esc(pretty(jobs || 'Service history is available from linked job orders.'))}</p>`);
  } else if (module === 'jobs') {
    title = 'JOB ORDER';
    const groups = [
      ['Customer', ['customer_name','contact_person','phone','email','address','site_location','customer_approval']],
      ['Job details', ['title','job_type','priority','department','description','scope_of_work','expected_result','special_instructions']],
      ['Equipment', ['machine_name','equipment_type','equipment_model','serial_number','site_location']],
      ['Schedule and team', ['planned_start_date','planned_end_date','site_visit_date','team_leader','assigned_to','assigned_employees','assigned_vehicle','responsibilities']],
      ['Materials and charges', ['materials','job_amount','additional_charges','payment_terms','status','note']]
    ];
    content = section('Job reference', `<div class="grid">${pair('Job order', number)}${pair('Status', get('status') || row?.[5])}${pair('Priority', get('priority') || row?.[4])}${pair('Assigned to', get('assigned_to', 'assigned_to_name') || row?.[2])}${pair('Due date', get('planned_end_date', 'due_date') || row?.[3])}</div>`)
      + groups.map(([heading, keys]) => { const values = keys.map(key => [key, get(key)]).filter(([,value]) => value !== ''); return values.length ? section(heading, `<div class="grid">${values.map(([key,value]) => pair(key.replaceAll('_',' '), value)).join('')}</div>`) : ''; }).join('');
  } else if (module === 'service-reports') {
    title = 'SERVICE REPORT';
    content = section('Customer and service', `<div class="grid">${pair('Customer', get('customer_name','customer') || row?.[2])}${pair('Contact', get('contact_person'))}${pair('Phone', get('phone'))}${pair('Address', get('address','site_location'))}${pair('Service type', get('service_type','job_type'))}${pair('Priority', get('priority'))}${pair('Status', get('status') || row?.[5])}${pair('Created / delivered', get('delivered_at','created_at','delivered') || row?.[3])}${pair('Job order', get('job_id','job_number','job') || row?.[1])}${pair('Technician', get('technician_name','prepared_by') || row?.[4])}</div>`)
      + section(get('equipment_type','machine_name') || 'Equipment', `<div class="grid">${pair('Machine', get('machine_name','equipment_type'))}${pair('Model', get('equipment_model','model'))}${pair('Serial number', get('serial_number'))}${pair('Service location', get('site_location','address'))}</div>`)
      + section('Complaint', `<p>${esc(get('customer_complaint','complaint','reported_issue'))}</p>`)
      + section('Diagnosis and work performed', `<div class="grid">${pair('Fault category', get('fault_category'))}${pair('Diagnosis / findings', get('findings','diagnosis'))}${pair('Work performed', get('work_done','work_performed'))}${pair('Labor hours', get('labor_hours'))}${pair('Technicians', get('technician_name','technicians') || row?.[4])}${pair('Parts used', get('parts_used'))}${pair('Remarks', get('recommendations','remarks'))}</div>`)
      + section('Costs and payment', `<div class="grid">${pair('Service cost', get('subtotal','amount','total'))}${pair('Payment status', get('payment_status','status') || row?.[5])}${pair('Invoice', get('invoice_number'))}</div>`)
      + `<div class="signatures"><span>Technician signature: ${esc(get('technician_signature') || '________________')}</span><span>Customer signature: ${esc(get('customer_signature') || '________________')}</span></div>`;
  } else {
    title = 'EXPENSE VOUCHER';
    content = section('Voucher details', `<div class="grid">${columns.map((column,index) => pair(column, row?.[index])).join('')}${Object.entries(record).filter(([key,value]) => !key.startsWith('_') && value != null && value !== '').map(([key,value]) => pair(key.replaceAll('_',' '),value)).join('')}</div>`)
      + section('Supporting details', `<div class="grid">${pair('Description', get('description','purpose'))}${pair('Job order', get('job_id','job_number'))}${pair('Supplier', get('supplier_name','supplier'))}${pair('Payment method', get('payment_method','method'))}</div>`);
  }
  const win = window.open('', '_blank', 'width=900,height=900');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(number)} - ${esc(title)}</title><style>
    @page{size:A4 portrait;margin:0}*{box-sizing:border-box}body{margin:0;background:#edf0f3;color:#233246;font:13px Arial,sans-serif}.sheet{width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:16mm 16mm 18mm;position:relative}.head{display:flex;justify-content:space-between;align-items:center;min-height:25mm}.head img{width:60mm;height:21mm;object-fit:contain;object-position:left center}.head-right{text-align:right}.head-right h1{font-size:23px;margin:0 0 7px;letter-spacing:.035em;color:#19283a}.head-right small{font-size:11px;color:#69788a}.rule{height:3px;background:#e59a1a;margin:3mm 0 8mm}.grid{display:grid;grid-template-columns:1fr 1fr;column-gap:10mm;row-gap:9px}.pair{display:grid;grid-template-columns:38mm 1fr;gap:4mm;min-height:19px;align-items:start}.pair span{font-size:11px;color:#68788c;text-transform:capitalize}.pair b{font-size:12px;font-weight:500;line-height:1.4;color:#233246;overflow-wrap:anywhere}.pair b:empty:after{content:'?';color:#7a8490}section{margin:0 0 18px}section h2{font-size:15px;margin:0 0 10px;font-weight:700;color:#1d2c40;padding-bottom:6px;border-bottom:1px solid #e8edf2}section p{font-size:12px;margin:0;white-space:pre-wrap;line-height:1.55;color:#405168}.invoice-parties{display:grid;grid-template-columns:1.05fr .95fr;gap:12px;margin-bottom:23px}.invoice-card{background:#f7f9fb;border:1px solid #e5eaf0;border-radius:8px;padding:14px 15px}.bill-to{border-left:3px solid #e59a1a}.kicker{display:block;font-size:10px;font-weight:700;letter-spacing:.12em;color:#718196;margin-bottom:9px}.bill-to h2{font-size:16px;margin:0 0 7px;color:#21334a}.bill-to p{font-size:12px;color:#53647a;line-height:1.45;margin:4px 0}.invoice-number{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #e2e8ef;padding-bottom:9px;margin-bottom:10px}.invoice-number span{font-size:10px;letter-spacing:.1em;color:#6d7c90;font-weight:700}.invoice-number b{font-size:13px;color:#24364c}.invoice-info .pair{grid-template-columns:30mm 1fr;min-height:21px}.invoice-status-row{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #e2e8ef;padding-top:9px;margin-top:5px;font-size:11px;color:#68788c}.status-pill{display:inline-flex;padding:5px 9px;border-radius:20px;font-size:10px;font-weight:700}.is-paid{background:#e8f6ef;color:#20845b}.is-open{background:#fff4df;color:#9b6a08}table{width:100%;border-collapse:collapse;margin:5px 0 14px;font-size:11px}th{text-align:left;color:#52647a;font-weight:700;background:#f2f5f8;font-size:10px;letter-spacing:.035em}th,td{padding:10px 9px;border-bottom:1px solid #e6ebf0}td{overflow-wrap:anywhere;color:#34465d;line-height:1.35}td:not(:first-child),th:not(:first-child){text-align:right}.invoice-bottom{display:grid;grid-template-columns:1fr 82mm;gap:18px;align-items:start;margin:12px 0 22px}.payment-note{padding:12px 0;color:#43556a}.payment-note>b{display:block;font-size:12px;color:#263950;margin-bottom:7px}.payment-note>p{font-size:11px;line-height:1.5;color:#718096;margin:0 0 10px}.payment-note .pair{grid-template-columns:34mm 1fr;padding:3px 0}.invoice-totals{padding:12px 14px;background:#f7f9fb;border:1px solid #e5eaf0;border-radius:8px}.invoice-totals .pair{grid-template-columns:1fr auto;padding:5px 0}.grand-total,.balance-total{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid #dfe6ee;font-size:13px;font-weight:700}.grand-total b{font-size:16px;color:#21344c}.balance-total{margin:0 -14px -12px;padding:12px 14px;background:#173a61;color:#fff;border-radius:0 0 8px 8px}.balance-total b{font-size:16px}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:15mm;margin-top:28px;font-size:11px;color:#5d6d81}.foot{position:absolute;left:16mm;right:16mm;bottom:9mm;display:flex;justify-content:space-between;border-top:1px solid #e8edf2;padding-top:7px;color:#718096;font-size:10px}.foot:after{content:'Page 1'}@media print{body{background:#fff}.sheet{margin:0;box-shadow:none}section,table,tr,.invoice-parties,.invoice-bottom{break-inside:avoid}}
  </style></head><body><main class="sheet"><header class="head"><img src="${esc(logo)}" alt="TSG Power Engineering"><div class="head-right"><h1>${esc(title)}</h1><small>${esc(headerMeta)}</small></div></header><div class="rule"></div>${content}<footer class="foot"><span>TSG Power Engineering Co., Ltd.</span></footer></main><script>window.onload=()=>{const logo=document.querySelector('.head img');if(logo.complete)window.print();else logo.onload=()=>window.print()}</script></body></html>`);
  win.document.close();
}

function printReport(title, columns, rows, filters) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const win = window.open('', '_blank', 'width=1000,height=760');
  if (!win) return;
  const filterText = Object.entries(filters).map(([key,value]) => `${escape(key)}: ${escape(value)}`).join(' ? ') || 'No filters';
  win.document.write(`<!doctype html><html><head><title>TSG-${escape(title)}</title><style>@page{size:A4 landscape;margin:14mm}body{font:14px Arial,sans-serif;color:#233044}header{display:flex;align-items:center;gap:18px;border-bottom:3px solid #e59a1a;padding-bottom:14px;margin-bottom:20px}header img{width:180px;max-height:62px;object-fit:contain}h1{font-size:24px;margin:0 0 6px}.meta{color:#64748b;font-size:12px;line-height:1.5}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #d7dee8;padding:9px;text-align:left}th{background:#edf3fa;font-size:11px;letter-spacing:.04em}td{font-size:12px;line-height:1.4}tr{break-inside:avoid}footer{margin-top:18px;color:#64748b;font-size:11px}@media print{thead{display:table-header-group}}</style></head><body><header><img src="/tsg-logo.png" alt="TSG Power"><div><h1>${escape(title)}</h1><div class="meta">TSG Power Engineering | ${new Date().toLocaleString()}</div><div class="meta">Filters: ${filterText} | ${rows.length} records</div></div></header><table><thead><tr>${columns.map(column => `<th>${escape(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table><footer>Generated from the current report result. Use the browser print dialog to print or save as PDF.</footer><script>window.onload=()=>window.print()</script></body></html>`);
  win.document.close();
}

function Status({ value }) { const val = value.toLowerCase().replaceAll(' ', '-'); const tone = /completed|approved|paid|active|in-stock|received/.test(val) ? 'green' : /overdue|rejected|low-stock/.test(val) ? 'red' : /scheduled|sent|submitted|open|partially-paid/.test(val) ? 'blue' : /waiting|pending|draft|unpaid/.test(val) ? 'amber' : 'gray'; return <span className={`status-badge ${tone}`}><i />{value}</span>; }
function Attention({ icon: Icon, color, title, detail, to }) { return <Link to={to} className="attention-row"><span className={`attention-icon ${color}`}><Icon size={16} /></span><span className="attention-copy"><b>{title}</b><small>{detail}</small></span><ChevronRight size={15} className="attention-chevron" /></Link>; }

import { ReceiptText as ReceiptTextIcon, PackageCheck as PackageCheckIcon, Boxes as BoxesIcon, BriefcaseBusiness as BriefcaseIcon, UsersRound as UsersIcon, Wallet as WalletIcon, ClipboardCheck as ClipboardIcon } from 'lucide-react';

export default App;
