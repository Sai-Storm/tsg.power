import { adminOnly, statusOf } from './shared.js';

export const recycleBinActions = () => [{ label: 'Restore', action: 'restore' }, { label: 'Purge permanently', action: 'purge' }];

export const staffActions = (_row, _columns, role) => adminOnly(role, [{ label: 'Edit profile', action: 'edit-profile' }]);

export function salaryActions(row, columns, role) {
  const status = statusOf(row, columns) || String(row[5] || '').toLowerCase();
  return role === 'Admin' && status !== 'paid' ? [{ label: 'Mark as paid', action: 'mark-salary-paid' }] : [];
}

export function notificationActions(row, columns) {
  const unread = statusOf(row, columns) === 'unread';
  return [...(unread ? [{ label: 'Mark read', action: 'mark-read', status: 'Read' }] : []), { label: 'Delete notification', action: 'delete-notification' }];
}
