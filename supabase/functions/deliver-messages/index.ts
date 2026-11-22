// Sends queued alerts (public.outbound_messages) by email and Telegram.
//
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   RESEND_API_KEY      email through https://resend.com (optional)
//   ALERT_EMAIL_FROM    sender, e.g. "TSG Power <alerts@yourdomain.com>"
//   TELEGRAM_BOT_TOKEN  bot from @BotFather (optional)
// A channel without its secret is skipped and its messages stay queued.
//
// Called by the app after it queues messages, and every few minutes by
// pg_cron (see README). Any signed-in user may trigger it: it only sends what
// the database already queued, at most 50 messages per call.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Message = { id: string; channel: 'email' | 'telegram'; recipient: string; subject: string | null; body: string; attempts: number };

async function sendEmail(m: Message, key: string, from: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.recipient], subject: m.subject || 'TSG Power', text: m.body }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function sendTelegram(m: Message, token: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: m.recipient, text: m.body, parse_mode: 'Markdown' }),
  });
  if (!res.ok) throw new Error(`Telegram failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  // New secret key (TSG_SECRET_KEY function secret); legacy key until it is set.
  const serviceKey = (Deno.env.get('TSG_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Caller must be a signed-in user, or the scheduled job sending the secret key.
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Sign in required' }, 401);
  if (token !== serviceKey) {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return json({ error: 'Sign in required' }, 401);
  }

  const resendKey = Deno.env.get('RESEND_API_KEY') || '';
  const from = Deno.env.get('ALERT_EMAIL_FROM') || 'TSG Power <onboarding@resend.dev>';
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  const channels = [...(resendKey ? ['email'] : []), ...(botToken ? ['telegram'] : [])];
  if (!channels.length) return json({ sent: 0, failed: 0, note: 'No channel configured (set RESEND_API_KEY and/or TELEGRAM_BOT_TOKEN).' });

  const { data: queue, error } = await admin.from('outbound_messages')
    .select('id, channel, recipient, subject, body, attempts')
    .eq('status', 'Queued').in('channel', channels).lt('attempts', 5)
    .order('created_at').limit(50);
  if (error) return json({ error: error.message }, 500);

  let sent = 0;
  let failed = 0;
  for (const m of (queue || []) as Message[]) {
    try {
      if (m.channel === 'email') await sendEmail(m, resendKey, from);
      else await sendTelegram(m, botToken);
      await admin.from('outbound_messages').update({ status: 'Sent', sent_at: new Date().toISOString(), attempts: m.attempts + 1, error: null }).eq('id', m.id);
      sent += 1;
    } catch (e) {
      const attempts = m.attempts + 1;
      await admin.from('outbound_messages').update({ status: attempts >= 5 ? 'Failed' : 'Queued', attempts, error: e instanceof Error ? e.message : String(e) }).eq('id', m.id);
      failed += 1;
    }
  }
  return json({ sent, failed });
});
