#!/usr/bin/env python3
"""Create a SQLite and uploads snapshot for GCSMS."""

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config import Config  # noqa: E402


def configured_path(value, *, database=False):
    path = Path(value)
    if not path.is_absolute():
        path = (ROOT / "instance" / path) if database else (ROOT / path)
    return path.resolve()


def sqlite_path():
    url = make_url(Config.SQLALCHEMY_DATABASE_URI)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise ValueError("These scripts support file-backed SQLite only; use database-native tools for MySQL.")
    return configured_path(url.database, database=True)


def check_integrity(path):
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        result = connection.execute("PRAGMA integrity_check").fetchone()
    finally:
        connection.close()
    if not result or result[0] != "ok":
        raise ValueError(f"SQLite integrity check failed for {path}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "instance" / "backups",
        help="Directory for the resulting archive (default: instance/backups).",
    )
    args = parser.parse_args()

    database = sqlite_path()
    if not database.is_file():
        parser.error(f"Database file does not exist: {database}")
    upload_folder = configured_path(Config.UPLOAD_FOLDER)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = output_dir / f"gcsms-{timestamp}.zip"
    if archive_path.exists():
        raise FileExistsError(f"Backup already exists: {archive_path}")

    with tempfile.TemporaryDirectory(prefix=".gcsms-backup-", dir=output_dir) as work_dir:
        work = Path(work_dir)
        snapshot = work / "database.sqlite3"
        source = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        destination = sqlite3.connect(snapshot)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
        check_integrity(snapshot)

        upload_files = []
        if upload_folder.exists():
            for path in sorted(upload_folder.rglob("*")):
                if path.is_symlink():
                    raise ValueError(f"Upload folder contains a symlink; refusing to follow it: {path}")
                if path.is_file():
                    upload_files.append(path)

        manifest = {
            "format_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "database": "database.sqlite3",
            "upload_file_count": len(upload_files),
        }
        staged_archive = work / "backup.zip"
        with zipfile.ZipFile(staged_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot, "database.sqlite3")
            for path in upload_files:
                archive.write(path, f"uploads/{path.relative_to(upload_folder).as_posix()}")
            archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        os.replace(staged_archive, archive_path)

    print(f"Backup created and SQLite integrity checked: {archive_path}")


if __name__ == "__main__":
    main()
