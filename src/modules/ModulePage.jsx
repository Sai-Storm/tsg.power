import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Activity, BarChart3, Bell, Check, ChevronLeft, ChevronRight, Clock3, Download, FileDown, Filter, MoreHorizontal, Plus, ReceiptText, Search, ShieldCheck, Trash2, Wrench } from 'lucide-react';
import { apiRequest, exportModule } from '../api/client.js';
import { moduleInfo, navigation } from '../data.js';
import { formSchemas } from '../formSchemas.js';
import Status from '../components/Status.jsx';
import { confirmDialog } from '../components/AskDialog.jsx';
import AdvanceExpensesDialog from '../AdvanceExpenses.jsx';
import { apiEndpoint, initials, isStatus, lookupRecords, normalizeList, requestBody, rowAvatar, toApiRecord } from '../lib/records.js';
import { canPrintDocument, documentLabel, printRecordDocument } from '../lib/print.js';
import { saveSessionUser, initialUser } from '../lib/session.js';
import workflowActions from './actions/index.js';
import RecordDialog from './dialogs/RecordDialog.jsx';
import AdvanceIssueDialog from './dialogs/AdvanceIssueDialog.jsx';
import SalaryPaymentDialog from './dialogs/SalaryPaymentDialog.jsx';
import StaffProfileDialog from './dialogs/StaffProfileDialog.jsx';
import StockMovementDialog from './dialogs/StockMovementDialog.jsx';
import JobFinanceDialog from './dialogs/JobFinanceDialog.jsx';

const PAGE_SIZE = 10;

const SUCCESS = {
  'reset-password': 'Password reset.', 'account-photo': 'Profile picture updated.', 'my-account': 'Your account has been updated.',
  'staff-profile': 'Staff profile updated.', 'salary-payment': 'Salary marked as paid. Voucher generated in Expense & claims.',
  payment: 'Payment recorded.', 'advance-issue': 'Money released. The staff member can now record expenses.',
  'service-report': 'Completion report submitted for manager review.', 'assign-job': 'Job assignment saved.', 'job-invoice': 'Invoice generated.',
  'job-close': 'Job closed.', 'job-cancel': 'Job cancelled with reason recorded.', 'job-note': 'Job note saved.',
};

/** Routes /<module> to its list page, respecting role access. */
export default function ModuleRoute({ user, notify }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname } = location;
  const slug = pathname.replace(/^\//, '');
  const info = moduleInfo[slug];
  if (!info) return <Navigate to="/" replace />;
  const item = navigation.find(n => n.path === pathname);
  if (item && !item.roles.includes(user.role)) return <Navigate to="/" replace />;
  const initialCreateForm = location.state?.openCreate ? (location.state.form || slug) : null;
  return <ModulePage key={slug} info={info} slug={slug} user={user} notify={notify} initialCreateForm={initialCreateForm} onCreateHandled={() => navigate(pathname, { replace: true, state: null })} />;
}

