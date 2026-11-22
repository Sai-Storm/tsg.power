// Row actions (the "…" menu) for each module. Each module's rules live in its
// own file; this map picks the right one.
import accountActions from './accounts.js';
import { advanceActions, myAdvanceActions, myClaimActions } from './advances.js';
import { cashClaimActions } from './claims.js';
import jobActions from './jobs.js';
import { invoiceActions, quotationActions } from './sales.js';
import { machineActions, materialRequestActions, serviceReportActions } from './operations.js';
import { notificationActions, recycleBinActions, salaryActions, staffActions } from './admin.js';

const byModule = {
  accounts: accountActions,
  'recycle-bin': recycleBinActions,
  staff: staffActions,
  notifications: notificationActions,
  'my-advances': myAdvanceActions,
  advances: advanceActions,
  'my-claims': myClaimActions,
  'staff-claims': (row, columns, role) => advanceActions(row, columns, role).map(action => ({ ...action, label: action.label.replace(/advance/i, 'claim') })),
  salary: salaryActions,
  'cash-claims': cashClaimActions,
  invoices: invoiceActions,
  jobs: jobActions,
  quotations: quotationActions,
  'service-reports': serviceReportActions,
  'material-requests': materialRequestActions,
  machines: machineActions,
};

export default function workflowActions(slug, row, columns, role) {
  return byModule[slug]?.(row, columns, role) || [];
}
