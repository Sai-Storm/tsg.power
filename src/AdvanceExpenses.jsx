import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Camera, Check, CornerUpLeft, Paperclip, Pencil, Save, Send, Trash2, X } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { ReceiptLink, looksLikeFile } from './Attachments.jsx';
import AdvanceTrend from './AdvanceTrend.jsx';
import { confirmDialog, promptDialog } from './components/AskDialog.jsx';
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
const emptyForm = () => ({ id: '', date: todayKey(), category: CATEGORIES[0], supplier_name: '', description: '', amount: '', notes: '', newFiles: [], existingFiles: [], removeFiles: [] });
const isOpen = status => ['issued', 'open', 'partially settled'].includes(lower(status));
const stageOf = status => ({ 'pending approval': 0, approved: 1, issued: 3, open: 3, 'partially settled': 3, 'under review': 4, 'settlement approved': 5, settled: 6, closed: 6 })[lower(status)] ?? 0;
const stageLabel = status => (isOpen(status) ? 'In progress' : status || '—');
const receiptsOf = entry => (Array.isArray(entry.receipt_files) && entry.receipt_files.length ? entry.receipt_files : entry.receipt_file ? [entry.receipt_file] : []);

export default function AdvanceExpensesDialog({ row, readOnly, isAdmin, notify, onClose, onChanged }) {
  const advanceId = row?._id || row?.[0];
  const query = useQuery({
    queryKey: ['advance-expenses', advanceId],
    queryFn: () => apiRequest(`/advances/${encodeURIComponent(advanceId)}/expenses`),
    enabled: Boolean(advanceId),
  });
  const data = query.data;
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
  const missingReceipts = drafts.filter(d => !receiptsOf(d).length).length;
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

  const refresh = async () => { await query.refetch(); onChanged?.(); };
  const run = async (task, success) => {
    setBusy(true); setError('');
    try { await task(); await refresh(); if (success) notify?.(success); return true; }
    catch (e) { setError(e.message || 'Something went wrong.'); return false; }
    finally { setBusy(false); }
  };

  // ---- Staff -----------------------------------------------------------------
  const saveDraft = async () => {
    const value = num(form.amount);
    if (value <= 0) { setError('Enter the amount spent.'); return; }
    if (!form.description.trim()) { setError('Describe what the money was spent on.'); return; }
    const ok = await run(async () => {
      const body = new FormData();
      if (form.id) body.append('id', form.id);
      body.append('date', form.date); body.append('category', form.category); body.append('supplier_name', form.supplier_name.trim());
      body.append('description', form.description.trim()); body.append('amount', String(value)); body.append('notes', form.notes.trim());
      form.newFiles.forEach(file => body.append('receipt_files', file));
      if (form.removeFiles.length) body.append('remove_receipts', JSON.stringify(form.removeFiles));
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/draft`, { method: 'POST', body });
    }, form.id ? 'Draft updated. Nothing has been sent to the manager.' : 'Saved as draft. Nothing has been sent to the manager.');
    if (ok) setForm({ ...emptyForm(), date: form.date, category: form.category });
  };

  const deleteDraft = async entry => {
    if (!await confirmDialog(`Delete the draft "${entry.description}" (${money(entry.amount)})?`, { title: 'Delete draft', confirmLabel: 'Delete', tone: 'danger' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/delete-draft`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id }) });
    }, 'Draft deleted.');
  };

  const submitSettlement = async () => {
    if (!drafts.length) return;
    if (missingReceipts) { setError(`${missingReceipts} expense${missingReceipts === 1 ? ' has' : 's have'} no receipt. Edit ${missingReceipts === 1 ? 'it' : 'them'} and upload the receipt before submitting.`); return; }
    const o = outcome(recorded);
    const tail = o.kind === 'return' ? `\n${money(o.value)} will need to be returned to the company.` : o.kind === 'reimburse' ? `\nYou spent ${money(o.value)} more than the advance. The company will reimburse it after approval.` : '\nThis uses the full advance.';
    if (!await confirmDialog(`Submit the settlement for ${advance?.number || row?.[0]}${jobNumber ? ` (job ${jobNumber})` : ''}?\n\n${drafts.length} expense${drafts.length === 1 ? '' : 's'} · ${money(draftTotal)}\nAdvance received: ${money(amount)}\nTotal expenses: ${money(recorded)}${tail}\n\nAfter submitting you cannot edit these expenses unless the manager returns them.`, { title: 'Submit settlement', confirmLabel: 'Submit to manager' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/submit-settlement`, { method: 'POST', body: JSON.stringify({}) });
    }, 'Settlement submitted to the manager.');
  };

  // ---- Manager ---------------------------------------------------------------
  const reviewExpense = async (entry, decision) => {
    let reason = '';
    if (decision === 'Rejected') { reason = await promptDialog(`Rejecting "${entry.description}" (${money(entry.amount)}). The staff member will see this reason.`, { title: 'Reject expense', label: 'Reason', required: true, multiline: true, defaultValue: entry.rejection_reason || '', confirmLabel: 'Reject expense' }) || ''; if (!reason.trim()) return; }
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/review-expense`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id, decision, reason }) });
    }, `Expense ${decision.toLowerCase()}.`);
  };

  const decide = async decision => {
    let note = '';
    if (decision === 'return') { note = await promptDialog('Tell the staff member what to change. They will be notified.', { title: 'Return to staff', label: 'What should change?', required: true, multiline: true, confirmLabel: 'Return settlement' }) || ''; if (!note.trim()) return; }
    else if (!await confirmDialog(`Approve the settlement for ${advance?.number}?\n\nEvery expense that is not rejected will be approved.`, { title: 'Approve settlement', confirmLabel: 'Approve settlement' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) });
    }, decision === 'approve' ? 'Settlement approved. Finance can now reconcile it.' : 'Settlement returned to the staff member.');
  };

  // ---- Finance ---------------------------------------------------------------
  const reconcile = async () => {
    const o = outcome(approved);
    const action = o.kind === 'return' ? `Record ${money(o.value)} returned by staff and close` : o.kind === 'reimburse' ? `Pay ${money(o.value)} to staff and close` : 'Close the fully settled advance';
    if (!await confirmDialog(`${action}?\n\nThis posts to the cash book against job ${jobNumber || '—'} and closes the advance.`, { title: 'Close advance', confirmLabel: 'Record and close' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/reconcile`, { method: 'POST', body: JSON.stringify(finance) });
    }, 'Advance closed.');
  };

  const openEdit = entry => { setError(''); setForm({ ...emptyForm(), id: String(entry.id), date: String(entry.date || '').slice(0, 10) || todayKey(), category: entry.category || CATEGORIES[0], supplier_name: entry.supplier_name || '', description: entry.description || '', notes: entry.notes || '', amount: String(num(entry.amount)), existingFiles: receiptsOf(entry) }); };
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
        {query.isLoading && <p className="advx-muted">Loading…</p>}
        {query.isError && <p className="advx-error">{query.error?.message}</p>}
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
                  <div className="advx-item-receipt">{receiptsOf(entry).length
                    ? receiptsOf(entry).map((file, index) => (looksLikeFile(file)
                      ? <ReceiptLink key={file} url={file} name={`Receipt ${index + 1} · ${entry.description || entry.number || ''}`} />
                      : <span key={file} className="advx-receipt"><Paperclip size={14} />Receipt {index + 1}</span>))
                    : <span className="advx-missing">No receipt yet</span>}</div>
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
              <div className="wide advx-receipts-field">
                <span className="advx-field-label">Receipts (photos or PDF)</span>
                <div className="advx-receipt-buttons">
                  <label className="advx-btn small"><Paperclip size={14} />Choose files<input key={`pick-${fileInputKey}`} type="file" multiple accept="image/*,.pdf" onChange={e => { const picked = Array.from(e.target.files || []); setForm(old => ({ ...old, newFiles: [...old.newFiles, ...picked] })); }} /></label>
                  <label className="advx-btn small"><Camera size={14} />Take photo<input key={`cam-${fileInputKey}`} type="file" accept="image/*" capture="environment" onChange={e => { const picked = Array.from(e.target.files || []); setForm(old => ({ ...old, newFiles: [...old.newFiles, ...picked] })); }} /></label>
                </div>
                {(form.existingFiles.length - form.removeFiles.length + form.newFiles.length) > 0
                  ? <ul className="advx-receipt-list">
                    {form.existingFiles.filter(file => !form.removeFiles.includes(file)).map((file, index) => <li key={file}><span>Saved receipt {index + 1}</span><button type="button" onClick={() => setForm(old => ({ ...old, removeFiles: [...old.removeFiles, file] }))}>Remove</button></li>)}
                    {form.newFiles.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" onClick={() => setForm(old => ({ ...old, newFiles: old.newFiles.filter((_, i) => i !== index) }))}>Remove</button></li>)}
                  </ul>
                  : <small>Add one or more receipts. You can add them later, but they are needed before you submit.</small>}
              </div>
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