function ModulePage({ info, slug, user, notify, initialCreateForm = null, onCreateHandled }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [typedConfirm, setTypedConfirm] = useState('');
  const [openRowActions, setOpenRowActions] = useState(null);

  const listQuery = useQuery({
    queryKey: ['module', slug, search, statusFilter, dateFrom, dateTo, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      return apiRequest(`/${apiEndpoint(slug)}?${params}`);
    },
    staleTime: 20_000,
  });

  const rows = listQuery.data ? normalizeList(listQuery.data, info.columns) : [];
  const statusIndex = info.columns.findIndex(col => /status/i.test(col));
  const dateIndex = info.columns.findIndex(col => /date|due|delivered|issued|purchased/i.test(col));
  const visibleRows = rows.filter(row => {
    if (!row.join(' ').toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter && !row.some(cell => String(cell).toLowerCase() === statusFilter.toLowerCase())) return false;
    if (dateIndex >= 0 && (dateFrom || dateTo)) {
      const date = new Date(row[dateIndex]);
      if (!Number.isNaN(date.valueOf())) {
        if (dateFrom && date < new Date(`${dateFrom}T00:00:00`)) return false;
        if (dateTo && date > new Date(`${dateTo}T23:59:59`)) return false;
      }
    }
    return true;
  });

  const isAdmin = user.role === 'Admin';
  const canCreate = isAdmin
    ? !['jobs', 'quotations', 'invoices', 'income', 'notifications', 'recycle-bin', 'settings'].includes(slug)
    : ['customers', 'quotations', 'invoices', 'jobs', 'service-reports', 'material-requests', 'my-expense-claims', 'my-advances'].includes(slug);
  const canEdit = isAdmin
    ? !['accounts', 'notifications', 'recycle-bin', 'income'].includes(slug)
    : ['customers', 'quotations', 'invoices', 'service-reports', 'material-requests', 'my-expense-claims'].includes(slug);
  const showDelete = isAdmin ? !['accounts', 'notifications', 'recycle-bin', 'settings', 'income'].includes(slug) : slug === 'customers';
  const showForceDelete = isAdmin && !['accounts', 'notifications', 'recycle-bin', 'settings', 'income'].includes(slug);
  const activeFilters = { ...(search ? { search } : {}), ...(statusFilter ? { status: statusFilter } : {}), ...(dateFrom ? { from: dateFrom } : {}), ...(dateTo ? { to: dateTo } : {}) };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['module', slug] });
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const onExport = async format => {
    if (format !== 'pdf' && !isAdmin) { notify('Excel export is available to admins only.'); return; }
    try { await exportModule(apiEndpoint(slug), format, activeFilters); } catch (e) { notify(e.message); }
  };

  const create = (requestedForm = slug) => {
    const form = requestedForm === 'my-advances' ? 'my-advance' : requestedForm === 'advances' ? 'new-advance' : typeof requestedForm === 'string' ? requestedForm : slug;
    const accountMode = form === 'accounts';
    const apiResource = ({ 'cash-claims': 'expenses', 'new-advance': 'advances', 'my-advance': 'advances', 'cash-entry': 'cash-entries' })[form] || apiEndpoint(form);
    const title = ({ 'cash-claims': 'Create expense voucher', 'new-advance': 'Issue staff advance', 'my-advance': 'Request staff advance', 'cash-entry': 'Record cash movement' })[form] || `Create ${info.title.replace(/s$/, '').toLowerCase()}`;
    setDialog({ type: 'create', accountMode, fields: accountMode ? null : formSchemas[form], apiResource, title, module: form });
  };
  useEffect(() => { if (initialCreateForm && canCreate) { create(initialCreateForm); onCreateHandled?.(); } }, [initialCreateForm, canCreate, slug]);

  const edit = row => {
    if (slug === 'settings') return setDialog({ type: 'edit', row, fields: [{ key: 'current_value', label: 'Current value', type: 'text', required: true }], apiResource: 'settings', module: 'settings', title: `Edit ${row[0]}` });
    if (slug === 'advances') return setDialog({ type: 'edit', row, fields: formSchemas['new-advance'], apiResource: 'advances', module: 'new-advance', title: `Edit ${row[0]}` });
    if (slug === 'cash-claims') {
      const kind = String(row?.[1] || '');
      const advance = /^staff advance/i.test(kind);
      const cash = /^cash/i.test(kind);
      return setDialog({ type: 'edit', row, fields: advance ? formSchemas['new-advance'] : cash ? formSchemas['cash-entry'] : formSchemas['cash-claims'], apiResource: advance ? 'advances' : cash ? 'cash-entries' : 'expenses', module: slug, title: `Edit ${advance ? 'advance' : cash ? 'cash entry' : 'expense claim'}` });
    }
    return setDialog({ type: 'edit', row, fields: formSchemas[slug], apiResource: apiEndpoint(slug), module: slug, title: `Edit ${info.title.replace(/s$/, '').toLowerCase()}` });
  };

  const clearNotifications = async () => {
    if (!await confirmDialog('Delete all notifications? This cannot be undone.', { title: 'Clear notifications', confirmLabel: 'Delete all', tone: 'danger' })) return;
    try {
      await apiRequest('/notifications?all=true', { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['module', 'notifications'] });
      notify('All notifications deleted.');
    } catch (error) { notify(error.message); }
  };

  // Saves whatever the open dialog collected.
  const confirmAction = async () => {
    if (dialog.type === 'force' && typedConfirm !== 'DELETE') return;
    const isRemoving = dialog.type === 'delete' || dialog.type === 'force';
    const recordId = encodeURIComponent(dialog.row?._id || dialog.row?.[0] || '');
    const post = (path, body) => apiRequest(path, { method: 'POST', body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body) });
    const put = (path, body) => apiRequest(path, { method: 'PUT', body: JSON.stringify(body) });
    try {
      switch (dialog.type) {
        case 'reset-password': await post(`/users/${recordId}/reset-password`, { password: dialog.password }); break;
        case 'account-photo': await put(`/users/${recordId}`, { avatar: dialog.photo }); break;
        case 'my-account': {
          const payload = { name: dialog.myAccount.name, username: dialog.myAccount.username, avatar: dialog.myAccount.avatar };
          if (dialog.myAccount.password) payload.password = dialog.myAccount.password;
          const updated = await put(`/users/${encodeURIComponent(dialog.user?.id || user.id)}`, payload);
          const apiUser = updated?.user || updated || {};
          const stored = initialUser() || user;
          saveSessionUser({ ...stored, name: apiUser.name || payload.name, username: apiUser.username || payload.username, avatar: apiUser.avatar ?? payload.avatar, role: stored.role });
          break;
        }
        case 'staff-profile': {
          const form = dialog.staffProfile || {};
          const profileId = dialog.profile?.id || dialog.row?._record?.profile_id || '';
          if (profileId) {
            const profilePayload = { name: form.name, username: form.username, phone: form.phone, avatar: form.avatar, ...(form.password ? { password: form.password } : {}) };
            const updated = await put(`/users/${encodeURIComponent(profileId)}`, profilePayload);
            const apiUser = updated?.user ? updated : (updated || {});
            const current = initialUser() || user;
            if (String(current.id) === String(profileId)) saveSessionUser({ ...current, name: apiUser.user || apiUser.name || form.name, username: apiUser.username || form.username, phone: form.phone, avatar: form.avatar ?? current.avatar });
          }
          await put(`/staff/${recordId}`, { name: form.name, phone: form.phone, email: form.email });
          await queryClient.invalidateQueries({ queryKey: ['module', 'accounts'] });
          break;
        }
        case 'salary-payment': await put(`/salaries/${recordId}`, { status: 'Paid', paid_on: dialog.salaryPayment.date, payment_method: dialog.salaryPayment.method, notes: dialog.salaryPayment.notes }); break;
        case 'job-invoice': {
          const invoice = await post('/invoices', {
            job_id: dialog.row?._id || dialog.row?.[0], customer_id: dialog.customerId || dialog.row?._record?.customer_id,
            date: dialog.invoiceDate, due_date: dialog.dueDate, payment_terms: dialog.paymentTerms,
            items: [{ description: dialog.row?.[1] || 'Job service', qty: 1, unit_price: dialog.subtotal }],
            subtotal: dialog.subtotal, additional_charges: dialog.charges, discount: dialog.discount, total: dialog.total, status: 'Issued',
          });
          const invoiceId = invoice?.id || invoice?._id || invoice?.number || invoice?.invoice?.id;
          if (dialog.amountPaid > 0 && invoiceId) await post(`/invoices/${encodeURIComponent(invoiceId)}/payments`, { amount: dialog.amountPaid, date: dialog.invoiceDate, method: 'Cash' });
          await post(`/jobs/${recordId}/status`, { status: 'Invoice Generated' });
          break;
        }
        case 'job-close': await post(`/jobs/${recordId}/close`, { payment_status: dialog.paymentStatus, payment_amount: dialog.paymentAmount, due_date: dialog.dueDate }); break;
        case 'advance-issue': await post(`/advances/${recordId}/issue`, dialog.issue); break;
        case 'job-cancel': await put(`/jobs/${recordId}`, { status: 'Cancelled', cancellation_reason: dialog.reason }); break;
        case 'stock-movement': await post(`/material-requests/${recordId}/${dialog.movement}`, dialog.movementPayload); break;
        case 'payment': await post(`/invoices/${recordId}/payments`, dialog.payment); break;
        case 'service-report': await post(`/jobs/${recordId}/service-report`, requestBody(dialog.serviceReport)); break;
        case 'assign-job': await post(`/jobs/${recordId}/assign`, requestBody(dialog.payload)); break;
        case 'job-note': await put(`/jobs/${recordId}`, { note: dialog.note }); break;
        default:
          if (dialog.purge) await apiRequest(`/recycle-bin/${recordId}?purge=true`, { method: 'DELETE' });
          else if (isRemoving) await apiRequest(`/${apiEndpoint(slug)}/${recordId}${dialog.type === 'force' ? '?force=true' : ''}`, { method: 'DELETE' });
          else if (dialog.accountMode) await post('/users', dialog.account);
          else if (dialog.type === 'create') await post(`/${dialog.apiResource || apiEndpoint(slug)}`, requestBody(dialog.payload || toApiRecord(info.columns, dialog.values)));
          else if (dialog.type === 'edit') await apiRequest(`/${dialog.apiResource || apiEndpoint(slug)}/${recordId}`, { method: 'PUT', body: requestBody(dialog.payload || toApiRecord(info.columns, dialog.values)) });
      }
      await refresh();
      notify(SUCCESS[dialog.type]
        || (dialog.purge ? 'Record permanently purged.' : isRemoving ? 'Record moved to the Recycle Bin.' : dialog.accountMode ? 'User account created.'
          : dialog.module === 'my-advance' ? 'Advance request submitted for approval.' : dialog.type === 'create' ? 'Record created.' : 'Changes saved.'));
      setDialog(null);
      setTypedConfirm('');
    } catch (error) { notify(error.message); }
  };

  // Runs a row action from the "…" menu.
  const workflow = async (row, action, nextStatus) => {
    const open = type => setDialog({ type, row });
    const recordId = encodeURIComponent(row._id || row[0]);
    switch (action) {
      case 'edit-profile': {
        const record = row._record || {};
        try {
          let profile = record.profile_id ? await apiRequest(`/users/${encodeURIComponent(record.profile_id)}`) : null;
          if (!profile) {
            const list = await apiRequest('/users?limit=500');
            const email = String(record.email || '').trim().toLowerCase();
            const name = String(record.name || row[0] || '').trim().toLowerCase();
            profile = lookupRecords('users', list).find(item => (email && String(item.email || '').trim().toLowerCase() === email) || (name && String(item.user || item.name || '').trim().toLowerCase() === name)) || null;
          }
          setDialog({ type: 'staff-profile', row, profile });
        } catch (error) { notify(error.message); }
        return;
      }
      case 'reset-password': return open('reset-password');
      case 'update-photo': return open('account-photo');
      case 'record-payment': return open('payment');
      case 'service-report': return open('service-report');
      case 'issue-materials': return setDialog({ type: 'stock-movement', movement: 'issue', row });
      case 'return-materials': return setDialog({ type: 'stock-movement', movement: 'return', row });
      case 'job-invoice': return open('job-invoice');
      case 'job-close': return open('job-close');
      case 'job-cancel': return open('job-cancel');
      case 'add-note': return setDialog({ type: 'job-note', row, title: 'Add job note' });
      case 'assign-job': {
        const pick = key => formSchemas.jobs.find(field => field.key === key);
        const fields = [{ ...pick('team_leader'), required: true }, pick('assigned_to'), pick('assigned_employees'), pick('planned_start_date'), pick('planned_end_date'), pick('assigned_vehicle'), pick('responsibilities')].filter(field => field?.key);
        return setDialog({ type: 'assign-job', row, title: 'Assign and schedule job', module: 'jobs', fields });
      }
      case 'mark-salary-paid': return open('salary-payment');
      case 'advance-expenses': return open('advance-expenses');
      case 'issue-advance': return open('advance-issue');
      case 'purge': return setDialog({ type: 'force', row, purge: true });
      case 'delete-notification':
        if (!await confirmDialog('Delete this notification permanently?', { title: 'Delete notification', confirmLabel: 'Delete', tone: 'danger' })) return;
        try {
          await apiRequest(`/notifications/${recordId}`, { method: 'DELETE' });
          await queryClient.invalidateQueries({ queryKey: ['module', 'notifications'] });
          notify('Notification deleted.');
        } catch (error) { notify(error.message); }
        return;
      default: break;
    }

    try {
      const apiModule = slug === 'my-expense-claims' || slug === 'cash-claims' ? 'expenses' : slug;
      const type = String(row[1] || '');
      if (slug === 'recycle-bin' && action === 'restore') await apiRequest(`/recycle-bin/${recordId}/restore`, { method: 'POST' });
      else if (slug === 'notifications' && action === 'mark-read') await apiRequest(`/notifications/${recordId}`, { method: 'PUT', body: JSON.stringify({ is_read: true }) });
      else if (slug === 'accounts' && ['activate', 'deactivate'].includes(action)) await apiRequest(`/users/${recordId}`, { method: 'PUT', body: JSON.stringify({ is_active: action === 'activate' }) });
      else if (slug === 'jobs') await apiRequest(`/${apiModule}/${recordId}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
      else if ((slug === 'advances' || (slug === 'cash-claims' && /^staff advance/i.test(type))) && ['approve', 'reject'].includes(action)) await apiRequest(`/advances/${recordId}/${action}`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
      else if (slug === 'cash-claims' && /^cash/i.test(type) && ['approve', 'reject', 'post'].includes(action)) await apiRequest(`/cash-entries/${recordId}/${action}`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
      else if (slug === 'quotations' && action === 'convert-to-job') await apiRequest(`/${apiModule}/${recordId}/convert-to-job`, { method: 'POST' });
      else if (apiModule === 'expenses') await apiRequest(`/${apiModule}/${recordId}/${action}`, { method: 'POST' });
      else await apiRequest(`/${apiModule}/${recordId}`, { method: 'PUT', body: JSON.stringify({ status: nextStatus }) });
      await refresh();
      notify(action === 'restore' ? 'Record restored to its module.' : `${info.title.slice(0, -1)} ${action}.`);
    } catch (error) { notify(error.message); }
  };

  const statusValues = [...new Set(rows.flatMap(row => row.filter(cellValue => isStatus(cellValue))))];
  const totalCount = Number(listQuery.data?.total ?? listQuery.data?.pagination?.total ?? visibleRows.length);
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const createLabel = { jobs: 'Create job order', customers: 'Create customer', 'my-advances': 'Request advance', advances: 'New advance', 'my-expense-claims': 'Submit expense claim' }[slug] || `Add ${info.title.replace(/s$/, '').toLowerCase()}`;
  const accessNote = isAdmin ? 'Admin access · Changes are recorded in the audit log.'
    : { customers: 'Staff access · You can manage customer records.', quotations: 'Staff access · You can prepare, issue and convert quotations.', invoices: 'Staff access · You can issue invoices and record customer payments.' }[slug]
      || 'Staff access · You can only view and update your assigned work.';
  const closeDialog = () => { setDialog(null); setTypedConfirm(''); };
  const confirmWith = payload => { Object.assign(dialog, payload); confirmAction(); };

  const rowMenu = row => <>
    <button className="row-actions-dismiss" aria-label="Close actions menu" onClick={() => setOpenRowActions(null)} />
    <div className="row-action-popover" role="menu" style={{ top: openRowActions.top, left: openRowActions.left }}>
      <strong>{row[0]}</strong>
      <button role="menuitem" onClick={() => { setOpenRowActions(null); setDialog({ type: 'view', row, module: slug }); }}>View details</button>
      {canEdit && <button role="menuitem" onClick={() => { setOpenRowActions(null); edit(row); }}>Edit record</button>}
      {slug === 'accounts' && (String(row[1]).toLowerCase() === String(user.username || '').toLowerCase() || row[0] === user.name) && <button role="menuitem" onClick={() => { setOpenRowActions(null); setDialog({ type: 'my-account', user }); }}>Manage my account</button>}
      {canPrintDocument(slug, row) && <button role="menuitem" onClick={() => { setOpenRowActions(null); printRecordDocument(slug, row, info.columns); }}>Print / save {documentLabel(slug)} PDF</button>}
      {workflowActions(slug, row, info.columns, user.role).map(action => <button role="menuitem" key={action.label} onClick={() => { setOpenRowActions(null); workflow(row, action.action, action.status); }}>{action.label}</button>)}
      {showDelete && <>
        <span className="row-menu-divider" />
        <button role="menuitem" className="menu-danger" onClick={() => { setOpenRowActions(null); setDialog({ type: 'delete', row }); }}>Delete record</button>
        {showForceDelete && <button role="menuitem" className="menu-danger" onClick={() => { setOpenRowActions(null); setDialog({ type: 'force', row }); }}>Force delete</button>}
      </>}
    </div>
  </>;

  const renderDialog = () => {
    if (!dialog) return null;
    const key = `${dialog.type}-${dialog.row?._id || dialog.row?.[0] || dialog.title || slug}`;
    if (['job-invoice', 'job-close', 'job-cancel'].includes(dialog.type)) return <JobFinanceDialog key={key} dialog={dialog} onClose={closeDialog} onConfirm={confirmWith} />;
    if (dialog.type === 'advance-expenses') return <AdvanceExpensesDialog key={key} row={dialog.row} columns={info.columns} readOnly={user.role !== 'Staff'} isAdmin={isAdmin} notify={notify} onClose={closeDialog} onChanged={() => { queryClient.invalidateQueries({ queryKey: ['module'] }); queryClient.invalidateQueries({ queryKey: ['dashboard'] }); }} />;
    if (dialog.type === 'staff-profile') return <StaffProfileDialog key={key} dialog={dialog} columns={info.columns} onClose={closeDialog} onConfirm={confirmWith} />;
    if (dialog.type === 'advance-issue') return <AdvanceIssueDialog key={key} dialog={dialog} onClose={closeDialog} onConfirm={confirmWith} />;
    if (dialog.type === 'salary-payment') return <SalaryPaymentDialog key={key} dialog={dialog} onClose={closeDialog} onConfirm={confirmWith} />;
    if (dialog.type === 'stock-movement') return <StockMovementDialog key={key} dialog={dialog} onClose={closeDialog} onConfirm={confirmWith} />;
    return <RecordDialog key={key} dialog={dialog} columns={info.columns} typedConfirm={typedConfirm} setTypedConfirm={setTypedConfirm} onClose={closeDialog} onConfirm={confirmAction} />;
  };

  return <>
    <div className="page-heading module-heading">
      <div><div className="eyebrow">OPERATIONS</div><h1>{info.title}</h1><p>{info.description}</p></div>
      {slug === 'advances' && isAdmin && <Link className="secondary-button" to="/advance-overview"><BarChart3 size={15} />Advance overview</Link>}
      {slug === 'accounts' && isAdmin && <button className="secondary-button" onClick={() => setDialog({ type: 'my-account', user })}><ShieldCheck size={15} />My account</button>}
      {canCreate && <button className="primary-button" onClick={() => create()}><Plus size={16} />{createLabel}</button>}
      {canCreate && slug === 'cash-claims' && <>
        <button className="secondary-button" onClick={() => create('cash-entry')}><Plus size={15} />Cash movement</button>
        <button className="secondary-button" onClick={() => create('new-advance')}><Plus size={15} />New advance request</button>
      </>}
    </div>

    {slug === 'jobs' && <div className="job-stage-strip">
      {[['Draft', Wrench], ['Scheduled', Clock3], ['In Progress', Activity], ['On Hold', Bell], ['Completed', Check], ['Invoice Generated', ReceiptText]].map(([stage, Icon]) => <button key={stage} className={statusFilter === stage ? 'selected' : ''} onClick={() => { setStatusFilter(statusFilter === stage ? '' : stage); setPage(1); }}>
        <span><Icon size={16} /></span><b>{rows.filter(row => String(row[statusIndex]).toLowerCase() === stage.toLowerCase()).length}</b><small>{stage}</small>
      </button>)}
    </div>}

    <section className="panel module-panel">
      <div className="list-toolbar">
        <div className="search-box"><Search size={16} /><input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder={`Search ${info.title.toLowerCase()}…`} /></div>
        <div className="list-actions">
          {slug === 'notifications' && <button className="secondary-button export-button" onClick={clearNotifications}><Trash2 size={15} /> Clear all</button>}
          <button className={`secondary-button filter-button ${filterOpen ? 'filter-selected' : ''}`} onClick={() => setFilterOpen(value => !value)}><Filter size={15} /> Filters {statusFilter && <span className="filter-count">1</span>}</button>
          {slug !== 'notifications' && <>
            <span className="toolbar-separator" />
            {slug !== 'service-reports' && isAdmin && <button className="secondary-button export-button" onClick={() => onExport('xlsx')}><FileDown size={15} /> Export Excel</button>}
            <button className="secondary-button export-button" onClick={() => onExport('pdf')}><Download size={15} /> Export list PDF</button>
          </>}
        </div>
      </div>

      {filterOpen && <div className="filter-panel">
        <label>Status<select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}><option value="">All statuses</option>{statusValues.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>From<input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} /></label>
        <label>To<input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} /></label>
        <button className="row-action-button" onClick={() => { setSearch(''); setStatusFilter(''); setDateFrom(''); setDateTo(''); setPage(1); }}>Clear filters</button>
        <span>Exports use these same filters.</span>
      </div>}

      {listQuery.isError && <div className="query-error"><b>Couldn’t load {info.title.toLowerCase()}.</b><span>{listQuery.error.message}</span><button className="secondary-button" onClick={() => listQuery.refetch()}>Try again</button></div>}
      {listQuery.isFetching && <div className="loading-bar"><span /></div>}

      <div className="table-scroll"><table className="data-table module-table">
        <thead><tr>{info.columns.map(col => <th key={col}>{col.toUpperCase()}</th>)}<th className="actions-head">ACTIONS</th></tr></thead>
        <tbody>
          {visibleRows.map((row, ri) => {
            const id = String(row._id || row[0]);
            const avatar = slug === 'accounts' ? rowAvatar(row) : '';
            return <tr key={`${id}-${ri}`}>
              {row.map((value, ci) => <td key={ci} data-label={info.columns[ci]}>
                {isStatus(value) ? <Status value={value} />
                  : ci === 0 && slug === 'accounts' ? <div className="record-user">{avatar ? <img className="record-avatar" src={avatar} alt="" /> : <span className="record-avatar record-avatar-fallback">{initials(value)}</span>}<b className="record-link">{value}</b></div>
                  : ci === 0 ? <b className="record-link">{value}</b> : value}
              </td>)}
              <td className="actions-cell"><div className="row-actions">
                <button className="row-view-button" onClick={() => setDialog({ type: 'view', row, module: slug })}>View</button>
                <button className="row-more-button" aria-label={`More actions for ${row[0]}`} title="More actions" aria-expanded={openRowActions?.id === id} onClick={event => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setOpenRowActions(current => (current?.id === id ? null : { id, top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 290)), left: Math.max(8, Math.min(rect.right - 205, window.innerWidth - 220)) }));
                }}><MoreHorizontal size={19} /></button>
                {openRowActions?.id === id && createPortal(rowMenu(row), document.body)}
              </div></td>
            </tr>;
          })}
          {!visibleRows.length && <tr><td colSpan={info.columns.length + 1} className="empty-state">{listQuery.isLoading ? 'Loading records…' : search ? `No records match “${search}”.` : 'No records yet.'}</td></tr>}
        </tbody>
      </table></div>

      <div className="table-footer">
        <span>Showing <b>{visibleRows.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{Math.min(page * PAGE_SIZE, totalCount)}</b> of <b>{totalCount}</b> records</span>
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))} aria-label="Previous page"><ChevronLeft size={15} /></button>
          <button className="page-active">{page}</button>
          <button disabled={page >= pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))} aria-label="Next page"><ChevronRight size={15} /></button>
        </div>
      </div>
    </section>

    <div className="module-note"><ShieldCheck size={15} /><span>{accessNote}</span></div>
    {renderDialog()}
  </>;
}
