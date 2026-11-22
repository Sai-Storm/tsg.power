import { adminOnly, statusOf } from './shared.js';

export function serviceReportActions(row, columns, role) {
  const status = statusOf(row, columns);
  if (status === 'draft') return [{ label: 'Submit for review', action: 'status', status: 'Submitted' }];
  if (status === 'submitted') return adminOnly(role, [{ label: 'Mark reviewed', action: 'status', status: 'Reviewed' }]);
  if (status === 'reviewed') return adminOnly(role, [{ label: 'Approve report', action: 'status', status: 'Approved' }, { label: 'Reject report', action: 'status', status: 'Rejected' }]);
  if (status === 'rejected') return [{ label: 'Resubmit', action: 'status', status: 'Submitted' }];
  return [];
}

export function materialRequestActions(row, columns, role) {
  const status = statusOf(row, columns);
  if (['pending', 'pending approval'].includes(status)) return adminOnly(role, [{ label: 'Approve', action: 'status', status: 'Approved' }, { label: 'Reject', action: 'status', status: 'Rejected' }]);
  if (status === 'approved' || status === 'partially issued') return adminOnly(role, [{ label: 'Issue materials', action: 'issue-materials' }]);
  if (status === 'issued') return adminOnly(role, [{ label: 'Record return', action: 'return-materials' }]);
  return [];
}

// A machine due for service becomes a draft job order in one click.
export const machineActions = (_row, _columns, role) => (role === 'Admin' ? [{ label: 'Create service job order', action: 'machine-job' }] : []);
