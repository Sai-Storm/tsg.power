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

## How it works

- `supabase/migrations/` creates the PostgreSQL schema, display views, indexes, triggers, document numbering, RLS policies, storage bucket and workflow RPCs.
- `src/api/client.js` maps the existing REST-style calls to Supabase tables, views and RPCs, so the UI code stays unchanged.
- `src/api/auth.js` handles Google OAuth, email/password sign-in and session restoration.
- `supabase/functions/admin-users/` uses the service role key (server-side only) to create accounts and reset passwords. The service role key is never shipped to the browser.
- Authorization: Admins can manage all modules. Staff can read master data and work on their own jobs, service reports, material requests, expenses, advances, salaries and notifications. RLS enforces this on every table, including direct API access.
- Attachments are uploaded to the `attachments` Storage bucket and the public URL is stored on the record.

The demo accounts use in-memory/localStorage records and do not authenticate against the backend.
