import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Send, X } from 'lucide-react';
import { apiRequest } from '../../api/client.js';

// Admin writes one message and sends it to all staff, everyone, or chosen people.
export default function SendNotificationDialog({ user, onClose, onConfirm }) {
  const [audience, setAudience] = useState('staff');
  const [chosen, setChosen] = useState([]);
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [relatedTo, setRelatedTo] = useState('');

  const people = useQuery({
    queryKey: ['notification-recipients'],
    queryFn: () => apiRequest('/users?limit=500'),
    staleTime: 60_000,
  });
  const everyone = (people.data?.items || []).filter(person => person.is_active !== false && String(person.id) !== String(user?.id));
  const term = search.trim().toLowerCase();
  const shown = everyone.filter(person => !term || `${person.user} ${person.username} ${person.role}`.toLowerCase().includes(term));
  const staffCount = everyone.filter(person => person.role === 'Staff').length;
  const count = audience === 'people' ? chosen.length : audience === 'staff' ? staffCount : everyone.length;
  const toggle = id => setChosen(old => (old.includes(id) ? old.filter(item => item !== id) : [...old, id]));
  const canSend = title.trim() && count > 0;

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="modal send-note-modal" role="dialog" aria-label="Send notification">
      <div className="modal-header">
        <div><div className="eyebrow">NOTIFICATIONS</div><h2>Send a notification</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
      </div>

      <div className="record-fields special-fields">
        <fieldset className="wide-field send-note-audience">
          <legend>Send to</legend>
          {[['staff', `All staff (${staffCount})`], ['everyone', `Everyone (${everyone.length})`], ['people', 'Choose people']].map(([value, label]) => <label key={value} className={audience === value ? 'selected' : ''}>
            <input type="radio" name="audience" value={value} checked={audience === value} onChange={() => setAudience(value)} />{label}
          </label>)}
        </fieldset>

        {audience === 'people' && <div className="wide-field send-note-people">
          <div className="search-box"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search people" /></div>
          {people.isLoading && <p>Loading people…</p>}
          {people.isError && <p className="send-note-error">{people.error?.message}</p>}
          <ul>
            {shown.map(person => <li key={person.id}><label>
              <input type="checkbox" checked={chosen.includes(person.id)} onChange={() => toggle(person.id)} />
              <span><b>{person.user || person.username}</b><small>{person.role}{person.username ? ` · ${person.username}` : ''}</small></span>
            </label></li>)}
            {!people.isLoading && !shown.length && <li className="empty">No one matches.</li>}
          </ul>
        </div>}

        <label className="wide-field">Title
          <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="e.g. Submit your advance receipts by Friday" autoFocus />
        </label>
        <label className="wide-field">Message
          <textarea rows={4} value={details} maxLength={1000} onChange={event => setDetails(event.target.value)} placeholder="Details (optional)" />
        </label>
        <label className="wide-field">Related to
          <input value={relatedTo} maxLength={80} onChange={event => setRelatedTo(event.target.value)} placeholder="e.g. TSG003 or Advance ADV-2026-0002 (optional)" />
        </label>
      </div>

      <div className="modal-footer">
        <button className="secondary-button" onClick={onClose}>Cancel</button>
        <button className="primary-button" disabled={!canSend}
          onClick={() => onConfirm({ notification: { audience, recipients: audience === 'people' ? chosen : [], title: title.trim(), details: details.trim(), related_to: relatedTo.trim() } })}>
          <Send size={15} />Send to {count} {count === 1 ? 'person' : 'people'}
        </button>
      </div>
    </section>
  </div>;
}
