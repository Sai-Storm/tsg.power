import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Check, CornerUpLeft, Paperclip, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { ReceiptLink, looksLikeFile } from './Attachments.jsx';
import './advance.css';

// One window for the whole life of a staff advance, always tied to its job order:
//   Staff    record expenses as drafts (nothing is sent) -> submit settlement
//   Manager  approve / reject each expense -> approve settlement or return it
//   Finance  record returned cash or pay the extra -> close the advance
// The Admin role acts as Manager and Finance.

const CATEGORIES = ['SKU / Materials', 'Spare parts', 'Transportation', 'Fuel', 'Meals', 'Accommodation', 'Tools', 'Office', 'Other'];
const STEPS = ['Requested', 'Approved', 'Money released', 'Recording expenses', 'Manager review', 'Finance settlement', 'Closed'];
const num = value => { const n = Number(String(value ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const money = value => `${num(value).toLocaleString('en-US', { maximumFractionDigits: 2 })} MMK`;
const lower = value => String(value || '').toLowerCase();
const isDraft = entry => lower(entry.status) === 'draft';
const todayKey = () => new Date().toISOString().slice(0, 10);
const shortDate = value => { if (!value) return '—'; const d = new Date(`${String(value).slice(0, 10)}T00:00:00`); return Number.isNaN(d.valueOf()) ? String(value) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const statusClass = status => `advx-status advx-status-${lower(status || 'draft').replace(/[^a-z]+/g, '-')}`;
const emptyForm = () => ({ id: '', date: todayKey(), category: CATEGORIES[0], supplier_name: '', description: '', amount: '', notes: '', receipt: null, receipt_file: '' });
const isOpen = status => ['issued', 'open', 'partially settled'].includes(lower(status));
const stageOf = status => ({ 'pending approval': 0, approved: 1, issued: 3, open: 3, 'partially settled': 3, 'under review': 4, 'settlement approved': 5, settled: 6, closed: 6 })[lower(status)] ?? 0;
const stageLabel = status => (isOpen(status) ? 'In progress' : status || '—');

// ---- Demo mode (no Supabase): the same workflow in localStorage -------------
const DEMO_KEY = 'tsg-demo-advance-expenses';
const demoAll = () => JSON.parse(localStorage.getItem(DEMO_KEY) || '{}');
function demoGet(row, columns) {
  const col = name => row[columns.findIndex(column => column.toLowerCase() === name)];
  const raw = demoAll()[row[0]];
  const listed = col('status');
  const base = { entries: [], history: [], status: listed && listed !== '—' ? listed : 'Issued', returned: 0, reimbursed: 0, review_note: '' };
  return Array.isArray(raw) ? { ...base, entries: raw } : { ...base, ...(raw || {}) };
}
function demoPut(row, state) { const all = demoAll(); all[row[0]] = state; localStorage.setItem(DEMO_KEY, JSON.stringify(all)); }
function demoData(row, columns) {
  const col = name => row[columns.findIndex(column => column.toLowerCase() === name)];
  const state = demoGet(row, columns);
  const amount = num(col('amount'));
  const sum = test => state.entries.filter(e => test(lower(e.status))).reduce((s, e) => s + num(e.amount), 0);
  const drafts = sum(s => s === 'draft'); const submitted = sum(s => s === 'submitted'); const approved = sum(s => s === 'approved'); const rejected = sum(s => s === 'rejected');
  const recorded = drafts + submitted + approved;
  return {
    advance: { number: row[0], purpose: col('purpose'), status: state.status, job_number: col('job order'), staff_name: col('staff member'), amount, drafts, submitted, approved, rejected, claimed: submitted + approved, recorded, remaining: Math.max(amount - recorded, 0), over: Math.max(recorded - amount, 0), net: amount - approved, returned_amount: state.returned, reimbursed_amount: state.reimbursed, review_note: state.review_note, can_record: isOpen(state.status), can_review: lower(state.status) === 'under review', can_reconcile: lower(state.status) === 'settlement approved' },
    entries: state.entries,
    history: state.history,
  };
}

export default function AdvanceExpensesDialog({ row, columns, isDemo, readOnly, isAdmin, notify, onClose, onChanged }) {
  const advanceId = row?._id || row?.[0];
  const [demoTick, setDemoTick] = useState(0);
  const query = useQuery({
    queryKey: ['advance-expenses', advanceId],
    queryFn: () => apiRequest(`/advances/${encodeURIComponent(advanceId)}/expenses`),
    enabled: !isDemo && Boolean(advanceId),
  });
  const data = useMemo(() => (isDemo ? demoData(row, columns) : query.data), [isDemo, row, columns, query.data, demoTick]);
  const advance = data?.advance;
  const entries = data?.entries || [];
  const history = data?.history || [];
  const drafts = entries.filter(isDraft);

  const [form, setForm] = useState(null); // null = closed, otherwise the expense being added / edited
  const [finance, setFinance] = useState({ date: todayKey(), method: 'Cash', reference: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const amount = num(advance?.amount);
  const draftTotal = num(advance?.drafts);
  const submitted = num(advance?.submitted);
  const approved = num(advance?.approved);
  const recorded = num(advance?.recorded ?? draftTotal + num(advance?.claimed));
  const remaining = Math.max(amount - recorded, 0);
  const status = advance?.status || '';
  const stage = stageOf(status);
  const canRecord = !readOnly && Boolean(advance?.can_record);
  const canReview = Boolean(isAdmin && advance?.can_review);
  const canReconcile = Boolean(isAdmin && advance?.can_reconcile);
  const jobNumber = advance?.job_number && advance.job_number !== '—' ? advance.job_number : '';
  const missingReceipts = drafts.filter(d => !d.receipt_file).length;
  const editingAmount = form?.id ? num(drafts.find(d => String(d.id) === form.id)?.amount) : 0;
  const formTotalAfter = recorded - editingAmount + num(form?.amount);
  const scale = Math.max(amount, recorded);
  const pct = value => (scale ? `${Math.min(100, (value / scale) * 100)}%` : '0%');

  // Staff see the calculation on everything recorded; manager/finance on approved.
  const outcome = expenses => {
    const diff = amount - expenses;
    if (diff > 0) return { kind: 'return', label: 'Amount to return to company', value: diff, text: 'Staff returns the remaining money to the company.' };
    if (diff < 0) return { kind: 'reimburse', label: 'Company reimburses staff', value: -diff, text: 'The company pays the difference after approval.' };
    return { kind: 'even', label: 'Fully settled', value: 0, text: 'Expenses equal the advance.' };
  };
  const usesApproved = canReconcile || stage >= 5;
  const settlementExpenses = usesApproved ? approved : recorded;
  const settlement = outcome(settlementExpenses);

  const refresh = async () => { if (isDemo) setDemoTick(t => t + 1); else await query.refetch(); onChanged?.(); };
  const run = async (task, success) => {
    setBusy(true); setError('');
    try { await task(); await refresh(); if (success) notify?.(success); return true; }
    catch (e) { setError(e.message || 'Something went wrong.'); return false; }
    finally { setBusy(false); }
  };
  const demoUpdate = (change, action, note, value) => {
    const state = demoGet(row, columns); change(state);
    state.history = [{ action, note, amount: value, at: new Date().toISOString(), by: isAdmin ? 'Admin' : 'Staff' }, ...(state.history || [])];
    demoPut(row, state);
  };

  // ---- Staff -----------------------------------------------------------------
  const saveDraft = async addAnother => {
    const value = num(form.amount);
    if (value <= 0) { setError('Enter the amount spent.'); return; }
    if (!form.description.trim()) { setError('Describe what the money was spent on.'); return; }
    const ok = await run(async () => {
      if (isDemo) {
        demoUpdate(state => {
          const record = { id: form.id || `D-${Date.now()}`, number: form.id ? state.entries.find(e => e.id === form.id)?.number : `EXP-DEMO-${state.entries.length + 1}`, date: form.date, category: form.category, supplier_name: form.supplier_name, description: form.description.trim(), notes: form.notes.trim(), amount: value, status: 'Draft', receipt_file: form.receipt ? form.receipt.name : form.receipt_file, job_number: jobNumber };
          state.entries = form.id ? state.entries.map(e => (e.id === form.id ? record : e)) : [...state.entries, record];
        }, form.id ? 'Draft edited' : 'Draft saved', form.description.trim(), value);
        return;
      }
      const body = new FormData();
      if (form.id) body.append('id', form.id);
      body.append('date', form.date); body.append('category', form.category); body.append('supplier_name', form.supplier_name.trim());
      body.append('description', form.description.trim()); body.append('amount', String(value)); body.append('notes', form.notes.trim());
      if (form.receipt) body.append('receipt_file', form.receipt);
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/draft`, { method: 'POST', body });
    }, form.id ? 'Draft updated. Nothing has been sent to the manager.' : 'Saved as draft. Nothing has been sent to the manager.');
    if (ok) setForm(addAnother ? { ...emptyForm(), date: form.date, category: form.category } : null);
  };

  const deleteDraft = entry => {
    if (!window.confirm(`Delete the draft "${entry.description}" (${money(entry.amount)})?`)) return;
    run(async () => {
      if (isDemo) { demoUpdate(state => { state.entries = state.entries.filter(e => e.id !== entry.id); }, 'Draft deleted', entry.description, num(entry.amount)); return; }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/delete-draft`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id }) });
    }, 'Draft deleted.');
  };

  const submitSettlement = () => {
    if (!drafts.length) return;
    if (missingReceipts) { setError(`${missingReceipts} expense${missingReceipts === 1 ? ' has' : 's have'} no receipt. Edit ${missingReceipts === 1 ? 'it' : 'them'} and upload the receipt before submitting.`); return; }
    const o = outcome(recorded);
    const tail = o.kind === 'return' ? `\n${money(o.value)} will need to be returned to the company.` : o.kind === 'reimburse' ? `\nYou spent ${money(o.value)} more than the advance. The company will reimburse it after approval.` : '\nThis uses the full advance.';
    if (!window.confirm(`Submit the settlement for ${advance?.number || row?.[0]}${jobNumber ? ` (job ${jobNumber})` : ''}?\n\n${drafts.length} expense${drafts.length === 1 ? '' : 's'} · ${money(draftTotal)}\nAdvance received: ${money(amount)}\nTotal expenses: ${money(recorded)}${tail}\n\nAfter submitting you cannot edit these expenses unless the manager returns them.`)) return;
    run(async () => {
      if (isDemo) { demoUpdate(state => { state.entries = state.entries.map(e => (isDraft(e) ? { ...e, status: 'Submitted' } : e)); state.status = 'Under Review'; state.review_note = ''; }, 'Settlement submitted', '', draftTotal); return; }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/submit-settlement`, { method: 'POST', body: JSON.stringify({}) });
    }, 'Settlement submitted to the manager.');
  };

  // ---- Manager ---------------------------------------------------------------
  const reviewExpense = (entry, decision) => {
    let reason = '';
    if (decision === 'Rejected') { reason = window.prompt(`Reason for rejecting "${entry.description}" (${money(entry.amount)}):`, entry.rejection_reason || '') || ''; if (!reason.trim()) return; }
    run(async () => {
      if (isDemo) { demoUpdate(state => { state.entries = state.entries.map(e => (e.id === entry.id ? { ...e, status: decision, rejection_reason: decision === 'Rejected' ? reason.trim() : '' } : e)); }, `Expense ${decision.toLowerCase()}: ${entry.description}`, reason, num(entry.amount)); return; }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/review-expense`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id, decision, reason }) });
    }, `Expense ${decision.toLowerCase()}.`);
  };

  const decide = decision => {
    let note = '';
    if (decision === 'return') { note = window.prompt('What should the staff member change? (This is sent to them.)') || ''; if (!note.trim()) return; }
    else if (!window.confirm(`Approve the settlement for ${advance?.number}?\n\nEvery expense that is not rejected will be approved.`)) return;
    run(async () => {
      if (isDemo) {
        demoUpdate(state => {
          if (decision === 'approve') { state.entries = state.entries.map(e => (lower(e.status) === 'submitted' ? { ...e, status: 'Approved' } : e)); state.status = 'Settlement Approved'; }
          else { state.entries = state.entries.map(e => (lower(e.status) === 'submitted' ? { ...e, status: 'Draft' } : e)); state.status = 'Issued'; state.review_note = note.trim(); }
        }, decision === 'approve' ? 'Settlement approved' : 'Settlement returned to staff', note);
        return;
      }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) });
    }, decision === 'approve' ? 'Settlement approved. Finance can now reconcile it.' : 'Settlement returned to the staff member.');
  };

  // ---- Finance ---------------------------------------------------------------
  const reconcile = () => {
    const o = outcome(approved);
    const action = o.kind === 'return' ? `Record ${money(o.value)} returned by staff and close` : o.kind === 'reimburse' ? `Pay ${money(o.value)} to staff and close` : 'Close the fully settled advance';
    if (!window.confirm(`${action}?\n\nThis posts to the cash book against job ${jobNumber || '—'} and closes the advance.`)) return;
    run(async () => {
      if (isDemo) { demoUpdate(state => { state.status = 'Settled'; state.returned = o.kind === 'return' ? o.value : 0; state.reimbursed = o.kind === 'reimburse' ? o.value : 0; }, o.kind === 'return' ? 'Returned cash recorded' : o.kind === 'reimburse' ? 'Reimbursement paid' : 'Advance closed', `${finance.method}${finance.reference ? ` · ${finance.reference}` : ''}`, o.value); return; }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/reconcile`, { method: 'POST', body: JSON.stringify(finance) });
    }, 'Advance closed.');
  };

  const openEdit = entry => { setError(''); setForm({ ...emptyForm(), id: String(entry.id), date: String(entry.date || '').slice(0, 10) || todayKey(), category: entry.category || CATEGORIES[0], supplier_name: entry.supplier_name || '', description: entry.description || '', notes: entry.notes || '', amount: String(num(entry.amount)), receipt_file: entry.receipt_file || '' }); };
  const showActions = canRecord || canReview;

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal advx-modal" role="dialog" aria-label={`Advance ${row?.[0]}`}>
      <div className="modal-header">
        <div>
          <div className="eyebrow">STAFF ADVANCE{advance?.staff_name && advance.staff_name !== '—' ? ` · ${advance.staff_name}` : ''}</div>
          <h2>Advance #{advance?.number || row?.[0]} {advance && <span className={statusClass(isOpen(status) ? 'in progress' : status)}>{stageLabel(status)}</span>}</h2>
          <div className="advx-job"><Briefcase size={16} /><span>Job order</span><b>{jobNumber || 'Not linked'}</b>{advance?.job_title ? <em>{advance.job_title}</em> : null}</div>
          {advance?.purpose && advance.purpose !== '—' && <p className="advx-purpose">{advance.purpose}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog" disabled={busy}><X size={18} /></button>
      </div>

      <div className="advx-body">
        {!isDemo && query.isLoading && <p className="advx-muted">Loading…</p>}
        {!isDemo && query.isError && <p className="advx-error">{query.error?.message}</p>}
        {advance && <>
          <ol className="advx-steps" aria-label="Advance progress">
            {STEPS.map((label, index) => <li key={label} className={index < stage ? 'done' : index === stage ? 'current' : ''}><i>{index < stage ? <Check size={13} /> : index + 1}</i><span>{label}</span></li>)}
          </ol>

          {advance.review_note && isOpen(status) && <div className="advx-callout danger"><b>Returned by the manager:</b> {advance.review_note}</div>}

          <div className="advx-summary">
            <div className="advx-total"><span>Advance received</span><b>{money(amount)}</b>{advance.issued_on && <small>Released {shortDate(advance.issued_on)}{advance.payment_method ? ` · ${advance.payment_method}` : ''}</small>}</div>
            <div className="advx-figure drafts"><span>Draft expenses</span><b>{money(draftTotal)}</b></div>
            <div className="advx-figure submitted"><span>{approved ? 'Submitted / approved' : 'Submitted'}</span><b>{money(submitted + approved)}</b></div>
            {num(advance.over) > 0
              ? <div className="advx-figure over"><span>Over the advance</span><b>{money(advance.over)}</b></div>
              : <div className="advx-figure remaining"><span>Unrecorded balance</span><b>{money(remaining)}</b></div>}
          </div>
          <div className="advx-progress">
            <div className="advx-bar" aria-hidden="true"><i className="approved" style={{ width: pct(approved) }} /><i className="submitted" style={{ width: pct(submitted) }} /><i className="drafts" style={{ width: pct(draftTotal) }} /></div>
            <p><b>{money(recorded)}</b> / {money(amount)} recorded{draftTotal > 0 ? ` · ${money(draftTotal)} still in draft (not sent)` : ''}</p>
          </div>

          <h3 className="advx-section-title">Expense records</h3>
          <div className="advx-table-wrap"><table className="advx-table">
            <thead><tr><th>Date</th><th>Description</th><th>Receipt</th><th className="num">Amount</th><th>Status</th>{showActions && <th />}</tr></thead>
            <tbody>
              {entries.map(entry => { const draft = isDraft(entry); const reviewable = ['submitted', 'approved', 'rejected'].includes(lower(entry.status)); return <tr key={entry.id} className={draft ? 'is-draft' : ''}>
                <td className="advx-date">{shortDate(entry.date)}</td>
                <td><b>{entry.description}</b><small>{[entry.category, entry.supplier_name, entry.number, entry.job_number || jobNumber].filter(Boolean).join(' · ')}</small>{entry.notes && <small className="advx-note">{entry.notes}</small>}</td>
                <td>{entry.receipt_file ? (looksLikeFile(entry.receipt_file) ? <ReceiptLink url={entry.receipt_file} name={`Receipt · ${entry.description || entry.number || ''}`} /> : <span className="advx-receipt"><Paperclip size={13} />Attached</span>) : <span className="advx-missing">Missing</span>}</td>
                <td className="num">{money(entry.amount)}</td>
                <td><span className={statusClass(entry.status)}>{entry.status}</span>{entry.rejection_reason && <small className="advx-reason">{entry.rejection_reason}</small>}</td>
                {showActions && <td className="advx-row-actions">
                  {draft && canRecord && <><button className="row-action-button" disabled={busy} onClick={() => openEdit(entry)} aria-label="Edit draft" title="Edit"><Pencil size={14} /></button><button className="row-action-button danger" disabled={busy} onClick={() => deleteDraft(entry)} aria-label="Delete draft" title="Delete"><Trash2 size={14} /></button></>}
                  {canReview && reviewable && <><button className="row-action-button ok" disabled={busy || lower(entry.status) === 'approved'} onClick={() => reviewExpense(entry, 'Approved')}>Approve</button><button className="row-action-button danger" disabled={busy} onClick={() => reviewExpense(entry, 'Rejected')}>Reject</button></>}
                </td>}
              </tr>; })}
              {!entries.length && <tr><td colSpan={showActions ? 6 : 5} className="advx-empty">No expenses recorded yet.{canRecord ? ' Click "Add expense" to start.' : ''}</td></tr>}
            </tbody>
            {entries.length > 0 && <tfoot><tr><td colSpan={3}>Total (excluding rejected)</td><td className="num">{money(entries.reduce((s, e) => s + (lower(e.status) === 'rejected' ? 0 : num(e.amount)), 0))}</td><td colSpan={showActions ? 2 : 1} /></tr></tfoot>}
          </table></div>

          {form && <div className="advx-form">
            <h3>{form.id ? 'Edit expense (draft)' : 'Add expense'}</h3>
            <div className="advx-form-grid">
              <label>Advance ID<input value={advance.number || row?.[0] || ''} readOnly /></label>
              <label>Job order<input value={jobNumber || '—'} readOnly /></label>
              <label>Expense date<input type="date" value={form.date} max={todayKey()} onChange={e => setForm({ ...form, date: e.target.value })} /></label>
              <label>Category<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{[...new Set([...CATEGORIES, form.category])].map(c => <option key={c}>{c}</option>)}</select></label>
              <label className="wide">Description<input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Generator spare parts" /></label>
              <label>Amount (MMK)<input type="number" min="0" step="any" inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="300000" /></label>
              <label>Supplier<input value={form.supplier_name} onChange={e => setForm({ ...form, supplier_name: e.target.value })} placeholder="e.g. ABC Supplier" /></label>
              <label className="wide">Receipt (image / PDF)<input type="file" accept="image/*,.pdf" onChange={e => setForm({ ...form, receipt: e.target.files?.[0] || null })} /><small>{form.receipt ? form.receipt.name : form.receipt_file ? 'A receipt is already attached. Choose a file only to replace it.' : 'You can add it later, but it is required before submitting.'}</small></label>
              <label className="wide">Notes<input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder={jobNumber ? `e.g. Purchased for job ${jobNumber}` : 'Optional'} /></label>
            </div>
            {num(form.amount) > 0 && formTotalAfter > amount && <p className="advx-warn">This brings your expenses to {money(formTotalAfter)}, which is {money(formTotalAfter - amount)} more than the advance. You can still save it. The company reimburses the difference after approval.</p>}
            <p className="advx-muted">Saving keeps this as a draft. Nothing is sent to the manager until you click <b>Submit settlement</b>.</p>
            <div className="advx-form-actions">
              <button className="secondary-button" disabled={busy} onClick={() => { setForm(null); setError(''); }}>Cancel</button>
              {!form.id && <button className="secondary-button" disabled={busy} onClick={() => saveDraft(true)}>Save and add another</button>}
              <button className="primary-button" disabled={busy} onClick={() => saveDraft(false)}>{busy ? 'Saving…' : 'Save draft'}</button>
            </div>
          </div>}

          {(drafts.length > 0 || stage >= 4) && <div className={`advx-settle advx-settle-${settlement.kind}`}>
            <h3 className="advx-section-title">Settlement calculation</h3>
            <table><tbody>
              <tr><td>Advance received</td><td className="num">{money(amount)}</td></tr>
              <tr><td>{usesApproved ? 'Approved expenses' : 'Total expenses'}</td><td className="num">{money(settlementExpenses)}</td></tr>
              {num(advance.rejected) > 0 && <tr className="muted"><td>Rejected (not counted)</td><td className="num">{money(advance.rejected)}</td></tr>}
              <tr className="result"><td>{settlement.label}</td><td className="num">{money(settlement.value)}</td></tr>
            </tbody></table>
            <p>{stage >= 6
              ? (num(advance.returned_amount) > 0 ? `Closed. ${money(advance.returned_amount)} was returned to the company.` : num(advance.reimbursed_amount) > 0 ? `Closed. ${money(advance.reimbursed_amount)} was reimbursed to the staff member.` : 'Closed. Fully settled.')
              : settlement.text}</p>
          </div>}

          {canReconcile && <div className="advx-form">
            <h3>{settlement.kind === 'return' ? 'Record returned cash' : settlement.kind === 'reimburse' ? 'Pay reimbursement' : 'Close advance'}</h3>
            <div className="advx-form-grid">
              <label>Date<input type="date" value={finance.date} onChange={e => setFinance({ ...finance, date: e.target.value })} /></label>
              <label>Method<select value={finance.method} onChange={e => setFinance({ ...finance, method: e.target.value })}><option>Cash</option><option>Bank transfer</option><option>Cheque</option></select></label>
              <label className="wide">Reference<input value={finance.reference} onChange={e => setFinance({ ...finance, reference: e.target.value })} placeholder="Receipt / voucher / transfer no." /></label>
            </div>
          </div>}

          {error && <p className="advx-error" role="alert">{error}</p>}
          {!readOnly && !advance.can_record && stage < 3 && <p className="advx-muted">You can record expenses once finance releases the money (current status: {status}).</p>}
          {!readOnly && stage === 4 && <p className="advx-muted">Your settlement is with the manager. You will be notified when it is approved or returned.</p>}

          {history.length > 0 && <details className="advx-history"><summary>History ({history.length})</summary><ul>
            {history.map((h, i) => <li key={i}><b>{h.action}</b>{h.amount != null && h.amount !== '' ? ` · ${money(h.amount)}` : ''}{h.note ? ` · ${h.note}` : ''}<small>{h.by ? `${h.by} · ` : ''}{h.at ? new Date(h.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</small></li>)}
          </ul></details>}
        </>}
      </div>

      <div className="modal-footer advx-footer">
        <button className="secondary-button" onClick={onClose} disabled={busy}>Close</button>
        {canRecord && !form && <button className="secondary-button" disabled={busy} onClick={() => { setError(''); setForm(emptyForm()); }}><Plus size={16} />Add expense</button>}
        {canRecord && <button className="primary-button" disabled={busy || Boolean(form) || !drafts.length} title={drafts.length ? '' : 'Add at least one expense first'} onClick={submitSettlement}><Send size={16} />Submit settlement{drafts.length ? ` (${drafts.length})` : ''}</button>}
        {canReview && <><button className="secondary-button" disabled={busy} onClick={() => decide('return')}><CornerUpLeft size={16} />Return to staff</button><button className="primary-button" disabled={busy} onClick={() => decide('approve')}><Check size={16} />Approve settlement</button></>}
        {canReconcile && <button className="primary-button" disabled={busy} onClick={reconcile}><Check size={16} />{settlement.kind === 'return' ? `Record ${money(settlement.value)} returned & close` : settlement.kind === 'reimburse' ? `Pay ${money(settlement.value)} & close` : 'Close advance'}</button>}
      </div>
    </section>
  </div>;
}
