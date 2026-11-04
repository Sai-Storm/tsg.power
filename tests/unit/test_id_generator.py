import os
import threading

import pytest

from app import create_app
from app.extensions import db
from app.services import id_generator as ids
from config import TestConfig


def test_sequence_increments_and_formats(app):
    assert ids.new_service_id(2026) == "GEN-SRV-2026-0001"
    assert ids.new_service_id(2026) == "GEN-SRV-2026-0002"
    db.session.commit()


def test_sequence_resets_per_year_independently(app):
    assert ids.new_service_id(2026) == "GEN-SRV-2026-0001"
    assert ids.new_service_id(2027) == "GEN-SRV-2027-0001"
    assert ids.new_service_id(2026) == "GEN-SRV-2026-0002"


def test_other_code_formats(app):
    assert ids.new_customer_code() == "CUS-000001"
    assert ids.new_generator_code() == "GEN-000001"
    assert ids.new_staff_code() == "STF-0001"
    assert ids.format_service_id(2026, 12345) == "GEN-SRV-2026-12345"


def test_rolled_back_value_is_not_reused_inside_committed_history(app):
    # Committed values are never reissued.
    first = ids.new_service_id(2026)
    db.session.commit()
    second = ids.new_service_id(2026)
    db.session.commit()
    assert first != second


MYSQL_URL = os.environ.get("TEST_MYSQL_URL")


@pytest.mark.skipif(not MYSQL_URL, reason="Set TEST_MYSQL_URL to run the MySQL concurrency test")
def test_concurrent_allocation_is_unique_on_mysql():
    class MySqlConfig(TestConfig):
        SQLALCHEMY_DATABASE_URI = MYSQL_URL
        SQLALCHEMY_ENGINE_OPTIONS = {"pool_size": 30, "max_overflow": 10}

    app = create_app(MySqlConfig)
    with app.app_context():
        db.drop_all()
        db.create_all()

    results, errors = [], []

    def worker():
        try:
            with app.app_context():
                value = ids.new_service_id(2026)
                db.session.commit()
                results.append(value)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    with app.app_context():
        db.drop_all()

    assert not errors
    assert len(results) == 40 and len(set(results)) == 40
    assert set(results) == {f"GEN-SRV-2026-{n:04d}" for n in range(1, 41)}
