import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, FileDown, Landmark, ReceiptText, Scale, Search, Wallet } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { downloadXlsx } from './excel.js';
import './cashboard.css';

const pad = n => String(n).padStart(2, '0');
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const num = value => Number(value) || 0;
const money = value => `MMK ${Math.round(num(value)).toLocaleString('en-US')}`;
const plain = value => Math.round(num(value)).toLocaleString('en-US');
const monthLabel = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }); };
const longMonth = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); };
const shortDate = value => { if (!value) return '—'; const [y, m, d] = String(value).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); };

function withBalance(entries, opening) {
  let balance = num(opening);
  return entries.map(entry => { balance += num(entry.cash_in) - num(entry.cash_out); return { ...entry, balance }; });
}

function byJob(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.job_number) continue;
    const row = map.get(entry.job_number) || { job: entry.job_number, cash_in: 0, cash_out: 0 };
    row.cash_in += num(entry.cash_in); row.cash_out += num(entry.cash_out);
    map.set(entry.job_number, row);
  }
  return [...map.values()].map(row => ({ ...row, net: row.cash_in - row.cash_out })).sort((a, b) => b.net - a.net);
}

function aging(receivables) {
  const buckets = [['Not due', 0], ['1–30 days', 0], ['31–60 days', 0], ['61–90 days', 0], ['Over 90 days', 0]];
  for (const item of receivables) {
    const days = num(item.days_overdue); const index = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
    buckets[index][1] += num(item.outstanding);
  }
  return buckets;
}

