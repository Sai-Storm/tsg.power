// Statement of account: every invoice and payment for one customer, with a
// running balance, on the company letterhead.
import * as pdf from '../pdfTemplate.js';
import { alertDialog } from '../components/AskDialog.jsx';

const amount = value => (Number(value) ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

export function printStatement(data) {
  const customer = data?.customer || {};
  let balance = 0;
  const rows = (data?.lines || []).map(line => {
    balance += Number(line.debit || 0) - Number(line.credit || 0);
    return [pdf.formatDate(line.date), line.kind, line.reference, line.due_date ? pdf.formatDate(line.due_date) : '', amount(line.debit), amount(line.credit), amount(balance) || '0.00'];
  });
  const body = `<h1 class="doc-title">STATEMENT OF ACCOUNT</h1>`
    + pdf.kv([
      ['Customer', customer.name, { strong: true }],
      ['Attention', customer.contact],
      ['Address', customer.address],
      ['Phone', customer.phone],
      ['Email', customer.email],
      ['Statement date', pdf.formatDate(new Date().toISOString())],
    ])
    + '<div style="height:5mm"></div>'
    + pdf.gridTable(['Date', 'Type', 'Reference', 'Due', 'Invoiced (MMK)', 'Paid (MMK)', 'Balance (MMK)'], rows, 'No invoices or payments.')
    + `<div class="kv" style="margin-top:5mm;justify-content:end;grid-template-columns:50mm 40mm"><span class="strong">Balance due</span><b class="em" style="text-align:right;font-size:15px">MMK ${amount(balance) || '0.00'}</b></div>`
    + '<div class="spacer"></div>'
    + '<p class="text">Please contact us if any item on this statement does not match your records. Thank you for your business.</p>'
    + pdf.bankDetails();
  try {
    pdf.openDocument({ title: `Statement - ${customer.name || 'Customer'}`, body });
  } catch (error) {
    alertDialog(error.message, { title: 'Could not open the statement' });
  }
}
