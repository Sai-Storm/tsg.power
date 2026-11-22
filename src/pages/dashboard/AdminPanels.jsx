// Company-wide panels: revenue vs expenses, cash flow, outstanding invoices
// and recent customer payments.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { apiRequest } from '../../api/client.js';
import { moduleInfo } from '../../data.js';
import Status from '../../components/Status.jsx';
import { normalizeList } from '../../lib/records.js';
import { getDashboardSeries, moneyText, rowsState } from './metrics.js';
import { MiniBarChart, PanelHeading } from './widgets.jsx';

const invoiceCol = name => moduleInfo.invoices.columns.indexOf(name);

export function AdminCharts({ dashboardData, outstandingAmount }) {
  const invoicesQuery = useQuery({ queryKey: ['dashboard-invoices'], queryFn: () => apiRequest('/invoices?page=1&limit=5'), staleTime: 20_000 });
  const invoiceRows = normalizeList(invoicesQuery.data, moduleInfo.invoices.columns);
  const revenueSeries = getDashboardSeries(dashboardData, ['monthlyRevenueExpenses', 'revenueVsExpenses', 'revenue_expense_trend', 'analytics.revenueExpenses']);
  const cashFlowSeries = getDashboardSeries(dashboardData, ['monthlyCashFlow', 'cashFlow', 'cash_flow', 'analytics.cashFlow']);
  const openCount = invoiceRows.filter(row => /unpaid|partial|overdue|issued/i.test(String(row[invoiceCol('Status')] || ''))).length;

  return <>
    <section className="panel analytics-panel revenue-panel">
      <PanelHeading title="Revenue vs expenses" subtitle="Monthly financial performance" to="/reports" linkLabel="Reports" />
      <MiniBarChart series={revenueSeries} emptyText="Monthly totals will appear here when provided by the dashboard API." />
    </section>
    <section className="panel analytics-panel cash-trend-panel">
      <PanelHeading title="Monthly cash flow" subtitle="Money received over time" to="/cash-claims" linkLabel="Cash & bank" />
      <MiniBarChart series={cashFlowSeries} cash emptyText="Monthly totals will appear here when provided by the dashboard API." />
    </section>
    <section className="panel invoice-summary-panel">
      <PanelHeading title="Outstanding invoices" subtitle="Open customer balances" to="/receivables" linkLabel="Receivables" />
      <div className="invoice-summary-value">{moneyText(outstandingAmount ?? '—')}</div>
      <div className="invoice-summary-meta">
        <span>{openCount} open in recent records</span>
        <span className="summary-status">{invoiceRows.length ? `${invoiceRows.length} recent invoices` : invoicesQuery.isLoading ? 'Loading…' : 'No invoice records'}</span>
      </div>
      <div className="invoice-mini-list">
        {invoiceRows.slice(0, 3).map(row => (
          <Link to="/income" key={row[0]}>
            <span><b>{row[0]}</b><small>{row[invoiceCol('Customer')]}{row[invoiceCol('Job order')] && row[invoiceCol('Job order')] !== '—' ? ` · ${row[invoiceCol('Job order')]}` : ''}</small></span>
            <strong>{row[invoiceCol('Outstanding')]}</strong>
            <Status value={row[invoiceCol('Status')] || 'Unpaid'} />
          </Link>
        ))}
        {!invoiceRows.length && <div className="dashboard-empty-line">{rowsState(invoicesQuery, invoiceRows)}</div>}
      </div>
    </section>
  </>;
}

export function RecentPayments({ cashQuery, cashRows }) {
  const payments = cashRows.filter(row => /payment|receipt|received/i.test(String(row[1] || ''))).slice(0, 4);
  return (
    <section className="panel activity-panel">
      <PanelHeading title="Recent customer payments" subtitle="Latest receipts and invoice payments." to="/cash-claims" linkLabel="Cash & bank" />
      <div className="attention-list">
        {payments.map(row => (
          <div className="attention-row" key={row[0]}>
            <span className="attention-icon green"><Wallet size={17} /></span>
            <div className="attention-copy"><b>{row[2]}</b><small>{row[0]} · {row[3]}</small></div>
            <strong className="payment-amount">{row[4]}</strong>
          </div>
        ))}
        {!payments.length && <div className="dashboard-empty-line">{rowsState(cashQuery, cashRows) || 'No recent customer payments.'}</div>}
      </div>
    </section>
  );
}
