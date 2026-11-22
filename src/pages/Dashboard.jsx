import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, BriefcaseBusiness, ClipboardCheck, Clock3, Download, FileText,
  HandCoins, Landmark, PackageCheck, ReceiptText, ShoppingCart, UsersRound, Wallet,
} from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { moduleInfo } from '../data.js';
import { normalizeList } from '../lib/records.js';
import { isAdminRole, isEmployeeRole } from '../lib/roles.js';
import { formatDelta, moneyText, resolveDashboardMetric } from './dashboard/metrics.js';
import useMyWork from './dashboard/useMyWork.js';
import { MetricCard } from './dashboard/widgets.jsx';
import { AdminCharts, RecentPayments } from './dashboard/AdminPanels.jsx';
import { JobStatusPanel, RecentJobs } from './dashboard/EmployeePanels.jsx';

// Admin sees the company; Staff and Finance see their own work (Finance also
// gets shortcuts to the money pages).

const ADMIN_ACTIONS = [
  ['Cash board', Wallet, '/cash-board'],
  ['Invoice & income', ReceiptText, '/income'],
  ['Team schedule', ClipboardCheck, '/schedule'],
  ['Manage staff', UsersRound, '/staff'],
  ['Review claims', ReceiptText, '/cash-claims'],
];
const STAFF_ACTIONS = [
  ['My job orders', BriefcaseBusiness, '/jobs'],
  ['Team schedule', ClipboardCheck, '/schedule'],
  ['New quotation', FileText, '/quotations', true],
  ['New invoice', ReceiptText, '/invoices', true],
  ['New service report', ClipboardCheck, '/service-reports', true],
  ['Request material', PackageCheck, '/material-requests', true],
  ['Request advance', Wallet, '/my-advances', true],
];
const FINANCE_ACTIONS = [
  ['Staff advances', Wallet, '/advances'],
  ['Cash board', Landmark, '/cash-board'],
  ['Receivables', HandCoins, '/receivables'],
  ['Purchasing', ShoppingCart, '/purchasing'],
];

