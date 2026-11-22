import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip, Pencil, Send, Trash2, Upload, X } from 'lucide-react';
import { apiRequest } from './api/client.js';
import { ReceiptLink, looksLikeFile } from './Attachments.jsx';
import './advance.css';

// One place for staff to account for an advance: upload the details of what
// they spent (saved as drafts, with receipts) and submit them all to the admin
// when they are done.

const CATEGORIES = ['Materials', 'Job', 'Travel', 'Fuel', 'Meals', 'Accommodation', 'Office', 'Other'];
const num = value => { const n = Number(String(value ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const money = value => `${num(value).toLocaleString('en-US', { maximumFractionDigits: 2 })} MMK`;
const isDraft = entry => String(entry.status || '').toLowerCase() === 'draft';
const todayKey = () => new Date().toISOString().slice(0, 10);
const shortDate = value => { if (!value) return '—'; const d = new Date(`${String(value).slice(0, 10)}T00:00:00`); return Number.isNaN(d.valueOf()) ? String(value) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const statusClass = status => `advx-status advx-status-${String(status || 'draft').toLowerCase().replace(/[^a-z]+/g, '-')}`;
const emptyForm = () => ({ id: '', date: todayKey(), category: 'Materials', supplier_name: '', description: '', amount: '', receipt: null, receipt_file: '' });

// ---- Demo mode (no Supabase): keep drafts in localStorage -------------------
const DEMO_KEY = 'tsg-demo-advance-expenses';
const demoStore = () => JSON.parse(localStorage.getItem(DEMO_KEY) || '{}');
const demoSave = store => localStorage.setItem(DEMO_KEY, JSON.stringify(store));
function demoData(row, columns) {
  const col = name => row[columns.findIndex(column => column.toLowerCase() === name)];
  const entries = demoStore()[row[0]] || [];
  const amount = num(col('amount'));
  const claimed = Math.max(num(col('claimed')), entries.filter(e => !isDraft(e)).reduce((s, e) => s + num(e.amount), 0));
  const drafts = entries.filter(isDraft).reduce((s, e) => s + num(e.amount), 0);
  return { advance: { number: row[0], purpose: col('purpose'), status: col('status') || 'Issued', amount, claimed, drafts, remaining: Math.max(amount - claimed - drafts, 0), can_record: true }, entries };
}

export default function AdvanceExpensesDialog({ row, columns, isDemo, readOnly, notify, onClose, onChanged }) {
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
  const drafts = entries.filter(isDraft);

  const [form, setForm] = useState(null); // null = closed, otherwise the draft being added / edited
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const amount = num(advance?.amount); const claimed = num(advance?.claimed); const draftTotal = num(advance?.drafts); const remaining = num(advance?.remaining);
  const editingAmount = form?.id ? num(drafts.find(d => String(d.id) === form.id)?.amount) : 0;
  const room = remaining + editingAmount;
  const canRecord = !readOnly && advance?.can_record;
  const toSubmit = drafts;
  const toSubmitTotal = toSubmit.reduce((s, d) => s + num(d.amount), 0);
  const missingReceipts = toSubmit.filter(d => !d.receipt_file).length;
  const pct = value => (amount ? `${Math.min(100, (value / amount) * 100)}%` : '0%');

  const refresh = async () => { if (isDemo) setDemoTick(t => t + 1); else await query.refetch(); onChanged?.(); };
  const run = async (task, success) => {
    setBusy(true); setError('');
    try { await task(); await refresh(); if (success) notify?.(success); return true; }
    catch (e) { setError(e.message || 'Something went wrong.'); return false; }
    finally { setBusy(false); }
  };

  const saveDraft = async () => {
    const value = num(form.amount);
    if (value <= 0) { setError('Enter the amount spent.'); return; }
    if (!form.description.trim()) { setError('Describe what the money was spent on.'); return; }
    if (value > room) { setError(`That is ${money(value - room)} more than this advance has left (${money(room)}). Record the extra as a normal expense claim (paid by you).`); return; }
    const ok = await run(async () => {
      if (isDemo) {
        const store = demoStore(); const list = store[row[0]] || [];
        const record = { id: form.id || `D-${Date.now()}`, number: form.id ? list.find(e => e.id === form.id)?.number : `EXP-DEMO-${list.length + 1}`, date: form.date, category: form.category, supplier_name: form.supplier_name, description: form.description.trim(), amount: value, status: 'Draft', receipt_file: form.receipt ? form.receipt.name : form.receipt_file };
        store[row[0]] = form.id ? list.map(e => (e.id === form.id ? record : e)) : [...list, record];
        demoSave(store); return;
      }
      const body = new FormData();
      if (form.id) body.append('id', form.id);
      body.append('date', form.date); body.append('category', form.category); body.append('supplier_name', form.supplier_name.trim());
      body.append('description', form.description.trim()); body.append('amount', String(value));
      if (form.receipt) body.append('receipt_file', form.receipt);
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/draft`, { method: 'POST', body });
    }, form.id ? 'Detail updated. It has not been sent to the admin yet.' : 'Detail uploaded. Press "Submit to admin" when you are done.');
    if (ok) setForm(null);
  };

  const deleteDraft = entry => {
    if (!window.confirm(`Delete the draft "${entry.description}" (${money(entry.amount)})?`)) return;
    run(async () => {
      if (isDemo) { const store = demoStore(); store[row[0]] = (store[row[0]] || []).filter(e => e.id !== entry.id); demoSave(store); return; }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/delete-draft`, { method: 'POST', body: JSON.stringify({ expense_id: entry.id }) });
    }, 'Draft deleted.');
  };

  const submit = () => {
    if (!toSubmit.length) return;
    if (missingReceipts) { setError(`${missingReceipts} draft${missingReceipts === 1 ? ' has' : 's have'} no receipt. Edit ${missingReceipts === 1 ? 'it' : 'them'} and attach the receipt before submitting.`); return; }
    const left = amount - claimed - toSubmitTotal;
    if (!window.confirm(`Submit ${toSubmit.length} expense${toSubmit.length === 1 ? '' : 's'} totalling ${money(toSubmitTotal)} to the admin?\n\nAfter submitting they can no longer be edited.${left > 0 ? `\n${money(left)} of the advance will still be open.` : '\nThis fully accounts for the advance.'}`)) return;
    run(async () => {
      if (isDemo) { const ids = new Set(toSubmit.map(d => d.id)); const store = demoStore(); store[row[0]] = (store[row[0]] || []).map(e => (ids.has(e.id) ? { ...e, status: 'Submitted' } : e)); demoSave(store); return; }
      await apiRequest(`/advances/${encodeURIComponent(advanceId)}/submit-drafts`, { method: 'POST', body: JSON.stringify({ ids: null }) });
    }, `${toSubmit.length} expense${toSubmit.length === 1 ? '' : 's'} submitted to the admin.`);
  };


  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal advx-modal" role="dialog" aria-label={`Expenses for advance ${row?.[0]}`}>
      <div className="modal-header"><div><div className="eyebrow">ADVANCE · {advance?.number || row?.[0]}</div><h2>Advance details</h2>{advance?.purpose && <p className="advx-purpose">{advance.purpose}{advance.job_number ? ` · ${advance.job_number}` : ''}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog" disabled={busy}><X size={18} /></button></div>

      <div className="advx-body">
        {!isDemo && query.isLoading && <p className="advx-muted">Loading…</p>}
        {!isDemo && query.isError && <p className="advx-error">{query.error?.message}</p>}
        {advance && <>
          <div className="advx-summary">
            <div className="advx-total"><span>Total advance received</span><b>{money(amount)}</b><small>Status: {advance.status}</small></div>
            <div className="advx-figure submitted"><span>Submitted</span><b>{money(claimed)}</b></div>
            <div className="advx-figure drafts"><span>Saved as draft (not submitted)</span><b>{money(draftTotal)}</b></div>
            <div className="advx-figure remaining"><span>Not yet accounted for</span><b>{money(remaining)}</b></div>
          </div>
          <div className="advx-bar" aria-hidden="true"><i className="submitted" style={{ width: pct(claimed) }} /><i className="drafts" style={{ width: pct(draftTotal) }} /></div>
          {draftTotal > 0 && <div className="advx-callout">{remaining <= 0
            ? <><b>The whole advance is accounted for in drafts.</b> Nothing has been sent yet. Press <b>Submit to admin</b> when you are done.</>
            : <><b>{money(draftTotal)} saved as draft and not submitted.</b> You can keep uploading details and press <b>Submit to admin</b> when you are done.</>}</div>}

          <h3 className="advx-section-title">Uploaded details</h3>
          <div className="advx-table-wrap"><table className="advx-table">
            <thead><tr><th>Date</th><th>Expense entry</th><th>Receipt</th><th className="num">Amount</th><th>Status</th>{!readOnly && <th />}</tr></thead>
            <tbody>
              {entries.map(entry => { const draft = isDraft(entry); return <tr key={entry.id} className={draft ? 'is-draft' : ''}>
                <td className="advx-date">{shortDate(entry.date)}</td>
                <td><b>{entry.description}</b><small>{[entry.category, entry.supplier_name, entry.number].filter(Boolean).join(' · ')}</small></td>
                <td>{entry.receipt_file ? (looksLikeFile(entry.receipt_file) ? <ReceiptLink url={entry.receipt_file} name={`Receipt · ${entry.description || entry.number || ''}`} /> : <span className="advx-receipt"><Paperclip size={13} />Attached</span>) : <span className="advx-missing">Missing</span>}</td>
                <td className="num">{money(entry.amount)}</td>
                <td><span className={statusClass(entry.status)}>{entry.status}</span></td>
                {!readOnly && <td className="advx-row-actions">{draft && canRecord && <><button className="row-action-button" disabled={busy} onClick={() => { setError(''); setForm({ ...emptyForm(), id: String(entry.id), date: String(entry.date || '').slice(0, 10) || todayKey(), category: entry.category || 'Materials', supplier_name: entry.supplier_name || '', description: entry.description || '', amount: String(num(entry.amount)), receipt_file: entry.receipt_file || '' }); }} aria-label="Edit draft"><Pencil size={13} /></button><button className="row-action-button danger" disabled={busy} onClick={() => deleteDraft(entry)} aria-label="Delete draft"><Trash2 size={13} /></button></>}</td>}
              </tr>; })}
              {!entries.length && <tr><td colSpan={readOnly ? 5 : 6} className="advx-empty">No expenses recorded against this advance yet.</td></tr>}
            </tbody>
            {entries.length > 0 && <tfoot><tr><td colSpan={3}>Total</td><td className="num">{money(entries.reduce((s, e) => s + (/rejected/i.test(e.status) ? 0 : num(e.amount)), 0))}</td><td colSpan={readOnly ? 1 : 2} /></tr></tfoot>}
          </table></div>

          {form && <div className="advx-form">
            <h3>{form.id ? 'Edit advance detail' : 'Upload advance detail (saved as draft)'}</h3>
            <div className="advx-form-grid">
              <label>Date<input type="date" value={form.date} max={todayKey()} onChange={e => setForm({ ...form, date: e.target.value })} /></label>
              <label>Category<select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
              <label>Supplier / shop<input value={form.supplier_name} onChange={e => setForm({ ...form, supplier_name: e.target.value })} placeholder="Where it was bought" /></label>
              <label>Amount (MMK)<input type="number" min="0" step="any" inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder={`Up to ${num(room).toLocaleString('en-US')}`} /><small>Left on this advance: {money(room)}</small></label>
              <label className="wide">What was it for?<input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. SKU purchase 1 – bearings and seals" /></label>
              <label className="wide">Receipt<input type="file" accept="image/*,.pdf" onChange={e => setForm({ ...form, receipt: e.target.files?.[0] || null })} /><small>{form.receipt ? form.receipt.name : form.receipt_file ? 'A receipt is already attached. Choose a file only to replace it.' : 'Optional for now, but required before you submit to the admin.'}</small></label>
            </div>
            <div className="advx-form-actions"><button className="secondary-button" disabled={busy} onClick={() => { setForm(null); setError(''); }}>Cancel</button><button className="primary-button" disabled={busy} onClick={saveDraft}>{busy ? 'Saving…' : form.id ? 'Save changes' : 'Save as draft'}</button></div>
          </div>}

          {error && <p className="advx-error" role="alert">{error}</p>}
          {readOnly && <p className="advx-muted">Drafts are shown for information only. They are not part of the approval queue until the staff member submits them.</p>}
          {!readOnly && !advance.can_record && <p className="advx-muted">{/settled/i.test(advance.status) ? 'This advance is fully settled.' : `Expenses can be recorded once the advance is issued (current status: ${advance.status}).`}</p>}
        </>}
      </div>

      <div className="modal-footer advx-footer">
        <button className="secondary-button" onClick={onClose} disabled={busy}>Close</button>
        {canRecord && !form && <button className="secondary-button" disabled={busy || remaining <= 0} title={remaining <= 0 ? 'The whole advance is already accounted for' : ''} onClick={() => { setError(''); setForm(emptyForm()); }}><Upload size={15} />Upload advance details</button>}
        {canRecord && <button className="primary-button" disabled={busy || Boolean(form) || !drafts.length} title={drafts.length ? '' : 'Upload advance details first'} onClick={submit}><Send size={15} />Submit to admin{drafts.length ? ` (${drafts.length}) · ${money(toSubmitTotal)}` : ''}</button>}
      </div>
    </section>
  </div>;
}
