# Browser tests

```bash
npm run test:e2e                      # builds the app, serves it, runs the tests
E2E_CHANNEL=msedge npm run test:e2e   # use the installed Edge/Chrome instead of downloading Chromium
```

The first time on a new machine (without `E2E_CHANNEL`): `npx playwright install chromium`.

## Smoke tests (`smoke.spec.js`)
Always run. They check that the built app loads without JavaScript errors, the
sign-in page works on desktop and phone sizes, protected pages ask to sign in,
and the app can be installed. They never sign in or change data.

## Advance workflow (`advance-flow.spec.js`)
Clicks through the whole advance workflow with three accounts. It creates real
records, so **use a separate test Supabase project**, never the live one:

| Variable | Account |
|---|---|
| `E2E_STAFF_EMAIL`, `E2E_STAFF_PASSWORD` | a Staff user with at least one job order |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | an Admin user |
| `E2E_FINANCE_EMAIL`, `E2E_FINANCE_PASSWORD` | a Finance user |

Build the app against the test project (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
pointing at it) or test a deployed copy with `E2E_BASE_URL=https://…`.
Without these variables the workflow tests are skipped.
