#!/usr/bin/env python3
"""Safely copy the current SQLite database into an empty, configured MySQL database."""

import argparse
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from sqlalchemy import MetaData, create_engine, func, inspect, select
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402

BATCH_SIZE = 500
ALEMBIC_TABLE = "alembic_version"


def sqlite_backup(source_path):
    backup_dir = ROOT / "instance" / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"gcsms-pre-mysql-{timestamp}.sqlite3"
    if backup_path.exists():
        raise FileExistsError(f"Refusing to overwrite an existing backup: {backup_path}")

    source_uri = f"file:{source_path.as_posix()}?mode=ro"
    with sqlite3.connect(source_uri, uri=True) as source, sqlite3.connect(backup_path) as backup:
        source.backup(backup)
    with sqlite3.connect(f"file:{backup_path.as_posix()}?mode=ro", uri=True) as backup:
        result = backup.execute("PRAGMA integrity_check").fetchone()
    if not result or result[0] != "ok":
        backup_path.unlink(missing_ok=True)
        raise RuntimeError("SQLite backup integrity check failed.")
    return backup_path


def ordered_tables(metadata, table_names):
    dependencies = {}
    for table in metadata.tables.values():
        if table.name not in table_names:
            continue
        dependencies[table.name] = {
            foreign_key.column.table.name
            for foreign_key in table.foreign_keys
            if foreign_key.column.table.name in table_names
            and foreign_key.column.table.name != table.name
        }

    ordered = []
    while dependencies:
        ready = sorted(name for name, required in dependencies.items() if not required)
        if not ready:
            raise RuntimeError("Foreign-key cycle detected; refusing to copy a partial database.")
        for name in ready:
            ordered.append(name)
            dependencies.pop(name)
        for required in dependencies.values():
            required.difference_update(ready)
    return ordered


def copy_database(source_path, target_engine, metadata):
    source_engine = create_engine(f"sqlite:///{source_path.as_posix()}")
    try:
        source_inspector = inspect(source_engine)
        source_names = set(source_inspector.get_table_names()) - {ALEMBIC_TABLE}
        model_names = set(metadata.tables)
        missing = model_names - source_names
        unexpected = source_names - model_names
        if missing or unexpected:
            raise RuntimeError(
                "SQLite schema does not match the application models "
                f"(missing tables: {sorted(missing)}; unexpected tables: {sorted(unexpected)})."
            )

        with source_engine.connect() as source:
            source_meta = MetaData()
            source_meta.reflect(bind=source)
            source_tables = source_meta.tables
            target_names = set(inspect(target_engine).get_table_names())
            if model_names - target_names:
                raise RuntimeError("MySQL schema is incomplete; run database migrations first.")

            reflected_target = MetaData()
            reflected_target.reflect(bind=target_engine, only=sorted(model_names))
            target_tables = reflected_target.tables

            for name in sorted(model_names):
                source_columns = set(source_tables[name].columns.keys())
                target_columns = set(target_tables[name].columns.keys())
                if source_columns != target_columns:
                    raise RuntimeError(f"Column mismatch in table '{name}'; refusing to copy.")

            names_in_order = ordered_tables(metadata, model_names)
            with target_engine.begin() as target:
                for name in names_in_order:
                    source_table = source_tables[name]
                    target_table = target_tables[name]
                    primary_key = [column.name for column in source_table.primary_key.columns]
                    statement = select(source_table)
                    if primary_key:
                        statement = statement.order_by(*(source_table.c[key] for key in primary_key))

                    offset = 0
                    while True:
                        rows = source.execute(statement.offset(offset).limit(BATCH_SIZE)).mappings().all()
                        if not rows:
                            break
                        target.execute(target_table.insert(), [dict(row) for row in rows])
                        offset += len(rows)

                for name in sorted(model_names):
                    source_count = source.execute(
                        select(func.count()).select_from(source_tables[name])
                    ).scalar_one()
                    target_count = target.execute(
                        select(func.count()).select_from(target_tables[name])
                    ).scalar_one()
                    if source_count != target_count:
                        raise RuntimeError(
                            f"Row-count verification failed for '{name}': "
                            f"SQLite={source_count}, MySQL={target_count}."
                        )
    finally:
        source_engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "instance" / "gcsms.db",
        help="SQLite database to copy (default: instance/gcsms.db).",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Confirm that the empty MySQL target will receive the SQLite data.",
    )
    args = parser.parse_args()

    source_path = args.source.resolve()
    if not source_path.is_file():
        parser.error(f"SQLite source does not exist: {source_path}")
    if not args.confirm:
        parser.error("Pass --confirm after verifying the configured MySQL target.")

    app = create_app()
    target_url = make_url(app.config["SQLALCHEMY_DATABASE_URI"])
    if target_url.get_backend_name() != "mysql":
        parser.error("DATABASE_URL must point to MySQL before running this migration.")
    if not target_url.database:
        parser.error("DATABASE_URL must include an existing MySQL database name.")

    with app.app_context():
        target_engine = db.engine
        try:
            with target_engine.connect() as connection:
                existing_tables = set(inspect(connection).get_table_names())
            if existing_tables:
                parser.error(
                    "The MySQL database is not empty. This migration will not overwrite existing tables."
                )
        except Exception as exc:
            if isinstance(exc, SystemExit):
                raise
            parser.error(f"Could not connect to the configured MySQL database ({type(exc).__name__}).")

    backup_path = sqlite_backup(source_path)
    print(f"SQLite backup created and integrity-checked: {backup_path}")

    migration_command = [
        sys.executable, "-m", "flask", "--app", "wsgi:app", "db", "upgrade",
    ]
    result = subprocess.run(migration_command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        output = (result.stdout + result.stderr).replace(
            target_url.render_as_string(hide_password=False),
            target_url.render_as_string(hide_password=True),
        )
        if output.strip():
            print(output.strip(), file=sys.stderr)
        parser.error("Could not upgrade the MySQL schema. The SQLite database remains unchanged.")

    with app.app_context():
        try:
            app_metadata = db.metadata
            target_engine = db.engine
            nonempty = []
            with target_engine.connect() as connection:
                names = set(inspect(connection).get_table_names())
                for name in set(app_metadata.tables) & names:
                    count = connection.execute(
                        select(func.count()).select_from(app_metadata.tables[name])
                    ).scalar_one()
                    if count:
                        nonempty.append(name)
            if nonempty:
                parser.error(
                    "MySQL tables already contain data; refusing to mix databases. "
                    f"Non-empty tables: {sorted(nonempty)}."
                )
            copy_database(source_path, target_engine, app_metadata)
        except SystemExit:
            raise
        except Exception as exc:
            detail = str(exc)
            if target_url.password:
                for secret in (target_url.password, quote(target_url.password, safe="")):
                    detail = detail.replace(secret, "[redacted]")
            parser.error(
                f"SQLite-to-MySQL copy failed ({type(exc).__name__}): {detail}. "
                f"SQLite is unchanged and its backup is at {backup_path}."
            )

    safe_url = target_url.render_as_string(hide_password=True)
    print(f"Migration complete into {safe_url}.")
    print("All application tables passed row-count verification; SQLite was left unchanged.")


if __name__ == "__main__":
    main()
