from sqlalchemy import create_engine, insert, select

from app.extensions import db
from scripts.migrate_sqlite_to_mysql import copy_database


def test_sqlite_copy_preserves_rows_and_orders_foreign_keys(app, tmp_path):
    source_path = tmp_path / "source.sqlite3"
    source_engine = create_engine(f"sqlite:///{source_path.as_posix()}")
    target_engine = create_engine(f"sqlite:///{(tmp_path / 'target.sqlite3').as_posix()}")
    db.metadata.create_all(source_engine)
    db.metadata.create_all(target_engine)

    roles = db.metadata.tables["roles"]
    permissions = db.metadata.tables["permissions"]
    role_permissions = db.metadata.tables["role_permissions"]
    settings = db.metadata.tables["company_settings"]
    with source_engine.begin() as connection:
        connection.execute(insert(roles), [{"id": 51, "name": "presenter", "description": "Presentation role"}])
        connection.execute(insert(permissions), [{"id": 71, "code": "demo.view", "description": "View demo"}])
        connection.execute(insert(role_permissions), [{"role_id": 51, "permission_id": 71}])
        connection.execute(insert(settings), [{"key": "company_name", "value": "Example Company"}])

    copy_database(source_path, target_engine, db.metadata)

    with target_engine.connect() as connection:
        assert connection.execute(select(roles.c.id, roles.c.name)).all() == [(51, "presenter")]
        assert connection.execute(select(role_permissions.c.role_id, role_permissions.c.permission_id)).all() \
            == [(51, 71)]
        assert connection.execute(select(settings.c.value)).scalar_one() == "Example Company"

    source_engine.dispose()
    target_engine.dispose()
