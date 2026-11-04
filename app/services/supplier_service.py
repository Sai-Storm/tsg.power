from email_validator import EmailNotValidError, validate_email
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import InventoryItem, Supplier
from ..utils.validators import is_valid_phone
from . import audit
from .common import require
from .errors import ValidationError


def _values(data, existing=None):
    name = (data.get("name") or "").strip()
    if len(name) < 2:
        raise ValidationError("Supplier name is required.")
    clash = db.session.scalar(select(Supplier).where(func.lower(Supplier.name) == name.lower()))
    if clash is not None and (existing is None or clash.id != existing.id):
        raise ValidationError("A supplier with this name already exists.")
    phone = (data.get("phone") or "").strip() or None
    if phone and not is_valid_phone(phone):
        raise ValidationError("Enter a valid phone number.")
    email = (data.get("email") or "").strip() or None
    if email:
        try:
            email = validate_email(email, check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            raise ValidationError("Enter a valid email address.")
    return {"name": name, "phone": phone, "email": email,
            "contact_person": (data.get("contact_person") or "").strip() or None,
            "address": (data.get("address") or "").strip() or None, "notes": (data.get("notes") or "").strip() or None}


def create_supplier(actor, data):
    require(actor, "inventory.manage")
    supplier = Supplier(**_values(data), is_active=True)
    db.session.add(supplier)
    db.session.flush()
    audit.log("supplier.create", "supplier", supplier.id, new={"name": supplier.name}, user=actor)
    db.session.commit()
    return supplier


def update_supplier(actor, supplier_id, data):
    require(actor, "inventory.manage")
    supplier = db.session.get(Supplier, supplier_id)
    if supplier is None:
        raise ValidationError("Supplier not found.")
    for key, value in _values(data, supplier).items():
        setattr(supplier, key, value)
    audit.log("supplier.update", "supplier", supplier.id, new={"name": supplier.name}, user=actor)
    db.session.commit()
    return supplier


def set_active(actor, supplier_id, active):
    require(actor, "inventory.manage")
    supplier = db.session.get(Supplier, supplier_id)
    if supplier is None:
        raise ValidationError("Supplier not found.")
    supplier.is_active = active
    audit.log("supplier.activate" if active else "supplier.deactivate", "supplier", supplier.id,
              new={"is_active": active}, user=actor)
    db.session.commit()
    return supplier


def delete_supplier(actor, supplier_id):
    require(actor, "inventory.manage")
    supplier = db.session.execute(
        select(Supplier).where(Supplier.id == supplier_id).with_for_update()
    ).scalar_one_or_none()
    if supplier is None:
        raise ValidationError("Supplier not found.")
    has_items = db.session.scalar(
        select(InventoryItem.id).where(InventoryItem.supplier_id == supplier.id).limit(1)
    )
    if has_items:
        raise ValidationError("This supplier is linked to inventory items. Deactivate it instead.")
    audit.log("supplier.delete", "supplier", supplier.id,
              old={"name": supplier.name, "email": supplier.email, "phone": supplier.phone}, user=actor)
    db.session.delete(supplier)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("This supplier is referenced by other records. Deactivate it instead.")
    return True


def search_suppliers(q=None, status=None):
    stmt = select(Supplier)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Supplier.name.ilike(like), Supplier.contact_person.ilike(like), Supplier.phone.ilike(like)))
    if status == "active":
        stmt = stmt.where(Supplier.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(Supplier.is_active.is_(False))
    return stmt.order_by(Supplier.name)
