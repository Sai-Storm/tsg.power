// Printable documents (invoice, quotation, job order, …) and list reports.
import * as pdf from '../pdfTemplate.js';
import { alertDialog } from '../components/AskDialog.jsx';

const documentLabels = {
  invoices: 'invoice',
  income: 'invoice',
  quotations: 'quotation',
  customers: 'customer report',
  jobs: 'job order',
  'service-reports': 'service report',
  'cash-claims': 'expense voucher',
  salary: 'salary slip',
};
export function documentLabel(module) {
  return documentLabels[module] || 'record';
}
export function canPrintDocument(module, row) {
  return (
    ['invoices', 'income', 'quotations', 'customers', 'jobs', 'service-reports'].includes(module) ||
    (module === 'cash-claims' && !/^cash/i.test(String(row?.[1] || ''))) ||
    (module === 'salary' && /^paid$/i.test(String(row?.[5] || '')))
  );
}
export function humanizeKey(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, char => char.toUpperCase());
}
export function printableValue(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (/^data:[^,]*,/i.test(text) && text.length > 120) return '[attachment]';
    if ((text.startsWith('[') || text.startsWith('{')) && text.length > 1) {
      try {
        return printableValue(JSON.parse(text));
      } catch {
        return text;
      }
    }
    return text;
  }
  if (typeof value === 'number')
    return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value))
    return value
      .map(item => printableValue(item))
      .filter(Boolean)
      .join('\n');
  if (typeof value === 'object') {
    const name = value.description ?? value.name ?? value.item_name ?? value.item ?? value.title;
    const qty = value.qty ?? value.quantity;
    const unit = value.unit ?? value.uom;
    const price = value.unit_price ?? value.price ?? value.rate;
    if (name != null && (qty != null || price != null)) {
      const parts = [String(name)];
      if (qty != null && qty !== '') parts.push(`${printableValue(qty)}${unit ? ` ${unit}` : ''}`);
      if (price != null && price !== '') parts.push(printableValue(price));
      Object.entries(value).forEach(([key, entry]) => {
        if (
          ['description', 'name', 'item_name', 'item', 'title', 'qty', 'quantity', 'unit', 'uom', 'unit_price', 'price', 'rate'].includes(
            key,
          )
        )
          return;
        if (entry == null || entry === '' || entry === 0 || entry === false) return;
        parts.push(`${humanizeKey(key)}: ${printableValue(entry)}`);
      });
      return parts.join(' — ');
    }
    const entries = Object.entries(value).filter(([, entry]) => entry != null && entry !== '');
    return entries.map(([key, entry]) => `${humanizeKey(key)}: ${printableValue(entry)}`).join(' · ');
  }
  return String(value);
}
export function printRecordDocument(module, row, columns) {
  if (module === 'income') module = 'invoices';
  const record = row?._record || {};
  const normalize = key =>
    String(key || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const byColumn = Object.fromEntries(columns.map((column, index) => [normalize(column), row?.[index]]));
  const get = (...keys) => {
    for (const key of keys) {
      const normalized = normalize(key);
      const entry = Object.entries(record).find(([name]) => normalize(name) === normalized);
      const value = entry?.[1] ?? byColumn[normalized];
      if (value != null && value !== '') return value;
    }
    return '';
  };
  const text = (...keys) => printableValue(get(...keys));
  const num = value => Number(String(value ?? 0).replace(/[^0-9.-]/g, '')) || 0;
  const lineItems = raw => {
    let list = raw;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        list = [];
      }
    }
    return (Array.isArray(list) ? list : [])
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const qty = item.qty ?? item.quantity ?? 1;
        const unitPrice = item.unit_price ?? item.rate ?? item.price ?? '';
        return {
          description: item.description || item.name || item.item_name || 'Item',
          qty,
          unit: item.unit || item.uom || '',
          unit_price: unitPrice,
          amount: item.amount ?? item.total ?? Math.max(0, num(qty) * num(unitPrice) - num(item.discount)),
        };
      });
  };
  const longText = (heading, value) => (value ? `${pdf.sectionTitle(heading)}<p class="text">${pdf.escLines(value)}</p>` : '');
  const attention = text('attention', 'customer_contact', 'contact_person');
  const customerBlock = () =>
    pdf.block(
      [
        ['Attention:', attention && `:${attention}`],
        ['Address:', text('customer_address', 'billing_address', 'address')],
      ],
      text('po_number') ? `PO - ${text('po_number')}` : '',
    );
  const number = String(row?.[0] || text('number') || 'Record');
  let title = documentLabel(module).toUpperCase();
  let body = '';

  if (module === 'invoices' || module === 'quotations') {
    const isInvoice = module === 'invoices';
    title = isInvoice ? 'SERVICE INVOICE' : 'QUOTATION';
    const total = num(get('total', 'grand_total', 'invoice_amount') || (isInvoice ? 0 : row?.[4]));
    const subtotal = get('subtotal') !== '' ? num(get('subtotal')) : total;
    const items = lineItems(get('items', 'line_items', 'invoice_items'));
    const rows = items.length
      ? items
      : [
          {
            description: text('job_title', 'description', 'scope_of_work') || 'Service charges',
            qty: 1,
            unit: '',
            unit_price: subtotal,
            amount: subtotal,
          },
        ];
    const tax = num(get('tax'));
    const charges = num(get('additional_charges'));
    const discount = num(get('discount'));
    const rate = num(get('tax_rate'));
    const totals = [];
    if (tax || charges || discount) {
      totals.push(['Sub Total', subtotal, '']);
      if (charges) totals.push(['Additional Charges', charges, 'plain']);
      if (discount) totals.push(['Discount', -discount, 'plain']);
      if (tax) totals.push([`Tax${rate ? ` (${rate}%)` : ''}`, tax, 'plain']);
    }
    totals.push([isInvoice ? 'Net Invoice Amt' : 'Total Quotation Amt', total, 'total']);
    const received = isInvoice ? num(get('amount_received')) : 0;
    if (received > 0) {
      totals.push(['Amount Received', received, 'plain']);
      totals.push(['Balance Due', Math.max(0, total - received), 'plain']);
    }
    const right = isInvoice
      ? [
          ['Work Order No.', text('job_number') && `:${text('job_number')}`],
          ['Invoice No.', `:${number}`],
          ['Invoice Date', pdf.formatDate(get('date', 'issued', 'invoice_date') || row?.[2])],
        ]
      : [
          ['Quotation No.', `:${number}`],
          ['Date', pdf.formatDate(get('date') || row?.[2])],
          ['Valid Until', pdf.formatDate(get('valid_until') || row?.[3])],
        ];
    const terms = isInvoice
      ? [
          ['Payment Terms', text('payment_terms')],
          ['Due Date', pdf.formatDate(get('due_date') || row?.[3])],
        ]
      : [
          ['Payment Terms', text('payment_terms')],
          ['Advance Payment', num(get('advance_percent')) ? `${num(get('advance_percent'))}%` : ''],
        ];
    body =
      `<h1 class="doc-title">${title}</h1><div class="header">${pdf.kv([
        ['Customer Name', text('customer_name', 'customer') || row?.[1], { strong: true, keep: true }],
        ['Machine/KVA/Sr', text('machine_label')],
      ])}${pdf.kv(right, 'right')}</div>` +
      customerBlock() +
      pdf.jobType('Job Type', isInvoice ? text('job_title') || text('description') : text('job_type')) +
      (isInvoice ? '' : longText('Scope of Work', text('scope_of_work'))) +
      pdf.itemsTable(rows, totals) +
      (terms.some(([, value]) => value) ? `<div style="margin-top:6mm">${pdf.kv(terms)}</div>` : '') +
      (isInvoice ? '' : longText('Terms & Conditions', text('terms'))) +
      (isInvoice
        ? `${pdf.signatory()}<div class="spacer"></div>${pdf.bankDetails()}`
        : `<div class="spacer"></div>${pdf.signatures(
            `${pdf.COMPANY.signatory.name}
${pdf.COMPANY.signatory.title}`,
            'Customer Acceptance',
          )}`);
  } else if (module === 'jobs') {
    title = 'JOB ORDER';
    const machine =
      text('machine_label') ||
      [text('equipment_type'), text('equipment_model'), text('serial_number') && `Sr ${text('serial_number')}`].filter(Boolean).join(' · ');
    const materials = lineItems(get('materials'));
    body =
      `<h1 class="doc-title">${title}</h1><div class="header">${pdf.kv([
        ['Customer Name', text('customer_name', 'customer') || String(row?.[1] || '').split(' · ')[0], { strong: true, keep: true }],
        ['Machine/KVA/Sr', machine],
        ['Site', text('site_location')],
      ])}${pdf.kv(
        [
          ['Job Order No.', `:${number}`],
          ['Job Date', pdf.formatDate(get('job_date'))],
          ['Priority', text('priority') || row?.[4]],
          ['Status', text('status') || row?.[5]],
        ],
        'right',
      )}</div>` +
      customerBlock() +
      pdf.jobType('Job Type', [text('job_type'), text('title')].filter(Boolean).join(' – ')) +
      longText('Job Description', text('description')) +
      longText('Scope of Work', text('scope_of_work')) +
      longText('Special Instructions', text('special_instructions')) +
      `${pdf.sectionTitle('Schedule & Team')}${pdf.kv([
        ['Planned Start', pdf.formatDate(get('planned_start_date'))],
        ['Expected Completion', pdf.formatDate(get('planned_end_date', 'due_date') || row?.[3])],
        ['Site Visit', pdf.formatDate(get('site_visit_date'))],
        ['Team Leader', text('team_leader_name')],
        ['Lead Technician', text('assigned_to_name') || row?.[2]],
        ['Responsibilities', text('responsibilities')],
      ])}` +
      (materials.length
        ? `${pdf.sectionTitle('Materials & Spare Parts')}${pdf.gridTable(
            ['No.', 'Description', 'Qty', 'Unit'],
            materials.map((item, index) => [String(index + 1), item.description, printableValue(item.qty), item.unit]),
          )}`
        : '') +
      (num(get('job_amount')) || num(get('additional_charges'))
        ? `${pdf.sectionTitle('Charges')}${pdf.kv([
            ['Quoted Amount', num(get('job_amount')) ? pdf.amount(get('job_amount')) : ''],
            ['Additional Charges', num(get('additional_charges')) ? pdf.amount(get('additional_charges')) : ''],
            ['Payment Terms', text('payment_terms')],
          ])}`
        : '') +
      longText('Notes', text('note')) +
      '<div class="spacer"></div>' +
      pdf.signatures('Team Leader', 'Customer Acknowledgement');
  } else if (module === 'service-reports') {
    title = 'SERVICE REPORT';
    const contact = text('customer_representative', 'contact_person');
    body =
      `<h1 class="doc-title">${title}</h1><div class="header">${pdf.kv([
        ['Customer Name', text('customer_name', 'customer') || row?.[2], { strong: true, keep: true }],
        ['Machine/KVA/Sr', text('machine_label', 'machine_name', 'equipment_type')],
        ['Technicians', text('technician_name', 'technicians', 'prepared_by') || row?.[4]],
      ])}${pdf.kv(
        [
          ['Report No.', `:${number}`],
          ['Job Order No.', `:${text('job_order', 'job_number', 'job') || row?.[1] || ''}`],
          ['Service Date', pdf.formatDate(get('service_date', 'delivered', 'delivered_at') || row?.[3])],
          ['Status', text('status') || row?.[5]],
        ],
        'right',
      )}</div>` +
      pdf.block([
        ['Contact:', contact && `:${contact}`],
        ['Address:', text('address', 'site_location')],
      ]) +
      pdf.kv([
        ['Started', printableValue(get('started_at')).replace('T', ' ')],
        ['Finished', printableValue(get('finished_at')).replace('T', ' ')],
      ]) +
      longText('Customer Complaint', text('customer_complaint', 'complaint', 'reported_issue')) +
      longText('Findings / Diagnosis', text('findings', 'diagnosis')) +
      longText('Work Performed', text('work_done', 'work_performed')) +
      longText('Parts Used', text('parts_used')) +
      longText('Test Results', text('test_results')) +
      longText('Recommendations', text('recommendations', 'remarks')) +
      longText('Customer Acceptance', [text('customer_acceptance'), text('acceptance_notes')].filter(Boolean).join(' – ')) +
      '<div class="spacer"></div>' +
      pdf.signatures('Technician', 'Customer');
  } else if (module === 'customers') {
    title = 'CUSTOMER REPORT';
    const machines = get('machines', 'equipment', 'installed_machines');
    const jobs = get('jobs', 'job_orders', 'service_history');
    const contact = text('contact_person', 'contact');
    body =
      `<h1 class="doc-title">${title}</h1><div class="header">${pdf.kv([
        ['Customer Name', text('name', 'customer') || row?.[0], { strong: true, keep: true }],
        ['Trading Name', text('trading_name')],
        ['Customer Type', text('customer_type')],
        ['Tax / Reg. No.', text('tax_number')],
      ])}${pdf.kv(
        [
          ['Customer Code', `:${text('number', 'code') || row?.[1] || ''}`],
          ['Phone', text('phone')],
          ['Email', text('email')],
          ['Status', text('status') || row?.[5]],
        ],
        'right',
      )}</div>` +
      pdf.block([
        ['Attention:', contact && `:${contact}`],
        ['Address:', text('billing_address', 'address', 'location')],
      ]) +
      `${pdf.sectionTitle('Account')}${pdf.kv(
        [
          ['Payment Terms', text('payment_terms')],
          ['Credit Limit', num(get('credit_limit')) ? pdf.amount(get('credit_limit')) : ''],
          ['Service Sites', text('service_sites')],
          ['Other Contacts', text('additional_contacts')],
        ],
        '',
      )}` +
      `${pdf.sectionTitle('Installed Equipment')}${
        Array.isArray(machines) && machines.length
          ? pdf.gridTable(
              ['Machine', 'Type', 'Serial No.', 'Location'],
              machines.map(item => [
                item.name || item.machine_name || item.model,
                item.type || item.machine_type,
                item.serial_no || item.serial_number,
                item.location || item.site_location,
              ]),
            )
          : `<p class="text">${pdf.esc(printableValue(machines) || row?.[3] || 'No equipment recorded.')}</p>`
      }` +
      (Array.isArray(jobs) && jobs.length
        ? `${pdf.sectionTitle('Service History')}${pdf.gridTable(
            ['Job', 'Date', 'Service', 'Status'],
            jobs.map(item => [
              item.number || item.job_number,
              pdf.formatDate(item.date || item.created_at),
              item.description || item.title,
              item.status,
            ]),
          )}`
        : '') +
      longText('Notes', text('notes'));
  } else if (module === 'salary') {
    title = 'SALARY SLIP';
    const basic = num(get('basic_salary', 'basic') || get('net_pay') || row?.[3]);
    const allowances = num(get('allowances', 'allowance'));
    const deductions = num(get('deductions', 'deduction'));
    const net = num(get('net_pay', 'net_salary', 'net') || row?.[3]) || Math.max(0, basic + allowances - deductions);
    const lines = [
      { description: 'Basic Salary', amount: basic },
      ...(allowances ? [{ description: 'Allowances', amount: allowances }] : []),
      ...(deductions ? [{ description: 'Less: Deductions', amount: -deductions }] : []),
    ].map(item => ({ ...item, qty: '', unit: '', unit_price: '' }));
    body =
      `<h1 class="doc-title">${title}</h1><div class="header">${pdf.kv([
        ['Employee Name', text('staff_name', 'staff_member', 'employee_name') || row?.[1], { strong: true, keep: true }],
        [
          'Salary Month',
          (value =>
            /^\d{4}-\d{2}$/.test(value)
              ? new Date(`${value}-01T00:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' })
              : value)(String(text('salary_month', 'month') || row?.[2] || '')),
        ],
      ])}${pdf.kv(
        [
          ['Voucher No.', `:${text('voucher_no', 'voucher') || number}`],
          ['Paid On', pdf.formatDate(get('paid_on', 'payment_date') || row?.[4])],
          ['Payment Method', text('payment_method', 'method')],
        ],
        'right',
      )}</div>` +
      '<div style="height:6mm"></div>' +
      pdf.itemsTable(lines, [['Net Pay', net, 'total']], { qty: '', price: '', total: 'Amount' }) +
      longText('Notes', text('notes')) +
      '<div class="spacer"></div>' +
      pdf.signatures('Prepared by', 'Received by');
  } else if (module === 'cash-claims') {
    title = 'EXPENSE VOUCHER';
    const total = num(get('amount') || row?.[4]);
    const jobNo = text('job_number', 'job_order') || (row?.[2] && row[2] !== '—' ? row[2] : '');
    body =
      `<h1 class="doc-title">${title}</h1><div class="header">${pdf.kv([
        ['Paid To', text('employee_name', 'staff_name', 'supplier_name', 'employee'), { strong: true, keep: true }],
        ['Category', text('category') || row?.[1]],
        ['Job Order No.', jobNo],
      ])}${pdf.kv(
        [
          ['Voucher No.', `:${number}`],
          ['Date', pdf.formatDate(get('date') || row?.[3])],
          ['Status', text('status') || row?.[5]],
        ],
        'right',
      )}</div>` +
      '<div style="height:6mm"></div>' +
      pdf.itemsTable(
        [
          {
            description: text('description', 'purpose') || text('category') || 'Expense',
            qty: 1,
            unit: '',
            unit_price: total,
            amount: total,
          },
        ],
        [['Total Amount', total, 'total']],
      ) +
      `<div style="margin-top:6mm">${pdf.kv([
        ['Payment Source', text('payment_source', 'payment_method', 'method')],
        ['Supplier', text('supplier_name', 'supplier')],
      ])}</div>` +
      '<div class="spacer"></div>' +
      pdf.signatures('Prepared by', 'Approved by');
  } else {
    body = `<h1 class="doc-title">${title}</h1>${pdf.kv(columns.map((column, index) => [column, printableValue(row?.[index])]))}`;
  }
  try {
    pdf.openDocument({ title: `${number} - ${title}`, body });
  } catch (error) {
    alertDialog(error.message, { title: 'Could not open the document' });
  }
}

// Database plumbing that means nothing on paper: ids, audit stamps, files, flags.
const TECHNICAL_KEY = /(^id$|_id$|_ids$|_by$|^created_at$|^updated_at$|^deleted_at$|avatar|signature|password|token|^receipt_files?$|^attachments$|^documents$|^photos?$|^is_|^record$|^search)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-][\d:]+)?)?$/;
const labelKey = label => String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const readable = value => {
  const text = printableValue(value);
  if (!text || text === '—' || UUID.test(text)) return '';
  return ISO_DATE.test(text) ? pdf.formatDate(text) : text;
};

// One record as a portrait "label: value" sheet: the fields shown on screen
// first, then any other readable field of the record (never ids or audit data).
export function printRecordDetails(title, columns, values, record = {}) {
  const pairs = [];
  const labels = new Set();
  const shown = new Set();
  const add = (label, value) => {
    const text = readable(value);
    if (!label || !text || labels.has(labelKey(label))) return;
    labels.add(labelKey(label));
    shown.add(text);
    pairs.push([humanizeKey(label), text]);
  };
  columns.forEach((column, index) => add(column, values[index]));
  Object.entries(record || {}).forEach(([key, value]) => {
    if (key.startsWith('_') || TECHNICAL_KEY.test(key)) return;
    const text = readable(value);
    if (text && !shown.has(text)) add(key, value);
  });
  const heading = String(title || 'Record');
  try {
    pdf.openDocument({
      title: `${heading} - TSG`,
      body: `<h1 class="doc-title">${pdf.esc(heading.toUpperCase())}</h1>${pdf.kv(pairs, 'details')}`,
    });
  } catch (error) {
    alertDialog(error.message, { title: 'Could not open the document' });
  }
}

export function printReport(title, columns, rows, filters) {
  try {
    pdf.openTableReport({
      title,
      columns: columns.map(humanizeKey),
      rows: rows.map(row => row.map(value => printableValue(value))),
      details: Object.entries(filters || {}).map(([key, value]) => [humanizeKey(key), String(value)]),
    });
  } catch (error) {
    alertDialog(error.message, { title: 'Could not open the document' });
  }
}
