// An employee's own numbers: assigned jobs, today's schedule, pending claims
// and open advance balance. Uses the dashboard summary when it has them and
// counts from the lists otherwise (whichever is higher).
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../api/client.js';
import { amountNumber, lookupRecords } from '../../lib/records.js';
import { resolveDashboardMetric, sameDisplayName, todayIso } from './metrics.js';

const isClosedJob = record => /completed|closed|cancel/i.test(String(record?.status || ''));
const assignedEmployeeIds = record => (Array.isArray(record?.assigned_employees) ? record.assigned_employees : [])
  .map(item => String(item?.id ?? item?.staff_id ?? item ?? ''));

export default function useMyWork(user, liveCounts, enabled) {
  const options = key => ({ queryKey: ['dashboard', key, user.id], enabled, staleTime: 20_000 });
  const staffQuery = useQuery({ ...options('my-staff'), queryFn: () => apiRequest('/staff?page=1&limit=500') });
  const jobsQuery = useQuery({ ...options('my-jobs'), queryFn: () => apiRequest('/jobs?page=1&limit=5000') });
  const claimsQuery = useQuery({ ...options('my-claims'), queryFn: () => apiRequest('/my-expense-claims?page=1&limit=5000') });
  const advancesQuery = useQuery({ ...options('my-advances'), queryFn: () => apiRequest('/my-advances?page=1&limit=5000') });
  if (!enabled) return null;

  const userId = String(user.id || '');
  const email = String(user.email || '').trim().toLowerCase();
  const myStaffIds = lookupRecords('staff', staffQuery.data)
    .filter(record => {
      const profileId = record?.profile_id ? String(record.profile_id) : '';
      const staffEmail = String(record?.email || '').trim().toLowerCase();
      return Boolean((userId && profileId === userId) || (email && staffEmail === email) || sameDisplayName(user.name, record?.name));
    })
    .map(record => String(record?.id || ''))
    .filter(Boolean);

  const isMine = record => myStaffIds.includes(String(record?.assigned_to || ''))
    || myStaffIds.includes(String(record?.team_leader || ''))
    || assignedEmployeeIds(record).some(id => myStaffIds.includes(id))
    || sameDisplayName(user.name, record?.assigned_to_name) || sameDisplayName(user.name, record?.team_leader_name);

  const openJobs = lookupRecords('jobs', jobsQuery.data).filter(record => isMine(record) && !isClosedJob(record));
  const today = todayIso();
  const todayJobs = openJobs.filter(record => String(record?.planned_start_date || record?.job_date || '').slice(0, 10) === today);
  const pendingClaims = lookupRecords('expenses', claimsQuery.data)
    .filter(record => /submitted|pending approval/i.test(String(record?.status || '')))
    .reduce((sum, record) => sum + amountNumber(record?.amount_value ?? record?.amount), 0);
  const openAdvance = lookupRecords('advances', advancesQuery.data)
    .filter(record => /issued|partially settled|under review|settlement approved/i.test(String(record?.status || '')))
    .reduce((sum, record) => sum + amountNumber(record?.balance), 0);
  const metric = (keys, fallback) => Math.max(Number(resolveDashboardMetric(liveCounts, keys) || 0), fallback);

  return {
    assignedJobs: metric(['myAssignedJobs', 'assignedJobs', 'assigned_jobs'], openJobs.length),
    todaysJobs: metric(['todaysScheduledJobs', 'scheduledToday', 'scheduled_today'], todayJobs.length),
    pendingClaims: metric(['myPendingClaims', 'pendingClaims', 'pending_claims'], pendingClaims),
    openAdvanceBalance: metric(['myOpenAdvanceBalance', 'openAdvanceBalance', 'advance_balance'], openAdvance),
  };
}
