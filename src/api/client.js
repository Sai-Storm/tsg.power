import { supabase, requireSupabase } from './supabase.js';
import { signInWithPassword } from './auth.js';

const READ_VIEW = {
  customers: 'v_customers',
  quotations: 'v_quotations',
  jobs: 'v_jobs',
  'service-reports': 'v_service_reports',
  machines: 'v_machines',
  inventory: 'v_inventory',
  'material-requests': 'v_material_requests',
  suppliers: 'v_suppliers',
  invoices: 'v_invoices',
  'cash-claims': 'v_expenses',
  'my-expense-claims': 'v_expenses',
  expenses: 'v_expenses',
  advances: 'v_advances',
  'my-advances': 'v_advances',
  'cash-entries': 'v_cash_entries',
  'fixed-assets': 'v_fixed_assets',
  staff: 'v_staff',
  salary: 'v_salaries',
  'my-salary': 'v_salaries',
  salaries: 'v_salaries',
  accounts: 'v_profiles',
  users: 'v_profiles',
  notifications: 'v_notifications',
  settings: 'v_settings',
  'recycle-bin': 'v_recycle_bin',
};

const WRITE_TABLE = {
  customers: 'customers',
  quotations: 'quotations',
  jobs: 'jobs',
  'service-reports': 'service_reports',
  machines: 'machines',
  inventory: 'inventory_items',
  'material-requests': 'material_requests',
  suppliers: 'suppliers',
  invoices: 'invoices',
  'cash-claims': 'expenses',
  'my-expense-claims': 'expenses',
  expenses: 'expenses',
  advances: 'advances',
  'my-advances': 'advances',
  'cash-entries': 'cash_entries',
  'fixed-assets': 'fixed_assets',
  staff: 'staff',
  salary: 'salaries',
  'my-salary': 'salaries',
  salaries: 'salaries',
  accounts: 'profiles',
  users: 'profiles',
  notifications: 'notifications',
  settings: 'settings',
  'recycle-bin': 'recycle_bin',
};

