"""Race-safe, never-reused identifiers backed by the id_sequences table.

next_value() takes a row lock (SELECT ... FOR UPDATE) so concurrent transactions queue up.
The counter only moves forward, so cancelled/deleted records never free a number.
The caller must commit (or roll back) the surrounding transaction.
"""
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import IdSequence


def next_value(name, period=0):
    for _ in range(5):
        stmt = (
            select(IdSequence)
            .where(IdSequence.name == name, IdSequence.period == period)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        row = db.session.execute(stmt).scalar_one_or_none()
        if row is not None:
            row.last_value += 1
            db.session.flush()
            return row.last_value
        # First use in this period (e.g. new year): create the counter. If another
        # transaction created it first, the unique constraint fires and we retry.
        try:
            with db.session.begin_nested():
                db.session.add(IdSequence(name=name, period=period, last_value=0))
                db.session.flush()
        except IntegrityError:
            pass
    raise RuntimeError(f"Could not allocate sequence value for {name}/{period}")


def format_service_id(year, n):
    return f"GEN-SRV-{year}-{n:04d}"  # grows to 5 digits after 9999


def format_customer_code(n):
    return f"CUS-{n:06d}"


def format_generator_code(n):
    return f"GEN-{n:06d}"


def format_part_code(n):
    return f"PRT-{n:06d}"


def format_staff_code(n):
    return f"STF-{n:04d}"


def new_service_id(year=None):
    year = year or datetime.utcnow().year
    return format_service_id(year, next_value("service", year))


def new_customer_code():
    return format_customer_code(next_value("customer"))


def new_generator_code():
    return format_generator_code(next_value("generator"))


def new_staff_code():
    return format_staff_code(next_value("staff"))


def new_part_code():
    return format_part_code(next_value("part"))


def _year():
    from ..utils.time import local_today
    return local_today().year


def new_invoice_number(year=None):
    year = year or _year()
    return f"INV-{year}-{next_value('invoice', year):04d}"


def new_payment_number(kind, year=None):
    year = year or _year()
    prefix = {"payment": "RCT", "refund": "REF", "adjustment": "ADJ"}[kind]
    return f"{prefix}-{year}-{next_value(kind, year):04d}"
