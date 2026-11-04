import re
from datetime import date
from decimal import Decimal, InvalidOperation

from sqlalchemy import delete as sql_delete, update as sql_update, func, or_, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import Attachment, Customer, Generator, ServiceEstimate
from ..models.generator import CONDITIONS, FUEL_TYPES
from ..utils.time import local_today, utcnow
from . import audit
from .errors import PermissionDenied, ValidationError
from .id_generator import new_generator_code

SERIAL_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-/._]{2,39}$")
PLACEHOLDER_SERIALS = {"NA", "N/A", "NONE", "NIL", "NULL", "UNKNOWN", "TBD", "TEST", "NOSERIAL", "NOTAVAILABLE"}
SORTS = {
    "code": Generator.generator_code, "brand": Generator.brand, "model": Generator.model,
    "capacity": Generator.capacity_kva, "next_maintenance": Generator.next_maintenance_date,
    "created": Generator.created_at,
}


def _require(actor, code):
    if actor is None or not actor.is_authenticated or not actor.has_permission(code):
        raise PermissionDenied("You do not have permission to do that.")


def normalize_serial(raw):
    return re.sub(r"\s+", "", (raw or "").strip()).upper()


def validate_serial(serial):
    if not SERIAL_RE.match(serial):
        raise ValidationError("Serial number must be 3 to 40 characters: letters, digits, - / . _ only.")
    if serial.replace("-", "").replace("/", "").replace(".", "").replace("_", "") in PLACEHOLDER_SERIALS \
            or len(set(serial)) == 1:
        raise ValidationError("Enter the real serial number from the generator's name plate.")


def _date(value, label):
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    raise ValidationError(f"{label} is not a valid date.")


def _prepare(data):
    brand = (data.get("brand") or "").strip()
    model = (data.get("model") or "").strip()
    if not brand or not model:
        raise ValidationError("Brand and model are required.")
    serial = normalize_serial(data.get("serial_number"))
    validate_serial(serial)
    try:
        capacity = Decimal(str(data.get("capacity_kva"))).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError):
        raise ValidationError("Capacity (kVA) must be a number.")
    if not (Decimal("0.5") <= capacity <= Decimal("20000")):
        raise ValidationError("Capacity must be between 0.5 and 20000 kVA.")
    fuel = data.get("fuel_type") or "diesel"
    condition = data.get("condition") or "good"
    if fuel not in FUEL_TYPES:
        raise ValidationError("Select a valid fuel type.")
    if condition not in CONDITIONS:
        raise ValidationError("Select a valid condition.")

    values = {
        "brand": brand, "brand_key": brand.lower(), "model": model, "serial_number": serial,
        "capacity_kva": capacity, "fuel_type": fuel, "condition": condition,
        "location": (data.get("location") or "").strip() or None,
        "notes": (data.get("notes") or "").strip() or None,
    }
    for f, label in (("installation_date", "Installation date"), ("warranty_start", "Warranty start"),
                     ("warranty_end", "Warranty end"), ("last_service_date", "Last service date"),
                     ("next_maintenance_date", "Next maintenance date")):
        values[f] = _date(data.get(f), label)
    if values["warranty_start"] and values["warranty_end"] and values["warranty_end"] < values["warranty_start"]:
        raise ValidationError("Warranty end cannot be before warranty start.")
    if values["last_service_date"] and values["last_service_date"] > local_today():
        raise ValidationError("Last service date cannot be in the future.")
    if values["last_service_date"] and values["next_maintenance_date"] \
            and values["next_maintenance_date"] < values["last_service_date"]:
        raise ValidationError("Next maintenance date cannot be before the last service date.")
    return values


def _snapshot(g):
    keys = ("generator_code", "customer_id", "brand", "model", "serial_number", "capacity_kva", "fuel_type",
            "installation_date", "location", "warranty_start", "warranty_end", "condition",
            "last_service_date", "next_maintenance_date", "notes", "is_active")
    return {k: getattr(g, k) for k in keys}


def _serial_conflict(values, exclude_id=None):
    stmt = select(Generator).where(Generator.brand_key == values["brand_key"],
                                   Generator.serial_number == values["serial_number"])
    if exclude_id:
        stmt = stmt.where(Generator.id != exclude_id)
    return db.session.scalar(stmt)


def _conflict_message(existing):
    return (f"A {existing.brand} generator with serial number {existing.serial_number} is already registered "
            f"({existing.generator_code}, customer {existing.customer.customer_code}).")


