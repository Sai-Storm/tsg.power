// Shared layout for every printable document and report (invoice, quotation,
// job order, service report, vouchers, salary slip and table exports).
// It follows the TSG service-invoice letterhead: logo mark + company block,
// gold rule, centred title, label/value header, plain item table with
// underlined totals, signatory and bank details.

export const COMPANY = {
  name: 'TSG POWER',
  subtitle: 'Engineering Co.,Ltd.',
  legalName: 'TSG Power Engineering Co.,Ltd.',
  address: 'No(1956B), Aung Thukha St, 14/Na Gyi Qtr, Shwe Pyi Thar Tsp, Yangon.',
  phones: '09 420164696, 09 448001713, 09 457187767, 09 760999972',
  email: 'tsgpower3@gmail.com',
  signatory: { name: 'Tin San', title: 'Service Manager' },
  bankAccounts: [
    { bank: 'AYA', type: 'Special', account: '40041890909', name: 'TSG Power Engineering Co.,Ltd.' },
    { bank: 'KBZ', type: 'Special', account: '219 511 999 020 13501', name: 'Daw Aye Nandar Tun' },
    { bank: 'KBZ', type: 'K PAY', account: '09 420164696', name: 'U Ngwe Phyo' },
  ],
};

export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export const escLines = value => esc(value).replaceAll('\n', '<br>');

const numeric = value => Number(String(value ?? 0).replace(/[^0-9.-]/g, '')) || 0;
export const amount = value => numeric(value).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function formatDate(value) {
  if (!value) return '';
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(`${text.slice(0, 10)}T00:00:00`) : new Date(text);
  if (Number.isNaN(date.valueOf())) return text;
  return `${String(date.getDate()).padStart(2, '0')}-${date.toLocaleString('en-US', { month: 'short' })}-${String(date.getFullYear()).slice(-2)}`;
}

const PHONE_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#1d2633"/><path fill="#fff" d="M5.3 3.5c.3 0 .5.2.6.4l.7 1.6c.1.3 0 .6-.2.8l-.6.5c.5 1.1 1.3 1.9 2.4 2.4l.5-.6c.2-.2.5-.3.8-.2l1.6.7c.3.1.4.3.4.6v1.2c0 .5-.4.9-.9.9C6.8 11.8 4.2 9.2 4.2 5.4c0-.5.4-.9.9-.9z"/></svg>';
const MAIL_ICON = '<svg viewBox="0 0 16 16" width="12" height="11" aria-hidden="true"><path fill="#1d2633" d="M1 3h14v10H1z"/><path fill="none" stroke="#fff" stroke-width="1.3" d="M1.5 3.6 8 8.6l6.5-5"/></svg>';

