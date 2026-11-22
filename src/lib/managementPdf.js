// Monthly management report as a printable PDF on the company letterhead.
import * as pdf from '../pdfTemplate.js';
import { alertDialog } from '../components/AskDialog.jsx';

const money = value => `${(Number(value) < 0 ? '-' : '')}${Math.abs(Math.round(Number(value) || 0)).toLocaleString('en-US')}`;

export function printManagementReport(monthLabel, r = {}) {
  const profit = Number(r.invoiced || 0) - Number(r.expenses || 0);
  const net = Number(r.cash_in || 0) - Number(r.cash_out || 0);
  const body = `<h1 class="doc-title">MANAGEMENT REPORT · ${pdf.esc(monthLabel.toUpperCase())}</h1>`
    + pdf.sectionTitle('Summary (MMK)')
    + pdf.gridTable(['Measure', 'Amount (MMK)'], [
      ['Invoiced', money(r.invoiced)],
      ['Collected from customers', money(r.collected)],
      ['Expenses (approved and paid)', money(r.expenses)],
      ['Invoiced minus expenses', money(profit)],
      ['Cash in', money(r.cash_in)],
      ['Cash out', money(r.cash_out)],
      ['Net cash', money(net)],
      ['Customers owe (today)', money(r.receivables)],
      ['Held by staff in advances (today)', money(r.open_advances)],
    ])
    + pdf.sectionTitle('Expenses by category')
    + pdf.gridTable(['Category', 'Amount (MMK)'], (r.expense_by_category || []).map(c => [c.category, money(c.amount)]), 'No approved expenses this month.')
    + pdf.sectionTitle('Profit by job')
    + pdf.gridTable(['Job', 'Title', 'Customer', 'Revenue (MMK)', 'Costs (MMK)', 'Margin (MMK)'],
      (r.jobs || []).map(j => [j.number, j.title || '', j.customer || '', money(j.revenue), money(j.costs), money(j.margin)]), 'No job activity this month.')
    + `<div class="footnote"><span>${pdf.esc(pdf.COMPANY.legalName)}</span><span>Generated ${pdf.formatDate(new Date().toISOString())}</span></div>`;
  try {
    pdf.openDocument({ title: `Management report ${monthLabel} - TSG`, body, flow: true });
  } catch (error) {
    alertDialog(error.message, { title: 'Could not open the report' });
  }
}
