import { adminOnly, approveReject, statusOf } from './shared.js';

// "Expenses & cash" lists company expenses (and older stand-alone staff claims)
// with cash movements; the Type column tells them apart. Staff advances and
// staff claims are handled in their own lists.
// Admin approves; Finance pays approved claims and posts approved cash entries.
const financeStep = (role, actions) => (role === 'Admin' || role === 'Finance' ? actions : []);

export function cashClaimActions(row, columns, role) {
  const type = String(row[columns.findIndex(column => /^type$/i.test(column))] ?? row[1] ?? '');
  const status = statusOf(row, columns);
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
