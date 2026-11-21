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
const initials = (name = '') => name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();
const fmt = (d, options) => new Intl.DateTimeFormat('en-GB', options).format(d);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

  const { staff, byStaffDay, unassignedByDay, me } = useMemo(() => {
    const meIds = new Set((data?.me || []).map(String));
    const people = [...(data?.staff || [])].map(person => ({ ...person, id: String(person.id), isMe: meIds.has(String(person.id)) }))
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || String(a.name).localeCompare(String(b.name)));
    const map = new Map(); const unassigned = new Map();
    const push = (target, key, day, job) => { if (!target.has(key)) target.set(key, new Map()); const inner = target.get(key); if (!inner.has(day)) inner.set(day, []); inner.get(day).push(job); };
    for (const job of data?.jobs || []) {
      if (!job.start_date) continue;
      const start = fromKey(job.start_date); const end = fromKey(job.end_date || job.start_date);
      const ids = (job.staff_ids || []).map(String);
      for (let d = start < from ? from : start; d <= (end > to ? to : end); d = addDays(d, 1)) {
        const dayKey = toKey(d);
        if (!ids.length) { if (!unassigned.has(dayKey)) unassigned.set(dayKey, []); unassigned.get(dayKey).push(job); }
        ids.forEach(id => push(map, id, dayKey, job));
      }
    }
    return { staff: people, byStaffDay: map, unassignedByDay: unassigned, me: meIds };
  }, [data, fromK, toK]);

  const visibleStaff = staff.filter(person => `${person.name} ${person.designation || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const jobsOn = (id, day) => byStaffDay.get(id)?.get(day) || [];
  const isBusy = (id, day) => jobsOn(id, day).some(job => !isDone(job.status));
  const freeCount = day => visibleStaff.filter(person => !isBusy(person.id, day)).length;

  const todayKey = toKey(today());
  const shift = dir => setAnchor(a => view === 'week' ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1));
  const goToday = () => { setAnchor(today()); setSelected(todayKey); };
  const title = view === 'week'
    ? `${fmt(from, { day: '2-digit', month: 'short' })} – ${fmt(to, { day: '2-digit', month: 'short', year: 'numeric' })}`
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
        <div className="schedule-legend" aria-hidden="true"><span><i className="free" />Free</span><span><i className="planned" />Assigned</span><span><i className="progress" />In progress</span><span><i className="hold" />On hold</span><span><i className="done" />Done</span></div>
      </div>

      {!isDemo && query.isLoading && <div className="schedule-empty">Loading schedule…</div>}
      {!isDemo && query.isError && <div className="schedule-empty">Could not load the schedule. {query.error?.message}</div>}
      {data && !staff.length && <div className="schedule-empty">No active staff members yet.</div>}

      {data && staff.length > 0 && <div className="schedule-layout">
        {view === 'week'
          ? <div className="schedule-scroll"><div className="schedule-board">
              <div className="sb-corner">Staff</div>
              {days.map(day => { const key = toKey(day); return <button key={key} className={`sb-day ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''}`} onClick={() => setSelected(key)}>
                <span>{fmt(day, { weekday: 'short' })}</span><b>{day.getDate()}</b><small>{freeCount(key)} free</small>
              </button>; })}
              {visibleStaff.map(person => { const busyDays = days.filter(day => isBusy(person.id, toKey(day))).length; return <div className="sb-row" key={person.id}>
                <div className={`sb-person ${person.isMe ? 'me' : ''}`}><span className="sb-avatar">{initials(person.name)}</span><span><b>{person.name}{person.isMe && <em>You</em>}</b><small>{busyDays ? `${busyDays} of 7 days booked` : 'Free all week'}</small></span></div>
                {days.map(day => { const key = toKey(day); const jobs = jobsOn(person.id, key); const busy = jobs.some(job => !isDone(job.status)); return <button key={key} className={`sb-cell ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''} ${busy ? 'busy' : 'free'}`} onClick={() => setSelected(key)} aria-label={`${person.name}, ${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${busy ? jobs.map(job => job.number).join(', ') : 'free'}`}>
                  {jobs.map(job => <span key={job.id} className={`sb-job tone-${tone(job.status)}`} title={`${job.number} · ${job.title || ''}${job.customer ? ` · ${job.customer}` : ''} (${job.status})`}><b>{job.number}</b><small>{job.customer || job.title}</small></span>)}
                  {!busy && <span className="sb-free">Free</span>}
                </button>; })}
              </div>; })}
              {!visibleStaff.length && <div className="sb-nomatch">No staff match “{search}”.</div>}
            </div></div>
          : <div className="schedule-month">
              {WEEKDAYS.map(name => <div className="sm-head" key={name}>{name}</div>)}
              {days.map(day => { const key = toKey(day); const free = freeCount(key); const total = visibleStaff.length; const busy = total - free; return <button key={key} className={`sm-day ${day.getMonth() !== anchor.getMonth() ? 'outside' : ''} ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''}`} onClick={() => setSelected(key)} aria-label={`${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${free} free, ${busy} busy`}>
                <b>{day.getDate()}</b>
                <span className="sm-free">{free} free</span>
                {busy > 0 && <span className="sm-busy">{busy} busy</span>}
                <span className="sm-bar"><i style={{ width: total ? `${(busy / total) * 100}%` : 0 }} /></span>
              </button>; })}
            </div>}

        <aside className="schedule-day" aria-live="polite">
          <div className="sd-head"><h3>{fmt(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}</h3><p>{freeOnSelected.length} of {visibleStaff.length} staff free</p></div>
          <h4>Free</h4>
          {freeOnSelected.length ? <div className="sd-free-list">{freeOnSelected.map(person => <span key={person.id} className={person.isMe ? 'me' : ''}><span className="sb-avatar">{initials(person.name)}</span>{person.name}{person.isMe && ' (you)'}</span>)}</div> : <p className="sd-empty">Everyone is booked on this day.</p>}
          <h4>Busy</h4>
          {busyOnSelected.length ? busyOnSelected.map(person => <div className="sd-busy" key={person.id}>
            <b>{person.name}{person.isMe && ' (you)'}</b>
            {jobsOn(person.id, selected).filter(job => !isDone(job.status)).map(job => <div key={job.id} className={`sd-job tone-${tone(job.status)}`}>
              <span><b>{job.number}</b> · {job.title || 'Job order'}</span>
              <small>{job.customer || '—'} · {fmt(fromKey(job.start_date), { day: 'numeric', month: 'short' })}{job.end_date && job.end_date !== job.start_date ? ` – ${fmt(fromKey(job.end_date), { day: 'numeric', month: 'short' })}` : ''} · {job.status}</small>
            </div>)}
          </div>) : <p className="sd-empty">No one is booked on this day.</p>}
          {unassignedOnSelected.length > 0 && <><h4>Not yet assigned</h4>{unassignedOnSelected.map(job => <div key={job.id} className={`sd-job tone-${tone(job.status)}`}><span><b>{job.number}</b> · {job.title || 'Job order'}</span><small>{job.customer || '—'} · {job.status}</small></div>)}</>}
        </aside>
      </div>}
    </section>
    <div className="module-note"><CalendarDays size={15} /><span>Free means no active job on that day. Completed and closed jobs do not block a day. Click any day to see who is free.</span></div>
  </>;
}
