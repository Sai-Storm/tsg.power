# TSG Power Engineering frontend

React + Vite operations workspace following the frontend architecture in the supplied system design report. It includes a single role-aware application shell, Admin and Staff navigation, dashboards, reusable module tables, protected routes, and shared Excel/PDF and delete controls.

The backend is **Supabase (PostgreSQL + Auth + Storage + Edge Functions)**. The browser talks to Supabase with the public anon key; all authorization is enforced by Row Level Security.

## Run locally

```sh
npm.cmd install
npm.cmd run dev
```

On macOS or Linux, use `npm install` and `npm run dev`.

Use **Continue as Admin** or **Continue as Staff** to preview the demo workspace, or configure Supabase to sign in with Google or email/password.

## Backend setup

1. Create a Supabase project at <https://supabase.com>.
2. Install the Supabase CLI and run the migrations:

   ```sh
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   For a local stack:

   ```sh
   supabase start
   supabase db reset
   ```

3. Deploy the admin user-management function:

   ```sh
   supabase functions deploy admin-users
   ```

4. Configure **Google (Gmail) sign-in**:
   - In Google Cloud Console create an OAuth 2.0 Client ID (Web application).
   - Add `https://<your-project-ref>.supabase.co/auth/v1/callback` as an Authorized redirect URI.
   - In Supabase Dashboard -> Authentication -> Providers -> Google, enable Google and paste the Client ID and Client Secret.
   - In Supabase Dashboard -> Authentication -> URL Configuration set the Site URL and Redirect URLs to your frontend origin (for local development `http://localhost:5173`).

5. Create `.env` from `.env.example` and add the project URL and anon key:

   ```env
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```

6. Sign in with Google. The **first account created becomes an Admin** so a fresh project is bootstrapped. Every later account starts as Staff. Promote accounts from the **Account management** screen or with:

   ```sql
   update public.profiles set role = 'Admin' where email = 'you@example.com';
   ```

## Hosting on Cloudflare

The app is a static site: Cloudflare serves the built files in `dist/` and the
browser talks to Supabase directly. Settings are in `wrangler.jsonc`; response
headers (caching, security) are in `public/_headers`.

**Automatic deploys from GitHub (recommended).** In the Cloudflare dashboard:
**Workers & Pages → Create → Import a repository**, pick this repository, then set

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values as `.env`) |

Every push to `main` then builds and goes live. The Supabase values are read
while building, so after changing them start a new deploy.

**Deploy from your computer instead:**

```sh
npx wrangler login
npm run deploy          # builds with your .env and uploads
npm run cf:preview      # serves the build locally the way Cloudflare will (http://localhost:8787)
```

**After the first deploy**, add the new address (e.g. `https://tsg-power.<account>.workers.dev`
or your own domain) in Supabase → Authentication → URL Configuration: set it as the
**Site URL** and add `https://<that-address>/**` to **Redirect URLs**, or Google sign-in
will send people back to the old site.

## How it works

- `supabase/migrations/` creates the PostgreSQL schema, display views, indexes, triggers, document numbering, RLS policies, storage bucket and workflow RPCs.
- `src/api/client.js` maps the existing REST-style calls to Supabase tables, views and RPCs, so the UI code stays unchanged.
- `src/api/auth.js` handles Google OAuth, email/password sign-in and session restoration.
- `supabase/functions/admin-users/` uses the service role key (server-side only) to create accounts and reset passwords. The service role key is never shipped to the browser.
- Authorization: Admins can manage all modules. Staff can read master data and work on their own jobs, service reports, material requests, expenses, advances, salaries and notifications. RLS enforces this on every table, including direct API access.
- Attachments are uploaded to the `attachments` Storage bucket and the public URL is stored on the record.

The demo accounts use in-memory/localStorage records and do not authenticate against the backend.

## Checks