const WRITE_COLUMNS = {
  customers: ['name', 'trading_name', 'customer_type', 'tax_number', 'contact_person', 'designation', 'phone', 'email', 'additional_contacts', 'billing_address', 'service_sites', 'payment_terms', 'credit_limit', 'status', 'notes'],
  quotations: ['date', 'valid_until', 'customer_id', 'job_type', 'prepared_by', 'scope_of_work', 'items', 'tax_rate', 'advance_percent', 'payment_terms', 'terms', 'acceptance_evidence', 'subtotal', 'tax', 'total', 'status'],
  jobs: ['job_date', 'job_type', 'priority', 'status', 'department', 'customer_id', 'site_location', 'quotation_id', 'customer_approval', 'payment_terms', 'title', 'machine_id', 'equipment_type', 'equipment_model', 'serial_number', 'equipment_records', 'description', 'scope_of_work', 'expected_result', 'special_instructions', 'planned_start_date', 'planned_end_date', 'site_visit_date', 'team_leader', 'assigned_to', 'assigned_employees', 'assigned_vehicle', 'assignment_date', 'responsibilities', 'materials', 'job_amount', 'additional_charges', 'note', 'notes', 'cancellation_reason'],
  'service-reports': ['job_id', 'service_date', 'started_at', 'finished_at', 'technicians', 'customer_complaint', 'findings', 'work_done', 'parts_used', 'test_results', 'recommendations', 'attachments', 'customer_representative', 'customer_acceptance', 'acceptance_notes', 'technician_signature', 'customer_signature', 'status'],
  machines: ['name', 'customer_id', 'site_location', 'machine_type', 'brand', 'model', 'serial_no', 'capacity', 'capacity_unit', 'fuel_type', 'meter_hours', 'install_date', 'warranty_start', 'warranty_until', 'next_service_date', 'status', 'attachments'],
  inventory: ['sku', 'name', 'category', 'specification', 'unit', 'warehouse', 'supplier_id', 'reorder_level', 'cost_price', 'sell_price', 'status', 'attachments'],
  'material-requests': ['job_id', 'required_date', 'requester_id', 'priority', 'warehouse', 'items', 'note', 'status'],
  suppliers: ['name', 'supplier_type', 'tax_number', 'contact', 'phone', 'email', 'address', 'payment_terms', 'currency', 'bank_beneficiary', 'bank_name', 'bank_account', 'bank_verified', 'status', 'documents'],
  invoices: ['customer_id', 'job_id', 'quotation_id', 'service_report_id', 'date', 'due_date', 'payment_terms', 'items', 'tax_rate', 'subtotal', 'tax', 'additional_charges', 'discount', 'total', 'amount_received', 'status'],
  expenses: ['category', 'office_type', 'job_id', 'supplier_id', 'supplier_name', 'employee_id', 'date', 'amount', 'currency', 'description', 'payment_source', 'advance_id', 'receipt_file', 'exception_reason', 'status', 'approved_by', 'approved_at', 'reimbursed_at'],
  advances: ['staff_id', 'job_id', 'date', 'due_date', 'amount', 'purpose', 'claimed', 'status', 'issued_on', 'issued_by', 'settled_at'],
  'cash-entries': ['type', 'date', 'account', 'reference_type', 'source_id', 'job_id', 'counterparty', 'amount', 'method', 'description', 'attachment', 'status', 'posted_at'],
  'fixed-assets': ['name', 'asset_tag', 'category', 'purchase_date', 'supplier_id', 'purchase_cost', 'residual_value', 'useful_life', 'depreciation_method', 'accumulated_depreciation', 'net_book_value', 'location', 'assigned_to', 'condition', 'status', 'warranty_until', 'attachments'],
  staff: ['name', 'phone', 'email', 'designation', 'join_date', 'salary', 'status', 'profile_id'],
  salary: ['staff_id', 'salary_month', 'basic_salary', 'allowances', 'deductions', 'paid_on', 'payment_method', 'status', 'notes'],
  'my-salary': ['staff_id', 'salary_month', 'basic_salary', 'allowances', 'deductions', 'paid_on', 'payment_method', 'status', 'notes'],
  salaries: ['staff_id', 'salary_month', 'basic_salary', 'allowances', 'deductions', 'paid_on', 'payment_method', 'status', 'notes'],
  users: ['name', 'username', 'avatar', 'phone', 'role', 'is_active'],
  accounts: ['name', 'username', 'avatar', 'phone', 'role', 'is_active'],
  notifications: ['title', 'details', 'related_to', 'is_read', 'user_id'],
};

const SEARCH_COLUMNS = {
  customers: ['name', 'code', 'contact', 'location', 'status'],
  suppliers: ['supplier', 'contact', 'phone', 'email'],
  machines: ['machine', 'customer', 'model', 'serial_no'],
  inventory: ['item', 'sku', 'category', 'specification'],
  'fixed-assets': ['asset', 'code', 'assigned_to_name'],
  quotations: ['number', 'customer', 'status'],
  jobs: ['number', 'customer_machine', 'assigned_to_name', 'title'],
  'service-reports': ['report', 'job_order', 'customer', 'prepared_by'],
  'material-requests': ['request', 'job_order', 'requested_by', 'items_display'],
  invoices: ['number', 'customer', 'status'],
  'cash-claims': ['reference', 'employee_source', 'description', 'job_order'],
  'my-expense-claims': ['voucher', 'description', 'job_order'],
  expenses: ['reference', 'employee_source', 'description', 'job_order'],
  advances: ['advance', 'staff_name', 'purpose'],
  'my-advances': ['advance', 'purpose'],
  'cash-entries': ['number', 'counterparty', 'description'],
  staff: ['staff_member', 'employee_id', 'designation'],
  salary: ['voucher', 'staff_member'],
  'my-salary': ['voucher', 'staff_member'],
  salaries: ['voucher', 'staff_member'],
  accounts: ['user', 'username', 'role'],
  users: ['user', 'username', 'role'],
  notifications: ['notification', 'details'],
  settings: ['setting', 'current_value'],
  'recycle-bin': ['module', 'record', 'deleted_by'],
};

