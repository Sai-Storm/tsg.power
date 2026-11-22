import { adminOnly, approveReject, statusOf } from './shared.js';
import { advanceActions } from './advances.js';

// "Expense & claims" lists expense claims, staff advances and cash movements
// together; the Type column tells them apart.
// Admin approves; Finance pays approved claims and posts approved cash entries.
const financeStep = (role, actions) => (role === 'Admin' || role === 'Finance' ? actions : []);

export function cashClaimActions(row, columns, role) {
  const type = String(row[columns.findIndex(column => /^type$/i.test(column))] ?? row[1] ?? '');
  const status = statusOf(row, columns);
  // Advance expenses are reviewed inside the advance, not here.
  if (/advance expense/i.test(type)) return [];
  if (/advance/i.test(type)) return advanceActions(row, columns, role).filter(action => action.action !== 'advance-expenses' || ['under review', 'settlement approved'].includes(status));
  if (/^cash/i.test(type)) {
    if (status === 'pending approval') return adminOnly(role, approveReject);
    if (status === 'approved') return financeStep(role, [{ label: 'Post transaction', action: 'post', status: 'Posted' }]);
    return [];
  }
  return expenseClaimActions(row, columns, role);
}

export function expenseClaimActions(row, columns, role) {
  const status = statusOf(row, columns);
  if (status === 'submitted') return adminOnly(role, approveReject);
  if (status === 'approved') return financeStep(role, [{ label: 'Record reimbursement', action: 'pay', status: 'Paid' }]);
  return [];
}
