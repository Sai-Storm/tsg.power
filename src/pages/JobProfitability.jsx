import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Search, TrendingUp } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import Status from '../components/Status.jsx';
import '../insights.css';

// Revenue minus costs for every job order.
//   Revenue = issued invoices · Costs = approved/paid expenses (incl. approved
//   advance expenses) + materials issued at cost price.

const money = value => `${Math.round(Number(value) || 0).toLocaleString('en-US')} MMK`;
const pct = value => (value == null ? '—' : `${Number(value).toFixed(1)}%`);
const SORTS = {
  margin: { label: 'Lowest margin first', fn: (a, b) => a.margin - b.margin },
  marginDesc: { label: 'Highest margin first', fn: (a, b) => b.margin - a.margin },
  revenue: { label: 'Highest revenue first', fn: (a, b) => b.revenue - a.revenue },
  costs: { label: 'Highest cost first', fn: (a, b) => b.costs - a.costs },
  number: { label: 'Job number', fn: (a, b) => String(b.number).localeCompare(String(a.number)) },
};

export default function JobProfitability() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('margin');
  const [onlyWithActivity, setOnlyWithActivity] = useState(true);
  const [open, setOpen] = useState(null);

  const query = useQuery({
    queryKey: ['job-profitability', from, to],
    queryFn: () => apiRequest(`/job-profitability?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
    staleTime: 30_000,
  });
  const all = (Array.isArray(query.data) ? query.data : []).map(job => ({
    ...job,
    revenue: Number(job.revenue) || 0, collected: Number(job.collected) || 0, expenses: Number(job.expenses) || 0,
    materials: Number(job.materials) || 0, costs: Number(job.costs) || 0, margin: Number(job.margin) || 0, open_advances: Number(job.open_advances) || 0,
  }));
  const term = search.trim().toLowerCase();
  const jobs = all
    .filter(job => !onlyWithActivity || job.revenue || job.costs || job.open_advances)
    .filter(job => !term || `${job.number} ${job.title} ${job.customer || ''}`.toLowerCase().includes(term))
    .sort(SORTS[sort].fn);

  const totals = jobs.reduce((t, job) => ({ revenue: t.revenue + job.revenue, costs: t.costs + job.costs, margin: t.margin + job.margin, collected: t.collected + job.collected }), { revenue: 0, costs: 0, margin: 0, collected: 0 });
  const losing = jobs.filter(job => job.margin < 0).length;
  const maxAbs = Math.max(1, ...jobs.map(job => Math.abs(job.margin)));

  return <div className="ins-root">
    <div className="page-heading ins-heading">
      <div><div className="eyebrow">FINANCE</div><h1>Job profitability</h1><p>Revenue, costs and margin for every job order.</p></div>
      <button className="ins-btn" onClick={() => window.print()}><Download size={16} />Print / save PDF</button>
    </div>

    <section className="ins-panel ins-filters">
      <label>Job date from<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      <label className="ins-grow">Search<span className="ins-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Job, title or customer" /></span></label>
      <label>Sort<select value={sort} onChange={event => setSort(event.target.value)}>{Object.entries(SORTS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
      <label className="ins-check"><input type="checkbox" checked={onlyWithActivity} onChange={event => setOnlyWithActivity(event.target.checked)} />Hide jobs with no money yet</label>
    </section>

    <section className="ins-tiles">
      <div className="ins-tile"><span>Revenue</span><b>{money(totals.revenue)}</b><small>{money(totals.collected)} collected</small></div>
      <div className="ins-tile"><span>Costs</span><b>{money(totals.costs)}</b><small>Expenses + materials</small></div>
      <div className={`ins-tile ${totals.margin < 0 ? 'loss' : 'profit'}`}><span>Margin</span><b>{money(totals.margin)}</b><small>{totals.revenue ? pct((totals.margin / totals.revenue) * 100) : '—'} of revenue</small></div>
      <div className={`ins-tile ${losing ? 'loss' : ''}`}><span>Jobs losing money</span><b>{losing}</b><small>of {jobs.length} shown</small></div>
    </section>

    <section className="ins-panel">
      <h2 className="ins-title"><TrendingUp size={18} />Margin by job <small>{jobs.length} job{jobs.length === 1 ? '' : 's'}</small></h2>
      {query.isLoading && <p className="ins-empty">Loading…</p>}
      {query.isError && <p className="ins-error">{query.error?.message}</p>}
      {!query.isLoading && !jobs.length && <p className="ins-empty">No jobs match these filters.</p>}
      {jobs.length > 0 && <div className="ins-table-wrap"><table className="ins-table">
        <thead><tr><th /><th>Job</th><th>Status</th><th className="num">Revenue</th><th className="num">Costs</th><th className="ins-margin-col">Margin</th><th className="num">Margin %</th><th className="num">Open advances</th></tr></thead>
        <tbody>
          {jobs.map(job => {
            const expanded = open === job.id;
            const share = Math.abs(job.margin) / maxAbs;
            return <Fragment key={job.id}>
              <tr className={job.margin < 0 ? 'is-loss' : ''}>
                <td><button className="ins-expand" aria-label={expanded ? 'Hide cost breakdown' : 'Show cost breakdown'} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : job.id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></td>
                <td data-label="Job"><b>{job.number}</b><small>{job.title}{job.customer ? ` · ${job.customer}` : ''}</small></td>
                <td data-label="Status">{job.status ? <Status value={job.status} /> : '—'}</td>
                <td data-label="Revenue" className="num">{money(job.revenue)}</td>
                <td data-label="Costs" className="num">{money(job.costs)}</td>
                <td data-label="Margin" className="ins-margin-col">
                  <div className={`ins-margin ${job.margin < 0 ? 'loss' : 'profit'}`} title={`${money(job.margin)}`}>
                    <span className="ins-margin-track"><i style={{ width: `${Math.max(2, share * 100)}%` }} /></span>
                    <b>{job.margin < 0 ? '−' : ''}{money(Math.abs(job.margin))}</b>
                  </div>
                </td>
                <td data-label="Margin %" className="num">{pct(job.margin_pct)}</td>
                <td data-label="Open advances" className="num">{job.open_advances ? money(job.open_advances) : '—'}</td>
              </tr>
              {expanded && <tr className="ins-breakdown"><td /><td colSpan={7}>
                <div className="ins-breakdown-grid">
                  <span>Invoiced <b>{money(job.revenue)}</b></span>
                  <span>Collected <b>{money(job.collected)}</b></span>
                  <span>Expenses <b>{money(job.expenses)}</b></span>
                  <span>Materials at cost <b>{money(job.materials)}</b></span>
                  {Object.entries(job.cost_by_category || {}).map(([category, value]) => <span key={category}>{category} <b>{money(value)}</b></span>)}
                </div>
                {job.open_advances > 0 && <p className="ins-hint">{money(job.open_advances)} of advances on this job are not settled yet. The margin will change once they are.</p>}
              </td></tr>}
            </Fragment>;
          })}
        </tbody>
      </table></div>}
      <p className="ins-hint">Revenue is issued invoices. Costs are approved or paid expenses (including approved advance expenses) plus materials issued to the job at cost price. Advances themselves are not counted, so money is never counted twice.</p>
    </section>
  </div>;
}
