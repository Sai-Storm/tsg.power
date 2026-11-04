# Production deployment

This guide describes a Linux deployment using Gunicorn, Nginx, systemd, and Let's Encrypt. Use
MySQL for a multi-worker production deployment. The repository's backup/restore scripts currently
support file-backed SQLite only; use the database vendor's backup tools for MySQL (see below).

## 1. Prepare the host

Install a supported Python version, MySQL 8, Nginx, and Certbot with its Nginx plugin. Create a
dedicated service account and install the application into a stable directory such as
`/opt/gcsms`. The service account should own the virtual environment, the configured upload
directory, and any local writable application data; it should not own the operating system.

```bash
sudo useradd --system --home /opt/gcsms --shell /usr/sbin/nologin gcsms
sudo install -d -o gcsms -g gcsms /opt/gcsms /var/lib/gcsms/uploads
```

Copy the application into `/opt/gcsms`, then create its environment and install dependencies:

```bash
cd /opt/gcsms
sudo -u gcsms python3 -m venv venv
sudo -u gcsms venv/bin/pip install -r requirements.txt
sudo -u gcsms venv/bin/pip install gunicorn
```

Create a dedicated MySQL database and least-privilege application account. Store its credentials
in a protected environment file, not in source control:

```bash
sudo install -d -m 0750 -o root -g gcsms /etc/gcsms
sudo install -m 0640 -o root -g gcsms /dev/null /etc/gcsms/gcsms.env
sudoedit /etc/gcsms/gcsms.env
```

Set at least the following values in `/etc/gcsms/gcsms.env`:

```ini
APP_ENV=production
SECRET_KEY=<a unique random secret>
DATABASE_URL=mysql+pymysql://gcsms_user:<url-encoded-password>@127.0.0.1:3306/gcsms?charset=utf8mb4
UPLOAD_FOLDER=/var/lib/gcsms/uploads
APP_TIMEZONE=Asia/Kolkata
RATELIMIT_STORAGE_URI=redis://127.0.0.1:6379/0
```

Generate `SECRET_KEY` with `python -c "import secrets; print(secrets.token_hex(32))"`. URL-encode
reserved characters in database credentials. Configure Redis for shared rate-limit state when
running multiple workers; the default in-memory store is per process. Ensure only the service
account and administrators can read secrets and application data.

## 2. Initialize or upgrade the database

Run migrations as the service account, from the application directory, with the production
environment loaded. Do not run `db create_all()` in production.

```bash
cd /opt/gcsms
sudo -u gcsms env $(grep -v '^[[:space:]]*#' /etc/gcsms/gcsms.env | xargs) \
  venv/bin/python -m flask --app wsgi:app db upgrade
sudo -u gcsms env $(grep -v '^[[:space:]]*#' /etc/gcsms/gcsms.env | xargs) \
  venv/bin/python -m flask --app wsgi:app seed-rbac
sudo -u gcsms env $(grep -v '^[[:space:]]*#' /etc/gcsms/gcsms.env | xargs) \
  venv/bin/python -m flask --app wsgi:app create-admin
```

For secrets containing spaces, quotes, or shell-special characters, do not use the `env ... xargs`
shortcut above. Load the file using a deployment secret manager or another mechanism that preserves
values exactly. The same environment must be available to migration commands and the service.

## 3. Run Gunicorn with systemd

Create `/etc/systemd/system/gcsms.service`:

```ini
[Unit]
Description=GCSMS Flask application
After=network.target

[Service]
Type=simple
User=gcsms
Group=gcsms
WorkingDirectory=/opt/gcsms
EnvironmentFile=/etc/gcsms/gcsms.env
ExecStart=/opt/gcsms/venv/bin/gunicorn --workers 3 --timeout 120 --bind 127.0.0.1:8000 --access-logfile - --error-logfile - wsgi:app
Restart=on-failure
RestartSec=5
UMask=0027

[Install]
WantedBy=multi-user.target
```

Adjust the worker count to the host and database capacity. Keep Gunicorn bound to loopback; Nginx
is the public-facing server. Then start and inspect the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gcsms
sudo systemctl status gcsms
sudo journalctl -u gcsms -f
```

## 4. Configure Nginx and HTTPS

Point the domain's DNS A/AAAA records to the host. Create an Nginx site (replace the hostname):

```nginx
server {
    listen 80;
    server_name gcsms.example.com;
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Enable the site, verify the configuration, then obtain and install the certificate:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d gcsms.example.com
sudo certbot renew --dry-run
```

Certbot configures HTTPS and its renewal timer on supported distributions. Confirm that HTTP
redirects to HTTPS, HTTPS reaches the application, and certificate renewal is scheduled. Do not
enable production mode until requests reach the app only through the trusted HTTPS proxy.

## Windows hosting notes

Gunicorn and the Linux systemd/Nginx instructions above are not for Windows. For an evaluation or
small internal installation, run the WSGI entry point `wsgi:app` behind a Windows-compatible WSGI
server such as Waitress, installed separately, and manage it with an approved Windows service
manager. Do not use Flask's development server as a production service. Use IIS with URL Rewrite
and ARR (or another maintained reverse proxy) for TLS termination and proxying; configure HTTPS
cookies by setting `APP_ENV=production`. Windows certificate automation is separate (for example,
win-acme with IIS). Configure the service's environment variables and writable upload path in the
service manager, and keep `.env` and database files out of the web root.

For a public or multi-worker deployment, prefer a supported Linux host and MySQL. SQLite, local
uploads, and a single Windows host do not provide a shared, highly available storage setup.

## Backups and recovery

The supplied `scripts/backup.py` and `scripts/restore.py` scripts are for file-backed SQLite
databases and configured uploads. They resolve paths from `.env`/environment variables and refuse
to operate on MySQL URLs. Run backups as the service account and copy completed archives to
separate, access-controlled storage:

```bash
sudo -u gcsms /opt/gcsms/venv/bin/python /opt/gcsms/scripts/backup.py
sudo -u gcsms /opt/gcsms/venv/bin/python /opt/gcsms/scripts/restore.py \
  /opt/gcsms/instance/backups/gcsms-YYYYMMDDTHHMMSSZ.zip --check
```

`--check` validates the ZIP, manifest, archive paths, and SQLite integrity without replacing the
configured database or uploads. A real SQLite restore replaces both, so first stop the service,
take a current backup, verify the chosen archive, and explicitly pass `--confirm`. The script keeps
the previous database and uploads beside their original paths with a `.pre-restore-<UTC timestamp>`
suffix when they exist. Start the service and verify the restored application afterward.

For MySQL, take consistent database-native backups and back up uploads separately. Store MySQL
client credentials in a protected option file (not command-line arguments), and retain backups
off-host. Example:

```bash
mysqldump --defaults-extra-file=/etc/gcsms/mysql-client.cnf \
  --single-transaction --routines --triggers gcsms > /secure-backups/gcsms.sql
```

Restore into a separate test database first and validate it with the application's migrations and
smoke tests. Only then, during a maintenance window, restore production data and the matching
uploads snapshot. The SQLite restore script must not be used for MySQL.

### Scheduling and restore drills

On Linux, use a root-owned systemd timer or cron entry to run `backup.py` daily as `gcsms`; retain
several daily and weekly generations and copy backups to an independent host/object store. Protect
the archive and any off-site transfer. Monitor job exit status, free disk space, and backup age.
On Windows, use Task Scheduler with the service account and the virtual environment's Python
executable; configure failure notifications and secured off-host retention. Schedule periodic
restore drills against an isolated copy, using `--check` before a full restore. A successful backup
job alone does not demonstrate recoverability.
