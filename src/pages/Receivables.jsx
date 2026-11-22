import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, ChevronDown, ChevronRight, FileText, HandCoins, Mail, Search, Users } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { confirmDialog } from '../components/AskDialog.jsx';
import { printStatement } from '../lib/statement.js';
import '../insights.css';

// What each customer owes, oldest first, with a payment reminder email and a
// printable statement of account.

const money = value => `${Math.round(Number(value) || 0).toLocaleString('en-US')} MMK`;
const shortDate = value => (value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const AGE_BANDS = [['Not due', d => d <= 0], ['1–30 days', d => d > 0 && d <= 30], ['31–60 days', d => d > 30 && d <= 60], ['61–90 days', d => d > 60 && d <= 90], ['Over 90 days', d => d > 90]];

export default function Receivables({ notify }) {
  const [search, setSearch] = useState('');
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const query = useQuery({ queryKey: ['receivables'], queryFn: () => apiRequest('/receivables'), staleTime: 30_000 });
  const all = Array.isArray(query.data) ? query.data : [];
  const term = search.trim().toLowerCase();
  const customers = all
    .filter(c => !onlyOverdue || Number(c.overdue) > 0)
    .filter(c => !term || `${c.customer} ${(c.invoices || []).map(i => i.number).join(' ')}`.toLowerCase().includes(term));

  const invoices = all.flatMap(c => c.invoices || []);
  const total = invoices.reduce((s, i) => s + Number(i.outstanding || 0), 0);
  const overdue = invoices.filter(i => i.days_overdue > 0).reduce((s, i) => s + Number(i.outstanding || 0), 0);
  const bands = AGE_BANDS.map(([label, test]) => ({ label, amount: invoices.filter(i => test(Number(i.days_overdue) || 0)).reduce((s, i) => s + Number(i.outstanding || 0), 0) }));
  const maxBand = Math.max(1, ...bands.map(b => b.amount));

  const remind = async customer => {
    if (!customer.email) { notify?.(`${customer.customer} has no email address. Add one on the customer record, or print the statement.`); return; }
    if (!await confirmDialog(`Email a payment reminder to ${customer.customer} (${customer.email})?\n\n${(customer.invoices || []).length} open invoice${customer.invoices?.length === 1 ? '' : 's'} · ${money(customer.outstanding)}`, { title: 'Send reminder', confirmLabel: 'Send reminder' })) return;
    setBusy(customer.customer_id);
    try {
      await apiRequest(`/customers/${customer.customer_id}/remind`, { method: 'POST' });
      notify?.(`Reminder queued for ${customer.email}. It is sent when email alerts are set up (see README).`);
    } catch (error) { notify?.(error.message); }
    finally { setBusy(''); }
  };

  const statement = async customer => {
    setBusy(customer.customer_id);
    try { printStatement(await apiRequest(`/customer-statement/${customer.customer_id}`)); }
    catch (error) { notify?.(error.message); }
    finally { setBusy(''); }
  };

  return <div className="ins-root">
    <div className="page-heading ins-heading">
      <div><div className="eyebrow">FINANCE</div><h1>Receivables</h1><p>Who owes money, how late it is, and a reminder in one click.</p></div>
    </div>

    <section className="ins-tiles">
      <div className="ins-tile"><span><HandCoins size={15} />Outstanding</span><b>{money(total)}</b><small>{invoices.length} open invoice{invoices.length === 1 ? '' : 's'}</small></div>
      <div className={`ins-tile ${overdue ? 'loss' : ''}`}><span><AlarmClock size={15} />Overdue</span><b>{money(overdue)}</b><small>Past the due date</small></div>
      <div className="ins-tile"><span><Users size={15} />Customers</span><b>{all.length}</b><small>{all.filter(c => Number(c.overdue) > 0).length} with overdue invoices</small></div>
    </section>

    <section className="ins-panel">
      <h2 className="ins-title">How late is the money?</h2>
      <ul className="ins-bars">
        {bands.map(band => <li key={band.label}>
          <span className="name">{band.label}</span>
          <span className="track"><i style={{ width: `${band.amount ? Math.max(2, (band.amount / maxBand) * 100) : 0}%` }} /></span>
          <span className="value">{money(band.amount)}</span>
        </li>)}
      </ul>
    </section>

    <section className="ins-panel">
      <div className="ins-filters">
        <label className="ins-grow">Search<span className="ins-search"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Customer or invoice number" /></span></label>
        <label className="ins-check"><input type="checkbox" checked={onlyOverdue} onChange={e => setOnlyOverdue(e.target.checked)} />Only overdue</label>
      </div>
      {query.isLoading && <p className="ins-empty">Loading…</p>}
      {query.isError && <p className="ins-error">{query.error?.message}</p>}
      {!query.isLoading && !customers.length && <p className="ins-empty" style={{ marginTop: 12 }}>Nothing outstanding.</p>}
      {customers.length > 0 && <div className="ins-table-wrap" style={{ marginTop: 12 }}><table className="ins-table">
        <thead><tr><th /><th>Customer</th><th className="num">Outstanding</th><th className="num">Overdue</th><th className="num">Oldest</th><th>Actions</th></tr></thead>
        <tbody>{customers.map(c => {
          const expanded = open === c.customer_id;
          return <Fragment key={c.customer_id}>
            <tr className={Number(c.overdue) > 0 ? 'is-loss' : ''}>
              <td><button className="ins-expand" aria-expanded={expanded} aria-label={expanded ? 'Hide invoices' : 'Show invoices'} onClick={() => setOpen(expanded ? null : c.customer_id)}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></td>
              <td data-label="Customer"><b>{c.customer}</b><small>{c.email || c.phone || 'No contact details'}</small></td>
              <td data-label="Outstanding" className="num">{money(c.outstanding)}</td>
              <td data-label="Overdue" className="num">{Number(c.overdue) ? money(c.overdue) : '—'}</td>
              <td data-label="Oldest" className="num">{Number(c.oldest_days) ? `${c.oldest_days} days` : 'Not due'}</td>
              <td data-label="Actions"><div className="ins-actions">
                <button className="ins-btn" disabled={busy === c.customer_id} onClick={() => remind(c)}><Mail size={15} />Send reminder</button>
                <button className="ins-btn" disabled={busy === c.customer_id} onClick={() => statement(c)}><FileText size={15} />Statement</button>
              </div></td>
            </tr>
            {expanded && <tr className="ins-breakdown"><td /><td colSpan={5}>
              <table className="ins-table">
                <thead><tr><th>Invoice</th><th>Job</th><th>Due</th><th className="num">Total</th><th className="num">Received</th><th className="num">Outstanding</th><th className="num">Days late</th></tr></thead>
                <tbody>{(c.invoices || []).map(i => <tr key={i.id}>
                  <td data-label="Invoice"><b>{i.number}</b></td><td data-label="Job">{i.job_number || '—'}</td><td data-label="Due">{shortDate(i.due_date)}</td>
                  <td data-label="Total" className="num">{money(i.total)}</td><td data-label="Received" className="num">{money(i.received)}</td>
                  <td data-label="Outstanding" className="num"><b>{money(i.outstanding)}</b></td><td data-label="Days late" className="num">{i.days_overdue || '—'}</td>
                </tr>)}</tbody>
              </table>
            </td></tr>}
          </Fragment>;
        })}</tbody>
      </table></div>}
      <p className="ins-hint">Overdue invoices also appear in your notifications once a week. Reminder emails need email alerts set up (RESEND_API_KEY).</p>
    </section>
  </div>;
}