export default function CashBoard({ notify }) {
  const [month, setMonth] = useState(thisMonth);
  const [flow, setFlow] = useState('all');
  const [search, setSearch] = useState('');
  const year = month.slice(0, 4);
  const query = useQuery({
    queryKey: ['cash-board', year],
    queryFn: () => apiRequest(`/cash-board?from=${year}-01-01&to=${year}-12-31`),
    staleTime: 30_000,
  });
  const data = query.data;

  const months = data?.months || [];
  const summary = months.find(item => item.month === month) || { opening: 0, income: 0, expense: 0, invoiced: 0, collected: 0, receivable: 0 };
  const closing = num(summary.opening) + num(summary.income) - num(summary.expense);
  const monthEntries = useMemo(() => withBalance((data?.ledger || []).filter(entry => String(entry.date).startsWith(month)), summary.opening), [data, month, summary.opening]);
  const visibleEntries = monthEntries.filter(entry => {
    if (flow === 'in' && !num(entry.cash_in)) return false;
    if (flow === 'out' && !num(entry.cash_out)) return false;
    const text = `${entry.reference} ${entry.category} ${entry.job_number || ''} ${entry.party || ''} ${entry.description || ''}`.toLowerCase();
    return text.includes(search.trim().toLowerCase());
  });
  const jobs = byJob(monthEntries);
  const receivables = data?.receivables || [];
  const agingBuckets = aging(receivables);
  const yearIncome = months.reduce((sum, item) => sum + num(item.income), 0);
  const yearExpense = months.reduce((sum, item) => sum + num(item.expense), 0);

  const stats = [
    { label: 'Opening balance', value: summary.opening, icon: Landmark, tone: 'slate', note: `1 ${monthLabel(month)}` },
    { label: 'Cash in (income)', value: summary.income, icon: ArrowUpRight, tone: 'green', note: `${monthEntries.filter(e => num(e.cash_in)).length} receipts` },
    { label: 'Cash out (expense)', value: summary.expense, icon: ArrowDownRight, tone: 'red', note: `${monthEntries.filter(e => num(e.cash_out)).length} payments` },
    { label: 'Closing balance', value: closing, icon: Wallet, tone: 'blue', note: `Net ${num(summary.income) - num(summary.expense) >= 0 ? '+' : ''}${plain(num(summary.income) - num(summary.expense))}` },
    { label: 'Invoiced this month', value: summary.invoiced, icon: ReceiptText, tone: 'violet', note: `Collected ${plain(summary.collected)}` },
    { label: 'Receivable (AR)', value: summary.receivable, icon: Scale, tone: 'amber', note: 'Unpaid invoices at month end' },
  ];

  const exportExcel = scope => {
    if (!data) return;
    const isMonth = scope === 'month';
    const entries = isMonth ? monthEntries : withBalance(data.ledger || [], data.opening);
    const opening = isMonth ? num(summary.opening) : num(data.opening);
    const label = isMonth ? longMonth(month) : `Year ${year}`;
    const ledgerRow = entry => [entry.date, entry.reference, entry.category, entry.job_number || '', entry.party || '', entry.description || ''];
    const income = entries.filter(entry => num(entry.cash_in));
    const expense = entries.filter(entry => num(entry.cash_out));
    const summaryRows = (isMonth ? months.filter(item => item.month === month) : months).map(item => [monthLabel(item.month), num(item.opening), num(item.income), num(item.expense), num(item.income) - num(item.expense), num(item.opening) + num(item.income) - num(item.expense), num(item.invoiced), num(item.collected), num(item.receivable)]);
    const subtitle = `TSG Power Engineering · ${label} · exported ${new Date().toLocaleString()}`;
    downloadXlsx(`TSG-income-expense-${isMonth ? month : year}`, [
      { name: 'Summary', title: `Cash summary – ${label}`, subtitle, columns: [{ header: 'Month', width: 12 }, { header: 'Opening', type: 'number' }, { header: 'Cash in', type: 'number' }, { header: 'Cash out', type: 'number' }, { header: 'Net', type: 'number' }, { header: 'Closing', type: 'number' }, { header: 'Invoiced', type: 'number' }, { header: 'Collected', type: 'number' }, { header: 'Receivable (AR)', type: 'number', width: 17 }], rows: summaryRows, totals: { label: 'Total', columns: [2, 3, 4, 6, 7] } },
      { name: 'Income', title: `Income – ${label}`, subtitle, columns: [{ header: 'Date', type: 'date' }, { header: 'Reference', width: 17 }, { header: 'Category', width: 18 }, { header: 'Job order', width: 12 }, { header: 'Received from', width: 26 }, { header: 'Description', width: 34 }, { header: 'Amount', type: 'number' }], rows: income.map(entry => [...ledgerRow(entry), num(entry.cash_in)]), totals: { label: 'Total income', columns: [6] } },
      { name: 'Expense', title: `Expense – ${label}`, subtitle, columns: [{ header: 'Date', type: 'date' }, { header: 'Reference', width: 17 }, { header: 'Category', width: 22 }, { header: 'Job order', width: 12 }, { header: 'Paid to', width: 26 }, { header: 'Description', width: 34 }, { header: 'Amount', type: 'number' }], rows: expense.map(entry => [...ledgerRow(entry), num(entry.cash_out)]), totals: { label: 'Total expense', columns: [6] } },
      { name: 'Cash book', title: `Cash book – ${label}`, subtitle: `Opening balance ${plain(opening)} · Closing balance ${plain(opening + income.reduce((s, e) => s + num(e.cash_in), 0) - expense.reduce((s, e) => s + num(e.cash_out), 0))}`, columns: [{ header: 'Date', type: 'date' }, { header: 'Reference', width: 17 }, { header: 'Category', width: 22 }, { header: 'Job order', width: 12 }, { header: 'Party', width: 26 }, { header: 'Description', width: 34 }, { header: 'Cash in', type: 'number' }, { header: 'Cash out', type: 'number' }, { header: 'Balance', type: 'number' }], rows: [['', '', 'Opening balance', '', '', '', '', '', opening], ...entries.map(entry => [...ledgerRow(entry), num(entry.cash_in) || '', num(entry.cash_out) || '', entry.balance])], totals: { label: 'Total', columns: [6, 7] } },
      { name: 'By job order', title: `Income & expense by job order – ${label}`, subtitle, columns: [{ header: 'Job order', width: 14 }, { header: 'Income', type: 'number' }, { header: 'Expense', type: 'number' }, { header: 'Net', type: 'number' }], rows: byJob(entries).map(row => [row.job, row.cash_in, row.cash_out, row.net]), totals: { label: 'Total', columns: [1, 2, 3] } },
      { name: 'Receivables', title: 'Accounts receivable (open invoices)', subtitle: `As of ${shortDate(data.to < new Date().toISOString().slice(0, 10) ? data.to : new Date().toISOString().slice(0, 10))}`, columns: [{ header: 'Invoice', width: 16 }, { header: 'Job order', width: 12 }, { header: 'Customer', width: 28 }, { header: 'Invoice date', type: 'date' }, { header: 'Due date', type: 'date' }, { header: 'Invoice amount', type: 'number' }, { header: 'Received', type: 'number' }, { header: 'Outstanding', type: 'number' }, { header: 'Days overdue', type: 'number', width: 13 }], rows: receivables.map(item => [item.number, item.job_number || '', item.customer || '', item.date, item.due_date, num(item.total), num(item.received), num(item.outstanding), num(item.days_overdue)]), totals: { label: 'Total', columns: [5, 6, 7] } },
    ]);
    notify?.(`Excel exported for ${label}.`);
  };

  return <>
    <div className="page-heading module-heading">
      <div><div className="eyebrow">FINANCE</div><h1>Cash board</h1><p>Monthly opening and closing cash, income, expense and receivables.</p></div>
      <div className="heading-actions cb-actions">
        <label className="cb-month"><span>Month</span><input type="month" value={month} onChange={event => event.target.value && setMonth(event.target.value)} /></label>
        <button className="secondary-button" onClick={() => exportExcel('month')} disabled={!data}><FileDown size={15} />Excel · month</button>
        <button className="primary-button" onClick={() => exportExcel('year')} disabled={!data}><FileDown size={15} />Excel · {year}</button>
      </div>
    </div>

    {query.isLoading && <section className="panel cb-empty">Loading cash board…</section>}
    {query.isError && <section className="panel cb-empty">Could not load the cash board. {query.error?.message}</section>}

    {data && <>
      <div className="cb-stats">{stats.map(stat => <div key={stat.label} className={`panel cb-stat tone-${stat.tone}`}><span className="cb-stat-icon"><stat.icon size={18} /></span><div><small>{stat.label}</small><b>{money(stat.value)}</b><em>{stat.note}</em></div></div>)}</div>

      <section className="panel cb-panel">
        <div className="panel-heading"><div><h2>Monthly summary · {year}</h2><p>Click a month to see its cash book.</p></div><span className="cb-chip">Year: in {plain(yearIncome)} · out {plain(yearExpense)}</span></div>
        <div className="table-scroll"><table className="data-table cb-table clickable">
          <thead><tr><th>Month</th><th className="num">Opening</th><th className="num">Cash in</th><th className="num">Cash out</th><th className="num">Net</th><th className="num">Closing</th><th className="num">Invoiced</th><th className="num">Collected</th><th className="num">Receivable</th></tr></thead>
          <tbody>{months.map(item => { const net = num(item.income) - num(item.expense); return <tr key={item.month} className={item.month === month ? 'selected' : ''} onClick={() => setMonth(item.month)}>
            <td><b>{monthLabel(item.month)}</b></td><td className="num">{plain(item.opening)}</td><td className={`num ${num(item.income) ? 'in' : 'muted'}`}>{plain(item.income)}</td><td className={`num ${num(item.expense) ? 'out' : 'muted'}`}>{plain(item.expense)}</td><td className={`num ${net < 0 ? 'out' : net > 0 ? 'in' : 'muted'}`}>{net < 0 ? '−' : ''}{plain(Math.abs(net))}</td><td className="num"><b>{plain(num(item.opening) + net)}</b></td><td className={`num ${num(item.invoiced) ? '' : 'muted'}`}>{plain(item.invoiced)}</td><td className={`num ${num(item.collected) ? '' : 'muted'}`}>{plain(item.collected)}</td><td className={`num ${num(item.receivable) ? '' : 'muted'}`}>{plain(item.receivable)}</td>
          </tr>; })}</tbody>
        </table></div>
      </section>

      <section className="panel cb-panel">
        <div className="panel-heading"><div><h2>Cash book · {longMonth(month)}</h2><p>Every receipt and payment with running balance, linked to job orders.</p></div>
          <div className="cb-filters">
            <div className="cb-toggle" role="tablist" aria-label="Filter cash flow">{[['all', 'All'], ['in', 'Cash in'], ['out', 'Cash out']].map(([key, label]) => <button key={key} role="tab" aria-selected={flow === key} className={flow === key ? 'active' : ''} onClick={() => setFlow(key)}>{label}</button>)}</div>
            <label className="cb-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search reference, job, party" aria-label="Search cash book" /></label>
          </div>
        </div>
        <div className="table-scroll"><table className="data-table cb-table">
          <thead><tr><th>Date</th><th>Reference</th><th>Category</th><th>Job order</th><th>Party</th><th>Description</th><th className="num">Cash in</th><th className="num">Cash out</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr className="cb-fixed"><td>{shortDate(`${month}-01`)}</td><td colSpan={7}><b>Opening balance</b></td><td className="num"><b>{plain(summary.opening)}</b></td></tr>
            {visibleEntries.map((entry, index) => <tr key={`${entry.reference}-${index}`}><td>{shortDate(entry.date)}</td><td><b>{entry.reference}</b></td><td>{entry.category}</td><td>{entry.job_number || '—'}</td><td>{entry.party || '—'}</td><td className="cb-desc">{entry.description || '—'}</td><td className="num in">{num(entry.cash_in) ? plain(entry.cash_in) : ''}</td><td className="num out">{num(entry.cash_out) ? plain(entry.cash_out) : ''}</td><td className="num">{plain(entry.balance)}</td></tr>)}
            {!visibleEntries.length && <tr><td colSpan={9} className="empty-state">{monthEntries.length ? 'No entries match this filter.' : 'No cash movements this month.'}</td></tr>}
            <tr className="cb-fixed total"><td colSpan={6}><b>Closing balance</b></td><td className="num in"><b>{plain(summary.income)}</b></td><td className="num out"><b>{plain(summary.expense)}</b></td><td className="num"><b>{plain(closing)}</b></td></tr>
          </tbody>
        </table></div>
      </section>

      <div className="cb-grid">
        <section className="panel cb-panel">
          <div className="panel-heading"><div><h2>Receivables (AR)</h2><p>Open invoices by job order.</p></div><Link to="/income" className="text-link">Invoice &amp; income</Link></div>
          <div className="cb-aging">{agingBuckets.map(([label, value]) => <div key={label}><small>{label}</small><b>{plain(value)}</b></div>)}</div>
          <div className="table-scroll"><table className="data-table cb-table">
            <thead><tr><th>Invoice</th><th>Job order</th><th>Customer</th><th>Due</th><th className="num">Invoice</th><th className="num">Received</th><th className="num">Outstanding</th></tr></thead>
            <tbody>{receivables.map(item => <tr key={item.number}><td><b>{item.number}</b></td><td>{item.job_number || '—'}</td><td>{item.customer || '—'}</td><td className={num(item.days_overdue) > 0 ? 'out' : ''}>{shortDate(item.due_date)}{num(item.days_overdue) > 0 ? ` · ${item.days_overdue}d late` : ''}</td><td className="num">{plain(item.total)}</td><td className="num in">{plain(item.received)}</td><td className="num"><b>{plain(item.outstanding)}</b></td></tr>)}
              {!receivables.length && <tr><td colSpan={7} className="empty-state">No outstanding invoices.</td></tr>}</tbody>
          </table></div>
        </section>
        <section className="panel cb-panel">
          <div className="panel-heading"><div><h2>By job order · {monthLabel(month)}</h2><p>Cash in and out linked to each job.</p></div></div>
          <div className="table-scroll"><table className="data-table cb-table">
            <thead><tr><th>Job order</th><th className="num">Income</th><th className="num">Expense</th><th className="num">Net</th></tr></thead>
            <tbody>{jobs.map(row => <tr key={row.job}><td><b>{row.job}</b></td><td className={`num ${row.cash_in ? 'in' : 'muted'}`}>{plain(row.cash_in)}</td><td className={`num ${row.cash_out ? 'out' : 'muted'}`}>{plain(row.cash_out)}</td><td className={`num ${row.net < 0 ? 'out' : 'in'}`}><b>{row.net < 0 ? '−' : ''}{plain(Math.abs(row.net))}</b></td></tr>)}
              {!jobs.length && <tr><td colSpan={4} className="empty-state">No job-linked cash this month.</td></tr>}</tbody>
          </table></div>
        </section>
      </div>

      <div className="module-note"><Landmark size={15} /><span>Starting cash balance {money(data.starting_balance)} comes from <Link to="/settings">Settings → Opening cash balance</Link>. Cash in = invoice receipts and posted receipts. Cash out = paid expenses (not funded from an advance), issued advances, salaries and posted payments.</span></div>
    </>}
  </>;
}
