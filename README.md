# GCSMS — Generator Company Service Management System

GCSMS is a Flask application for generator-company staff. It includes a customer master file,
quotation/estimate workflow, open service jobs and service-delivery reports, invoices and receipts,
employee advances and expense claims, cash in/out and balance tracking, financial reports,
inventory, role-based access control, and audit history.

## Install for local development

Windows PowerShell:

```powershell
Set-Location -LiteralPath "C:\path\to\gcsms"
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cd /path/to/gcsms
python3 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

Set a unique `SECRET_KEY` in `.env`, for example:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

The application requires MySQL 8 for normal development and production. Create the database and
application user, then set `DATABASE_URL` in `.env` to the MySQL connection string before starting
the app. SQLite is used only by the isolated automated test configuration.

## Optional: import an older SQLite database into MySQL

To import data from an older SQLite installation, first create an empty `gcsms` MySQL database and
an application user with access to it, then stop the Flask app so the source file is not changing
during the copy. In the project `.env`, set `DATABASE_URL` to your own MySQL connection string
(URL-encode special characters in the password):

```ini
DATABASE_URL=mysql+pymysql://gcsms_user:<url-encoded-password>@127.0.0.1:3306/gcsms?charset=utf8mb4
```

Keep the connection string private. From PowerShell, with the project virtual environment active,
run the migration script:

```powershell
python .\scripts\migrate_sqlite_to_mysql.py --confirm
```

The script requires an empty MySQL database, runs the application migrations, makes and checks a
timestamped SQLite backup in `instance/backups`, copies all application tables in foreign-key order,
and verifies row counts. It leaves the original SQLite database unchanged and refuses to overwrite
existing MySQL tables or data. After success, the app uses MySQL through `DATABASE_URL`; keep the
SQLite file and backup until you have verified the MySQL app and uploaded files.

## Configure and initialize

Important `.env` settings:

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development` (default), `testing`, or `production`. Production enables secure session cookies and disables debug mode. |
| `SECRET_KEY` | Required for production; use a private, randomly generated value. Development has an insecure fallback only for local use. |
| `DATABASE_URL` | Required MySQL 8 connection string. |
| `UPLOAD_FOLDER` | Uploaded documents and images; default is `instance/uploads`. Keep it writable by the app and outside the public web root. |
| `APP_TIMEZONE` | Display/input timezone; default is `Asia/Kolkata`. Stored timestamps are UTC. |
| `RATELIMIT_STORAGE_URI` | Flask-Limiter storage URI. Default `memory://` is per-process; use Redis for multiple workers. |
Keep `.env` private and out of source control. URL-encode special characters in database URL
credentials. For production deployment, see [docs/deployment.md](docs/deployment.md).

Apply the current schema and initialize permissions/settings in MySQL before creating an
administrator:

```bash
python -m flask --app wsgi:app db upgrade
python -m flask --app wsgi:app seed-rbac
python -m flask --app wsgi:app create-admin
python -m flask --app wsgi:app run
```

If you cannot sign in to an existing Admin account, recover it from the project directory with
PowerShell:

```powershell
$env:FLASK_APP = "wsgi.py"
.\venv\Scripts\python.exe -m flask recover-admin
```

Choose the listed Admin staff code, then enter the new email and password when prompted. Password
input is hidden. This updates that existing Admin in the configured MySQL database, clears login
lockout, revokes API sessions, and writes an audit record. It does not create another account.

`seed-rbac` is safe to re-run. Review generated migrations before applying them. To try the app
with one repeatable sample customer, generator, and service request, run
`python -m flask --app wsgi:app demo-data` in development after creating an admin. This command
refuses to run in production, does not create credentials, and reuses its sample records when
re-run. Do not use demo records in a live database.

## Customer, service, and finance workflows

- **Global search:** the Search page shows recent records you can access across searchable modules
  and also supports keyword search. Select up to 50 records to export them to CSV; selected service
  jobs can also be bulk status-updated or have a technician added. Each service action still follows
  that job's permissions and workflow rules.
- **Customer master:** maintain customer records from Customers; use **Export master CSV** for the
  complete customer register.
- **Quotation and job order:** create a standalone quotation for a registered customer and
  generator, obtain internal approval, record the customer's acceptance, then convert it to one
  Job Order. Conversion is idempotent, so repeating it cannot create duplicate jobs. Quotations can
  be downloaded as PDFs before a job exists.
- **Service delivery report and invoice:** submit the service completion report from the job and
  download its PDF. A separate manager must approve the report before an invoice can be drafted;
  changing the report or reopening the job clears that approval. Invoice drafts use the accepted
  quotation's amounts when available, otherwise they use recorded job labor and used materials.
