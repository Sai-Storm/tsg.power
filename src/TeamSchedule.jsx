import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { apiRequest } from './api/client.js';
import './schedule.css';

// Team schedule: who is free and which jobs each person is on.
// Week view = one card per person with a 7-day strip (never scrolls sideways);
// month view = calendar of free/busy counts. Click a day for the details.

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
const isDone = status => /completed|closed|invoice generated|cancel/i.test(String(status || ''));
const tone = status => {
  const s = String(status || '').toLowerCase();
  if (isDone(s)) return 'done';
  if (s === 'in progress') return 'progress';
  if (/hold|waiting/.test(s)) return 'hold';
  if (/assigned|scheduled/.test(s)) return 'planned';
  return 'draft';
};
const TONE_LABEL = { planned: 'Assigned', progress: 'In progress', hold: 'On hold', done: 'Done', draft: 'Not started' };
const TONE_ORDER = ['progress', 'hold', 'planned', 'draft'];

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

function JobCard({ job, showRange = true }) {
  const t = tone(job.status);
  return <div className={`ts-job tone-${t}`}>
    <div className="ts-job-top"><b>{job.number}</b><span className={`ts-pill tone-${t}`}>{TONE_LABEL[t]}</span></div>
    <div className="ts-job-title">{job.title || 'Job order'}{job.customer ? <span> · {job.customer}</span> : null}</div>
    {showRange && <div className="ts-job-dates"><CalendarDays size={13} />{jobRange(job)}</div>}
  </div>;
}

