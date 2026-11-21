import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { apiRequest } from './api/client.js';
import './schedule.css';

const pad = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = key => { const [y, m, d] = String(key).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = d => addDays(d, -((d.getDay() + 6) % 7));
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const initials = (name = '') => name.split(' ').filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase();
const fmt = (d, options) => new Intl.DateTimeFormat('en-GB', options).format(d);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;

// Jobs in these states no longer occupy the people assigned to them.
const isDone = status => /completed|closed|invoice generated/i.test(String(status || ''));
const tone = status => {
  const s = String(status || '').toLowerCase();
  if (isDone(s)) return 'done';
  if (s === 'in progress') return 'progress';
  if (/hold|waiting/.test(s)) return 'hold';
  if (/assigned|scheduled/.test(s)) return 'planned';
  return 'draft';
};
const TONE_LABEL = { planned: 'Assigned', progress: 'In progress', hold: 'On hold', done: 'Done', draft: 'Not started' };

const shortDate = key => fmt(fromKey(key), { day: 'numeric', month: 'short' });
const jobRange = job => {
  const start = job.start_date; const end = job.end_date || job.start_date;
  return start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`;
};

function rangeFor(view, anchor) {
  if (view === 'week') { const from = startOfWeek(anchor); return { from, to: addDays(from, 6) }; }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  return { from: startOfWeek(first), to: addDays(startOfWeek(last), 6) };
}

function demoSchedule(user) {
  const t = today(); const k = n => toKey(addDays(t, n));
  return {
    staff: [
      { id: 'ST-0012', name: 'Arjun Nair', designation: 'Service Engineer' },
      { id: 'ST-0009', name: 'Ravi Kumar', designation: 'Technician' },
      { id: 'ST-0014', name: 'Meera Shah', designation: 'Technician' },
      { id: 'ST-0016', name: 'Kiran Das', designation: 'Electrician' },
    ],
    me: user.role === 'Staff' ? ['ST-0012'] : [],
    jobs: [
      { id: 'j1', number: 'TSG098', title: 'Compressor overhaul', customer: 'Eastern Hydro Works', status: 'In Progress', start_date: k(-1), end_date: k(1), staff_ids: ['ST-0012'] },
      { id: 'j2', number: 'TSG099', title: 'Chiller maintenance', customer: 'Meridian Foods Ltd.', status: 'Scheduled', start_date: k(2), end_date: k(3), staff_ids: ['ST-0012', 'ST-0009'] },
      { id: 'j3', number: 'TSG100', title: 'Generator repair', customer: 'Bluepeak Manufacturing', status: 'Waiting for Parts', start_date: k(0), end_date: k(4), staff_ids: ['ST-0014'] },
      { id: 'j4', number: 'TSG097', title: 'Cold room inspection', customer: 'Aster Cold Storage', status: 'Completed', start_date: k(-3), end_date: k(-2), staff_ids: ['ST-0009'] },
      { id: 'j5', number: 'TSG101', title: 'Panel installation', customer: 'Eastern Hydro Works', status: 'Draft', start_date: k(5), end_date: k(5), staff_ids: [] },
    ],
  };
}

function JobChip({ job, dayKey, compact = false }) {
  const t = tone(job.status);
  const continues = dayKey && job.start_date && dayKey > String(job.start_date).slice(0, 10);
  return <span className={`sc-chip tone-${t}`} title={`${job.number} · ${job.title || 'Job order'}${job.customer ? ` · ${job.customer}` : ''}\n${jobRange(job)} · ${job.status}`}>
    <span className="sc-chip-top"><b>{job.number}</b><em>{TONE_LABEL[t]}</em></span>
    {!compact && <span className="sc-chip-title">{job.title || 'Job order'}</span>}
    {!compact && job.customer && <span className="sc-chip-sub">{job.customer}</span>}
    {!compact && <span className="sc-chip-sub">{continues ? 'continued · ' : ''}{jobRange(job)}</span>}
  </span>;
}

export default function TeamSchedule({ user }) {
  const isDemo = Boolean(user.id?.startsWith('demo-'));
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(() => toKey(today()));
  const [search, setSearch] = useState('');
  const { from, to } = rangeFor(view, anchor);
  const fromK = toKey(from); const toK = toKey(to);

  const query = useQuery({
    queryKey: ['team-schedule', fromK, toK],
    queryFn: () => apiRequest(`/schedule?from=${fromK}&to=${toK}`),
    enabled: !isDemo,
    staleTime: 30_000,
  });
  const data = isDemo ? demoSchedule(user) : query.data;

  const days = useMemo(() => { const list = []; for (let d = from; d <= to; d = addDays(d, 1)) list.push(d); return list; }, [fromK, toK]);

  const { staff, byStaffDay, unassignedByDay, jobsByDay } = useMemo(() => {
    const meIds = new Set((data?.me || []).map(String));
    const people = [...(data?.staff || [])].map(person => ({ ...person, id: String(person.id), isMe: meIds.has(String(person.id)) }))
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || String(a.name).localeCompare(String(b.name)));
    const map = new Map(); const unassigned = new Map(); const perDay = new Map();
    const push = (target, key, day, job) => { if (!target.has(key)) target.set(key, new Map()); const inner = target.get(key); if (!inner.has(day)) inner.set(day, []); inner.get(day).push(job); };
    const add = (target, key, job) => { if (!target.has(key)) target.set(key, []); target.get(key).push(job); };
    for (const job of data?.jobs || []) {
      if (!job.start_date) continue;
      const start = fromKey(job.start_date); const end = fromKey(job.end_date || job.start_date);
      const ids = (job.staff_ids || []).map(String);
      for (let d = start < from ? from : start; d <= (end > to ? to : end); d = addDays(d, 1)) {
        const dayKey = toKey(d);
        add(perDay, dayKey, job);
        if (!ids.length) add(unassigned, dayKey, job);
        ids.forEach(id => push(map, id, dayKey, job));
      }
    }
    return { staff: people, byStaffDay: map, unassignedByDay: unassigned, jobsByDay: perDay };
  }, [data, fromK, toK]);

  const visibleStaff = staff.filter(person => `${person.name} ${person.designation || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const jobsOn = (id, day) => byStaffDay.get(id)?.get(day) || [];
  const isBusy = (id, day) => jobsOn(id, day).some(job => !isDone(job.status));
  const freeCount = day => visibleStaff.filter(person => !isBusy(person.id, day)).length;
  const staffName = id => staff.find(person => person.id === String(id))?.name || '';

  const todayKey = toKey(today());
  const shift = dir => setAnchor(a => view === 'week' ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1));
  const goToday = () => { setAnchor(today()); setSelected(todayKey); };
  const title = view === 'week'
    ? `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : fmt(anchor, { month: 'long', year: 'numeric' });

  const selectedDate = fromKey(selected);
  const freeOnSelected = visibleStaff.filter(person => !isBusy(person.id, selected));
  const busyOnSelected = visibleStaff.filter(person => isBusy(person.id, selected));
  const unassignedOnSelected = (unassignedByDay.get(selected) || []).filter(job => !isDone(job.status));

  return <>
    <div className="page-heading">
      <div><h1>Team schedule</h1><p>See who is free and which jobs each person is on, day by day.</p></div>
      <div className="heading-actions schedule-actions">
        <div className="schedule-toggle" role="tablist" aria-label="Calendar view">
          {['week', 'month'].map(option => <button key={option} role="tab" aria-selected={view === option} className={view === option ? 'active' : ''} onClick={() => setView(option)}>{option === 'week' ? 'Week' : 'Month'}</button>)}
        </div>
        <button className="secondary-button" onClick={goToday}><CalendarDays size={15} />Today</button>
      </div>
    </div>

    <section className="panel schedule-panel">
      <div className="schedule-toolbar">
        <div className="schedule-nav">
          <button className="icon-button" aria-label={`Previous ${view}`} onClick={() => shift(-1)}><ChevronLeft size={18} /></button>
          <h2>{title}</h2>
          <button className="icon-button" aria-label={`Next ${view}`} onClick={() => shift(1)}><ChevronRight size={18} /></button>
        </div>
        <label className="schedule-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter staff" aria-label="Filter staff" /></label>
        <div className="schedule-legend" aria-hidden="true"><span><i className="free" />Free</span>{['planned', 'progress', 'hold', 'draft', 'done'].map(t => <span key={t}><i className={t} />{TONE_LABEL[t]}</span>)}</div>
      </div>

      {!isDemo && query.isLoading && <div className="schedule-empty">Loading schedule…</div>}
      {!isDemo && query.isError && <div className="schedule-empty">Could not load the schedule. {query.error?.message}</div>}
      {data && !staff.length && <div className="schedule-empty">No active staff members yet.</div>}

      {data && staff.length > 0 && <>
        {view === 'week'
          ? <div className="schedule-scroll"><div className="schedule-board">
              <div className="sb-corner">Staff <small>{visibleStaff.length}</small></div>
              {days.map(day => { const key = toKey(day); const free = freeCount(key); return <button key={key} className={`sb-day ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''} ${isWeekend(day) ? 'weekend' : ''}`} onClick={() => setSelected(key)}>
                <span>{fmt(day, { weekday: 'short' })}</span><b>{day.getDate()}</b><small><i className="dot-free" />{free} free · {visibleStaff.length - free} busy</small>
              </button>; })}
              {visibleStaff.map(person => { const busyDays = days.filter(day => isBusy(person.id, toKey(day))).length; return <div className="sb-row" key={person.id}>
                <div className={`sb-person ${person.isMe ? 'me' : ''}`}><span className="sb-avatar">{initials(person.name)}</span><span className="sb-person-text"><b>{person.name}{person.isMe && <em>You</em>}</b><small>{person.designation || 'Staff'}</small><small className={busyDays ? 'booked' : 'free'}>{busyDays ? `${busyDays} of 7 days booked` : 'Free all week'}</small></span></div>
                {days.map(day => { const key = toKey(day); const jobs = jobsOn(person.id, key); const busy = jobs.some(job => !isDone(job.status)); return <button key={key} className={`sb-cell ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''} ${busy ? 'busy' : 'free'} ${isWeekend(day) ? 'weekend' : ''}`} onClick={() => setSelected(key)} aria-label={`${person.name}, ${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${busy ? jobs.map(job => `${job.number} ${job.status}`).join(', ') : 'free'}`}>
                  {jobs.map(job => <JobChip key={job.id} job={job} dayKey={key} />)}
                  {!busy && <span className="sb-free">Free</span>}
                </button>; })}
              </div>; })}
              {!visibleStaff.length && <div className="sb-nomatch">No staff match “{search}”.</div>}
            </div></div>
          : <div className="schedule-month">
              {WEEKDAYS.map(name => <div className="sm-head" key={name}>{name}</div>)}
              {days.map(day => { const key = toKey(day); const free = freeCount(key); const total = visibleStaff.length; const busy = total - free; const jobs = (jobsByDay.get(key) || []).filter(job => !isDone(job.status)); return <button key={key} className={`sm-day ${day.getMonth() !== anchor.getMonth() ? 'outside' : ''} ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''} ${isWeekend(day) ? 'weekend' : ''}`} onClick={() => setSelected(key)} aria-label={`${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${free} free, ${busy} busy, ${jobs.length} active jobs`}>
                <span className="sm-top"><b>{day.getDate()}</b><span className="sm-free">{free}/{total} free</span></span>
                {jobs.slice(0, 3).map(job => <JobChip key={job.id} job={job} compact />)}
                {jobs.length > 3 && <span className="sm-more">+{jobs.length - 3} more</span>}
                <span className="sm-bar" title={`${busy} of ${total} busy`}><i style={{ width: total ? `${(busy / total) * 100}%` : 0 }} /></span>
              </button>; })}
            </div>}

        <div className="schedule-day" aria-live="polite">
          <div className="sd-head"><h3>{fmt(selectedDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3><p><b>{freeOnSelected.length}</b> of {visibleStaff.length} staff free · <b>{busyOnSelected.length}</b> busy{unassignedOnSelected.length ? <> · <b>{unassignedOnSelected.length}</b> unassigned job{unassignedOnSelected.length === 1 ? '' : 's'}</> : null}</p></div>
          <div className="sd-columns">
            <div className="sd-col">
              <h4><i className="dot-free" />Free ({freeOnSelected.length})</h4>
              {freeOnSelected.length ? <div className="sd-free-list">{freeOnSelected.map(person => <span key={person.id} className={person.isMe ? 'me' : ''}><span className="sb-avatar">{initials(person.name)}</span><span><b>{person.name}{person.isMe && ' (you)'}</b><small>{person.designation || 'Staff'}</small></span></span>)}</div> : <p className="sd-empty">Everyone is booked on this day.</p>}
            </div>
            <div className="sd-col">
              <h4><i className="dot-busy" />Busy ({busyOnSelected.length})</h4>
              {busyOnSelected.length ? busyOnSelected.map(person => <div className="sd-busy" key={person.id}>
                <b>{person.name}{person.isMe && ' (you)'}</b>
                {jobsOn(person.id, selected).filter(job => !isDone(job.status)).map(job => <JobChip key={job.id} job={job} dayKey={selected} />)}
              </div>) : <p className="sd-empty">No one is booked on this day.</p>}
            </div>
            {unassignedOnSelected.length > 0 && <div className="sd-col">
              <h4><i className="dot-draft" />Not yet assigned ({unassignedOnSelected.length})</h4>
              {unassignedOnSelected.map(job => <JobChip key={job.id} job={job} dayKey={selected} />)}
            </div>}
          </div>
          {view === 'month' && (jobsByDay.get(selected) || []).some(job => (job.staff_ids || []).length) && <p className="sd-team-note">Teams: {(jobsByDay.get(selected) || []).filter(job => !isDone(job.status) && (job.staff_ids || []).length).map(job => `${job.number} – ${(job.staff_ids || []).map(staffName).filter(Boolean).join(', ')}`).join(' · ')}</p>}
        </div>
      </>}
    </section>
    <div className="module-note"><CalendarDays size={15} /><span>Free means no active job on that day. Completed and closed jobs do not block a day. Click any day to see who is free.</span></div>
  </>;
}