const FILTER_DATE = {
  customers: { name: 'created_at', timestamp: true },
  suppliers: { name: 'created_at', timestamp: true },
  machines: { name: 'created_at', timestamp: true },
  inventory: { name: 'created_at', timestamp: true },
  'fixed-assets': { name: 'purchased' },
  quotations: { name: 'date' },
  jobs: { name: 'due_date' },
  'service-reports': { name: 'delivered' },
  'material-requests': { name: 'date' },
  invoices: { name: 'issued' },
  'cash-claims': { name: 'date' },
  'my-expense-claims': { name: 'date' },
  expenses: { name: 'date' },
  advances: { name: 'issued' },
  'my-advances': { name: 'issued' },
  'cash-entries': { name: 'date' },
  staff: { name: 'created_at', timestamp: true },
  salary: { name: 'paid_on' },
  'my-salary': { name: 'paid_on' },
  salaries: { name: 'paid_on' },
  accounts: { name: 'created', timestamp: true },
  users: { name: 'created', timestamp: true },
  notifications: { name: 'received', timestamp: true },
  settings: { name: 'updated', timestamp: true },
  'recycle-bin': { name: 'deleted_date', timestamp: true },
};

const ORDER_COLUMN = {
  settings: 'updated',
  'recycle-bin': 'deleted_date',
  'my-advances': 'issued',
  advances: 'issued',
};

const REPORT_SOURCES = {
  'job-register': 'jobs',
  'quotation-register': 'quotations',
  'machine-service-history': 'machines',
  'invoice-register': 'invoices',
  'receivables-aging': 'invoices',
  'cash-book': 'cash-claims',
  'income-expense': 'cash-claims',
  'advance-outstanding': 'my-advances',
  'expense-claims': 'my-expense-claims',
  'inventory-stock': 'inventory',
  'material-usage-job': 'material-requests',
  'supplier-register': 'suppliers',
  'fixed-asset-register': 'fixed-assets',
};

function parsePath(path) {
  const raw = String(path || '');
  const [pathname, search = ''] = raw.split('?');
  return {
    pathname: pathname.startsWith('/') ? pathname : `/${pathname}`,
    params: new URLSearchParams(search),
  };
}

function errorMessage(error) {
  return error?.message || 'The request could not be completed.';
}

async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(errorMessage(error));
  return data;
}

function clean(payload) {
  return Object.fromEntries(
    Object.entries(payload || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, value]),
  );
}

function filterColumns(resource, payload) {
  const columns = WRITE_COLUMNS[resource];
  if (!columns) return clean(payload);
  const filtered = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, column)) filtered[column] = payload[column];
  }
  return clean(filtered);
}

function preparePayload(resource, payload) {
  const prepared = filterColumns(resource, payload);
  if (resource === 'machines' && !prepared.name) {
    prepared.name = [prepared.brand, prepared.model].filter(Boolean).join(' ') || prepared.machine_type || 'Machine';
  }
  if (resource === 'jobs') {
    const assigned = Boolean(prepared.assigned_to || prepared.team_leader || (Array.isArray(prepared.assigned_employees) && prepared.assigned_employees.length));
    if (assigned && (!prepared.status || /^(draft|new)$/i.test(prepared.status))) {
      prepared.status = prepared.planned_start_date || prepared.planned_end_date ? 'Scheduled' : 'Assigned';
    }
  }
  return prepared;
}

async function readBody(options) {
  const body = options?.body;
  if (!body) return {};
  if (typeof FormData !== 'undefined' && body instanceof FormData) return uploadFormData(body);
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

async function uploadFile(file) {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id || 'anonymous';
  const safeName = String(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '-');
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const { error } = await supabase.storage.from('attachments').upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (error) throw new Error(errorMessage(error));
  const { data } = supabase.storage.from('attachments').getPublicUrl(path);
  return data.publicUrl;
}

async function uploadFormData(form) {
  const payload = {};
  for (const [key, value] of form.entries()) {
    let next = value;
    if (typeof File !== 'undefined' && value instanceof File) {
      next = await uploadFile(value);
    } else if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try { next = JSON.parse(value); } catch { next = value; }
    }
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = Array.isArray(payload[key]) ? [...payload[key], next] : [payload[key], next];
    } else {
      payload[key] = next;
    }
  }
  return payload;
}

