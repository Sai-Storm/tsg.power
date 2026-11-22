import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Check, CornerUpLeft, Paperclip, Pencil, Save, Send, Trash2, X } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { ReceiptLink, looksLikeFile } from './Attachments.jsx';
import AdvanceTrend from './AdvanceTrend.jsx';
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

  const [form, setForm] = useState(emptyForm); // the expense being added, or edited when form.id is set
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
  const saveDraft = async () => {
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
    if (ok) setForm({ ...emptyForm(), date: form.date, category: form.category });
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
  const formDirty = Boolean(form.id || form.description.trim() || String(form.amount).trim());
  const next = nextStep(stage, { isAdmin, readOnly, hasDrafts: drafts.length > 0, reviewNote: advance?.review_note });
  const fileInputKey = `${form.id || 'new'}-${entries.length}`;

  return <div className="modal-backdrop advx-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal advx-modal" role="dialog" aria-label={`Advance ${row?.[0]}`}>
      <header className="advx-head">
        <div className="advx-head-main">
          <div className="advx-title"><h2>{advance?.number || row?.[0]}</h2>{advance && <span className={statusClass(isOpen(status) ? 'in progress' : status)}>{stageLabel(status)}</span>}</div>
          <div className="advx-chips">
            <span className="advx-chip job"><Briefcase size={15} />Job order <b>{jobNumber || 'Not linked'}</b>{advance?.job_title ? <em>{advance.job_title}</em> : null}</span>
            {advance?.staff_name && advance.staff_name !== '—' && <span className="advx-chip">Staff <b>{advance.staff_name}</b></span>}
            {advance?.purpose && advance.purpose !== '—' && <span className="advx-chip">Purpose <b>{advance.purpose}</b></span>}
          </div>
        </div>
        <button className="advx-close" onClick={onClose} aria-label="Close dialog" disabled={busy}><X size={20} /></button>
      </header>

      <div className="advx-body">
        {!isDemo && query.isLoading && <p className="advx-muted">Loading…</p>}
        {!isDemo && query.isError && <p className="advx-error">{query.error?.message}</p>}
        {advance && <>
          <section className={`advx-next advx-next-${next.tone}`}>
            <div className="advx-next-top"><span>Step {Math.min(stage + 1, STEPS.length)} of {STEPS.length}</span><b>{STEPS[stage]}</b></div>
            <div className="advx-track" aria-hidden="true">{STEPS.map((label, index) => <i key={label} className={index < stage ? 'done' : index === stage ? 'current' : ''} />)}</div>
            <p>{next.text}</p>
          </section>

          <section className="advx-tiles">
            <div className="advx-tile"><span>Advance received</span><b>{money(amount)}</b>{advance.issued_on ? <small>Released {shortDate(advance.issued_on)}{advance.payment_method ? ` · ${advance.payment_method}` : ''}</small> : <small>Not released yet</small>}</div>
            <div className="advx-tile amber"><span>Draft expenses</span><b>{money(draftTotal)}</b><small>Saved, not sent</small></div>
            <div className="advx-tile blue"><span>Submitted</span><b>{money(submitted + approved)}</b><small>{approved ? `${money(approved)} approved` : 'Sent to manager'}</small></div>
            {num(advance.over) > 0
              ? <div className="advx-tile red"><span>Over the advance</span><b>{money(advance.over)}</b><small>Company reimburses after approval</small></div>
              : <div className="advx-tile"><span>Unrecorded balance</span><b>{money(remaining)}</b><small>Not yet recorded</small></div>}
          </section>
          {amount > 0 && <div className="advx-progress">
            <div className="advx-bar" aria-hidden="true"><i className="approved" style={{ width: pct(approved) }} /><i className="submitted" style={{ width: pct(submitted) }} /><i className="drafts" style={{ width: pct(draftTotal) }} /></div>
            <p><b>{money(recorded)}</b> of {money(amount)} recorded</p>
          </div>}

          <AdvanceTrend entries={entries} amount={amount} issuedOn={advance.issued_on} />

          <section className="advx-section">
            <h3>Expense records <small>{entries.length} item{entries.length === 1 ? '' : 's'}</small></h3>
            {!entries.length && <p className="advx-empty">No expenses recorded yet.{canRecord ? ' Fill in the form below and click Save draft.' : ''}</p>}
            <ul className="advx-list">
              {entries.map(entry => { const draft = isDraft(entry); const reviewable = ['submitted', 'approved', 'rejected'].includes(lower(entry.status)); const editing = form.id === String(entry.id); return <li key={entry.id} className={`${draft ? 'is-draft' : ''} ${editing ? 'is-editing' : ''}`}>
                <div className="advx-item-main">
                  <div className="advx-item-top"><b>{entry.description}</b><span className={statusClass(entry.status)}>{entry.status}</span></div>
                  <div className="advx-item-meta">{[shortDate(entry.date), entry.category, entry.supplier_name, entry.number].filter(Boolean).join(' · ')}</div>
                  {entry.notes && <div className="advx-item-note">{entry.notes}</div>}
                  {entry.rejection_reason && <div className="advx-item-reason">Rejected: {entry.rejection_reason}</div>}
                  <div className="advx-item-receipt">{entry.receipt_file ? (looksLikeFile(entry.receipt_file) ? <ReceiptLink url={entry.receipt_file} name={`Receipt · ${entry.description || entry.number || ''}`} /> : <span className="advx-receipt"><Paperclip size={14} />Receipt attached</span>) : <span className="advx-missing">No receipt yet</span>}</div>
                </div>
                <div className="advx-item-side">
                  <b className="advx-item-amount">{money(entry.amount)}</b>
                  {showActions && <div className="advx-item-actions">
                    {draft && canRecord && <><button className="advx-btn small" disabled={busy} onClick={() => openEdit(entry)}><Pencil size={14} />Edit</button><button className="advx-btn small danger" disabled={busy} onClick={() => deleteDraft(entry)}><Trash2 size={14} />Delete</button></>}
                    {canReview && reviewable && <><button className="advx-btn small ok" disabled={busy || lower(entry.status) === 'approved'} onClick={() => reviewExpense(entry, 'Approved')}><Check size={14} />Approve</button><button className="advx-btn small danger" disabled={busy} onClick={() => reviewExpense(entry, 'Rejected')}><X size={14} />Reject</button></>}
                  </div>}
                </div>
              </li>; })}
            </ul>
            {entries.length > 0 && <div className="advx-list-total"><span>Total (excluding rejected)</span><b>{money(entries.reduce((s, e) => s + (lower(e.status) === 'rejected' ? 0 : num(e.amount)), 0))}</b></div>}
          </section>

          {canRecord && <section className="advx-section advx-form">
            <h3>{form.id ? 'Edit draft expense' : 'Add expense'}</h3>
            <div className="advx-form-grid">
              <label>Expense date<input type="date" value={form.date} max={todayKey()} onChange={e => setForm({ ...form, date: e.target.value })} /></label>
              <label>Category<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{[...new Set([...CATEGORIES, form.category])].map(c => <option key={c}>{c}</option>)}</select></label>
              <label>Amount (MMK)<input type="number" min="0" step="any" inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="e.g. 300000" /></label>
              <label className="wide">Description<input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Generator spare parts" /></label>
              <label>Supplier<input value={form.supplier_name} onChange={e => setForm({ ...form, supplier_name: e.target.value })} placeholder="e.g. ABC Supplier" /></label>
              <label className="wide">Receipt (photo or PDF)<input key={fileInputKey} type="file" accept="image/*,.pdf" onChange={e => setForm({ ...form, receipt: e.target.files?.[0] || null })} /><small>{form.receipt ? form.receipt.name : form.receipt_file ? 'Receipt already attached. Choose a file only to replace it.' : 'Can be added later, but needed before you submit.'}</small></label>
              <label>Notes<input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder={jobNumber ? `For job ${jobNumber}` : 'Optional'} /></label>
            </div>
            <p className="advx-form-link">Linked to advance <b>{advance.number || row?.[0]}</b> and job order <b>{jobNumber || '—'}</b>.</p>
            {num(form.amount) > 0 && formTotalAfter > amount && <p className="advx-warn">This brings your expenses to {money(formTotalAfter)}, {money(formTotalAfter - amount)} more than the advance. You can still save it. The company reimburses the difference after approval.</p>}
            <div className="advx-form-actions">
              {formDirty && <button className="advx-btn" disabled={busy} onClick={() => { setForm(emptyForm()); setError(''); }}>{form.id ? 'Cancel edit' : 'Clear'}</button>}
              <button className="advx-btn primary" disabled={busy} onClick={() => saveDraft()}><Save size={16} />{busy ? 'Saving…' : form.id ? 'Save changes' : 'Save draft'}</button>
            </div>
            <p className="advx-hint">Save draft keeps the expense here only. Nothing goes to the manager until you click <b>Submit settlement</b>.</p>
          </section>}

          {(drafts.length > 0 || stage >= 4) && <section className={`advx-section advx-settle advx-settle-${settlement.kind}`}>
            <h3>Settlement calculation</h3>
            <dl>
              <div><dt>Advance received</dt><dd>{money(amount)}</dd></div>
              <div><dt>{usesApproved ? 'Approved expenses' : 'Total expenses'}</dt><dd>{money(settlementExpenses)}</dd></div>
              {num(advance.rejected) > 0 && <div className="muted"><dt>Rejected (not counted)</dt><dd>{money(advance.rejected)}</dd></div>}
              <div className="result"><dt>{settlement.label}</dt><dd>{money(settlement.value)}</dd></div>
            </dl>
            <p>{stage >= 6
              ? (num(advance.returned_amount) > 0 ? `Closed. ${money(advance.returned_amount)} was returned to the company.` : num(advance.reimbursed_amount) > 0 ? `Closed. ${money(advance.reimbursed_amount)} was reimbursed to the staff member.` : 'Closed. Fully settled.')
              : settlement.text}</p>
          </section>}

          {canReconcile && <section className="advx-section advx-form">
            <h3>{settlement.kind === 'return' ? 'Record returned cash' : settlement.kind === 'reimburse' ? 'Pay reimbursement' : 'Close advance'}</h3>
            <div className="advx-form-grid">
              <label>Date<input type="date" value={finance.date} onChange={e => setFinance({ ...finance, date: e.target.value })} /></label>
              <label>Method<select value={finance.method} onChange={e => setFinance({ ...finance, method: e.target.value })}><option>Cash</option><option>Bank transfer</option><option>Cheque</option></select></label>
              <label>Reference<input value={finance.reference} onChange={e => setFinance({ ...finance, reference: e.target.value })} placeholder="Receipt / voucher no." /></label>
            </div>
          </section>}

          {error && <p className="advx-error" role="alert">{error}</p>}

          {history.length > 0 && <details className="advx-history"><summary>History ({history.length})</summary><ul>
            {history.map((h, i) => <li key={i}><b>{h.action}</b>{h.amount != null && h.amount !== '' ? ` · ${money(h.amount)}` : ''}{h.note ? ` · ${h.note}` : ''}<small>{h.by ? `${h.by} · ` : ''}{h.at ? new Date(h.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</small></li>)}
          </ul></details>}
        </>}
      </div>

      <footer className="advx-foot">
        <button className="advx-btn" onClick={onClose} disabled={busy}>Close</button>
        {canRecord && <button className="advx-btn primary" disabled={busy || formDirty || !drafts.length} title={formDirty ? 'Save or clear the expense you are typing first' : drafts.length ? '' : 'Save at least one draft first'} onClick={submitSettlement}><Send size={16} />Submit settlement{drafts.length ? ` (${drafts.length} · ${money(draftTotal)})` : ''}</button>}
        {canReview && <><button className="advx-btn" disabled={busy} onClick={() => decide('return')}><CornerUpLeft size={16} />Return to staff</button><button className="advx-btn primary" disabled={busy} onClick={() => decide('approve')}><Check size={16} />Approve settlement</button></>}
        {canReconcile && <button className="advx-btn primary" disabled={busy} onClick={reconcile}><Check size={16} />{settlement.kind === 'return' ? `Record ${money(settlement.value)} returned & close` : settlement.kind === 'reimburse' ? `Pay ${money(settlement.value)} & close` : 'Close advance'}</button>}
      </footer>
    </section>
  </div>;
}

// Plain-language "what happens next" for each stage and viewer.
function nextStep(stage, { isAdmin, readOnly, hasDrafts, reviewNote }) {
  const staff = !readOnly && !isAdmin;
  if (stage === 0) return { tone: 'wait', text: isAdmin ? 'Waiting for approval. Approve or reject this request from the Staff advances list.' : 'Waiting for the manager to approve your request. You can add expenses after finance releases the money.' };
  if (stage === 1) return { tone: 'wait', text: isAdmin ? 'Approved. Use "Release money" in the Staff advances list to record the payment.' : 'Approved. Waiting for finance to release the money. You can add expenses after that.' };
  if (stage === 3) {
    if (reviewNote) return { tone: 'alert', text: `Returned by the manager: ${reviewNote}` };
    return { tone: 'go', text: staff ? (hasDrafts ? 'Keep adding expenses with Save draft. When you are done, click Submit settlement at the bottom.' : 'Add each expense below and click Save draft. When you are done, click Submit settlement.') : 'The staff member is recording expenses. Nothing has been submitted yet.' };
  }
  if (stage === 4) return { tone: 'wait', text: isAdmin ? 'Approve or reject each expense, then click Approve settlement (or Return to staff).' : 'Submitted. The manager is reviewing your expenses. You will be notified.' };
  if (stage === 5) return { tone: 'wait', text: isAdmin ? 'Settlement approved. Record the returned cash or reimbursement below, then close the advance.' : 'Settlement approved. Finance will settle the balance with you.' };
  return { tone: 'done', text: 'This advance is closed.' };
}