def create_generator(actor, customer_id, data):
    _require(actor, "generator.create")
    customer = db.session.get(Customer, customer_id)
    if customer is None:
        raise ValidationError("Customer not found.")
    if not customer.is_active:
        raise ValidationError("This customer is inactive. Reactivate the customer before adding generators.")
    values = _prepare(data)
    existing = _serial_conflict(values)
    if existing:
        raise ValidationError(_conflict_message(existing))
    gen = Generator(generator_code=new_generator_code(), customer_id=customer.id, created_by_id=actor.id,
                    is_active=True, **values)
    try:
        db.session.add(gen)
        db.session.flush()
        audit.log("generator.create", "generator", gen.id, new=_snapshot(gen), user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("A generator with this brand and serial number is already registered.")
    return gen


def update_generator(actor, generator_id, data):
    _require(actor, "generator.edit")
    gen = db.session.get(Generator, generator_id)
    if gen is None:
        raise ValidationError("Generator not found.")
    values = _prepare(data)
    existing = _serial_conflict(values, exclude_id=gen.id)
    if existing:
        raise ValidationError(_conflict_message(existing))
    before = _snapshot(gen)
    for k, v in values.items():
        setattr(gen, k, v)
    try:
        db.session.flush()
        audit.log("generator.update", "generator", gen.id, old=before, new=_snapshot(gen), user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("A generator with this brand and serial number is already registered.")
    return gen


def set_active(actor, generator_id, active):
    _require(actor, "generator.edit")
    gen = db.session.get(Generator, generator_id)
    if gen is None:
        raise ValidationError("Generator not found.")
    if gen.is_active != active:
        gen.is_active = active
        audit.log("generator.activate" if active else "generator.deactivate", "generator", gen.id,
                  old={"is_active": not active}, new={"is_active": active}, user=actor)
        db.session.commit()
    return gen


def delete_generator(actor, generator_id):
    _require(actor, "generator.edit")
    gen = db.session.execute(
        select(Generator).where(Generator.id == generator_id).with_for_update()
    ).scalar_one_or_none()
    if gen is None:
        raise ValidationError("Generator not found.")
    has_attachments = db.session.scalar(
        select(Attachment.id).where(
            Attachment.owner_type == "generator", Attachment.owner_id == gen.id
        ).limit(1)
    )
    if has_attachments:
        raise ValidationError("This generator has attached files. Remove those files before deleting the generator.")
    from . import service_request_service
    deleted_services = service_request_service.delete_unstarted_for_generator(actor, gen.id)
    before = _snapshot(gen)
    audit.log("generator.delete", "generator", gen.id, old=before, user=actor)
    db.session.delete(gen)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("This generator is referenced by other records. Deactivate it instead.")
    return deleted_services


def _force_delete_generator_rows(actor, gen):
    from ..models import ServiceRequest
    from . import service_request_service
    deleted_services = service_request_service.force_delete_services_for_generator(actor, gen.id)
    attachments = db.session.scalars(select(Attachment).where(
        Attachment.owner_type == "generator", Attachment.owner_id == gen.id,
        Attachment.deleted_at.is_(None))).all()
    for attachment in attachments:
        attachment.deleted_at = utcnow()
        audit.log("attachment.delete", "generator", gen.id,
                  old={"attachment_id": attachment.id}, user=actor)
    db.session.execute(sql_update(ServiceRequest).where(
        ServiceRequest.generator_id == gen.id).values(generator_id=None))
    db.session.execute(sql_delete(ServiceEstimate).where(
        ServiceEstimate.generator_id == gen.id, ServiceEstimate.service_request_id.is_(None)))
    audit.log("generator.force_delete", "generator", gen.id, old=_snapshot(gen), user=actor)
    db.session.execute(sql_delete(Generator).where(Generator.id == gen.id))
    return deleted_services


def force_delete_generator(actor, generator_id):
    _require(actor, "role.manage")
    gen = db.session.execute(
        select(Generator).where(Generator.id == generator_id).with_for_update()
    ).scalar_one_or_none()
    if gen is None:
        raise ValidationError("Generator not found.")
    deleted_services = _force_delete_generator_rows(actor, gen)
    db.session.commit()
    return deleted_services


def search_generators(q=None, customer_id=None, fuel=None, condition=None, status=None,
                      maintenance=None, sort="code", direction="desc"):
    stmt = select(Generator).join(Customer, Generator.customer_id == Customer.id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Generator.generator_code.ilike(like), Generator.serial_number.ilike(like),
                              Generator.model.ilike(like), Generator.brand.ilike(like),
                              Customer.name.ilike(like), Customer.customer_code.ilike(like)))
    if customer_id:
        stmt = stmt.where(Generator.customer_id == customer_id)
    if fuel in FUEL_TYPES:
        stmt = stmt.where(Generator.fuel_type == fuel)
    if condition in CONDITIONS:
        stmt = stmt.where(Generator.condition == condition)
    if status == "active":
        stmt = stmt.where(Generator.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(Generator.is_active.is_(False))
    if maintenance == "overdue":
        stmt = stmt.where(Generator.next_maintenance_date < local_today())
    col = SORTS.get(sort, Generator.generator_code)
    return stmt.order_by(col.desc() if direction == "desc" else col.asc(), Generator.id)