async function listResource(resource, params) {
  const view = READ_VIEW[resource] || resource;
  let query = supabase.from(view).select('*', { count: 'exact' });

  const status = params.get('status');
  if (status) query = query.ilike('status', status);

  const date = FILTER_DATE[resource];
  const from = params.get('from');
  const to = params.get('to');
  if (date && from) query = query.gte(date.name, from);
  if (date && to) query = query.lte(date.name, date.timestamp ? `${to}T23:59:59` : to);

  const search = params.get('search');
  const searchColumns = SEARCH_COLUMNS[resource] || [];
  if (search && searchColumns.length) {
    const term = String(search).replace(/[(),]/g, ' ').trim();
    if (term) query = query.or(searchColumns.map(column => `${column}.ilike.%${term}%`).join(','));
  }

  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = Math.min(5000, Math.max(1, Number(params.get('limit')) || 10));
  query = query
    .order(ORDER_COLUMN[resource] || 'created_at', { ascending: false, nullsFirst: false })
    .range((page - 1) * limit, page * limit - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(errorMessage(error));
  return { items: data || [], total: count ?? (data?.length || 0), page, limit };
}

async function getResource(resource, id) {
  const view = READ_VIEW[resource] || resource;
  const { data, error } = await supabase.from(view).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(errorMessage(error));
  return data;
}

async function invokeAdmin(action, payload) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: { action, ...payload } });
  if (error) {
    try {
      const body = await error.context?.json?.();
      if (body?.error) throw new Error(body.error);
    } catch (inner) {
      if (inner instanceof Error && inner.message && inner.message !== 'Failed to fetch') throw inner;
    }
    throw new Error(errorMessage(error));
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function createAccount(payload) {
  const email = String(payload?.email || '').trim();
  if (!email) throw new Error('An email address is required for the new account.');
  const result = await invokeAdmin('create', {
    email,
    password: payload.password,
    name: payload.name,
    username: payload.username,
    role: payload.role,
    avatar: payload.avatar,
  });
  return result.user;
}

async function updateUser(id, payload) {
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'is_active')) {
    return (await invokeAdmin('set-active', { user_id: id, is_active: Boolean(payload.is_active) })).user;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'role')) {
    return (await invokeAdmin('set-role', { user_id: id, role: payload.role })).user;
  }
  const updates = filterColumns('users', payload);
  const { data: sessionData } = await supabase.auth.getSession();
  if (payload?.password) {
    if (sessionData?.session?.user?.id === id) {
      const { error } = await supabase.auth.updateUser({ password: payload.password });
      if (error) throw new Error(errorMessage(error));
    } else {
      await invokeAdmin('reset-password', { user_id: id, password: payload.password });
    }
  }
  if (Object.keys(updates).length) {
    const { error } = await supabase.from('profiles').update(updates).eq('id', id);
    if (error) throw new Error(errorMessage(error));
  }
  return getResource('users', id);
}

async function saveSettings(payload) {
  const entries = Object.entries(payload || {}).filter(([, value]) => value !== '' && value != null && typeof value !== 'object');
  if (!entries.length) throw new Error('Enter at least one setting value.');
  for (const [key, value] of entries) {
    const label = key.replaceAll('_', ' ').replace(/(^|\s)\S/g, letter => letter.toUpperCase());
    const { error } = await supabase.from('settings').upsert({
      key,
      label,
      value: String(value),
      updated_by: (await supabase.auth.getUser()).data?.user?.id || null,
    }, { onConflict: 'key' });
    if (error) throw new Error(errorMessage(error));
  }
  return { ok: true };
}

async function updateSetting(id, payload) {
  const value = payload?.[id] ?? payload?.value ?? payload?.current_value;
  if (value === undefined || value === null || value === '') throw new Error('Enter a value to save this setting.');
  const { error } = await supabase.from('settings').update({
    value: String(value),
    updated_by: (await supabase.auth.getUser()).data?.user?.id || null,
  }).eq('key', id);
  if (error) throw new Error(errorMessage(error));
  const { data, error: readError } = await supabase.from('v_settings').select('*').eq('id', id).maybeSingle();
  if (readError) throw new Error(errorMessage(readError));
  return data;
}

