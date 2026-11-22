import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck, X } from 'lucide-react';
import { apiRequest } from '../../api/client.js';
import { formSchemas } from '../../formSchemas.js';
import FormField, { readFormValues } from '../../components/FormField.jsx';
import { AttachmentGallery, collectAttachments } from '../../Attachments.jsx';
import { initials, lookupOptions, lookupRecords, rowAvatar, toDisplayRow } from '../../lib/records.js';
import { canPrintDocument, documentLabel, printRecordDetails, printRecordDocument } from '../../lib/print.js';

// The general-purpose record dialog: view, create, edit, delete, plus the
// smaller workflow forms (payment, job note, completion report, accounts).
// The caller reads what the user entered from the `dialog` object on confirm.

const CLAIM_MODULES = ['cash-claims', 'my-expense-claims'];
const isFileValue = value => (typeof File !== 'undefined' && value instanceof File) || (Array.isArray(value) && value.length > 0);

function readPhoto(file, apply, setError) {
  if (!file) { apply(''); setError(''); return; }
  if (!/^image\//.test(file.type)) { setError('Choose an image file (JPG, PNG or WebP).'); return; }
  if (file.size > 1.5 * 1024 * 1024) { setError('Choose an image smaller than 1.5 MB.'); return; }
  const reader = new FileReader();
  reader.onload = () => { apply(String(reader.result || '')); setError(''); };
  reader.readAsDataURL(file);
}

export default function RecordDialog({ dialog, columns, typedConfirm, setTypedConfirm, onClose, onConfirm }) {
  const formFields = dialog.fields?.length ? dialog.fields : formSchemas[dialog.module] || [];
  const type = dialog.type;
  const isDelete = type === 'delete' || type === 'force';
  const isView = type === 'view';
  const isForm = type === 'create' || type === 'edit';
  const isAssign = type === 'assign-job';
  const isJobNote = type === 'job-note';
  const isAccountCreate = Boolean(dialog.accountMode);
  const isAccountPhoto = type === 'account-photo';
  const isMyAccount = type === 'my-account';
  const isReset = type === 'reset-password';
  const isPayment = type === 'payment';
  const isServiceReport = type === 'service-report';
  const isSchemaForm = ((isForm && !isAccountCreate) || isAssign) && Boolean(formFields.length);

  const [values, setValues] = useState(dialog.row || []);
  const [fieldValues, setFieldValues] = useState(() => readFormValues(formFields, type === 'edit' ? dialog.row : null, columns));
  const setField = (key, value) => setFieldValues(old => ({ ...old, [key]: value }));

  // Quotation / invoice totals
  const itemRows = fieldValues.items || [];
  const subtotal = itemRows.reduce((sum, item) => sum + Math.max(0, Number(item.qty || 0) * Number(item.unit_price || 0) - Number(item.discount || 0)), 0);
  const tax = (subtotal * Number(fieldValues.tax_rate || 0)) / 100;

  // Account forms
  const [account, setAccount] = useState({ name: '', username: '', role: 'Staff', password: '', email: '', photo: '' });
  const [photo, setPhoto] = useState(() => rowAvatar(dialog.row) || dialog.user?.avatar || '');
  const [photoError, setPhotoError] = useState('');
  const [mine, setMine] = useState({ name: dialog.user?.name || '', username: dialog.user?.username || String(dialog.user?.name || '').toLowerCase().replace(/\s+/g, '.'), password: '', confirm: '' });
  const [password, setPassword] = useState('');

  // Payment
  const invoiceDue = isPayment ? Number(dialog.row?._record?.outstanding_value ?? String(dialog.row?.[columns ? columns.indexOf('Outstanding') : -1] ?? '').replace(/[^0-9.]/g, '')) || 0 : 0;
  const [payment, setPayment] = useState({ amount: invoiceDue ? String(invoiceDue) : '', method: 'Bank transfer', date: new Date().toISOString().slice(0, 10) });

  // Completion report
  const [report, setReport] = useState({
    workDone: '', findings: '', complaint: '', testResults: '', recommendations: '', partsUsed: '', customerName: '', technicianName: '',
    customerSignature: '', technicianSignature: '', photos: [], approved: false,
    startedAt: new Date(Date.now() - 3600000).toISOString().slice(0, 16), finishedAt: new Date().toISOString().slice(0, 16),
  });
  const setReportField = (key, value) => setReport(old => ({ ...old, [key]: value }));
  const [jobNote, setJobNote] = useState('');

  // Lookup options for schema forms
  const lookupResources = [...new Set(formFields.filter(field => ['lookup', 'lookup-multiple', 'materials', 'request-items'].includes(field.type)).map(field => field.resource).filter(Boolean))];
  const lookupsQuery = useQuery({
    queryKey: ['form-lookups', lookupResources],
    queryFn: async () => Object.fromEntries(await Promise.all(lookupResources.map(async resource => [resource, await apiRequest(`/${resource}?limit=100`)]))),
    enabled: lookupResources.length > 0,
    staleTime: 60_000,
  });

  // Jobs, quotations and invoices: fill customer / quotation details automatically.
  useEffect(() => {
    if (!['jobs', 'quotations', 'invoices'].includes(dialog.module)) return;
    const findRecord = (resource, id) => lookupRecords(resource, lookupsQuery.data?.[resource]).find(record => String(record.id ?? record.uuid ?? record.code ?? record.number) === String(id));
    const quotation = fieldValues.quotation_id ? findRecord('quotations', fieldValues.quotation_id) : null;
    const customer = (quotation?.customer_id ? findRecord('customers', quotation.customer_id) : null) || (fieldValues.customer_id ? findRecord('customers', fieldValues.customer_id) : null);
    const updates = {};
    if (customer) Object.assign(updates, {
      customer_name: customer.name || customer.legal_name || customer.customer_name || '',
      billing_address: customer.billing_address || customer.address || '',
      contact_person: customer.contact_person || customer.contact_name || '',
      phone: customer.phone || customer.phone_number || '',
      email: customer.email || '',
      address: customer.address || customer.billing_address || '',
    });
    if (quotation && dialog.module === 'jobs') Object.assign(updates, {
      quotation_date: String(quotation.date || quotation.quotation_date || quotation.created_at || '').slice(0, 10),
      quotation_amount: String(quotation.total ?? quotation.amount ?? quotation.total_amount ?? ''),
      customer_approval: 'Approved',
      payment_terms: quotation.payment_terms || '',
      quoted_items: quotation.items || quotation.line_items || [],
      ...(quotation.customer_id ? { customer_id: quotation.customer_id } : {}),
    });
    if (Object.keys(updates).length) setFieldValues(old => ({ ...old, ...updates, ...(customer?.address && !old.site_location ? { site_location: customer.address } : {}) }));
  }, [dialog.module, fieldValues.customer_id, fieldValues.quotation_id, lookupsQuery.data]);

  const hiddenField = field => CLAIM_MODULES.includes(dialog.module) && (
    (field.key === 'job_id' && fieldValues.category === 'Office')
    || (field.key === 'office_type' && fieldValues.category !== 'Office')
    || (field.key === 'advance_id' && fieldValues.payment_source !== 'From advance'));

  const formInvalid = formFields.some(field => {
    const value = fieldValues[field.key];
    const empty = field.type === 'file' ? !isFileValue(value)
      : field.type === 'lookup-multiple' ? !Array.isArray(value) || !value.length
      : Array.isArray(value) ? !value.some(item => item.description || item.item_id)
      : String(value ?? '').trim() === '';
    const claim = CLAIM_MODULES.includes(dialog.module);
    if (field.type === 'request-items' && field.required && (!value.some(item => item.item_id && Number(item.qty) > 0) || value.some(item => item.item_id && Number(item.qty) <= 0))) return true;
    if (field.required && empty) return true;
    if (field.type === 'items' && field.required && (!Array.isArray(value) || !value.some(item => item.description?.trim() && Number(item.qty) > 0 && Number(item.unit_price) >= 0))) return true;
    if (claim && field.key === 'job_id' && fieldValues.category === 'Job' && empty) return true;
    if (claim && field.key === 'office_type' && fieldValues.category === 'Office' && empty) return true;
    if (claim && field.key === 'advance_id' && fieldValues.payment_source === 'From advance' && empty) return true;
    // A claim needs a receipt, or a written reason why there is none.
    if (claim && field.key === 'receipt_file' && !isFileValue(value) && !String(fieldValues.exception_reason || '').trim()) return true;
    if (!field.money && field.type === 'number' && value !== '' && value != null && Number(value) < Number(field.min || 0)) return true;
    if (field.type === 'email' && value && !/^\S+@\S+\.\S+$/.test(value)) return true;
    if (['suppliers', 'customers'].includes(dialog.module) && field.key === 'phone' && !String(value || '').trim() && !String(fieldValues.email || '').trim()) return true;
    if (dialog.module === 'quotations' && field.key === 'valid_until' && fieldValues.date && value && value < fieldValues.date) return true;
    if (dialog.module === 'jobs' && field.key === 'planned_end_date' && fieldValues.planned_start_date && value && value < fieldValues.planned_start_date) return true;
    return false;
  });

  const myAccountInvalid = isMyAccount && (mine.name.trim().length < 2 || mine.username.trim().length < 3 || Boolean(photoError) || (mine.password !== '' && (mine.password.length < 10 || mine.password !== mine.confirm)));
  const accountInvalid = isAccountCreate && (account.name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(account.email) || account.username.trim().length < 3 || account.password.length < 10);
  const reportInvalid = isServiceReport && (!report.workDone.trim() || !report.findings.trim() || !report.complaint.trim() || !report.testResults.trim() || !report.technicianName.trim() || !report.customerName.trim() || !report.customerSignature || !report.technicianSignature || !report.approved || report.finishedAt < report.startedAt);
  const confirmDisabled = (type === 'force' && typedConfirm !== 'DELETE') || myAccountInvalid || (isReset && password.length < 10) || accountInvalid || (isJobNote && !jobNote.trim()) || reportInvalid || (isSchemaForm && formInvalid);

  const eyebrow = isMyAccount ? 'MY ACCOUNT' : isAccountPhoto ? 'ACCOUNT PROFILE' : isJobNote ? 'JOB NOTE' : isPayment ? 'RECORD CUSTOMER PAYMENT'
    : isServiceReport ? 'COMPLETION REPORT' : type === 'force' ? 'FORCE DELETE' : isReset ? 'ADMIN PASSWORD RESET' : isDelete ? 'DELETE RECORD' : isView ? 'RECORD DETAILS' : 'RECORD';
  const title = isMyAccount ? 'Manage my account' : isAccountPhoto ? `Profile picture · ${dialog.row?.[0]}` : isJobNote ? `Add note · ${dialog.row?.[0]}`
    : isPayment ? `Payment · ${dialog.row?.[0]}` : isServiceReport ? `Complete job · ${dialog.row?.[0]}` : isAccountCreate ? 'Create user account'
    : isAssign ? dialog.title : type === 'create' ? (dialog.title || 'Create new record') : type === 'edit' ? 'Edit record'
    : isReset ? `Reset password · ${dialog.row?.[0]}` : isView ? dialog.row?.[0] : isDelete ? (type === 'force' ? 'Force delete this record?' : 'Delete this record?') : '';
  const confirmLabel = isAccountCreate ? 'Create account' : isAccountPhoto ? 'Save photo' : isMyAccount ? 'Save my account' : isAssign ? 'Save assignment'
    : isJobNote ? 'Save note' : type === 'create' ? (dialog.title || 'Create record') : type === 'edit' ? 'Save changes' : isReset ? 'Reset password'
    : isPayment ? 'Record payment' : isServiceReport ? 'Save completion report' : type === 'force' ? 'Force delete' : 'Delete record';

  // Copy what the user entered onto the dialog object, then let the page act on it.
  const confirm = () => {
    if (isSchemaForm) {
      dialog.displayPayload = { ...fieldValues };
      const payload = Object.fromEntries(formFields.filter(field => field.type !== 'section' && field.type !== 'readonly').map(field => [field.key, fieldValues[field.key]]));
      if (dialog.module === 'quotations' || dialog.module === 'invoices') Object.assign(payload, { subtotal, tax, total: subtotal + tax });
      dialog.payload = payload;
      dialog.values = toDisplayRow(columns, { ...dialog.displayPayload, ...payload });
    }
    if (isForm && !isAccountCreate && !isSchemaForm) dialog.values = values;
    if (isAccountCreate) dialog.account = { name: account.name, email: account.email, username: account.username, role: account.role, password: account.password, avatar: account.photo };
    if (isAccountPhoto) { dialog.photo = photo; dialog.accountUsername = dialog.row?.[1]; }
    if (isMyAccount) dialog.myAccount = { name: mine.name.trim(), username: mine.username.trim(), avatar: photo, password: mine.password };
    if (isReset) dialog.password = password;
    if (isPayment) dialog.payment = { amount: Number(payment.amount), date: payment.date, method: payment.method };
    if (isJobNote) dialog.note = jobNote;
    if (isServiceReport) dialog.serviceReport = {
      work_done: report.workDone, findings: report.findings, customer_complaint: report.complaint, test_results: report.testResults,
      recommendations: report.recommendations, parts_used: report.partsUsed, technician_name: report.technicianName, customer_name: report.customerName,
      customer_approval: report.approved, technician_signature: report.technicianSignature, customer_signature: report.customerSignature,
      attachments: report.photos, started_at: report.startedAt, finished_at: report.finishedAt, delivered_at: new Date().toISOString(),
    };
    onConfirm();
  };

  const photoPreview = (src, alt, onRemove) => <div className="account-photo-field wide-field">
    <span className="account-photo-preview"><img src={src} alt={alt} /></span>
    <button type="button" className="secondary-button" onClick={onRemove}>Remove photo</button>
  </div>;

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="modal">
      <div className="modal-header">
        <div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
      </div>

      {isAccountCreate && <div className="record-fields special-fields">
        <label>Full name<input value={account.name} onChange={e => setAccount({ ...account, name: e.target.value })} placeholder="Staff member name" /></label>
        <label>Email<input type="email" autoComplete="off" value={account.email} onChange={e => setAccount({ ...account, email: e.target.value })} placeholder="name@company.com" /></label>
        <label>Username<input autoComplete="off" value={account.username} onChange={e => setAccount({ ...account, username: e.target.value })} placeholder="Unique username" /></label>
        <label>Role<select value={account.role} onChange={e => setAccount({ ...account, role: e.target.value })}><option>Staff</option><option>Admin</option></select></label>
        <label>Initial password<input type="password" autoComplete="new-password" value={account.password} onChange={e => setAccount({ ...account, password: e.target.value })} placeholder="At least 10 characters" /></label>
        <label className="wide-field">Profile picture<input type="file" accept="image/*" onChange={e => readPhoto(e.target.files?.[0], value => setAccount(old => ({ ...old, photo: value })), setPhotoError)} /><small>Optional. JPG, PNG or WebP up to 1.5 MB.</small></label>
        {account.photo && photoPreview(account.photo, 'Profile preview', () => setAccount({ ...account, photo: '' }))}
        {photoError && <p className="form-error wide-field">{photoError}</p>}
        <p className="wide-field">Only Admin can create accounts and reset passwords. There is no self-service password recovery.</p>
      </div>}

      {isAccountPhoto && <div className="account-photo-editor">
        <span className="account-photo-preview">{photo ? <img src={photo} alt={`${dialog.row?.[0]} profile`} /> : initials(dialog.row?.[0])}</span>
        <label>Profile picture<input type="file" accept="image/*" onChange={e => readPhoto(e.target.files?.[0], setPhoto, setPhotoError)} /><small>JPG, PNG or WebP up to 1.5 MB. A square image works best.</small></label>
        {photoError && <p className="form-error">{photoError}</p>}
        {photo && <button type="button" className="secondary-button" onClick={() => { setPhoto(''); setPhotoError(''); }}>Remove photo</button>}
      </div>}

      {isMyAccount && <div className="record-fields special-fields">
        <label>Full name<input value={mine.name} onChange={e => setMine({ ...mine, name: e.target.value })} placeholder="Your full name" /></label>
        <label>Username<input autoComplete="off" value={mine.username} onChange={e => setMine({ ...mine, username: e.target.value })} placeholder="Your username" /></label>
        <label>Role<input value={dialog.user?.role || 'Admin'} readOnly /></label>
        <label>New password<input type="password" autoComplete="new-password" value={mine.password} onChange={e => setMine({ ...mine, password: e.target.value })} placeholder="Leave blank to keep current" /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" value={mine.confirm} onChange={e => setMine({ ...mine, confirm: e.target.value })} placeholder="Repeat new password" /></label>
        <label className="wide-field">Profile picture<input type="file" accept="image/*" onChange={e => readPhoto(e.target.files?.[0], setPhoto, setPhotoError)} /><small>Optional. JPG, PNG or WebP up to 1.5 MB.</small></label>
        {photo && photoPreview(photo, 'Your profile preview', () => { setPhoto(''); setPhotoError(''); })}
        {photoError && <p className="form-error wide-field">{photoError}</p>}
        {mine.password && mine.confirm && mine.password !== mine.confirm && <p className="form-error wide-field">Passwords do not match.</p>}
        {mine.password && mine.password.length < 10 && <p className="form-error wide-field">Use at least 10 characters for the new password.</p>}
        <p className="wide-field">You are editing your own administrator account. Leave the password fields blank to keep your current password.</p>
      </div>}

      {isReset && <div className="record-fields reset-fields">
        <label>New temporary password<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter a temporary password" /></label>
        <p>The user will need to contact an administrator if they forget this password.</p>
      </div>}

      {isPayment && dialog.row?._record && <div className="payment-summary">
        <span>Invoice <b>{dialog.row._record.invoice_amount || '—'}</b></span>
        <span>Received <b>{dialog.row._record.received || '—'}</b></span>
        <span>Outstanding <b>{dialog.row._record.outstanding || '—'}</b></span>
      </div>}
      {isPayment && <div className="record-fields special-fields">
        <label>Amount<input type="number" value={payment.amount} onChange={e => setPayment({ ...payment, amount: e.target.value })} placeholder="0.00" /></label>
        <label>Payment date<input type="date" value={payment.date} onChange={e => setPayment({ ...payment, date: e.target.value })} /></label>
        <label>Payment method<select value={payment.method} onChange={e => setPayment({ ...payment, method: e.target.value })}><option>Bank transfer</option><option>Cash</option><option>Cheque</option><option>UPI</option></select></label>
        <p>Recording a payment also creates the matching cash-in entry.</p>
      </div>}

      {isJobNote && <div className="record-fields special-fields">
        <label className="wide-field">Work note<textarea rows={4} value={jobNote} onChange={e => setJobNote(e.target.value)} placeholder="Add a work update or handover note" /></label>
      </div>}

      {isServiceReport && <div className="record-fields special-fields">
        <label>Service start<input type="datetime-local" value={report.startedAt} onChange={e => setReportField('startedAt', e.target.value)} /></label>
        <label>Service finish<input type="datetime-local" value={report.finishedAt} onChange={e => setReportField('finishedAt', e.target.value)} /></label>
        <label className="wide-field">Customer complaint / reported issue<textarea required value={report.complaint} onChange={e => setReportField('complaint', e.target.value)} rows={2} placeholder="What issue did the customer report?" /></label>
        <label className="wide-field">Inspection findings<textarea required value={report.findings} onChange={e => setReportField('findings', e.target.value)} rows={2} placeholder="Diagnosis, measurements and observations" /></label>
        <label className="wide-field">Work completed<textarea required value={report.workDone} onChange={e => setReportField('workDone', e.target.value)} rows={3} placeholder="Describe the work and corrective actions" /></label>
        <label className="wide-field">Materials used<textarea value={report.partsUsed} onChange={e => setReportField('partsUsed', e.target.value)} rows={2} placeholder="Parts and quantities used" /></label>
        <label className="wide-field">Test results / readings<textarea required value={report.testResults} onChange={e => setReportField('testResults', e.target.value)} rows={2} placeholder="Record operating checks and readings" /></label>
        <label className="wide-field">Recommendations<textarea value={report.recommendations} onChange={e => setReportField('recommendations', e.target.value)} rows={2} placeholder="Recommended follow-up work" /></label>
        <label>Technician name<input required value={report.technicianName} onChange={e => setReportField('technicianName', e.target.value)} placeholder="Technician completing this report" /></label>
        <label>Customer representative<input required value={report.customerName} onChange={e => setReportField('customerName', e.target.value)} placeholder="Name and designation" /></label>
        <label>Technician signature<input type="file" required accept="image/*,.pdf" onChange={e => setReportField('technicianSignature', e.target.files?.[0] || '')} /></label>
        <label>Customer sign-off<input type="file" required accept="image/*,.pdf" onChange={e => setReportField('customerSignature', e.target.files?.[0] || '')} /></label>
        <label className="wide-field">Job photos / attachments<input type="file" multiple accept="image/*,.pdf" onChange={e => setReportField('photos', Array.from(e.target.files || []))} /><small>{report.photos.length ? `${report.photos.length} file(s) selected` : 'Attach before, during or after photos if available'}</small></label>
        <label className="approval-check"><input type="checkbox" checked={report.approved} onChange={e => setReportField('approved', e.target.checked)} />Customer accepted the completed service</label>
        <p className="wide-field">Submitting sends this report to the service manager for review. The job stays open until approval.</p>
      </div>}

      {isDelete && (type === 'force'
        ? <>
          <div className="warning-box force-warning"><ShieldCheck size={19} /><p><b>This action is logged and recoverable.</b><br />Dependants and related records may also be affected. Review the record before proceeding.</p></div>
          <div className="confirm-preview"><b>Record to delete</b><span>{dialog.row?.[0]} · {dialog.row?.[1]}</span></div>
          <label className="confirm-label">Type <b>DELETE</b> to confirm<input value={typedConfirm} onChange={e => setTypedConfirm(e.target.value)} placeholder="Type DELETE" autoFocus /></label>
        </>
        : <div className="warning-box"><div className="warning-symbol">!</div><p><b>This record will be moved to the Recycle Bin.</b><br />It can be restored later by an administrator.</p></div>)}

      {(isView || (isForm && !isAccountCreate && !isSchemaForm)) && <div className="record-fields">
        {columns.map((col, i) => <label key={col}>{col}
          {isForm
            ? <input value={values[i] === '—' ? '' : values[i] || ''} onChange={e => setValues(old => old.map((v, j) => (i === j ? e.target.value : v)))} placeholder={`Enter ${col.toLowerCase()}`} />
            : <div className="detail-value">{values[i] || '—'}</div>}
        </label>)}
        {isView && <AttachmentGallery groups={collectAttachments(dialog.row?._record)} title="Uploaded files" />}
      </div>}

      {isSchemaForm && <div className="record-fields schema-fields">
        {formFields.filter(field => !hiddenField(field)).map(field => <FormField key={field.key} field={field} value={fieldValues[field.key]}
          options={['lookup', 'lookup-multiple', 'materials', 'request-items'].includes(field.type) ? lookupOptions(field.resource, lookupsQuery.data?.[field.resource], field) : []}
          onChange={value => setField(field.key, value)} />)}
        {(dialog.module === 'quotations' || dialog.module === 'invoices') && <div className="total-preview">
          <span>Subtotal <b>MMK {subtotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></span>
          <span>Tax <b>MMK {tax.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></span>
          <span>Total <b>MMK {(subtotal + tax).toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></span>
        </div>}
      </div>}

      <div className="modal-footer">
        <button className="secondary-button" onClick={onClose}>Cancel</button>
        {isView && <button className="secondary-button" onClick={() => (canPrintDocument(dialog.module, dialog.row) ? printRecordDocument(dialog.module, dialog.row, columns) : printRecordDetails(dialog.row?.[0] || 'Record', columns, values, dialog.row?._record))}>
          <Download size={15} />{canPrintDocument(dialog.module, dialog.row) ? `Download ${documentLabel(dialog.module)} PDF` : 'Print / Save PDF'}
        </button>}
        {!isView && <button className={type === 'force' ? 'danger-button' : 'primary-button'} disabled={confirmDisabled} onClick={confirm}>{confirmLabel}</button>}
      </div>
    </section>
  </div>;
}