export default function TeamSchedule() {
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(() => toKey(today()));
  const [search, setSearch] = useState('');
  const [busyOnly, setBusyOnly] = useState(false);
  const { from, to } = rangeFor(view, anchor);
  const fromK = toKey(from); const toK = toKey(to);

  const query = useQuery({
    queryKey: ['team-schedule', fromK, toK],
    queryFn: () => apiRequest(`/schedule?from=${fromK}&to=${toK}`),
    staleTime: 30_000,
  });
  const data = query.data;

  const days = useMemo(() => { const list = []; for (let d = from; d <= to; d = addDays(d, 1)) list.push(d); return list; }, [fromK, toK]);

  const { staff, byStaffDay, unassignedByDay, jobsByDay } = useMemo(() => {
    const meIds = new Set((data?.me || []).map(String));
    const people = [...(data?.staff || [])].map(person => ({ ...person, id: String(person.id), isMe: meIds.has(String(person.id)) }))
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || String(a.name).localeCompare(String(b.name)));
    const map = new Map(); const unassigned = new Map(); const perDay = new Map();
    const push = (key, day, job) => { if (!map.has(key)) map.set(key, new Map()); const inner = map.get(key); if (!inner.has(day)) inner.set(day, []); inner.get(day).push(job); };
    const add = (target, key, job) => { if (!target.has(key)) target.set(key, []); target.get(key).push(job); };
    for (const job of data?.jobs || []) {
      if (!job.start_date) continue;
      const start = fromKey(job.start_date); const end = fromKey(job.end_date || job.start_date);
      const ids = (job.staff_ids || []).map(String);
      for (let d = start < from ? from : start; d <= (end > to ? to : end); d = addDays(d, 1)) {
        const dayKey = toKey(d);
        add(perDay, dayKey, job);
        if (!ids.length) add(unassigned, dayKey, job);
        ids.forEach(id => push(id, dayKey, job));
      }
    }
    return { staff: people, byStaffDay: map, unassignedByDay: unassigned, jobsByDay: perDay };
  }, [data, fromK, toK]);

  const jobsOn = (id, day) => (byStaffDay.get(id)?.get(day) || []).filter(job => !isDone(job.status));
  const isBusy = (id, day) => jobsOn(id, day).length > 0;
  const dayTone = (id, day) => { const tones = jobsOn(id, day).map(job => tone(job.status)); return TONE_ORDER.find(t => tones.includes(t)) || 'free'; };
  const matches = person => `${person.name} ${person.designation || ''}`.toLowerCase().includes(search.trim().toLowerCase());
  const searchedStaff = staff.filter(matches);
  const weekKeys = days.map(toKey);
  const busyDaysOf = person => weekKeys.filter(key => isBusy(person.id, key)).length;
  const visibleStaff = busyOnly ? searchedStaff.filter(person => busyDaysOf(person) > 0) : searchedStaff;
  const freeCount = day => searchedStaff.filter(person => !isBusy(person.id, day)).length;
  const weekJobsOf = person => {
    const seen = new Map();
    weekKeys.forEach(key => jobsOn(person.id, key).forEach(job => seen.set(job.id, job)));
    return [...seen.values()].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  };

  const todayKey = toKey(today());
  const shift = dir => setAnchor(a => (view === 'week' ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  const goToday = () => { setAnchor(today()); setSelected(todayKey); };
  const title = view === 'week'
    ? `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : fmt(anchor, { month: 'long', year: 'numeric' });

  const selectedDate = fromKey(selected);
  const freeOnSelected = searchedStaff.filter(person => !isBusy(person.id, selected));
  const busyOnSelected = searchedStaff.filter(person => isBusy(person.id, selected));
  const unassignedOnSelected = (unassignedByDay.get(selected) || []).filter(job => !isDone(job.status));
  const total = searchedStaff.length;

  return <div className="ts-root">
    <div className="page-heading ts-heading">
      <div><div className="eyebrow">OPERATIONS</div><h1>Team schedule</h1><p>Who is free, and which job each person is on, day by day.</p></div>
      <div className="ts-heading-actions">
        <div className="ts-toggle" role="tablist" aria-label="Calendar view">
          {['week', 'month'].map(option => <button key={option} role="tab" aria-selected={view === option} className={view === option ? 'active' : ''} onClick={() => setView(option)}>{option === 'week' ? 'Week' : 'Month'}</button>)}
        </div>
        <button className="ts-btn" onClick={goToday}><CalendarDays size={16} />Today</button>
      </div>
    </div>

    <section className="ts-panel">
      <div className="ts-toolbar">
        <div className="ts-nav">
          <button className="ts-icon" aria-label={`Previous ${view}`} onClick={() => shift(-1)}><ChevronLeft size={20} /></button>
          <h2>{title}</h2>
          <button className="ts-icon" aria-label={`Next ${view}`} onClick={() => shift(1)}><ChevronRight size={20} /></button>
        </div>
        <label className="ts-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a staff member" aria-label="Find a staff member" /></label>
        {view === 'week' && <label className="ts-check"><input type="checkbox" checked={busyOnly} onChange={event => setBusyOnly(event.target.checked)} />Only people with jobs</label>}
      </div>

      {query.isLoading && <div className="ts-empty">Loading schedule…</div>}
      {query.isError && <div className="ts-empty">Could not load the schedule. {query.error?.message}</div>}
      {data && !staff.length && <div className="ts-empty">No active staff members yet.</div>}

      {data && staff.length > 0 && view === 'week' && <>
        <div className="ts-days" role="tablist" aria-label="Days of the week">
          {days.map(day => {
            const key = toKey(day); const free = freeCount(key); const busy = total - free;
            return <button key={key} role="tab" aria-selected={key === selected} className={`ts-day ${key === selected ? 'selected' : ''} ${key === todayKey ? 'today' : ''} ${isWeekend(day) ? 'weekend' : ''}`} onClick={() => setSelected(key)}>
              <span className="ts-day-name">{fmt(day, { weekday: 'short' })}{key === todayKey && <em>Today</em>}</span>
              <b>{day.getDate()}</b>
              <span className="ts-day-count"><strong>{free}</strong> free · <strong>{busy}</strong> busy</span>
              <span className="ts-day-bar" aria-hidden="true"><i style={{ width: total ? `${(busy / total) * 100}%` : 0 }} /></span>
            </button>;
          })}
        </div>

        <div className="ts-legend" aria-hidden="true">
          <span><i className="free" />Free</span>
          {['progress', 'planned', 'hold', 'draft'].map(t => <span key={t}><i className={`tone-${t}`} />{TONE_LABEL[t]}</span>)}
        </div>

        <div className="ts-people">
          {visibleStaff.map(person => {
            const busyDays = busyDaysOf(person); const jobs = weekJobsOf(person);
            return <article key={person.id} className={`ts-person ${person.isMe ? 'me' : ''}`}>
              <header className="ts-person-head">
                <span className="ts-avatar">{initials(person.name)}</span>
                <div className="ts-person-name"><b>{person.name}{person.isMe && <em>You</em>}</b><small>{person.designation || 'Staff'}</small></div>
                <span className={`ts-load ${busyDays ? 'booked' : 'free'}`}>{busyDays ? `Busy ${busyDays} of 7 days` : 'Free all week'}</span>
              </header>
              <div className="ts-week" role="list" aria-label={`${person.name} this week`}>
                {days.map(day => {
                  const key = toKey(day); const t = dayTone(person.id, key); const dayJobs = jobsOn(person.id, key);
                  const label = dayJobs.length ? dayJobs.map(job => job.number).join(', ') : 'Free';
                  return <button key={key} role="listitem" className={`ts-slot ${t === 'free' ? 'free' : `tone-${t}`} ${key === selected ? 'selected' : ''} ${key === todayKey ? 'today' : ''}`} onClick={() => setSelected(key)} title={`${fmt(day, { weekday: 'long', day: 'numeric', month: 'short' })}: ${label}`} aria-label={`${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${label}`}>
                    <span className="ts-slot-day">{WEEKDAYS[(day.getDay() + 6) % 7]}</span>
                    <span className="ts-slot-text">{dayJobs.length ? dayJobs[0].number : 'Free'}{dayJobs.length > 1 ? ` +${dayJobs.length - 1}` : ''}</span>
                  </button>;
                })}
              </div>
              {jobs.length > 0 && <div className="ts-person-jobs">{jobs.map(job => <JobCard key={job.id} job={job} />)}</div>}
            </article>;
          })}
          {!visibleStaff.length && <div className="ts-empty">{search ? `No staff match “${search}”.` : 'Nobody has a job this week.'}</div>}
        </div>
      </>}

      {data && staff.length > 0 && view === 'month' && <div className="ts-month">
        {WEEKDAYS.map(name => <div className="ts-month-head" key={name}>{name}</div>)}
        {days.map(day => {
          const key = toKey(day); const free = freeCount(key); const busy = total - free;
          const jobs = (jobsByDay.get(key) || []).filter(job => !isDone(job.status));
          return <button key={key} className={`ts-month-day ${day.getMonth() !== anchor.getMonth() ? 'outside' : ''} ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''} ${isWeekend(day) ? 'weekend' : ''}`} onClick={() => setSelected(key)} aria-label={`${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${free} free, ${busy} busy, ${jobs.length} active jobs`}>
            <span className="ts-month-top"><b>{day.getDate()}</b>{jobs.length > 0 && <span className="ts-month-jobs">{jobs.length} job{jobs.length === 1 ? '' : 's'}</span>}</span>
            <span className="ts-month-free"><strong>{free}</strong>/{total} free</span>
            <span className="ts-day-bar" aria-hidden="true"><i style={{ width: total ? `${(busy / total) * 100}%` : 0 }} /></span>
          </button>;
        })}
      </div>}
    </section>

    {data && staff.length > 0 && <section className="ts-panel ts-detail" aria-live="polite">
      <div className="ts-detail-head">
        <h3>{fmt(selectedDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
        <p><strong>{freeOnSelected.length}</strong> of {total} free · <strong>{busyOnSelected.length}</strong> busy{unassignedOnSelected.length ? <> · <strong>{unassignedOnSelected.length}</strong> job{unassignedOnSelected.length === 1 ? '' : 's'} not assigned</> : null}</p>
      </div>
      <div className="ts-detail-cols">
        <div>
          <h4><i className="free" />Free ({freeOnSelected.length})</h4>
          {freeOnSelected.length
            ? <ul className="ts-free-list">{freeOnSelected.map(person => <li key={person.id}><span className="ts-avatar small">{initials(person.name)}</span><span><b>{person.name}{person.isMe && ' (you)'}</b><small>{person.designation || 'Staff'}</small></span></li>)}</ul>
            : <p className="ts-muted">Everyone is booked on this day.</p>}
        </div>
        <div>
          <h4><i className="busy" />Busy ({busyOnSelected.length})</h4>
          {busyOnSelected.length
            ? busyOnSelected.map(person => <div className="ts-busy" key={person.id}><b>{person.name}{person.isMe && ' (you)'}</b>{jobsOn(person.id, selected).map(job => <JobCard key={job.id} job={job} />)}</div>)
            : <p className="ts-muted">No one is booked on this day.</p>}
        </div>
        {unassignedOnSelected.length > 0 && <div>
          <h4><i className="tone-draft" />Not yet assigned ({unassignedOnSelected.length})</h4>
          {unassignedOnSelected.map(job => <JobCard key={job.id} job={job} />)}
        </div>}
      </div>
    </section>}

    <p className="ts-note"><CalendarDays size={15} />Free means no active job that day. Completed, closed and cancelled jobs do not block a day.</p>
  </div>;
}