async function insertResource(resource, payload) {
  if (resource === 'users' || resource === 'accounts') return createAccount(payload);
  if (resource === 'settings') return saveSettings(payload);
  const table = WRITE_TABLE[resource] || resource;
  const prepared = preparePayload(resource, payload);
  const { data, error } = await supabase.from(table).insert(prepared).select().single();
  if (error) throw new Error(errorMessage(error));
  return data;
}

async function updateResource(resource, id, payload) {
  if (resource === 'users' || resource === 'accounts') return updateUser(id, payload);
  if (resource === 'settings') return updateSetting(id, payload);
  const table = WRITE_TABLE[resource] || resource;
  const prepared = preparePayload(resource, payload);
  if (!Object.keys(prepared).length) throw new Error('There are no changes to save.');
  const { data, error } = await supabase.from(table).update(prepared).eq('id', id).select().maybeSingle();
  if (error) throw new Error(errorMessage(error));
  return data;
}

async function deleteResource(resource, id, params) {
  if (resource === 'users' || resource === 'accounts') {
    await invokeAdmin('set-active', { user_id: id, is_active: false });
    return null;
  }
  if (resource === 'recycle-bin') {
    await rpc('purge_recycle_entry', { p_id: id });
    return null;
  }
  await rpc('soft_delete_record', {
    p_resource: resource,
    p_id: id,
    p_mode: params.get('force') === 'true' ? 'Force' : 'Restricted',
  });
  return null;
}

async function workflowRoute(resource, id, action, payload) {
  if (resource === 'recycle-bin' && action === 'restore') return rpc('restore_recycle_entry', { p_id: id });

  if (resource === 'jobs') {
    if (action === 'status') return rpc('set_job_status', { p_job: id, p_status: payload?.status });
    if (action === 'close') return rpc('close_job', {
      p_job: id,
      p_payment_status: payload?.payment_status ?? null,
      p_payment_amount: payload?.payment_amount ?? 0,
      p_due_date: payload?.due_date ?? null,
    });
    if (action === 'assign') return rpc('assign_job', { p_job: id, p_payload: payload || {} });
    if (action === 'service-report') {
      const report = { ...(payload || {}) };
      if (report.customer_representative == null && report.customer_name != null) report.customer_representative = report.customer_name;
      if (report.customer_acceptance == null && report.customer_approval != null) report.customer_acceptance = report.customer_approval ? 'Accepted' : 'Not accepted';
      if (report.technicians == null && report.technician_name != null) report.technicians = [{ name: report.technician_name }];
      if (typeof report.attachments === 'string') report.attachments = [report.attachments];
      if (typeof report.parts_used === 'string' && report.parts_used.trim()) report.parts_used = [{ description: report.parts_used }];
      return rpc('submit_service_report', { p_job: id, p_payload: report });
    }
  }

  if (resource === 'invoices' && action === 'payments') {
    return rpc('record_invoice_payment', { p_invoice: id, p_payload: payload || {} });
  }

  if (resource === 'advances') {
    if (action === 'issue') return rpc('issue_advance', { p_advance: id, p_payload: payload || {} });
    if (action === 'claim') return rpc('claim_advance', { p_advance: id, p_payload: payload || {} });
    if (action === 'settle') return rpc('settle_advance', { p_advance: id, p_amount: payload?.amount ?? 0 });
    if (action === 'approve') return rpc('set_advance_status', { p_advance: id, p_status: 'Approved' });
    if (action === 'reject') return rpc('set_advance_status', { p_advance: id, p_status: 'Rejected' });
  }

  if (resource === 'expenses') {
    const status = { approve: 'Approved', reject: 'Rejected', pay: 'Paid' }[action];
    if (status) return rpc('set_expense_status', { p_expense: id, p_status: status });
  }

  if (resource === 'cash-entries') {
    const status = { approve: 'Approved', reject: 'Rejected', post: 'Posted' }[action];
    if (status) return rpc('set_cash_entry_status', { p_entry: id, p_status: status });
  }

  if (resource === 'quotations' && action === 'convert-to-job') {
    return rpc('convert_quotation_to_job', { p_quotation: id });
  }

  if (resource === 'material-requests' && (action === 'issue' || action === 'return')) {
    return rpc('stock_movement', {
      p_request: id,
      p_item: payload?.item_id,
      p_type: action,
      p_payload: payload || {},
    });
  }

  return undefined;
}