- **Employee advances and claims:** employees can link advance requests and expense claims to a
  Job Order. A manager approves the request before an accountant issues the money. Advance
  settlements use receipts to offset the advance; personal expenses without an advance become
  reimbursement due after approval. Unused advance cash is recorded as a return. Employees cannot
  approve their own quotations, service reports, advance requests, or expense claims.
- **Customer deposits:** finance records deposits separately from invoices. A deposit is a liability,
  not service revenue; apply it to an issued invoice to reduce the balance due. The standard payment
  form does not treat an unapplied deposit as a new cash receipt.
- **Cash and reports:** a centralized append-only double-entry journal records invoice issuance,
  receipts, refunds, customer deposits, employee advances, claim reimbursements, and manual
  cash entries. Cash balances and income/expense reports are derived from that journal. An advance
  or opening balance changes cash but is not income or an expense by itself. Use cash-entry forms
  for other income/expenses, not invoice receipts or employee claims, to avoid double counting.
  The complete cash ledger can be filtered by date and exported to CSV.
- **Role profiles:** Admin can assign Sales, Operations, Accountant, and Manager roles when
  creating or editing staff. Role seeding adds each profile's workflow permissions without removing
  permissions administrators have customized.
- **Excel accounting workbook:** Admins with finance, customer, inventory, and invoice permissions
  can download a combined `.xlsx` workbook or an empty import template from Finance. The workbook
  exports customers, inventory, stock adjustments, employee requests and advances, customer
  deposits, the financial journal, claims, cash entries, invoices, and payments. Imports create new
  transactions or explicitly update customer/item master data; they never edit posted financial or
  stock history. Advance imports require a previously approved employee request; use unique
  references for cash entries, advances, deposits, claims, stock adjustments, and payments. Invoice,
  request, and journal rows are export-only. Each import row is processed separately and the
  downloaded results workbook identifies saved rows and validation failures. Review it before
  retrying an import.

Run the test suite with `pytest`. Some concurrency tests use `TEST_MYSQL_URL` against a throw-away
database and drop its tables; follow the test instructions before setting it.

## Web app and API status

The supported interface in this repository is the browser-based web application. Authentication,
customers, generators, service jobs, inventory/material requests, estimates, invoices/payments,
PDFs, staff, suppliers, settings, dashboard pages, notifications, and reporting features are
implemented.

A registered REST API is also present under `/api/v1` for authenticated staff workflows, including
login, refresh, logout, user lookup, service-job listing/detail, job history, status changes,
material requests, photo uploads, completion reporting, and paginated search. The API enforces the
same service-layer permissions and visibility rules as the web app, with consistent JSON error
responses.

This repository does not include a compiled Android client or a checked-in Android Studio project.
The mobile app is planned as a separate Java/XML Retrofit client, but it is not built or verified in
this environment. Treat the Android app as future work that must be validated with Android Studio on a
machine with the Android SDK.

## Security and known limitations

- Passwords are hashed; password policy requires at least 10 characters with upper case, lower
  case, and a digit. Login lockout and rate limiting are enabled.
- Forms use CSRF protection. Audit records capture administrative deletes; service-history records
  are preserved except when an authorized urgent operational delete is explicitly confirmed. Neither
  is a substitute for protected database backups.
- Standard delete controls are limited to records that can be safely removed. Admins also have
  a second delete function button for service jobs, staff workload, generators, and customers for
  urgent deletion without any rules or blocks; these remove or decouple linked records unconditionally,
  and attachments are soft-deleted. Type the record's ID or code in the confirmation dialog.
  Audit records remain. Admins can urgently clear a staff member's active workload without any rules or
  blocks; the staff account and completed-job history remain.
- Eligible open service requests can be cancelled with a required reason. Cancellation preserves the
  service record and its status/audit history.
- Stock, payment, financial-journal, and audit histories are retained. Urgent operational deletion
  can remove service/status history only when no protected ledger records depend on the job. Linked
  master records that have protected finance history and staff accounts must be deactivated instead;
  issued invoices are voided, and payments are never deleted.
- Cash, advance, return, and expense-claim records are append-only and cannot be deleted; use the
  appropriate refund, return, rejection, or offsetting cash-entry workflow to correct them.
- The default rate-limit backend is process-local memory. Configure shared Redis storage for
  multiple workers.
- The Android client is not compiled or run in this repository; mobile validation requires Android
  Studio and a device/emulator.
- SQLite is not recommended for concurrent, multi-worker production. Use MySQL and external
  database backups for production.
- PDF generation uses standard fonts: MMK is rendered with the `Ks` marker by default, and
  unsupported non-Latin text may appear as `?`.
- Front-end Bootstrap/icons/fonts load from public CDNs; self-host them if availability, integrity,
  or privacy policy requires it.
- The included backup/restore scripts handle file-backed SQLite plus uploads only. MySQL backups
  must use database-native tooling.

See [docs/production-checklist.md](docs/production-checklist.md) before exposing an installation
to the public internet.