export default function Dashboard({ user }) {
  const isAdmin = isAdminRole(user.role);
  const isEmployee = isEmployeeRole(user.role);
  const dashboardQuery = useQuery({ queryKey: ['dashboard', user.role], queryFn: () => apiRequest('/dashboard'), staleTime: 30_000 });
  const dashboardData = dashboardQuery.data?.data || dashboardQuery.data || {};
  const liveCounts = dashboardData.counts || dashboardData.stats || dashboardData;
  const cashQuery = useQuery({ queryKey: ['dashboard-cash', user.role], queryFn: () => apiRequest('/cash-claims?page=1&limit=5'), enabled: isAdmin, staleTime: 20_000 });
  const cashRows = normalizeList(cashQuery.data, moduleInfo['cash-claims'].columns);
  const mine = useMyWork(user, liveCounts, isEmployee);
  const metric = keys => resolveDashboardMetric(liveCounts, keys);
  const outstandingAmount = metric(['outstandingPayments', 'unpaidInvoices', 'unpaidInvoiceTotal', 'invoices.unpaidTotal']);

  const stats = isAdmin ? [
    { label: 'Total revenue', value: metric(['totalRevenue', 'revenue', 'revenueTotal', 'income.total']) ?? '—', delta: dashboardData.comparisons?.revenue, target: '/income', icon: ArrowUpRight, color: 'blue' },
    { label: 'Outstanding payments', value: outstandingAmount ?? '—', delta: dashboardData.comparisons?.outstanding, target: '/receivables', icon: ReceiptText, color: 'amber' },
    { label: 'Total expenses', value: metric(['totalExpenses', 'expenses', 'expenseTotal', 'expense.total']) ?? '—', delta: dashboardData.comparisons?.expenses, target: '/cash-claims', icon: ArrowDownRight, color: 'violet' },
    { label: 'Net cash balance', value: metric(['netCashBalance', 'cashBalance', 'cash_balance', 'cash.netBalance']) ?? '—', delta: dashboardData.comparisons?.cash, target: '/cash-board', icon: Wallet, color: 'green' },
  ] : [
    { label: 'My assigned jobs', value: mine?.assignedJobs ?? 0, target: '/jobs', icon: BriefcaseBusiness, color: 'blue' },
    { label: "Today's schedule", value: mine?.todaysJobs ?? 0, target: '/jobs', icon: ClipboardCheck, color: 'violet' },
    { label: 'Open advance balance', value: mine?.openAdvanceBalance ?? 0, target: '/my-advances', icon: Wallet, color: 'green' },
    { label: 'Pending quotations', value: metric(['pendingQuotations', 'pending_quotations', 'quotations.pending']) ?? '—', target: '/quotations', icon: FileText, color: 'teal' },
  ];
  const actions = isAdmin ? ADMIN_ACTIONS : user.role === 'Finance' ? [...FINANCE_ACTIONS, ...STAFF_ACTIONS] : STAFF_ACTIONS;
  const today = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());

  return (
    <>
      <div className="page-heading dashboard-heading">
        <div>
          <div className="eyebrow">{isAdmin ? 'COMPANY OVERVIEW' : 'YOUR WORKSPACE'}</div>
          <h1>{isAdmin ? 'Operations Overview' : 'My work'}</h1>
          <p>{isAdmin ? 'A clear view of service, finance and customer activity.' : 'Your assigned work and items needing attention.'}</p>
        </div>
        <div className="heading-actions">
          <span className="date-pill"><Clock3 size={15} />{today}</span>
          <button className="secondary-button" onClick={() => window.print()}><Download size={15} />Export overview</button>
        </div>
      </div>
      {dashboardQuery.isError && <div className="dashboard-api-error" role="status">Live summary is temporarily unavailable. Module data remains available below.</div>}

      <div className="stat-grid">
        {stats.map((stat, index) => (
          <MetricCard key={stat.label} stat={stat} index={index}
            value={moneyText(stat.value, /revenue|payment|expense|cash|claim|advance/i.test(stat.label))}
            delta={formatDelta(stat.delta)} />
        ))}
      </div>

      <div className="dashboard-quick">
        <section className="panel quick-panel">
          <div className="panel-heading"><div><h2>Quick actions</h2><p>Common tasks</p></div></div>
          <div className="quick-links">
            {actions.map(([label, Icon, target, openCreate]) => (
              <Link to={target} state={openCreate ? { openCreate: true, form: target.replace(/^\//, '') } : undefined} key={label}>
                <span className="quick-icon"><Icon size={18} /></span><span>{label}</span><ArrowRight size={15} className="quick-arrow" />
              </Link>
            ))}
          </div>
        </section>
      </div>

      <div className={`analytics-grid ${isEmployee ? 'staff-analytics-grid' : ''}`}>
        {isAdmin ? <AdminCharts dashboardData={dashboardData} outstandingAmount={outstandingAmount} /> : <JobStatusPanel dashboardData={dashboardData} />}
      </div>

      <div className="dashboard-grid dashboard-data-grid">
        {isAdmin ? <RecentPayments cashQuery={cashQuery} cashRows={cashRows} /> : <RecentJobs />}
      </div>

      <div className="dashboard-pending-row">
        <section className="panel pending-panel">
          <div className="panel-heading">
            <div><h2>{isAdmin ? 'Pending approvals' : 'My outstanding items'}</h2><p>Items requiring attention.</p></div>
            <span className="attention-count">{metric(['pendingApprovals', 'pending_approvals', 'approvals.pending']) ?? '—'}</span>
          </div>
          <div className="pending-links">
            {!isAdmin && <Link to="/quotations"><FileText size={17} /><span>Quotations</span><b>{metric(['pendingQuotations', 'pending_quotations']) ?? '—'}</b><ArrowRight size={14} /></Link>}
            {isAdmin && <Link to="/cash-claims"><ReceiptText size={17} /><span>Expense claims</span><b>{metric(['pendingExpenseClaims', 'pending_expense_claims']) ?? '—'}</b><ArrowRight size={14} /></Link>}
            <Link to="/material-requests"><PackageCheck size={17} /><span>Material requests</span><b>{metric(['pendingMaterialRequests', 'pending_material_requests']) ?? '—'}</b><ArrowRight size={14} /></Link>
          </div>
        </section>
      </div>
    </>
  );
}
