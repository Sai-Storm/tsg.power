import { statusOf } from './shared.js';
import { cell } from '../../lib/records.js';
import { ROLES } from '../../lib/roles.js';

export default function accountActions(row, columns) {
  const active = statusOf(row, columns) === 'active';
  const current = String(cell(row, columns, 'Role') || '');
  return [
    { label: 'Update photo', action: 'update-photo' },
    { label: 'Reset password', action: 'reset-password' },
    ...ROLES.filter(role => role.toLowerCase() !== current.toLowerCase()).map(role => ({ label: `Make ${role}`, action: 'set-role', role })),
    active ? { label: 'Deactivate', action: 'deactivate', status: 'Inactive' } : { label: 'Activate', action: 'activate', status: 'Active' },
  ];
}
