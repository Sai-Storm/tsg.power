import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing, Send } from 'lucide-react';
import { apiRequest } from '../api/client.js';

// Get notifications outside the app: by email and/or Telegram.
export default function AlertSettings({ notify }) {
  const query = useQuery({ queryKey: ['alert-preferences'], queryFn: () => apiRequest('/alerts/preferences'), staleTime: 60_000 });
  const [email, setEmail] = useState(false);
  const [chat, setChat] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setEmail(Boolean(query.data.email_alerts));
    setChat(query.data.telegram_chat_id || '');
  }, [query.data]);

  const save = async () => {
    setBusy(true);
    try {
      await apiRequest('/alerts/preferences', { method: 'PUT', body: JSON.stringify({ email_alerts: email, telegram_chat_id: chat }) });
      await query.refetch();
      notify?.('Alert settings saved.');
    } catch (error) { notify?.(error.message, 'error'); }
    finally { setBusy(false); }
  };

  return <section className="panel profile-panel alert-settings">
    <h2><BellRing size={18} />Alerts outside the app</h2>
    <p>Approvals, overdue advances, invoices due and other notifications can also reach you here.</p>
    {query.isError && <p className="form-error">{/could not find|column/i.test(query.error?.message || '') ? 'Alerts need the latest database update.' : query.error?.message}</p>}
    <div className="record-fields special-fields">
      <label className="alert-check wide-field"><input type="checkbox" checked={email} onChange={e => setEmail(e.target.checked)} disabled={!query.data} />
        <span><b>Email me</b><small>Sent to {query.data?.email || 'your login email'}</small></span></label>
      <label className="wide-field">Telegram chat ID
        <input inputMode="numeric" value={chat} onChange={e => setChat(e.target.value.trim())} placeholder="e.g. 123456789 (leave empty for no Telegram)" disabled={!query.data} />
        <small>In Telegram, open the company bot and press Start, then message <b>@userinfobot</b> to see your chat ID and paste it here.</small>
      </label>
    </div>
    <div className="profile-actions"><button className="primary-button" disabled={busy || !query.data} onClick={save}><Send size={15} />{busy ? 'Saving…' : 'Save alert settings'}</button></div>
  </section>;
}
