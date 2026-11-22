import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { printManagementReport } from '../lib/managementPdf.js';
import '../insights.css';

// One page per month: what was invoiced and collected, what was spent, cash,
// profit by job, and what is still owed to and by the company.

const money = value => `${Math.round(Number(value) || 0).toLocaleString('en-US')} MMK`;
const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const monthName = ym => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export default function ManagementReport() {
  const [month, setMonth] = useState(lastMonth);
  const query = useQuery({ queryKey: ['management-report', month], queryFn: () => apiRequest(`/management-report?month=${month}`), staleTime: 60_000 });
  const r = query.data || {};
  const jobs = r.jobs || [];
  const categories = r.expense_by_category || [];
  const profit = Number(r.invoiced || 0) - Number(r.expenses || 0);
  const net = Number(r.cash_in || 0) - Number(r.cash_out || 0);
  const maxCat = Math.max(1, ...categories.map(c => Number(c.amount) || 0));
  const maxJob = Math.max(1, ...jobs.map(j => Math.abs(Number(j.margin) || 0)));

  return <div className="ins-root">
    <div className="page-heading ins-heading">
      <div><div className="eyebrow">MANAGEMENT</div><h1>Management report</h1><p>The month at a glance. A notification reminds you on the 1st when last month is ready.</p></div>
      <div className="ins-actions">
        <label className="ins-filters" style={{ alignItems: 'center' }}><input type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={e => e.target.value && setMonth(e.target.value)} aria-label="Month" /></label>
        <button className="ins-btn primary" disabled={!query.data} onClick={() => printManagementReport(monthName(month), r)}><Download size={16} />Save as PDF</button>
      </div>
    </div>
    {query.isError && <p className="ins-error">{query.error?.message}</p>}
    {query.isLoading && <p className="ins-empty">Loading…</p>}

    {query.data && <>
      <section className="ins-tiles">
        <div className="ins-tile"><span>Invoiced</span><b>{money(r.invoiced)}</b><small>{money(r.collected)} collected</small></div>
        <div className="ins-tile"><span>Expenses</span><b>{money(r.expenses)}</b><small>Approved and paid</small></div>
        <div className={`ins-tile ${profit < 0 ? 'loss' : 'profit'}`}><span>Invoiced − expenses</span><b>{profit < 0 ? '−' : ''}{money(Math.abs(profit))}</b><small>Before materials</small></div>
        <div className={`ins-tile ${net < 0 ? 'loss' : 'profit'}`}><span>Net cash</span><b>{net < 0 ? '−' : ''}{money(Math.abs(net))}</b><small>{money(r.cash_in)} in · {money(r.cash_out)} out</small></div>
      </section>
      <section className="ins-tiles">
        <div className={`ins-tile ${Number(r.receivables) ? 'warn' : ''}`}><span>Customers owe (today)</span><b>{money(r.receivables)}</b><small>All open invoices</small></div>
        <div className={`ins-tile ${Number(r.open_advances) ? 'warn' : ''}`}><span>Held by staff (today)</span><b>{money(r.open_advances)}</b><small>Advances not yet settled</small></div>
      </section>

        <section className="ins-panel">
          <h2 className="ins-title">Expenses by category</h2>
          {!categories.length && <p className="ins-empty">No approved expenses this month.</p>}
          <ul className="ins-bars">{categories.map(c => <li key={c.category}>
            <span className="name">{c.category}</span>
            <span className="track"><i style={{ width: `${Math.max(2, (Number(c.amount) / maxCat) * 100)}%` }} /></span>
            <span className="value">{money(c.amount)}</span>
          </li>)}</ul>
        </section>

        <section className="ins-panel">
          <h2 className="ins-title">Profit by job <small>{jobs.length} job{jobs.length === 1 ? '' : 's'} with activity</small></h2>
          {!jobs.length && <p className="ins-empty">No job had invoices or costs this month.</p>}
          {jobs.length > 0 && <div className="ins-table-wrap"><table className="ins-table">
            <thead><tr><th>Job</th><th className="num">Revenue</th><th className="num">Costs</th><th className="ins-margin-col">Margin</th></tr></thead>
            <tbody>{jobs.map(j => { const m = Number(j.margin) || 0; return <tr key={j.number} className={m < 0 ? 'is-loss' : ''}>
              <td data-label="Job"><b className="ins-id">{j.number}</b><small>{j.title}{j.customer ? ` · ${j.customer}` : ''}</small></td>
              <td data-label="Revenue" className="num">{money(j.revenue)}</td>
              <td data-label="Costs" className="num">{money(j.costs)}</td>
              <td data-label="Margin" className="ins-margin-col"><div className={`ins-margin ${m < 0 ? 'loss' : 'profit'}`}><span className="ins-margin-track"><i style={{ width: `${Math.max(2, (Math.abs(m) / maxJob) * 100)}%` }} /></span><b>{m < 0 ? '−' : ''}{money(Math.abs(m))}</b></div></td>
            </tr>; })}</tbody>
          </table></div>}
        </section>
      <p className="ins-hint">Revenue counts invoices dated in the month. Costs are approved/paid expenses dated in the month plus materials issued to the job at cost price. Cash is every money movement in the month.</p>
    </>}
  </div>;
}
