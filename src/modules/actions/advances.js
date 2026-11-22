import { adminOnly, approveReject, statusOf } from './shared.js';

// Staff advances: request -> approve -> release -> settlement -> review -> reconcile.
export function myAdvanceActions(_row, _columns, role) {
  return role === 'Staff' ? [{ label: 'Advance details', action: 'advance-expenses' }] : [];
}

export function advanceStageActions(status) {
  if (status === 'pending approval') return approveReject;
  if (status === 'approved') return [{ label: 'Release money', action: 'issue-advance' }];
  if (status === 'under review') return [{ label: 'Review settlement', action: 'advance-expenses' }];
  if (status === 'settlement approved') return [{ label: 'Reconcile & close', action: 'advance-expenses' }];
  if (['issued', 'open', 'partially settled', 'settled'].includes(status)) return [{ label: 'View advance', action: 'advance-expenses' }];
  return [];
}

export function advanceActions(row, columns, role) {
  return adminOnly(role, advanceStageActions(statusOf(row, columns)));
}
