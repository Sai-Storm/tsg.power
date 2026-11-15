# TSG Power Engineering backend (Supabase)

## Layout

| Path | Purpose |
| --- | --- |
| `migrations/20261114000000_schema.sql` | Tables, indexes, display views, numbering, auth-profile trigger |
| `migrations/20261114000100_rls.sql` | Row Level Security policies, grants, Storage bucket policies |
| `migrations/20261114000200_workflows.sql` | Job/invoice/advance/expense/stock RPCs, dashboard, recycle bin |
| `migrations/20261114000300_seed.sql` | Default company settings |
| `functions/admin-users/index.ts` | Service-role account creation and password resets |
| `config.toml` | Local Supabase stack configuration |

## First run

```sh
supabase start
supabase db reset
supabase functions serve admin-users --env-file .env.local
```

`supabase db reset` applies all migrations and the seed in order.

## Deploy

```sh
supabase link --project-ref <project-ref>
supabase db push
supabase functions deploy admin-users
```

## Authentication

Supabase Auth is the identity provider. Google OAuth gives Gmail sign-in; email/password is available as a fallback. On sign-up a trigger inserts `public.profiles` and assigns:

- `Admin` to the first account in the project (bootstrap)
- `Staff` to every later account

Change roles from Account management or SQL:

```sql
update public.profiles set role = 'Admin' where email = 'owner@example.com';
```

### Google Cloud + Supabase

1. Google Cloud Console -> APIs & Services -> Credentials -> Create OAuth client ID (Web application).
2. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase Dashboard -> Authentication -> Providers -> Google: enable and paste the client ID/secret.
4. Supabase Dashboard -> Authentication -> URL Configuration:
   - Site URL: `https://app.example.com` (or `http://localhost:5173`)
   - Redirect URLs: your production origin + `http://localhost:5173/**`

## Authorization model

- Every table has RLS enabled.
- `public.is_admin()` reads the caller's `profiles.role`.
- Staff can:
  - create, read, update and soft-delete customers
  - read suppliers, machines, inventory, fixed assets, staff, quotations and settings
  - read/update jobs they are assigned to or lead
  - create/read their own service reports and material requests
  - read their own expenses, advances and salaries
  - read/update their own notifications
- Admin-only: suppliers, machines, inventory, fixed assets, quotations, invoices, payments, cash entries, salaries, settings writes, recycle bin, and all workflow approvals.
- Workflow RPCs are `SECURITY DEFINER` and re-check the caller, so staff cannot bypass RLS by calling them directly.

## Storage

The `attachments` bucket stores receipts, machine photos and report files. Uploads are written under `<auth.uid()>/...`; read access is public, inserts/updates are restricted to the owner.

## Useful SQL

```sql
-- Promote the first signed-in user
update public.profiles set role = 'Admin' where email = 'owner@example.com';

-- Inspect the role attached to a session
select public.is_admin(), public.current_staff_id();

-- Run the dashboard payload used by the UI
select public.dashboard_summary();
```
