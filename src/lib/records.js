// Turning API records into table rows (and back), plus small shared helpers.

const STATUS_WORDS = /^(active|inactive|in stock|received|paid|approved|completed|unread|sent|accepted|in progress|scheduled|submitted|pending|pending approval|draft|open|low stock|overdue|waiting for parts|partially paid|partially issued|unpaid|rejected|cancelled|new|assigned|issued|settled|reviewed|expired|on hold|closed - paid|closed - pending payment|void|credited|under review|settlement approved)$/i;

export function isStatus(value) {
  return typeof value === 'string' && STATUS_WORDS.test(value);
}

export function normalizeCurrency(value) {
  if (typeof value !== 'string') return value;
  if (!/^(₹|INR|Rs\.?|MMK)\s*[\d,]+(?:\.\d+)?$/i.test(value.trim())) return value;
  const amount = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(amount) ? `MMK ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : value;
}

/** Module slug -> API resource name. */
export function apiEndpoint(slug) {
  return ({ accounts: 'users', 'my-expense-claims': 'expenses', salary: 'salaries' })[slug] || slug;
}

export function formatMoney(value) {
  return `MMK ${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function amountNumber(value) {
  return Number(String(value ?? 0).replace(/[^0-9.-]/g, '')) || 0;
}

export function lookupRecords(_resource, response) {
  return Array.isArray(response) ? response : response?.items || response?.data || response?.results || [];
}

const LIST_ALIASES = {
  customer: ['customer_name', 'name'], contact: ['contact_person', 'phone'], 'customer · machine': ['machine_name', 'title'],
  'job order': ['number', 'job_number'], quotation: ['number', 'quotation_number'], invoice: ['number', 'invoice_number'],
  request: ['number', 'request_number'], voucher: ['voucher_no', 'number'], report: ['number', 'report_number'],
  'assigned to': ['assigned_to_name', 'staff_name'], 'serial number': ['serial_no'], 'on hand': ['qty_on_hand'],
  'reorder at': ['reorder_level'], 'valid until': ['valid_until'], 'due date': ['due_date'], 'last login': ['last_login'],
  created: ['created_at'], items: ['items_display'],
};

/**
 * API list payload -> table rows, one cell per column label. Each row keeps the
 * original record on the hidden `_record` property and its id on `_id`, so
 * actions never depend on the column position.
 */
export function normalizeList(payload, columns) {
  const list = Array.isArray(payload) ? payload : payload?.items || payload?.data || payload?.results || [];
  if (!Array.isArray(list)) return [];
  return list.map(record => {
    if (Array.isArray(record)) return record.map(normalizeCurrency);
    const values = columns.map(label => {
      if (label.toLowerCase() === 'items' && record?.items_display != null) return normalizeCurrency(String(record.items_display));
      const alias = LIST_ALIASES[label.toLowerCase()] || [];
      const displayName = alias.filter(key => key.endsWith('_name')).map(key => record?.[key]).find(value => value != null);
      if (displayName != null) return normalizeCurrency(String(displayName));
      const wanted = label.toLowerCase().replace(/[^a-z0-9]/g, '');
      const pair = Object.entries(record || {}).find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
      if (pair) return pair[1] == null ? '—' : normalizeCurrency(String(pair[1]));
      const found = alias.map(key => record?.[key]).find(value => value != null);
      return found == null ? '—' : normalizeCurrency(String(found));
    });
    Object.defineProperty(values, '_id', { value: record?.id ?? record?.uuid ?? record?.[Object.keys(record || {})[0]], enumerable: false });
    Object.defineProperty(values, '_record', { value: record, enumerable: false });
    return values;
  });
}

/** Read a cell by column label instead of by position. */
export function cell(row, columns, pattern) {
  const index = columns.findIndex(column => (pattern instanceof RegExp ? pattern.test(column) : column.toLowerCase() === String(pattern).toLowerCase()));
  return index >= 0 ? row?.[index] : undefined;
}

export function toApiRecord(columns, values) {
  return Object.fromEntries(columns.map((column, i) => [
    column.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    values?.[i] || '',
  ]));
}

const DISPLAY_ALIASES = {
  customer: ['customer_name', 'legal_name', 'customer_id', 'name'], supplier: ['supplier_name', 'name'], machine: ['machine_name', 'name', 'model'],
  location: ['site_location', 'billing_address', 'address'], asset: ['name'], item: ['name'], code: ['id', 'sku'],
  quotation: ['number', 'quotation_number'], 'job order': ['number', 'job_number', 'title'], invoice: ['number', 'invoice_number'],
  request: ['number', 'request_number'], voucher: ['voucher_no', 'number'], report: ['number', 'report_number'],
  'customer · machine': ['machine_name', 'title'], contact: ['contact_person', 'phone'], 'due date': ['due_date'],
  'serial number': ['serial_no'], amount: ['amount', 'total'], 'assigned to': ['assigned_to_name', 'assigned_to'],
};

export function toDisplayRow(columns, payload) {
  return columns.map(label => {
    const key = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const alias = DISPLAY_ALIASES[label.toLowerCase()] || [];
    const keys = [...alias.filter(name => name.endsWith('_name')), key, ...alias.filter(name => !name.endsWith('_name'))];
    const value = keys
      .map(name => payload?.[name] ?? payload?.[name.replace(/_([a-z])/g, (_, char) => char.toUpperCase())])
      .find(item => item != null && item !== '');
    return value == null ? '—' : String(value);
  });
}

/** JSON body, or multipart FormData when the payload contains files. */
export function requestBody(payload) {
  const values = Object.entries(payload || {});
  const isFile = value => typeof File !== 'undefined' && value instanceof File;
  const hasFile = values.some(([, value]) => isFile(value) || (Array.isArray(value) && value.some(isFile)));
  if (!hasFile) return JSON.stringify(payload);
  const form = new FormData();
  for (const [key, value] of values) {
    if (value == null || value === '') continue;
    if (isFile(value)) form.append(key, value);
    else if (Array.isArray(value) && value.some(isFile)) value.forEach(item => { if (isFile(item)) form.append(key, item); });
    else if (typeof value === 'object') form.append(key, JSON.stringify(value));
    else form.append(key, String(value));
  }
  return form;
}

/** Options for lookup <select>s, built from API records. */
export function lookupOptions(resource, response, field = {}) {
  const raw = lookupRecords(resource, response);
  return raw
    .filter(record => resource !== 'quotations' || ['approved', 'accepted'].includes(String(record.status || '').toLowerCase()))
    .filter(record => !field.allowedStatuses?.length || field.allowedStatuses.includes(String(record.status || '').toLowerCase()))
    .map(record => ({
      value: record.id ?? record.uuid ?? record.code ?? record.number,
      label: record.name || record.legal_name || record.legal_company_name || record.title || record.number || record.code || record.username || String(record.id),
    }));
}

export const initials = (name = '') => name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();
export const rowAvatar = row => row?._record?.avatar || row?._record?.profile_picture || '';
