import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Clock3,
  Download,
  FileText as FileTextIcon,
  ReceiptText as ReceiptTextIcon,
  PackageCheck as PackageCheckIcon,
  BriefcaseBusiness as BriefcaseIcon,
  UsersRound as UsersIcon,
  Wallet as WalletIcon,
  ClipboardCheck as ClipboardIcon,
} from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { moduleInfo } from '../data.js';
import Status from '../components/Status.jsx';
import { amountNumber, apiEndpoint, lookupRecords, normalizeList } from '../lib/records.js';

function resolveDashboardMetric(data, aliases = []) {
  for (const key of aliases) {
    const value = key.split('.').reduce((node, part) => node?.[part], data);
    if (value == null) continue;
    const scalar = typeof value === 'object' ? (value.total ?? value.count ?? value.amount ?? value.value) : value;
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
  const normalize = value =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}
function MetricCard({ stat, value, delta, index }) {
  return (
    <Link to={stat.target} className={`stat-card metric-card ${stat.color}`} style={{ animationDelay: `${index * 55}ms` }}>
      <div className="metric-card-head">
        <div className={`stat-icon ${stat.color}`}>
          <stat.icon size={20} strokeWidth={1.9} />
        </div>
        <span className="metric-trend">
          <ArrowUpRight size={15} />
        </span>
      </div>
      <div className="stat-label">{stat.label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-delta">{delta || 'Current period'}</div>
    </Link>
  );
}
function MiniBarChart({ series, emptyText, cash = false }) {
  if (!series.length)
    return (
      <div className="chart-empty">
        <span className="chart-empty-icon">
          <Activity size={19} />
        </span>
        <b>No chart data yet</b>
        <span>{emptyText}</span>
      </div>
    );
  const max = Math.max(
    1,
    ...series.flatMap(item => [Number(item.revenue ?? item.income ?? item.value ?? 0), Number(item.expenses ?? item.outflow ?? 0)]),
  );
  return (
    <div className={`mini-bar-chart ${cash ? 'cash-chart' : ''}`}>
      <div className="chart-legend">
        <span>
          <i className="legend-revenue" />
          {cash ? 'Inflow' : 'Revenue'}
        </span>
        {!cash && (
          <span>
            <i className="legend-expense" />
            Expenses
          </span>
        )}
      </div>
      <div className="bar-chart-plot">
        {series.map((item, index) => {
          const first = Number(item.revenue ?? item.income ?? item.value ?? 0);
          const second = Number(item.expenses ?? item.outflow ?? 0);
          return (
            <div className="bar-chart-group" key={`${item.month || item.label || index}`}>
              <div className="bar-chart-bars">
                <span
                  className="revenue-bar"
                  style={{ height: `${Math.max(3, (first / max) * 100)}%` }}
                  title={`${cash ? 'Inflow' : 'Revenue'}: ${first.toLocaleString('en-US')}`}
                />
                {!cash && (
                  <span
                    className="expense-bar"
                    style={{ height: `${Math.max(3, (second / max) * 100)}%` }}
                    title={`Expenses: ${second.toLocaleString('en-US')}`}
                  />
                )}
              </div>
              <small>{item.month || item.label || ''}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function JobStatusDonut({ counts, emptyText }) {
  const palette = ['#2f88f5', '#18b89b', '#f2ad4b', '#8f78f6', '#ec7182', '#82a0b8'];
  const entries = (
    Array.isArray(counts)
      ? counts.map(item => [item.status ?? item.label ?? item.name ?? 'Other', item.count ?? item.total ?? item.value])
      : Object.entries(counts || {})
  )
    .map(([label, value]) => [label, Number(value?.count ?? value?.total ?? value) || 0])
    .filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total)
    return (
      <div className="chart-empty">
        <span className="chart-empty-icon">
          <BriefcaseIcon size={19} />
        </span>
        <b>No status data yet</b>
        <span>{emptyText}</span>
      </div>
    );
  let cursor = 0;
  const stops = entries
    .map(([, value], i) => {
      const start = cursor;
      cursor += (value / total) * 100;
      return `${palette[i % palette.length]} ${start}% ${cursor}%`;
    })
    .join(',');
  return (
    <div className="status-chart-wrap">
      <div className="status-donut" style={{ background: `conic-gradient(${stops})` }}>
        <div>
          <b>{total}</b>
          <span>Job orders</span>
        </div>
      </div>
      <div className="status-legend">
        {entries.map(([label, value], i) => (
          <div key={label}>
            <i style={{ background: palette[i % palette.length] }} />
            <span>{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
export default function Dashboard({ user }) {
  const dashboardQuery = useQuery({
    queryKey: ['dashboard', user.role],
    queryFn: () => apiRequest('/dashboard'),
    enabled: true,
    staleTime: 30_000,
  });
  const dashboardData = dashboardQuery.data?.data || dashboardQuery.data || {};
  const liveCounts = dashboardData.counts || dashboardData.stats || dashboardData;
  const dashboardJobsQuery = useQuery({
    queryKey: ['dashboard-jobs'],
    queryFn: () => apiRequest('/jobs?page=1&limit=5'),
    enabled: user.role === 'Staff',
    staleTime: 20_000,
  });
  const myStaffQuery = useQuery({
    queryKey: ['dashboard', 'my-staff', user.id],
    queryFn: () => apiRequest('/staff?page=1&limit=500'),
    enabled: user.role === 'Staff',
    staleTime: 20_000,
  });
  const myJobsQuery = useQuery({
    queryKey: ['dashboard', 'my-jobs', user.id],
    queryFn: () => apiRequest('/jobs?page=1&limit=5000'),
    enabled: user.role === 'Staff',
    staleTime: 20_000,
  });
  const invoicesQuery = useQuery({
    queryKey: ['dashboard-invoices'],
    queryFn: () => apiRequest('/invoices?page=1&limit=5'),
    enabled: user.role === 'Admin',
    staleTime: 20_000,
  });
  const cashQuery = useQuery({
    queryKey: ['dashboard-cash', user.role],
    queryFn: () => apiRequest(`/${user.role === 'Admin' ? 'cash-claims' : apiEndpoint('my-expense-claims')}?page=1&limit=5`),
    enabled: true,
    staleTime: 20_000,
  });
  const myClaimsQuery = useQuery({
    queryKey: ['dashboard', 'my-claims', user.id],
    queryFn: () => apiRequest('/my-expense-claims?page=1&limit=5000'),
    enabled: user.role === 'Staff',
    staleTime: 20_000,
  });
  const myAdvancesQuery = useQuery({
    queryKey: ['dashboard', 'my-advances', user.id],
    queryFn: () => apiRequest('/my-advances?page=1&limit=5000'),
    enabled: user.role === 'Staff',
    staleTime: 20_000,
  });
  const jobRows = normalizeList(dashboardJobsQuery.data, moduleInfo.jobs.columns);
  const invoiceRows = normalizeList(invoicesQuery.data, moduleInfo.invoices.columns);
  const invoiceCol = name => moduleInfo.invoices.columns.indexOf(name);
  const cashRows = normalizeList(cashQuery.data, moduleInfo[user.role === 'Admin' ? 'cash-claims' : 'my-expense-claims'].columns);
  const myStaffIds = (() => {
    if (user.role !== 'Staff') return [];
    const userId = String(user.id || '');
    const email = String(user.email || '')
      .trim()
      .toLowerCase();
    return lookupRecords('staff', myStaffQuery.data)
      .filter(record => {
        const profileId = record?.profile_id ? String(record.profile_id) : '';
        const staffEmail = String(record?.email || '')
          .trim()
          .toLowerCase();
        return Boolean((userId && profileId === userId) || (email && staffEmail === email) || sameDisplayName(user.name, record?.name));
      })
      .map(record => String(record?.id || ''))
      .filter(Boolean);
  })();
  const myJobRecords = user.role !== 'Staff' ? [] : lookupRecords('jobs', myJobsQuery.data);
  const isClosedJob = record => /completed|closed|cancel/i.test(String(record?.status || ''));
  const assignedEmployeeIds = record =>
    (Array.isArray(record?.assigned_employees) ? record.assigned_employees : []).map(item =>
      String(item?.id ?? item?.staff_id ?? item ?? ''),
    );
  const isAssignedToUser = record => {
    if (myStaffIds.includes(String(record?.assigned_to || '')) || myStaffIds.includes(String(record?.team_leader || ''))) return true;
    if (assignedEmployeeIds(record).some(id => myStaffIds.includes(id))) return true;
    return sameDisplayName(user.name, record?.assigned_to_name) || sameDisplayName(user.name, record?.team_leader_name);
  };
  const todayIso = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const clientAssignedJobs = myJobRecords.filter(record => isAssignedToUser(record) && !isClosedJob(record)).length;
  const clientTodayJobs = myJobRecords.filter(
    record =>
      isAssignedToUser(record) &&
      !isClosedJob(record) &&
      String(record?.planned_start_date || record?.job_date || '').slice(0, 10) === todayIso,
  ).length;
  const myAssignedJobs = Math.max(
    Number(resolveDashboardMetric(liveCounts, ['myAssignedJobs', 'assignedJobs', 'assigned_jobs']) || 0),
    clientAssignedJobs,
  );
  const todaysScheduledJobs = Math.max(
    Number(resolveDashboardMetric(liveCounts, ['todaysScheduledJobs', 'scheduledToday', 'scheduled_today']) || 0),
    clientTodayJobs,
  );
  const myClaimRecords = lookupRecords('expenses', myClaimsQuery.data);
  const clientPendingClaims = myClaimRecords
    .filter(record => /submitted|pending approval/i.test(String(record?.status || '')))
    .reduce((sum, record) => sum + amountNumber(record?.amount_value ?? record?.amount), 0);
  const myAdvanceRecords = lookupRecords('advances', myAdvancesQuery.data);
  const clientOpenAdvance = myAdvanceRecords
    .filter(record => /issued|partially settled|under review|settlement approved/i.test(String(record?.status || '')))
    .reduce((sum, record) => sum + amountNumber(record?.balance), 0);
  const myPendingClaims = Math.max(
    Number(resolveDashboardMetric(liveCounts, ['myPendingClaims', 'pendingClaims', 'pending_claims']) || 0),
    clientPendingClaims,
  );
  const myOpenAdvanceBalance = Math.max(
    Number(resolveDashboardMetric(liveCounts, ['myOpenAdvanceBalance', 'openAdvanceBalance', 'advance_balance']) || 0),
    clientOpenAdvance,
  );
  const invoicePayments =
    user.role === 'Admin' ? cashRows.filter(row => /payment|receipt|received/i.test(String(row[1] || ''))).slice(0, 4) : [];
  const jobStatusCounts = dashboardData.jobsByStatus || dashboardData.jobStatusCounts || dashboardData.job_status_counts || {};
  const revenueSeries = getDashboardSeries(dashboardData, [
    'monthlyRevenueExpenses',
    'revenueVsExpenses',
    'revenue_expense_trend',
    'analytics.revenueExpenses',
  ]);
  const cashFlowSeries = getDashboardSeries(dashboardData, ['monthlyCashFlow', 'cashFlow', 'cash_flow', 'analytics.cashFlow']);
  const pendingQuotes = resolveDashboardMetric(liveCounts, ['pendingQuotations', 'pending_quotations', 'quotations.pending']);
  const outstandingAmount = resolveDashboardMetric(liveCounts, [
    'outstandingPayments',
    'unpaidInvoices',
    'unpaidInvoiceTotal',
    'invoices.unpaidTotal',
  ]);
  const revenueAmount = resolveDashboardMetric(liveCounts, ['totalRevenue', 'revenue', 'revenueTotal', 'income.total']);
  const expensesAmount = resolveDashboardMetric(liveCounts, ['totalExpenses', 'expenses', 'expenseTotal', 'expense.total']);
  const cashAmount = resolveDashboardMetric(liveCounts, ['netCashBalance', 'cashBalance', 'cash_balance', 'cash.netBalance']);
  const adminStats = [
    {
      label: 'Total revenue',
      value: revenueAmount ?? '—',
      delta: dashboardData.comparisons?.revenue,
      target: '/income',
      icon: ArrowUpRight,
      color: 'blue',
    },
    {
      label: 'Outstanding payments',
      value: outstandingAmount ?? '—',
      delta: dashboardData.comparisons?.outstanding,
      target: '/income',
      icon: ReceiptTextIcon,
      color: 'amber',
    },
    {
      label: 'Total expenses',
      value: expensesAmount ?? '—',
      delta: dashboardData.comparisons?.expenses,
      target: '/cash-claims',
      icon: ArrowDownRight,
      color: 'violet',
    },
    {
      label: 'Net cash balance',
      value: cashAmount ?? '—',
      delta: dashboardData.comparisons?.cash,
      target: '/cash-board',
      icon: WalletIcon,
      color: 'green',
    },
  ];
  const staffStats = [
    { label: 'My assigned jobs', value: myAssignedJobs, delta: null, target: '/jobs', icon: BriefcaseIcon, color: 'blue' },
    { label: "Today's schedule", value: todaysScheduledJobs, delta: null, target: '/jobs', icon: ClipboardIcon, color: 'violet' },
    { label: 'Pending claims', value: myPendingClaims, delta: null, target: '/my-expense-claims', icon: ReceiptTextIcon, color: 'amber' },
    { label: 'Open advance balance', value: myOpenAdvanceBalance, delta: null, target: '/my-advances', icon: WalletIcon, color: 'green' },
    { label: 'Pending quotations', value: pendingQuotes ?? '—', delta: null, target: '/quotations', icon: FileTextIcon, color: 'teal' },
  ];
  const stats = user.role === 'Admin' ? adminStats : staffStats;
  const today = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());
  const moneyText = (value, isMoney = true) => {
    if (value == null || value === '?') return '—';
    if (typeof value === 'number')
      return isMoney ? `MMK ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : value.toLocaleString('en-US');
    return String(value);
  };
  const formatDelta = delta => {
    if (delta == null) return 'Change unavailable';
    if (typeof delta === 'object') {
      const change = delta.percent ?? delta.changePercent ?? delta.value;
      const direction = Number(change) < 0 ? 'down' : 'up';
      return Number.isFinite(Number(change))
        ? `${Math.abs(Number(change))}% ${direction} vs previous period`
        : String(delta.label || 'Compared with previous period');
    }
    return String(delta);
  };
  const navActions =
    user.role === 'Admin'
      ? [
          ['Cash board', WalletIcon, '/cash-board'],
          ['Invoice & income', ReceiptTextIcon, '/income'],
          ['Team schedule', ClipboardIcon, '/schedule'],
          ['Manage staff', UsersIcon, '/staff'],
          ['Review claims', ReceiptTextIcon, '/cash-claims'],
        ]
      : [
          ['My job orders', BriefcaseIcon, '/jobs'],
          ['Team schedule', ClipboardIcon, '/schedule'],
          ['New quotation', FileTextIcon, '/quotations', true],
          ['New invoice', ReceiptTextIcon, '/invoices', true],
          ['New service report', ClipboardIcon, '/service-reports', true],
          ['Request material', PackageCheckIcon, '/material-requests', true],
          ['Submit expense claim', ReceiptTextIcon, '/my-expense-claims', true],
          ['Request advance', WalletIcon, '/my-advances', true],
        ];
  const showRowsState = (query, rows) =>
    query.isLoading ? 'Loading records…' : query.isError ? 'Could not load records.' : rows.length ? '' : 'No records to show yet.';
  return (
    <>
      <div className="page-heading dashboard-heading">
        <div>
          <div className="eyebrow">{user.role === 'Admin' ? 'COMPANY OVERVIEW' : 'YOUR WORKSPACE'}</div>
          <h1>{user.role === 'Admin' ? 'Operations Overview' : 'My work'}</h1>
          <p>
            {user.role === 'Admin'
              ? 'A clear view of service, finance and customer activity.'
              : 'Your assigned work and items needing attention.'}
          </p>
        </div>
        <div className="heading-actions">
          <span className="date-pill">
            <Clock3 size={15} />
            {today}
          </span>
          <button className="secondary-button" onClick={() => window.print()}>
            <Download size={15} />
            Export overview
          </button>
        </div>
      </div>
      {dashboardQuery.isError && (
        <div className="dashboard-api-error" role="status">
          Live summary is temporarily unavailable. Module data remains available below.
        </div>
      )}
      <div className="stat-grid">
        {stats.map((stat, index) => (
          <MetricCard
            key={stat.label}
            stat={stat}
            value={moneyText(stat.value, /revenue|payment|expense|cash|claim|advance/i.test(stat.label))}
            delta={formatDelta(stat.delta)}
            index={index}
          />
        ))}
      </div>
      <div className="dashboard-quick">
        <section className="panel quick-panel">
          <div className="panel-heading">
            <div>
              <h2>Quick actions</h2>
              <p>Common tasks</p>
            </div>
          </div>
          <div className="quick-links">
            {navActions.map(([label, Icon, target, openCreate]) => (
              <Link to={target} state={openCreate ? { openCreate: true, form: target.replace(/^\//, '') } : undefined} key={label}>
                <span className="quick-icon">
                  <Icon size={18} />
                </span>
                <span>{label}</span>
                <ArrowRight size={15} className="quick-arrow" />
              </Link>
            ))}
          </div>
        </section>
      </div>
      <div className={`analytics-grid ${user.role === 'Staff' ? 'staff-analytics-grid' : ''}`}>
        {user.role === 'Admin' && (
          <section className="panel analytics-panel revenue-panel">
            <div className="panel-heading">
              <div>
                <h2>Revenue vs expenses</h2>
                <p>Monthly financial performance</p>
              </div>
              <Link to="/reports" className="text-link">
                Reports <ArrowRight size={14} />
              </Link>
            </div>
            <MiniBarChart series={revenueSeries} emptyText="Monthly totals will appear here when provided by the dashboard API." />
          </section>
        )}
        {user.role === 'Staff' && (
          <section className="panel analytics-panel job-status-panel">
            <div className="panel-heading">
              <div>
                <h2>Job order status</h2>
                <p>Current workload distribution</p>
              </div>
              <Link to="/jobs" className="text-link">
                All jobs <ArrowRight size={14} />
              </Link>
            </div>
            <JobStatusDonut counts={jobStatusCounts} emptyText="Status totals were not included in the dashboard response." />
          </section>
        )}
        {user.role === 'Admin' && (
          <section className="panel analytics-panel cash-trend-panel">
            <div className="panel-heading">
              <div>
                <h2>Monthly cash flow</h2>
                <p>Money received over time</p>
              </div>
              <Link to="/cash-claims" className="text-link">
                Cash &amp; bank <ArrowRight size={14} />
              </Link>
            </div>
            <MiniBarChart series={cashFlowSeries} cash emptyText="Monthly totals will appear here when provided by the dashboard API." />
          </section>
        )}
        {user.role === 'Admin' && (
          <section className="panel invoice-summary-panel">
            <div className="panel-heading">
              <div>
                <h2>Outstanding invoices</h2>
                <p>Open customer balances</p>
              </div>
              <Link to="/income" className="text-link">
                Invoice &amp; income <ArrowRight size={14} />
              </Link>
            </div>
            <div className="invoice-summary-value">{moneyText(outstandingAmount ?? '—')}</div>
            <div className="invoice-summary-meta">
              <span>
                {invoiceRows.filter(row => /unpaid|partial|overdue|issued/i.test(String(row[invoiceCol('Status')] || ''))).length} open in
                recent records
              </span>
              <span className="summary-status">
                {invoiceRows.length ? `${invoiceRows.length} recent invoices` : invoicesQuery.isLoading ? 'Loading…' : 'No invoice records'}
              </span>
            </div>
            <div className="invoice-mini-list">
              {invoiceRows.slice(0, 3).map(row => (
                <Link to="/income" key={row[0]}>
                  <span>
                    <b>{row[0]}</b>
                    <small>
                      {row[invoiceCol('Customer')]}
                      {row[invoiceCol('Job order')] && row[invoiceCol('Job order')] !== '—' ? ` · ${row[invoiceCol('Job order')]}` : ''}
                    </small>
                  </span>
                  <strong>{row[invoiceCol('Outstanding')]}</strong>
                  <Status value={row[invoiceCol('Status')] || 'Unpaid'} />
                </Link>
              ))}
              {!invoiceRows.length && <div className="dashboard-empty-line">{showRowsState(invoicesQuery, invoiceRows)}</div>}
            </div>
          </section>
        )}
      </div>
      <div className="dashboard-grid dashboard-data-grid">
        {user.role === 'Staff' && (
          <section className="panel jobs-panel">
            <div className="panel-heading">
              <div>
                <h2>Recent job orders</h2>
                <p>Latest service work across your team.</p>
              </div>
              <Link to="/jobs" className="text-link">
                View all <ArrowRight size={14} />
              </Link>
            </div>
            <div className="table-scroll">
              <table className="data-table dashboard-table">
                <thead>
                  <tr>
                    <th>JOB ORDER</th>
                    <th>CUSTOMER / MACHINE</th>
                    <th>ASSIGNED TO</th>
                    <th>STATUS</th>
                    <th>DUE</th>
                  </tr>
                </thead>
                <tbody>
                  {jobRows.slice(0, 5).map(row => (
                    <tr key={row._id || row[0]}>
                      <td>
                        <b className="record-link">{row[0]}</b>
                      </td>
                      <td>{row[1]}</td>
                      <td>{row[2]}</td>
                      <td>
                        <Status value={row[5] || 'New'} />
                      </td>
                      <td>{row[3]}</td>
                    </tr>
                  ))}
                  {!jobRows.length && (
                    <tr>
                      <td colSpan={5} className="empty-state">
                        {showRowsState(dashboardJobsQuery, jobRows)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {user.role === 'Admin' && (
          <section className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <h2>Recent customer payments</h2>
                <p>Latest receipts and invoice payments.</p>
              </div>
              <Link to="/cash-claims" className="text-link">
                Cash &amp; bank <ArrowRight size={14} />
              </Link>
            </div>
            <div className="attention-list">
              {invoicePayments.map(row => (
                <div className="attention-row" key={row[0]}>
                  <span className="attention-icon green">
                    <WalletIcon size={17} />
                  </span>
                  <div className="attention-copy">
                    <b>{row[2]}</b>
                    <small>
                      {row[0]} · {row[3]}
                    </small>
                  </div>
                  <strong className="payment-amount">{row[4]}</strong>
                </div>
              ))}
              {!invoicePayments.length && (
                <div className="dashboard-empty-line">{showRowsState(cashQuery, cashRows) || 'No recent customer payments.'}</div>
              )}
            </div>
          </section>
        )}
      </div>
      <div className="dashboard-pending-row">
        <section className="panel pending-panel">
          <div className="panel-heading">
            <div>
              <h2>{user.role === 'Admin' ? 'Pending approvals' : 'My outstanding items'}</h2>
              <p>Items requiring attention.</p>
            </div>
            <span className="attention-count">
              {resolveDashboardMetric(liveCounts, ['pendingApprovals', 'pending_approvals', 'approvals.pending']) ?? '—'}
            </span>
          </div>
          <div className="pending-links">
            {user.role === 'Staff' && (
              <Link to="/quotations">
                <FileTextIcon size={17} />
                <span>Quotations</span>
                <b>{resolveDashboardMetric(liveCounts, ['pendingQuotations', 'pending_quotations']) ?? '—'}</b>
                <ArrowRight size={14} />
              </Link>
            )}
            <Link to={user.role === 'Admin' ? '/cash-claims' : '/my-expense-claims'}>
              <ReceiptTextIcon size={17} />
              <span>Expense claims</span>
              <b>{resolveDashboardMetric(liveCounts, ['pendingExpenseClaims', 'pending_expense_claims']) ?? '—'}</b>
              <ArrowRight size={14} />
            </Link>
            <Link to="/material-requests">
              <PackageCheckIcon size={17} />
              <span>Material requests</span>
              <b>{resolveDashboardMetric(liveCounts, ['pendingMaterialRequests', 'pending_material_requests']) ?? '—'}</b>
              <ArrowRight size={14} />
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
