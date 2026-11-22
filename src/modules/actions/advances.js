import { approveReject, statusOf } from './shared.js';
import { isAdminRole, isEmployeeRole } from '../../lib/roles.js';

// Staff advances: request -> approve -> release -> settlement -> review -> reconcile.
export function myAdvanceActions(_row, _columns, role) {
  return isEmployeeRole(role) ? [{ label: 'Advance details', action: 'advance-expenses' }] : [];
}

// Expense claims use the same window; there is no request or release step.
export function myClaimActions(_row, _columns, role) {
  return isEmployeeRole(role) ? [{ label: 'Claim details', action: 'advance-expenses' }] : [];
}

export function advanceStageActions(status) {
  if (status === 'pending approval') return approveReject;
  if (status === 'approved') return [{ label: 'Release money', action: 'issue-advance' }];
  if (status === 'under review') return [{ label: 'Review settlement', action: 'advance-expenses' }];
  if (status === 'settlement approved') return [{ label: 'Reconcile & close', action: 'advance-expenses' }];
  if (['issued', 'open', 'partially settled', 'settled'].includes(status)) return [{ label: 'View advance', action: 'advance-expenses' }];
  return [];
}

// Admin (manager) takes every step; Finance only releases money and closes.
export function advanceActions(row, columns, role) {
  const status = statusOf(row, columns);
  if (isAdminRole(role)) return advanceStageActions(status);
  if (role !== 'Finance') return [];
  if (status === 'approved') return [{ label: 'Release money', action: 'issue-advance' }];
  if (status === 'settlement approved') return [{ label: 'Reconcile & close', action: 'advance-expenses' }];
  return status === 'pending approval' ? [] : [{ label: 'View advance', action: 'advance-expenses' }];
}