export async function apiRequest(path, options = {}) {
  const client = requireSupabase();
  const { pathname, params } = parsePath(path);
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) throw new Error('Invalid API path.');

  const method = String(options.method || 'GET').toUpperCase();
  const resource = parts[0];
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  const action = parts[2] || null;
  const payload = method === 'GET' ? null : await readBody(options);

  if (method === 'GET') {
    if (resource === 'dashboard') return rpc('dashboard_summary');
    if (resource === 'reports') return { items: [] };
    if (id) return getResource(resource, id);
    return listResource(resource, params);
  }

  if (method === 'DELETE') return deleteResource(resource, id, params);

  if (resource === 'users') {
    if (action === 'reset-password') {
      const result = await invokeAdmin('reset-password', { user_id: id, password: payload?.password });
      return result;
    }
    if (method === 'POST') return createAccount(payload);
    if (method === 'PUT') return updateUser(id, payload);
  }

  if (method === 'POST' && action) {
    const result = await workflowRoute(resource, id, action, payload);
    if (result !== undefined) return result;
  }

  if (method === 'POST') return insertResource(resource, payload);
  if (method === 'PUT' || method === 'PATCH') return updateResource(resource, id, payload);

  throw new Error(`Unsupported request: ${method} ${pathname}`);
}

export async function signIn(email, password) {
  return signInWithPassword(email, password);
}

function toCsv(rows) {
  const keys = rows.length
    ? Object.keys(rows[0]).filter(key => !['id', 'record'].includes(key) && !key.endsWith('_id') && !key.endsWith('_by') && key !== 'created_at' && key !== 'updated_at' && key !== 'is_read' && key !== 'is_active')
    : [];
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [keys.map(key => quote(key.replaceAll('_', ' '))).join(',')];
  for (const row of rows) {
    lines.push(keys.map(key => {
      const value = row[key];
      if (value == null) return '""';
      return quote(typeof value === 'object' ? JSON.stringify(value) : value);
    }).join(','));
  }
  return lines.join('\r\n');
}

function downloadCsv(rows, filename) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function printRows(rows, title) {
  const keys = rows.length ? Object.keys(rows[0]).filter(key => !['id', 'record'].includes(key) && !key.endsWith('_id') && !key.endsWith('_by') && key !== 'created_at' && key !== 'updated_at') : [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:12px/1.45 Arial,sans-serif;margin:24px;color:#172033}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #cdd7e4;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eef4fb}@media print{body{margin:0}}</style></head><body><h1>${escape(title)}</h1><p>Generated ${escape(new Date().toLocaleString())}</p><table><thead><tr>${keys.map(key => `<th>${escape(key.replaceAll('_', ' '))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${keys.map(key => `<td>${escape(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
  const win = window.open('', '_blank');
  if (!win) throw new Error('Allow pop-ups to export this report.');
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

export async function exportModule(module, format, filters = {}) {
  requireSupabase();
  const reportId = String(module).startsWith('reports/') ? String(module).slice('reports/'.length) : null;
  const resource = reportId ? (REPORT_SOURCES[reportId] || 'jobs') : module;
  const params = new URLSearchParams({ page: '1', limit: '5000', ...filters });
  const result = await listResource(resource, params);
  const rows = result.items || [];
  if (format === 'pdf') {
    printRows(rows, reportId ? reportId.replaceAll('-', ' ') : resource.replaceAll('-', ' '));
    return;
  }
  downloadCsv(rows, `${reportId || resource}.csv`);
}
