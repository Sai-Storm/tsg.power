import { statusOf } from './shared.js';

export function invoiceActions(row, columns, role) {
  const status = statusOf(row, columns);
  if (['unpaid', 'partially paid', 'issued'].includes(status)) return [{ label: 'Record payment', action: 'record-payment' }];
  if (role === 'Staff' && ['draft', 'pending approval', 'approved'].includes(status)) return [{ label: 'Issue invoice', action: 'status', status: 'Issued' }];
  return [];
}

export function quotationActions(row, columns, role) {
  if (role !== 'Staff') return [];
  const status = statusOf(row, columns);
  if (['draft', 'pending approval', 'approved'].includes(status)) return [{ label: 'Issue to customer', action: 'status', status: 'Sent' }];
  if (status === 'sent') return [{ label: 'Mark accepted', action: 'status', status: 'Accepted' }, { label: 'Mark rejected', action: 'status', status: 'Rejected' }];
  if (status === 'accepted') return [{ label: 'Convert to job', action: 'convert-to-job', status: 'Converted to Job' }];
  return [];
}
