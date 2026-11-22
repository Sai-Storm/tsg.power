// An employee's panels: job status mix and recent job orders.
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../api/client.js';
import { moduleInfo } from '../../data.js';
import Status from '../../components/Status.jsx';
import { normalizeList } from '../../lib/records.js';
import { rowsState } from './metrics.js';
import { JobStatusDonut, PanelHeading } from './widgets.jsx';

export function JobStatusPanel({ dashboardData }) {
  const counts = dashboardData.jobsByStatus || dashboardData.jobStatusCounts || dashboardData.job_status_counts || {};
  return (
    <section className="panel analytics-panel job-status-panel">
      <PanelHeading title="Job order status" subtitle="Current workload distribution" to="/jobs" linkLabel="All jobs" />
      <JobStatusDonut counts={counts} emptyText="Status totals were not included in the dashboard response." />
    </section>
  );
}

export function RecentJobs() {
  const query = useQuery({ queryKey: ['dashboard-jobs'], queryFn: () => apiRequest('/jobs?page=1&limit=5'), staleTime: 20_000 });
  const rows = normalizeList(query.data, moduleInfo.jobs.columns);
  return (
    <section className="panel jobs-panel">
      <PanelHeading title="Recent job orders" subtitle="Latest service work across your team." to="/jobs" linkLabel="View all" />
      <div className="table-scroll">
        <table className="data-table dashboard-table">
          <thead><tr><th>JOB ORDER</th><th>CUSTOMER / MACHINE</th><th>ASSIGNED TO</th><th>STATUS</th><th>DUE</th></tr></thead>
          <tbody>
            {rows.slice(0, 5).map(row => (
              <tr key={row._id || row[0]}>
                <td><b className="record-link">{row[0]}</b></td><td>{row[1]}</td><td>{row[2]}</td>
                <td><Status value={row[5] || 'New'} /></td><td>{row[3]}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="empty-state">{rowsState(query, rows)}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