const BASE_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:#e9ecef;color:#1d2633;font:12.5px/1.45 Calibri,Carlito,'Segoe UI',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;background:#f6f7f9;border-bottom:1px solid #dde1e6}
  .toolbar button{font:600 12px Arial,sans-serif;padding:8px 14px;border:1px solid #1d2633;background:#1d2633;color:#fff;border-radius:5px;cursor:pointer}
  .sheet{background:#fff;margin:14px auto;box-shadow:0 2px 14px rgba(0,0,0,.12);display:flex;flex-direction:column}
  .sheet.portrait{width:210mm;min-height:297mm;padding:12mm 16mm 12mm}
  .sheet.landscape{width:297mm;min-height:210mm;padding:10mm 12mm}
  .letterhead{display:flex;align-items:center;gap:6mm;padding:0 0 3mm 4mm}
  .letterhead img{width:25mm;height:25mm;object-fit:contain;filter:brightness(.42) saturate(1.3)}
  .company{display:flex;flex-direction:column;gap:1px}
  .company .name{font:500 26px/1.05 'DIN Alternate','Bahnschrift','Segoe UI',Arial,sans-serif;letter-spacing:.02em;color:#3b4859}
  .company .sub{font:500 15.5px/1.2 'DIN Alternate','Bahnschrift','Segoe UI',Arial,sans-serif;color:#3b4859;margin-bottom:5px}
  .company .line{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:#1d2633}
  .company .line.mail{font-weight:400;color:#1f5fbf}
  .rule{height:0;border-top:1.6px solid #c9a24a;margin:0 0 4mm}
  .doc-title{text-align:center;font-size:16px;font-weight:700;letter-spacing:.06em;margin:0 0 5mm}
  .header{display:grid;grid-template-columns:1fr 70mm;column-gap:8mm;margin-bottom:2mm}
  .kv{display:grid;grid-template-columns:31mm 1fr;row-gap:1.2mm;column-gap:2mm;align-content:start}
  .kv.right{grid-template-columns:27mm 1fr}
  .kv span{color:#1d2633}
  .kv b{font-weight:400}
  .kv .strong,.kv .strong+b{font-weight:700}
  .kv .strong+b{font-size:14.5px}
  .kv .em{font-weight:700}
  .block{display:grid;grid-template-columns:31mm 1fr auto;column-gap:2mm;row-gap:1.2mm;margin:1.5mm 0 5mm}
  .block .po{font-weight:700;padding-right:8mm}
  .job-type{display:grid;grid-template-columns:31mm 1fr;column-gap:2mm;font-weight:700;margin:2mm 0 6mm}
  .section-title{font-weight:700;font-size:13px;margin:4.5mm 0 1.8mm;padding-bottom:.8mm;border-bottom:1px solid #1d2633}
  table.items{width:100%;border-collapse:collapse;margin:0 0 2mm}
  table.items th{font-weight:700;text-align:left;padding:1.6mm 2mm;border-bottom:1.6px solid #1d2633}
  table.items td{padding:2.4mm 2mm;vertical-align:top}
  table.items .num{text-align:right;white-space:nowrap}
  table.items .center{text-align:center}
  table.items th.center{text-align:center}
  table.items .idx{width:9mm;text-align:center}
  table.items tfoot td{padding:2mm 2mm}
  table.items tfoot .label{text-align:right;font-weight:700}
  table.items tfoot .sum{text-align:right;font-weight:400;border-top:1.3px solid #1d2633}
  table.items tfoot .total .label,table.items tfoot .total .sum{font-weight:700}
  table.items tfoot .total .sum{border-top:1.3px solid #1d2633;border-bottom:4px double #1d2633}
  table.items tfoot .plain .sum{border-top:0}
  table.grid{width:100%;border-collapse:collapse}
  .kv.details{grid-template-columns:48mm 1fr;row-gap:0;border-top:1px solid #1d2633}
  .kv.details span,.kv.details b{padding:2mm 2mm;border-bottom:.6px solid #d4d8de}
  .kv.details span{font-weight:700;background:#f6f7f9}
  .kv.details b{white-space:pre-wrap;overflow-wrap:break-word}
  table.grid{width:100%;border-collapse:collapse;font-size:11px}
  table.grid th{font-weight:700;text-align:left;padding:1.6mm 2mm;border-bottom:1.6px solid #1d2633;vertical-align:bottom;word-break:normal;overflow-wrap:normal;hyphens:none}
  table.grid td{padding:1.3mm 2mm;border-bottom:.6px solid #d4d8de;vertical-align:top;word-break:normal;overflow-wrap:break-word;hyphens:none}
  table.grid .num,table.grid .nowrap{white-space:nowrap}
  table.grid tbody tr:nth-child(even) td{background:#fafbfc}
  table.grid tr{break-inside:avoid}
  .text{white-space:pre-wrap;margin:0 0 2mm}
  .spacer{flex:1 1 auto;min-height:4mm}
  .signatory{margin-top:14mm;line-height:1.5}
  .signatures{display:grid;grid-template-columns:1fr 1fr;gap:20mm;margin-top:14mm;break-inside:avoid}
  .signatures div{border-top:1px solid #1d2633;padding-top:1.5mm;text-align:center}
  .bank{display:grid;grid-template-columns:30mm 22mm 52mm 1fr;row-gap:.4mm;margin:8mm 0 0 3mm}
  .bank b{font-weight:700}
  .meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2mm 8mm;margin:0 0 4mm}
  .footnote{margin-top:3mm;break-inside:avoid;font-size:10.5px;color:#5b6573;display:flex;justify-content:space-between}
  @media print{
    body{background:#fff}
    .toolbar{display:none}
    .sheet{margin:0;box-shadow:none;padding:0!important;width:auto!important}
    .sheet.portrait{min-height:270mm}
    .sheet.landscape,.sheet.flow{min-height:0}
    thead{display:table-header-group}
    table.items tr,.signatures,.bank{break-inside:avoid}
  }
`;

export function letterhead() {
  const logo = new URL('/tsg-mark.png', window.location.href).href;
  return `<header class="letterhead"><img src="${esc(logo)}" alt=""><div class="company"><span class="name">${esc(COMPANY.name)}</span><span class="sub">${esc(COMPANY.subtitle)}</span><span class="line">${esc(COMPANY.address)}</span><span class="line">${PHONE_ICON}${esc(COMPANY.phones)}</span><span class="line mail">${MAIL_ICON}${esc(COMPANY.email)}</span></div></header><div class="rule"></div>`;
}

export function signatory() {
  return `<div class="signatory">${esc(COMPANY.signatory.name)}<br>${esc(COMPANY.signatory.title)}</div>`;
}

export function signatures(left, right) {
  return `<div class="signatures"><div>${escLines(left)}</div><div>${escLines(right)}</div></div>`;
}

export function bankDetails() {
  return `<div class="bank"><span>Banking Payment</span><span>Type</span><span>Account No.</span><span>Name</span>${COMPANY.bankAccounts.map(item => `<span>${esc(item.bank)}</span><span>${esc(item.type)}</span><b>${esc(item.account)}</b><span>${esc(item.name)}</span>`).join('')}</div>`;
}

// pairs: [label, value, { strong, em }] — empty values are skipped unless keep is set.
export function kv(pairs, className = '') {
  const rows = pairs.filter(([, value, opts]) => opts?.keep || (value != null && String(value).trim() !== ''));
  return `<div class="kv ${className}">${rows.map(([label, value, opts = {}]) => `<span class="${opts.strong ? 'strong' : ''}">${esc(label)}</span><b class="${opts.em ? 'em' : ''}">${opts.raw ? value : escLines(value)}</b>`).join('')}</div>`;
}

// Attention / Address style block with an optional bold note on the right (e.g. PO number).
export function block(pairs, note = '') {
  const rows = pairs.filter(([, value]) => value != null && String(value).trim() !== '');
  if (!rows.length && !note) return '';
  return `<div class="block">${rows.map(([label, value], index) => `<span>${esc(label)}</span><span>${escLines(value)}</span><span class="po">${index === 0 && note ? esc(note) : ''}</span>`).join('')}${!rows.length && note ? `<span></span><span></span><span class="po">${esc(note)}</span>` : ''}</div>`;
}

export function jobType(label, value) {
  return value ? `<div class="job-type"><span>${esc(label)}</span><span>${esc(value)}</span></div>` : '';
}

export function sectionTitle(title) { return `<div class="section-title">${esc(title)}</div>`; }

// items: [{ description, qty, unit, unit_price, amount }]; totals: [[label, value, 'total'|'plain'|'']]
export function itemsTable(items, totals = [], headers = {}) {
  const h = { item: 'Item', description: 'Description', qty: 'Qty', price: 'Unit Price', total: 'Total Price', ...headers };
  const body = items.map((item, index) => `<tr><td class="idx">${index + 1}</td><td>${escLines(item.description)}</td><td class="center">${esc(item.qty ?? '')}${item.unit ? `&nbsp;&nbsp;${esc(item.unit)}` : ''}</td><td class="num">${item.unit_price === '' || item.unit_price == null ? '' : amount(item.unit_price)}</td><td class="num">${amount(item.amount)}</td></tr>`).join('');
  const foot = totals.map(([label, value, kind = '']) => `<tr class="${kind}"><td colspan="3"></td><td class="label">${esc(label)}</td><td class="sum">${amount(value)}</td></tr>`).join('');
  return `<table class="items"><thead><tr><th class="idx">${esc(h.item)}</th><th class="center">${esc(h.description)}</th><th class="center">${esc(h.qty)}</th><th class="num">${esc(h.price)}</th><th class="num">${esc(h.total)}</th></tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table>`;
}

// columns: [label]; rows: [[cell]] — cells are plain text (newlines allowed).
export function gridTable(columns, rows, emptyText = 'No records.') {
  const isNum = index => { const values = rows.map(row => String(row[index] ?? '').trim()).filter(value => value && value !== '—'); return values.length > 0 && values.every(value => /^(MMK\s*)?-?[\d,]+(\.\d+)?%?$/.test(value)); };
  const numeric = columns.map((_, index) => isNum(index));
  // Short single-word values (dates like 21-Nov-26, statuses, codes) never wrap.
  const short = columns.map((_, index) => rows.every(row => { const value = String(row[index] ?? '').trim(); return value.length <= 14 && !/\s/.test(value); }));
  const cls = index => (numeric[index] ? 'num' : short[index] ? 'nowrap' : '');
  return `<table class="grid"><thead><tr>${columns.map((column, index) => `<th class="${numeric[index] ? 'num' : ''}">${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map((cell, index) => `<td class="${cls(index)}">${escLines(cell ?? '') || '—'}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length || 1}">${esc(emptyText)}</td></tr>`}</tbody></table>`;
}

function schedulePrint(win) {
  let printed = false;
  const run = () => { if (printed) return; printed = true; try { win.focus(); win.print(); } catch { /* the toolbar still offers printing */ } };
  const pending = Array.from(win.document.images || []).filter(image => !image.complete);
  if (!pending.length) { setTimeout(run, 300); return; }
  let remaining = pending.length;
  const settle = () => { remaining -= 1; if (remaining <= 0) setTimeout(run, 200); };
  pending.forEach(image => { image.addEventListener('load', settle, { once: true }); image.addEventListener('error', settle, { once: true }); });
  setTimeout(run, 3000);
}

// Opens the document in a new window and starts printing (Save as PDF).
export function openDocument({ title, body, landscape = false, flow = false }) {
  const win = window.open('', '_blank', `width=${landscape ? 1200 : 920},height=900`);
  if (!win) throw new Error('Allow pop-ups for this site to save the PDF.');
  const page = landscape ? '@page{size:A4 landscape;margin:10mm 12mm}' : '@page{size:A4 portrait;margin:12mm 15mm}';
  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${page}${BASE_CSS}</style></head><body><div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div><main class="sheet ${landscape ? 'landscape' : 'portrait'}${flow ? ' flow' : ''}">${letterhead()}${body}</main></body></html>`);
  win.document.close();
  schedulePrint(win);
  return win;
}

// Table report (module exports and Reports page) in the same letterhead.
export function openTableReport({ title, columns, rows, details = [] }) {
  const landscape = columns.length > 6;
  const heading = String(title || 'Report').replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const meta = `<div class="meta">${[['Generated', formatDate(new Date().toISOString()) + ' ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })], ...details, ['Records', String(rows.length)]].map(([label, value]) => `<span><b>${esc(label)}:</b> ${esc(value)}</span>`).join('')}</div>`;
  const cells = rows.map(row => row.map(cell => (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-][\d:]+)?)?$/.test(String(cell ?? '').trim()) ? formatDate(cell) : cell)));
  const body = `<h1 class="doc-title">${esc(heading.toUpperCase())}</h1>${meta}${gridTable(columns, cells, 'No records match these filters.')}<div class="footnote"><span>${esc(COMPANY.legalName)}</span><span>Generated from the current report result.</span></div>`;
  return openDocument({ title: `${heading} - TSG`, body, landscape, flow: true });
}
