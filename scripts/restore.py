#!/usr/bin/env python3
"""Check or restore a SQLite and uploads archive created by backup.py."""

import argparse
import json
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config import Config  # noqa: E402
from backup import check_integrity, configured_path, sqlite_path  # noqa: E402


def inspect_archive(archive_path):
    archive = zipfile.ZipFile(archive_path)
    try:
        bad_file = archive.testzip()
        if bad_file:
            raise ValueError(f"Archive CRC check failed for {bad_file}.")

        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Archive contains duplicate file names.")
        if "manifest.json" not in names or "database.sqlite3" not in names:
            raise ValueError("Archive must contain manifest.json and database.sqlite3.")

        upload_names = []
        for name in names:
            if name in ("manifest.json", "database.sqlite3"):
                continue
            path = PurePosixPath(name)
            if (
                path.is_absolute()
                or "\\" in name
                or not path.parts
                or path.parts[0] != "uploads"
                or any(
                    part in ("", ".", "..")
                    or any(character in part for character in '<>:"|?*')
                    for part in path.parts
                )
            ):
                raise ValueError(f"Archive contains an unsafe path: {name}")
            upload_names.append(name)

        manifest = json.loads(archive.read("manifest.json"))
        if (
            manifest.get("format_version") != 1
            or manifest.get("database") != "database.sqlite3"
            or manifest.get("upload_file_count") != len(upload_names)
        ):
            raise ValueError("Archive manifest does not match the archive contents.")
        return archive, upload_names
    except Exception:
        archive.close()
        raise


def stage_archive(archive_path, database_parent, upload_parent):
    archive, upload_names = inspect_archive(archive_path)
    db_work = tempfile.TemporaryDirectory(prefix=".gcsms-restore-db-", dir=database_parent)
    uploads_work = tempfile.TemporaryDirectory(prefix=".gcsms-restore-uploads-", dir=upload_parent)
    staged_database = Path(db_work.name) / "database.sqlite3"
    staged_uploads = Path(uploads_work.name) / "uploads"
    staged_uploads.mkdir()

    try:
        with archive:
            with archive.open("database.sqlite3") as source, staged_database.open("wb") as target:
                shutil.copyfileobj(source, target)
            check_integrity(staged_database)
            for name in upload_names:
                relative = PurePosixPath(name).parts[1:]
                target = staged_uploads.joinpath(*relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
        return db_work, uploads_work, staged_database, staged_uploads
    except Exception:
        db_work.cleanup()
        uploads_work.cleanup()
        raise


def remove_path(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def restore(archive_path, database, upload_folder):
    database.parent.mkdir(parents=True, exist_ok=True)
    upload_folder.parent.mkdir(parents=True, exist_ok=True)
    db_work, uploads_work, staged_database, staged_uploads = stage_archive(
        archive_path, database.parent, upload_folder.parent
    )

    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    previous_database = database.with_name(f"{database.name}.pre-restore-{suffix}")
    previous_uploads = upload_folder.with_name(f"{upload_folder.name}.pre-restore-{suffix}")
    previous_sidecars = []
    moved_database = moved_uploads = installed_database = installed_uploads = False

    try:
        if previous_database.exists() or previous_uploads.exists():
            raise FileExistsError("A pre-restore snapshot with this timestamp already exists.")
        if database.exists():
            os.replace(database, previous_database)
            moved_database = True
        if upload_folder.exists():
            os.replace(upload_folder, previous_uploads)
            moved_uploads = True
        for suffix_name in ("-wal", "-shm"):
            sidecar = Path(f"{database}{suffix_name}")
            if sidecar.exists():
                saved_sidecar = Path(f"{sidecar}.pre-restore-{suffix}")
                os.replace(sidecar, saved_sidecar)
                previous_sidecars.append((saved_sidecar, sidecar))

        os.replace(staged_database, database)
        installed_database = True
        os.replace(staged_uploads, upload_folder)
        installed_uploads = True
    except Exception:
        if installed_uploads:
            remove_path(upload_folder)
        if installed_database:
            remove_path(database)
        if moved_database and previous_database.exists():
            os.replace(previous_database, database)
        if moved_uploads and previous_uploads.exists():
            os.replace(previous_uploads, upload_folder)
        for saved_sidecar, original_sidecar in previous_sidecars:
            if saved_sidecar.exists():
                os.replace(saved_sidecar, original_sidecar)
        raise
    finally:
        db_work.cleanup()
        uploads_work.cleanup()

    print(f"Restore complete. Previous database and uploads, if present, remain beside their originals.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Backup archive created by scripts/backup.py.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Validate the archive without changing live data.")
    mode.add_argument("--confirm", action="store_true", help="Replace the configured database and uploads.")
    args = parser.parse_args()

    archive_path = args.archive.resolve()
    if not archive_path.is_file():
        parser.error(f"Backup archive does not exist: {archive_path}")
    database = sqlite_path()
    upload_folder = configured_path(Config.UPLOAD_FOLDER)

    if args.check:
        database.parent.mkdir(parents=True, exist_ok=True)
        upload_folder.parent.mkdir(parents=True, exist_ok=True)
        db_work, uploads_work, _, _ = stage_archive(
            archive_path, database.parent, upload_folder.parent
        )
        db_work.cleanup()
        uploads_work.cleanup()
        print(f"Backup archive is valid; SQLite integrity check passed: {archive_path}")
        return

    restore(archive_path, database, upload_folder)


if __name__ == "__main__":
    main()
