import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlarmClock, ArrowRight, BellRing, Clock3, Wallet } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import '../insights.css';

// Admin view of every staff advance: how many sit at each step, how much money
// staff are holding, which advances are overdue, and which settlements wait.

const money = value => `${Math.round(Number(value) || 0).toLocaleString('en-US')} MMK`;
const shortDate = value => (value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const STAGE_HELP = {
  'Pending Approval': 'Manager to approve',
  Approved: 'Finance to release money',
  Issued: 'Staff recording expenses',
  'Under Review': 'Manager to review settlement',
  'Settlement Approved': 'Finance to close',
};

export default function AdvanceOverview() {
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const query = useQuery({ queryKey: ['advance-overview'], queryFn: () => apiRequest('/advance-overview'), staleTime: 20_000 });
  const data = query.data || {};
  const stages = data.stages || [];
  const byStaff = data.by_staff || [];
  const overdue = data.overdue || [];
  const waiting = data.waiting_review || [];
  const maxHeld = Math.max(1, ...byStaff.map(item => Number(item.held) || 0));

  const sendReminders = async () => {
    setSending(true); setMessage('');
    try {
      const sent = await apiRequest('/advances/reminders', { method: 'POST' });
      setMessage(Number(sent) ? `${sent} reminder${Number(sent) === 1 ? '' : 's'} sent.` : 'Everyone has already been reminded today.');
    } catch (error) { setMessage(error.message); }
    finally { setSending(false); }
  };

  return <div className="ins-root">
    <div className="page-heading ins-heading">
      <div><div className="eyebrow">FINANCE</div><h1>Advance overview</h1><p>Where every staff advance is, and what needs attention.</p></div>
      <div className="ins-actions">
        <button className="ins-btn" disabled={sending} onClick={sendReminders}><BellRing size={16} />{sending ? 'Sending…' : 'Send reminders now'}</button>
        <Link className="ins-btn primary" to="/advances">Staff advances<ArrowRight size={16} /></Link>
      </div>
    </div>
    {message && <p className="ins-banner" role="status">{message}</p>}
    {query.isError && <p className="ins-error">{query.error?.message}</p>}

    <section className="ins-tiles">
      <div className="ins-tile"><span><Wallet size={15} />Money held by staff</span><b>{money(data.held_by_staff)}</b><small>Released, not yet backed by approved expenses</small></div>
      <div className={`ins-tile ${overdue.length ? 'loss' : ''}`}><span><AlarmClock size={15} />Overdue advances</span><b>{overdue.length}</b><small>Past the expected settlement date</small></div>
      <div className={`ins-tile ${waiting.some(item => item.days_waiting >= 3) ? 'warn' : ''}`}><span><Clock3 size={15} />Settlements waiting</span><b>{waiting.length}</b><small>{waiting.filter(item => item.days_waiting >= 3).length} waiting 3+ days</small></div>
    </section>

    <section className="ins-panel">
      <h2 className="ins-title">Advances at each step</h2>
      <ol className="ins-stages">
        {stages.map((stage, index) => <li key={stage.status}>
          <span className="ins-stage-num">{index + 1}</span>
          <b>{stage.status === 'Issued' ? 'In progress' : stage.status}</b>
          <strong>{stage.count}</strong>
          <small>{money(stage.amount)}</small>
          <em>{STAGE_HELP[stage.status]}</em>
        </li>)}
      </ol>
    </section>

    <div className="ins-two">
      <section className="ins-panel">
        <h2 className="ins-title">Money held by each staff member</h2>
        {!byStaff.length && <p className="ins-empty">No open advances.</p>}
        <ul className="ins-bars">
          {byStaff.map(item => <li key={item.staff}>
            <span className="name">{item.staff}<small>{item.advances} advance{Number(item.advances) === 1 ? '' : 's'}</small></span>
            <span className="track"><i style={{ width: `${Math.max(2, (Number(item.held) / maxHeld) * 100)}%` }} /></span>
            <span className="value">{money(item.held)}</span>
          </li>)}
        </ul>
      </section>

      <section className="ins-panel">
        <h2 className="ins-title">Settlements waiting</h2>
        {!waiting.length && <p className="ins-empty">Nothing is waiting for review.</p>}
        <ul className="ins-list">
          {waiting.map(item => <li key={item.id} className={item.days_waiting >= 3 ? 'late' : ''}>
            <div><b>{item.number}</b><small>{item.staff} · job {item.job_number || '—'}</small></div>
            <div className="right"><span className="ins-tag">{item.status === 'Under Review' ? 'Manager review' : 'Finance to close'}</span><small>{item.days_waiting} day{item.days_waiting === 1 ? '' : 's'} waiting</small></div>
          </li>)}
        </ul>
      </section>
    </div>

    <section className="ins-panel">
      <h2 className="ins-title"><AlarmClock size={18} />Overdue advances</h2>
      {!overdue.length && <p className="ins-empty">No advance is past its expected settlement date.</p>}
      {overdue.length > 0 && <div className="ins-table-wrap"><table className="ins-table">
        <thead><tr><th>Advance</th><th>Staff</th><th>Job order</th><th className="num">Amount</th><th className="num">Drafts saved</th><th>Due</th><th className="num">Days overdue</th></tr></thead>
        <tbody>{overdue.map(item => <tr key={item.id} className="is-loss">
          <td data-label="Advance"><b>{item.number}</b></td>
          <td data-label="Staff">{item.staff}</td>
          <td data-label="Job order">{item.job_number || '—'}</td>
          <td data-label="Amount" className="num">{money(item.amount)}</td>
          <td data-label="Drafts saved" className="num">{money(item.drafts)}</td>
          <td data-label="Due">{shortDate(item.due_date)}</td>
          <td data-label="Days overdue" className="num"><b>{item.days_overdue}</b></td>
        </tr>)}</tbody>
      </table></div>}
      <p className="ins-hint">Staff with overdue advances and admins with settlements waiting 3+ days get a reminder notification once a day.</p>
    </section>
  </div>;
}
