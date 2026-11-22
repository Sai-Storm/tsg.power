import { statusOf } from './shared.js';

// Job order lifecycle: draft -> assigned/scheduled -> in progress -> completed
// -> invoice generated -> closed.
export default function jobActions(row, columns, role) {
  const status = statusOf(row, columns);
  const staff = role === 'Staff';
  if (['draft', 'new', 'pending approval', 'approved'].includes(status)) return staff ? [{ label: 'Assign / schedule', action: 'assign-job' }, { label: 'Cancel job', action: 'job-cancel' }] : [];
  if (status === 'assigned' || status === 'scheduled') return [{ label: 'Start work', action: 'status', status: 'In Progress' }, { label: 'Add note', action: 'add-note' }];
  if (status === 'in progress') return [{ label: 'Add note', action: 'add-note' }, { label: 'Completion report', action: 'service-report' }, { label: 'Put on hold', action: 'status', status: 'On Hold' }];
  if (status === 'on hold' || status === 'waiting for parts') return [{ label: 'Add note', action: 'add-note' }, { label: 'Resume work', action: 'status', status: 'In Progress' }];
  if (status === 'completed') return staff ? [{ label: 'Generate invoice', action: 'job-invoice' }, { label: 'Completion report', action: 'service-report' }] : [{ label: 'Completion report', action: 'service-report' }];
  if (status === 'invoice generated') return staff ? [{ label: 'Close job', action: 'job-close' }] : [];
  if (status === 'closed - pending payment') return staff ? [{ label: 'Close as paid', action: 'job-close' }] : [];
  return [];
}
