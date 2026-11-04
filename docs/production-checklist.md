# Production readiness checklist

- [ ] Use a supported Linux host, dedicated non-login service account, and a maintained Python version.
- [ ] Set `APP_ENV=production` and a unique, generated `SECRET_KEY`; store secrets outside the repository with restrictive permissions.
- [ ] Use MySQL for production/multiple workers; grant the application account only the permissions it needs.
- [ ] Apply reviewed migrations and run `flask seed-rbac`; create a named administrator and verify access.
- [ ] Configure the public host with HTTPS, renew certificates automatically, and redirect HTTP to HTTPS.
- [ ] Run Gunicorn behind Nginx; bind Gunicorn to loopback and cap request size/timeouts.
- [ ] Set `UPLOAD_FOLDER` outside the web root and grant write access only to the service account.
- [ ] Configure Redis for rate limiting when multiple workers are used; the default in-memory backend is not shared.
- [ ] Replace or self-host third-party CDN assets if availability, integrity, or privacy requirements demand it.
- [ ] Set company identity, address, tax details, rates, payment terms, and logo in Settings.
- [ ] Disable or remove demo data before importing real records; never run `flask demo-data` in production.
- [ ] Back up the database and uploads together, encrypt/restrict archives, copy them off-host, and monitor scheduled jobs.
- [ ] Verify backup archives with `scripts/restore.py --check` and periodically perform an isolated full restore drill.
- [ ] Define retention, recovery point/time objectives, incident contacts, patching, log review, and disk monitoring.
- [ ] Smoke-test login, role boundaries, uploads/downloads, PDFs, billing, and a database-backed transaction over HTTPS.
- [ ] Validate the Android client separately in Android Studio or a CI runner; the repo does not include a compiled mobile build to verify here.
