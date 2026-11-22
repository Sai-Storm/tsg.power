// Helpers shared by the per-module action lists.
export const statusOf = (row, columns) => String(row[columns.findIndex(column => /status/i.test(column))] || '').toLowerCase();
export const adminOnly = (role, actions) => (role === 'Admin' ? actions : []);
export const approveReject = [{ label: 'Approve', action: 'approve', status: 'Approved' }, { label: 'Reject', action: 'reject', status: 'Rejected' }];