```sh
npm run lint                 # ESLint
npm run build                # production build
npm run test:db -- --temp    # database tests in a throw-away PostgreSQL (needs PostgreSQL installed)
npm run test:e2e             # browser tests (see e2e/README.md); E2E_CHANNEL=msedge uses installed Edge
DATABASE_URL=postgresql://user:pass@host:5432/postgres npm run test:db   # or against a server you choose
```

The database tests (`supabase/tests`) build a fresh database from every migration and check the
money logic (advances, settlements, returns, reimbursements, cash board totals, job profitability)
and the access rules (staff only see their own advances, claims and nothing of salaries or the cash book).

GitHub Actions (`.github/workflows/ci.yml`) runs lint, build, the database tests and the browser
smoke tests on every push.
Cloudflare deploys every push to `main`; check the GitHub Actions result before merging to `main`.

## Roles

| Role | Can do |
|---|---|
| **Admin** (manager) | Everything: approves advance requests, settlements and claims, manages accounts and settings. |
| **Finance** | Releases advance money, pays approved claims, posts cash entries, settles and closes advances; sees the cash board, invoices, receivables, purchasing and reports. Cannot approve. Also has the normal staff pages for their own work. |
| **Staff** | Own jobs, quotations, invoices, claims and advances. |

Nobody can approve, release or settle **their own** advance or approve their own expenses; the
database refuses it. Change a role in **Account management → … → Make Finance / Make Admin / Make Staff**.

## Database version check

The app asks the database for `schema_version()` when someone signs in. If the database is older
than the code (a migration was not run), a yellow **Database update needed** banner appears instead
of confusing errors. When you add a migration, update `schema_version()` in it and `REQUIRED_SCHEMA`
in `src/lib/useAppStatus.js`.

## Automatic database updates (optional)

The CI job `deploy-database` runs `supabase db push` on every push to `main` once you enable it.
Because earlier migrations were run by hand in the SQL Editor, tell Supabase they are already
applied **once** before turning it on:

```sh
supabase login
supabase link --project-ref <project-id>
supabase migration list                       # shows which ones Supabase thinks are missing
supabase migration repair --status applied 20261114000000 20261114000100   # …every version already run by hand
```

Then in GitHub: **Settings → Secrets and variables → Actions** add the secrets `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID` and the variable `AUTO_DB_PUSH = true`. The database
update runs in GitHub Actions, alongside Cloudflare's deploy of the new app.

## Email and Telegram alerts

Every notification can also be sent by email and/or Telegram to people who switch it on in
**My profile → Alerts outside the app**. Payment reminders to customers (Receivables → Send reminder)
go by email. Messages are queued in `outbound_messages` and sent by the `deliver-messages` edge function.

1. Deploy the function: `supabase functions deploy deliver-messages`
2. Add secrets in Supabase (**Edge Functions → Secrets**), any of:
   - `RESEND_API_KEY` and `ALERT_EMAIL_FROM` (e.g. `TSG Power <alerts@yourdomain.com>`) for email via resend.com
   - `TELEGRAM_BOT_TOKEN` from @BotFather for Telegram (each person presses **Start** on the bot once)
3. Send the queue every 5 minutes (SQL Editor; needs the `pg_cron` and `pg_net` extensions):

```sql
select cron.schedule('tsg-deliver-messages', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<project-id>.supabase.co/functions/v1/deliver-messages',
    headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
$$);
```

The app also triggers a send right after it queues a message, so step 3 only matters for alerts
created by the daily schedule.

## Daily alerts

`send_daily_alerts()` runs every morning through pg_cron (and when an admin or finance user signs in).
Each alert is sent at most once a day: low stock (weekly per item, until a purchase request is open),
machines due for service within 14 days, overdue invoices (weekly) and, on the 1st–3rd, "monthly
management report ready".

## Files

Uploaded files live in the private `attachments` bucket and open through links that expire after an
hour. Receipts and cash documents can be opened only by the person who uploaded them and by Admin and
Finance; job, machine and report files by every signed-in user.
