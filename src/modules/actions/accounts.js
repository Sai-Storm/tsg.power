import { statusOf } from './shared.js';

// Roles are fixed when the account is created; there is no role switching here.
export default function accountActions(row, columns) {
  const active = statusOf(row, columns) === 'active';
  return [
    { label: 'Update photo', action: 'update-photo' },
    { label: 'Reset password', action: 'reset-password' },
    active ? { label: 'Deactivate', action: 'deactivate', status: 'Inactive' } : { label: 'Activate', action: 'activate', status: 'Active' },
  ];
}
