// Who may do what. Mirrors the database rules (is_admin / is_finance / is_staff).
//   Admin   = manager: approves requests and settlements, and can do everything
//   Finance = releases money, settles advances, cash, invoices, purchasing, reports
//   Staff   = own work only
// Finance users are employees too, so they keep every staff self-service page.
export const ROLES = ['Admin', 'Finance', 'Staff'];

export const isAdminRole = role => role === 'Admin';
export const isFinanceRole = role => role === 'Admin' || role === 'Finance';
export const isEmployeeRole = role => role === 'Staff' || role === 'Finance';

export function normalizeRole(value) {
  const role = String(value || '').toLowerCase();
  return role === 'admin' ? 'Admin' : role === 'finance' ? 'Finance' : 'Staff';
}
