import { approveReject, statusOf } from './shared.js';
import { isAdminRole, isEmployeeRole } from '../../lib/roles.js';
import { cell } from '../../lib/records.js';

const isClaim = (row, columns) => /claim/i.test(String(cell(row, columns, 'Type') || ''));

// Staff advances: request -> approve -> release -> settlement -> review -> reconcile.
export function myAdvanceActions(row, columns, role) {
  return isEmployeeRole(role) ? [{ label: isClaim(row, columns) ? 'Claim details' : 'Advance details', action: 'advance-expenses' }] : [];
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
