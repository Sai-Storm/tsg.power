import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, Camera, Check, CloudOff, CornerUpLeft, Paperclip, Pencil, Save, Send, Trash2, X } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { ReceiptLink, looksLikeFile } from './Attachments.jsx';
import { confirmDialog, promptDialog } from './components/AskDialog.jsx';
import { flushOfflineDrafts, isOfflineError, offlineDrafts, onOfflineDraftsChanged, removeOfflineDraft, saveOfflineDraft } from './lib/offlineDrafts.js';
import './advance.css';

// One window for the whole life of a staff advance, always tied to its job order:
//   Staff    record expenses as drafts (nothing is sent) -> submit to manager
//   Manager  approve / reject each expense -> approve settlement or return it
//   Finance  record returned cash or pay the extra -> close the advance
// The Admin role acts as Manager and Finance.
// An expense claim (kind 'Claim') is the same window with an advance of 0: the
// staff member paid with their own money and is reimbursed the approved total.

const CATEGORIES = ['SKU / Materials', 'Spare parts', 'Transportation', 'Fuel', 'Meals', 'Accommodation', 'Tools', 'Office', 'Other'];
const num = value => { const n = Number(String(value ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const money = value => `${num(value).toLocaleString('en-US', { maximumFractionDigits: 2 })} MMK`;
const lower = value => String(value || '').toLowerCase();
const isDraft = entry => lower(entry.status) === 'draft';
const todayKey = () => new Date().toISOString().slice(0, 10);
const shortDate = value => { if (!value) return ''; const d = new Date(`${String(value).slice(0, 10)}T00:00:00`); return Number.isNaN(d.valueOf()) ? String(value) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const statusClass = status => `advx-status advx-status-${lower(status || 'draft').replace(/[^a-z]+/g, '-')}`;
// supplier_name / notes are no longer asked for, but kept so editing a draft never wipes them.
const emptyForm = () => ({ id: '', date: todayKey(), category: CATEGORIES[0], supplier_name: '', description: '', amount: '', notes: '', exception_reason: '', newFiles: [], existingFiles: [], removeFiles: [] });
const isOpen = status => ['issued', 'open', 'partially settled'].includes(lower(status));
const stageOf = status => ({ 'pending approval': 0, approved: 1, issued: 3, open: 3, 'partially settled': 3, 'under review': 4, 'settlement approved': 5, settled: 6, closed: 6, cancelled: 6 })[lower(status)] ?? 0;
const stageLabel = status => (isOpen(status) ? 'In progress' : status || '—');
const hasReason = entry => Boolean(String(entry?.exception_reason || '').trim());
const receiptsOf = entry => (Array.isArray(entry.receipt_files) && entry.receipt_files.length ? entry.receipt_files : entry.receipt_file ? [entry.receipt_file] : []);

export default function AdvanceExpensesDialog({ row, readOnly, isAdmin, isFinance = isAdmin, notify, onClose, onChanged }) {
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
  const [waiting, setWaiting] = useState([]); // expenses saved offline on this device

  useEffect(() => {
    let alive = true;
    const load = () => offlineDrafts(advanceId).then(list => { if (alive) setWaiting(list); });
    const uploaded = () => { load(); query.refetch(); };
    load();
    const stop = onOfflineDraftsChanged(load);
    window.addEventListener('tsg-offline-uploaded', uploaded);
    return () => { alive = false; stop(); window.removeEventListener('tsg-offline-uploaded', uploaded); };
  }, [advanceId]);

  const amount = num(advance?.amount);
  const draftTotal = num(advance?.drafts);
  const approved = num(advance?.approved);
  const recorded = num(advance?.recorded ?? draftTotal + num(advance?.claimed));
  const status = advance?.status || '';
  const stage = stageOf(status);
  const canRecord = !readOnly && Boolean(advance?.can_record);
  const canReview = Boolean(isAdmin && advance?.can_review);
  const canReconcile = Boolean(isFinance && advance?.can_reconcile);
  const jobNumber = advance?.job_number && advance.job_number !== '—' ? advance.job_number : '';
  const isClaim = advance?.kind === 'Claim';
  const noun = isClaim ? 'claim' : 'advance';
  const missingReceipts = drafts.filter(d => !receiptsOf(d).length && !hasReason(d)).length;
  const canCancel = canRecord && isClaim && !entries.some(e => !['draft', 'rejected'].includes(lower(e.status))) && !waiting.length;
  const editingAmount = form?.id ? num(drafts.find(d => String(d.id) === form.id)?.amount) : 0;
  const formTotalAfter = recorded - editingAmount + num(form?.amount);

  // Staff see the balance on everything recorded; manager/finance on approved.
  const outcome = expenses => {
    const diff = amount - expenses;
    if (diff > 0) return { kind: 'return', value: diff };
    if (diff < 0) return { kind: 'reimburse', value: -diff };
    return { kind: 'even', value: 0 };
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
    if (!form.description.trim()) { setError('Write what the money was spent on.'); return; }
    if (value <= 0) { setError('Enter the amount spent.'); return; }
    const fields = { date: form.date, category: form.category, supplier_name: form.supplier_name.trim(), description: form.description.trim(), amount: String(value), notes: form.notes.trim(), exception_reason: form.exception_reason.trim() };
    const keepOnDevice = async () => {
      await saveOfflineDraft(advanceId, fields, form.newFiles);
      setForm({ ...emptyForm(), date: form.date, category: form.category });
      setError('');
      notify?.('No connection. The expense is saved on this device and will upload automatically.');
    };
    // New expenses can be saved without a connection; edits need one.
    if (!form.id && typeof navigator !== 'undefined' && navigator.onLine === false) { await keepOnDevice(); return; }
    let offline = false;
    const ok = await run(async () => {
      const body = new FormData();
      if (form.id) body.append('id', form.id);
      Object.entries(fields).forEach(([key, val]) => body.append(key, val));
      form.newFiles.forEach(file => body.append('receipt_files', file));
      if (form.removeFiles.length) body.append('remove_receipts', JSON.stringify(form.removeFiles));
      try {
        await apiRequest(`/advances/${encodeURIComponent(advanceId)}/draft`, { method: 'POST', body });
      } catch (e) {
        if (!form.id && isOfflineError(e)) { offline = true; return; }
        throw e;
      }
    }, form.id ? 'Expense updated.' : 'Expense saved as draft.');
    if (offline) { await keepOnDevice(); return; }
    if (ok) setForm({ ...emptyForm(), date: form.date, category: form.category });
  };

  const discardWaiting = async item => {
    if (!await confirmDialog(`Delete "${item.fields?.description}" saved on this device? It has not been uploaded.`, { title: 'Delete expense', confirmLabel: 'Delete', tone: 'danger' })) return;
    await removeOfflineDraft(item.key);
  };

  const deleteDraft = async entry => {
    if (!await confirmDialog(`Delete "${entry.description}" (${money(entry.amount)})?`, { title: 'Delete expense', confirmLabel: 'Delete', tone: 'danger' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/delete-draft`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id }) });
    }, 'Expense deleted.');
  };

  const submitSettlement = async () => {
    if (!drafts.length) return;
    if (missingReceipts) { setError(`${missingReceipts} expense${missingReceipts === 1 ? ' has' : 's have'} no receipt. Edit ${missingReceipts === 1 ? 'it' : 'them'} and add the receipt, or explain why there is none.`); return; }
    const o = outcome(recorded);
    const tail = o.kind === 'return' ? `You return ${money(o.value)}.` : o.kind === 'reimburse' ? `The company owes you ${money(o.value)}.` : 'The advance is fully used.';
    const summary = isClaim ? `Claim total ${money(recorded)}. Finance pays you once the manager approves it.` : `Advance ${money(amount)} · spent ${money(recorded)}\n${tail}`;
    if (!await confirmDialog(`Send ${drafts.length} expense${drafts.length === 1 ? '' : 's'} (${money(draftTotal)}) to the manager?\n\n${summary}\n\nYou cannot edit them after sending unless the manager returns them.`, { title: 'Submit to manager', confirmLabel: 'Submit' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/submit-settlement`, { method: 'POST', body: JSON.stringify({}) });
    }, 'Sent to the manager.');
  };

  const cancelClaim = async () => {
    if (!await confirmDialog(`Cancel ${advance?.number}? ${drafts.length ? `Its ${drafts.length} draft expense${drafts.length === 1 ? '' : 's'} will be deleted.` : ''}`.trim(), { title: 'Cancel claim', confirmLabel: 'Cancel claim', tone: 'danger' })) return;
    const ok = await run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/cancel-claim`, { method: 'POST', body: JSON.stringify({}) });
    }, 'Claim cancelled.');
    if (ok) onClose();
  };

  // ---- Manager ---------------------------------------------------------------
  const reviewExpense = async (entry, decision) => {
    let reason = '';
    if (decision === 'Rejected') { reason = await promptDialog(`Reject "${entry.description}" (${money(entry.amount)}). The staff member will see the reason.`, { title: 'Reject expense', label: 'Reason', required: true, multiline: true, defaultValue: entry.rejection_reason || '', confirmLabel: 'Reject' }) || ''; if (!reason.trim()) return; }
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/review-expense`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id, decision, reason }) });
    }, `Expense ${decision.toLowerCase()}.`);
  };

  const decide = async decision => {
    let note = '';
    if (decision === 'return') { note = await promptDialog('Tell the staff member what to change.', { title: 'Return to staff', label: 'What should change?', required: true, multiline: true, confirmLabel: 'Return' }) || ''; if (!note.trim()) return; }
    else if (!await confirmDialog(`Approve ${advance?.number}? Every expense that is not rejected will be approved.`, { title: 'Approve settlement', confirmLabel: 'Approve' })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) });
    }, decision === 'approve' ? 'Settlement approved.' : 'Returned to the staff member.');
  };

  // ---- Finance ---------------------------------------------------------------
  const reconcile = async () => {
    const o = outcome(approved);
    const action = o.kind === 'return' ? `Record ${money(o.value)} returned by staff` : o.kind === 'reimburse' ? `Pay ${money(o.value)} to staff` : `Close this ${noun}`;
    if (!await confirmDialog(`${action} and close the ${noun}?\n\nThis posts to the cash book${jobNumber ? ` against job ${jobNumber}` : ''}.`, { title: `Close ${noun}`, confirmLabel: `Close ${noun}` })) return;
    run(async () => {
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/reconcile`, { method: 'POST', body: JSON.stringify(finance) });
    }, isClaim ? 'Claim paid and closed.' : 'Advance closed.');
  };

  const openEdit = entry => { setError(''); setForm({ ...emptyForm(), id: String(entry.id), date: String(entry.date || '').slice(0, 10) || todayKey(), category: entry.category || CATEGORIES[0], supplier_name: entry.supplier_name || '', description: entry.description || '', notes: entry.notes || '', exception_reason: entry.exception_reason || '', amount: String(num(entry.amount)), existingFiles: receiptsOf(entry) }); };
  const addFiles = event => { const picked = Array.from(event.target.files || []); setForm(old => ({ ...old, newFiles: [...old.newFiles, ...picked] })); };
  const showActions = canRecord || canReview;
  const formDirty = Boolean(form.id || form.description.trim() || String(form.amount).trim());
  const next = nextStep(stage, { isAdmin, isFinance, readOnly, hasDrafts: drafts.length > 0, reviewNote: advance?.review_note, isClaim });
  const fileInputKey = `${form.id || 'new'}-${entries.length}`;
  const formFiles = form.existingFiles.length - form.removeFiles.length + form.newFiles.length;
  const balanceLabel = stage >= 6 ? 'Result' : settlement.kind === 'return' ? 'To return' : settlement.kind === 'reimburse' ? 'To reimburse' : 'Balance';
  const balanceTone = stage >= 6 || settlement.kind === 'even' ? 'green' : settlement.kind === 'return' ? 'amber' : 'red';

  return <div className="modal-backdrop advx-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal advx-modal" role="dialog" aria-label={`${isClaim ? 'Expense claim' : 'Advance'} ${row?.[0]}`}>
      <header className="advx-head">
        <div className="advx-head-main">
          <div className="advx-title"><h2>{advance?.number || row?.[0]}</h2>{advance && <span className={statusClass(isOpen(status) ? 'in progress' : status)}>{stageLabel(status)}</span>}{isClaim && <span className="advx-status advx-status-claim">Expense claim</span>}</div>
          <p className="advx-sub">
            <Briefcase size={15} />{isClaim && !jobNumber ? <b>Office expenses (no job order)</b> : <>Job <b>{jobNumber || 'not linked'}</b></>}
            {advance?.staff_name && advance.staff_name !== '—' && <> · {advance.staff_name}</>}
            {advance?.purpose && advance.purpose !== '—' && <> · {advance.purpose}</>}
          </p>
        </div>
        <button className="advx-close" onClick={onClose} aria-label="Close dialog" disabled={busy}><X size={20} /></button>
      </header>

      <div className="advx-body">
        {query.isLoading && <p className="advx-muted">Loading…</p>}
        {query.isError && <p className="advx-error">{query.error?.message}</p>}
        {advance && <>
          <p className={`advx-next advx-next-${next.tone}`}>{next.text}</p>

          <section className="advx-tiles">
            {!isClaim && <div className="advx-tile"><span>Advance</span><b>{money(amount)}</b></div>}
            <div className="advx-tile blue"><span>{usesApproved ? 'Approved spending' : 'Spent'}</span><b>{money(settlementExpenses)}</b></div>
            <div className={`advx-tile ${balanceTone}`}><span>{balanceLabel}</span><b>{stage >= 6 ? closedText(advance) : money(settlement.value)}</b></div>
          </section>

          <section className="advx-section">
            <h3>Expenses <small>{entries.length}</small></h3>
            {!entries.length && !waiting.length && <p className="advx-empty">No expenses yet.{canRecord ? ' Add one below.' : ''}</p>}
            <ul className="advx-list">
              {waiting.map(item => <li key={`offline-${item.key}`} className="is-draft is-offline">
                <div className="advx-item-main">
                  <div className="advx-item-top"><b>{item.fields?.description}</b><span className="advx-status advx-status-offline"><CloudOff size={13} />{item.error ? 'Not uploaded' : 'Waiting to upload'}</span></div>
                  <div className="advx-item-meta"><span>{[shortDate(item.fields?.date), item.fields?.category].filter(Boolean).join(' · ')}</span><span>{item.files?.length ? `${item.files.length} receipt${item.files.length === 1 ? '' : 's'} on this device` : <span className="advx-missing">No receipt</span>}</span></div>
                  {item.error && <div className="advx-item-reason">{item.error}</div>}
                </div>
                <div className="advx-item-side">
                  <b className="advx-item-amount">{money(item.fields?.amount)}</b>
                  <div className="advx-item-actions">
                    <button className="advx-btn small" disabled={busy} onClick={() => flushOfflineDrafts().then(() => offlineDrafts(advanceId).then(setWaiting))}>Retry</button>
                    <button className="advx-btn small danger" disabled={busy} onClick={() => discardWaiting(item)} aria-label="Delete expense" title="Delete"><Trash2 size={14} /></button>
                  </div>
                </div>
              </li>)}
              {entries.map(entry => {
                const draft = isDraft(entry);
                const reviewable = ['submitted', 'approved', 'rejected'].includes(lower(entry.status));
                const files = receiptsOf(entry);
                return <li key={entry.id} className={`${draft ? 'is-draft' : ''} ${form.id === String(entry.id) ? 'is-editing' : ''}`}>
                  <div className="advx-item-main">
                    <div className="advx-item-top"><b>{entry.description}</b><span className={statusClass(entry.status)}>{entry.status}</span></div>
                    <div className="advx-item-meta">
                      <span>{[shortDate(entry.date), entry.category].filter(Boolean).join(' · ')}</span>
                      {files.length
                        ? files.map((file, index) => (looksLikeFile(file)
                          ? <ReceiptLink key={file} url={file} name={`Receipt ${index + 1} · ${entry.description || entry.number || ''}`} />
                          : <span key={file} className="advx-receipt"><Paperclip size={14} />Receipt {index + 1}</span>))
                        : hasReason(entry) ? <span className="advx-receipt">No receipt: {entry.exception_reason}</span> : <span className="advx-missing">No receipt</span>}
                    </div>
                    {entry.rejection_reason && <div className="advx-item-reason">Rejected: {entry.rejection_reason}</div>}
                  </div>
                  <div className="advx-item-side">
                    <b className="advx-item-amount">{money(entry.amount)}</b>
                    {showActions && <div className="advx-item-actions">
                      {draft && canRecord && <><button className="advx-btn small" disabled={busy} onClick={() => openEdit(entry)}><Pencil size={14} />Edit</button><button className="advx-btn small danger" disabled={busy} onClick={() => deleteDraft(entry)} aria-label="Delete expense" title="Delete"><Trash2 size={14} /></button></>}
                      {canReview && reviewable && <><button className="advx-btn small ok" disabled={busy || lower(entry.status) === 'approved'} onClick={() => reviewExpense(entry, 'Approved')}><Check size={14} />Approve</button><button className="advx-btn small danger" disabled={busy} onClick={() => reviewExpense(entry, 'Rejected')}><X size={14} />Reject</button></>}
                    </div>}
                  </div>
                </li>;
              })}
            </ul>
          </section>

          {canRecord && <section className="advx-section advx-form">
            <h3>{form.id ? 'Edit expense' : 'Add expense'}</h3>
            <div className="advx-form-grid">
              <label className="wide">What was it for?<input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Generator spare parts" /></label>
              <label>Amount (MMK)<input type="number" min="0" step="any" inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="e.g. 300000" /></label>
              <label>Date<input type="date" value={form.date} max={todayKey()} onChange={e => setForm({ ...form, date: e.target.value })} /></label>
              <label>Category<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{[...new Set([...CATEGORIES, form.category])].map(c => <option key={c}>{c}</option>)}</select></label>
              <div className="advx-receipts-field">
                <span className="advx-field-label">Receipt</span>
                <div className="advx-receipt-buttons">
                  <label className="advx-btn small"><Paperclip size={14} />File<input key={`pick-${fileInputKey}`} type="file" multiple accept="image/*,.pdf" onChange={addFiles} /></label>
                  <label className="advx-btn small"><Camera size={14} />Photo<input key={`cam-${fileInputKey}`} type="file" accept="image/*" capture="environment" onChange={addFiles} /></label>
                </div>
              </div>
              {formFiles > 0 && <ul className="advx-receipt-list advx-full">
                {form.existingFiles.filter(file => !form.removeFiles.includes(file)).map((file, index) => <li key={file}><span>Saved receipt {index + 1}</span><button type="button" onClick={() => setForm(old => ({ ...old, removeFiles: [...old.removeFiles, file] }))}>Remove</button></li>)}
                {form.newFiles.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" onClick={() => setForm(old => ({ ...old, newFiles: old.newFiles.filter((_, i) => i !== index) }))}>Remove</button></li>)}
              </ul>}
              {formFiles === 0 && <label className="wide">No receipt? Say why<input value={form.exception_reason} onChange={e => setForm({ ...form, exception_reason: e.target.value })} placeholder="e.g. Street taxi, no receipt given" /></label>}
            </div>
            {!isClaim && num(form.amount) > 0 && formTotalAfter > amount && <p className="advx-warn">This is {money(formTotalAfter - amount)} over the advance. The company reimburses it after approval.</p>}
            <div className="advx-form-actions">
              {formDirty && <button className="advx-btn" disabled={busy} onClick={() => { setForm(emptyForm()); setError(''); }}>{form.id ? 'Cancel' : 'Clear'}</button>}
              <button className="advx-btn primary" disabled={busy} onClick={saveDraft}><Save size={16} />{busy ? 'Saving…' : form.id ? 'Save changes' : 'Save draft'}</button>
            </div>
          </section>}

          {canReconcile && <section className="advx-section advx-form">
            <h3>{settlement.kind === 'return' ? 'Record returned cash' : settlement.kind === 'reimburse' ? 'Pay reimbursement' : `Close ${noun}`}</h3>
            <div className="advx-form-grid">
              <label>Date<input type="date" value={finance.date} onChange={e => setFinance({ ...finance, date: e.target.value })} /></label>
              <label>Method<select value={finance.method} onChange={e => setFinance({ ...finance, method: e.target.value })}><option>Cash</option><option>Bank transfer</option><option>Cheque</option></select></label>
              <label>Reference<input value={finance.reference} onChange={e => setFinance({ ...finance, reference: e.target.value })} placeholder="Voucher no. (optional)" /></label>
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
        {canCancel && <button className="advx-btn danger" disabled={busy} onClick={cancelClaim}><Trash2 size={16} />Cancel claim</button>}
        {canRecord && <button className="advx-btn primary" disabled={busy || formDirty || !drafts.length || waiting.length > 0} title={waiting.length ? 'Some expenses are still on this device. Upload them first.' : formDirty ? 'Save or clear the expense you are typing first' : drafts.length ? '' : 'Save at least one expense first'} onClick={submitSettlement}><Send size={16} />Submit to manager{drafts.length ? ` (${drafts.length})` : ''}</button>}
        {canReview && <><button className="advx-btn" disabled={busy} onClick={() => decide('return')}><CornerUpLeft size={16} />Return to staff</button><button className="advx-btn primary" disabled={busy} onClick={() => decide('approve')}><Check size={16} />Approve settlement</button></>}
        {canReconcile && <button className="advx-btn primary" disabled={busy} onClick={reconcile}><Check size={16} />{settlement.kind === 'return' ? `Record ${money(settlement.value)} returned & close` : settlement.kind === 'reimburse' ? `Pay ${money(settlement.value)} & close` : `Close ${noun}`}</button>}
      </footer>
    </section>
  </div>;
}

function closedText(advance) {
  if (lower(advance.status) === 'cancelled') return 'Cancelled';
  if (num(advance.returned_amount) > 0) return `${money(advance.returned_amount)} returned`;
  if (num(advance.reimbursed_amount) > 0) return `${money(advance.reimbursed_amount)} reimbursed`;
  return 'Fully settled';
}

// One short line: what happens next, for this viewer.
function nextStep(stage, { isAdmin, isFinance, readOnly, hasDrafts, reviewNote, isClaim }) {
  const staff = !readOnly;
  if (stage === 0) return { tone: 'wait', text: isAdmin ? 'Waiting for approval. Approve it from the advances list.' : 'Waiting for manager approval.' };
  if (stage === 1) return { tone: 'wait', text: isFinance ? 'Approved. Release the money from the advances list.' : 'Approved. Waiting for finance to release the money.' };
  if (stage === 3) {
    if (reviewNote) return { tone: 'alert', text: `Returned by the manager: ${reviewNote}` };
    return { tone: 'go', text: staff ? (hasDrafts ? 'Add more expenses, or press Submit to manager when you are done.' : isClaim ? 'Add each expense you paid, with its receipt, and press Save draft.' : 'Add each expense and press Save draft.') : 'Staff is recording expenses.' };
  }
  if (stage === 4) return { tone: 'wait', text: isAdmin ? 'Approve or reject each expense, then approve the settlement.' : staff ? 'Submitted. The manager is reviewing it.' : 'The manager is reviewing the settlement.' };
  if (stage === 5) return { tone: 'wait', text: isFinance ? (isClaim ? 'Approved. Pay the staff member below to close.' : 'Approved. Settle the balance below to close.') : (isClaim ? 'Approved. Finance will pay you.' : 'Approved. Finance will settle the balance with you.') };
  return { tone: 'done', text: 'Closed.' };
}
