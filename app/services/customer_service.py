import re

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import delete as sql_delete, update as sql_update, func, or_, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import Attachment, Customer, CustomerAdvance, Generator, ServiceEstimate, ServiceRequest
from ..models.customer import CUSTOMER_TYPES
from ..utils.time import utcnow
from ..utils.validators import is_valid_phone, normalize_phone
from . import audit
from .errors import DuplicateWarning, PermissionDenied, ValidationError
from .id_generator import new_customer_code

SORTS = {
    "name": Customer.name, "code": Customer.customer_code,
    "city": Customer.city, "created": Customer.created_at,
}
TEXT_FIELDS = ("contact_person", "address", "city", "state", "notes")


def _require(actor, code):
    if actor is None or not actor.is_authenticated or not actor.has_permission(code):
        raise PermissionDenied("You do not have permission to do that.")


def _clean(value):
    return (value or "").strip() or None


def _prepare(data):
    """Validate and normalise form/API input. Returns a dict of column values."""
    name = (data.get("name") or "").strip()
    if len(name) < 2:
        raise ValidationError("Customer name is required.")
    ctype = data.get("customer_type") or "individual"
    if ctype not in CUSTOMER_TYPES:
        raise ValidationError("Select a valid customer type.")
    phone = (data.get("phone_primary") or "").strip()
    if not is_valid_phone(phone):
        raise ValidationError("Enter a valid primary phone number (7 to 15 digits).")
    alt = _clean(data.get("phone_alt"))
    if alt and not is_valid_phone(alt):
        raise ValidationError("Enter a valid alternate phone number (7 to 15 digits).")
    email = _clean(data.get("email"))
    if email:
        try:
            email = validate_email(email, check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            raise ValidationError("Enter a valid email address.")
    values = {
        "name": name, "customer_type": ctype, "phone_primary": phone, "phone_alt": alt,
        "normalized_phone": normalize_phone(phone), "normalized_phone_alt": normalize_phone(alt) if alt else None,
        "email": email,
    }
    for f in TEXT_FIELDS:
        values[f] = _clean(data.get(f))
    return values


def _snapshot(c):
    return {k: getattr(c, k) for k in ("customer_code", "name", "contact_person", "phone_primary", "phone_alt",
                                       "email", "address", "city", "state", "customer_type", "notes", "is_active")}


def find_potential_duplicates(values, exclude_id=None):
    """Customers sharing a phone number, an email, or the same name in the same city."""
    phones = {p for p in (values.get("normalized_phone"), values.get("normalized_phone_alt")) if p}
    conds = []
    if phones:
        conds += [Customer.normalized_phone.in_(phones), Customer.normalized_phone_alt.in_(phones)]
    if values.get("email"):
        conds.append(Customer.email == values["email"])
    conds.append(db.and_(
        func.lower(Customer.name) == values["name"].lower(),
        func.lower(func.coalesce(Customer.city, "")) == (values.get("city") or "").lower(),
    ))
    stmt = select(Customer).where(or_(*conds)).order_by(Customer.id).limit(10)
    if exclude_id:
        stmt = stmt.where(Customer.id != exclude_id)
    matches = []
    for c in db.session.scalars(stmt):
        reasons = []
        if c.normalized_phone in phones:
            reasons.append("Same primary phone")
        if c.normalized_phone_alt and c.normalized_phone_alt in phones:
            reasons.append("Same alternate phone")
        if c.normalized_phone not in phones and values.get("normalized_phone") == c.normalized_phone_alt:
            reasons.append("Phone matches their alternate number")
        if values.get("email") and c.email == values["email"]:
            reasons.append("Same email")
        if c.name.lower() == values["name"].lower() and (c.city or "").lower() == (values.get("city") or "").lower():
            reasons.append("Same name and city")
        matches.append({"customer": c, "reasons": reasons or ["Similar contact details"]})
    return matches


def create_customer(actor, data, confirm_duplicate=False):
    _require(actor, "customer.create")
    values = _prepare(data)
    matches = find_potential_duplicates(values)
    if matches and not confirm_duplicate:
        raise DuplicateWarning(matches)
    customer = Customer(customer_code=new_customer_code(), created_by_id=actor.id, is_active=True, **values)
    db.session.add(customer)
    db.session.flush()
    new = _snapshot(customer)
    if matches:
        new["duplicate_override_of"] = [m["customer"].customer_code for m in matches]
    audit.log("customer.create", "customer", customer.id, new=new, user=actor)
    db.session.commit()
    return customer


def update_customer(actor, customer_id, data, confirm_duplicate=False):
    _require(actor, "customer.edit")
    customer = db.session.get(Customer, customer_id)
    if customer is None:
        raise ValidationError("Customer not found.")
    values = _prepare(data)
    matches = find_potential_duplicates(values, exclude_id=customer.id)
    if matches and not confirm_duplicate:
        raise DuplicateWarning(matches)
    before = _snapshot(customer)
    for k, v in values.items():
        setattr(customer, k, v)
    db.session.flush()
    audit.log("customer.update", "customer", customer.id, old=before, new=_snapshot(customer), user=actor)
    db.session.commit()
    return customer


def set_active(actor, customer_id, active):
    _require(actor, "customer.edit")
    customer = db.session.get(Customer, customer_id)
    if customer is None:
        raise ValidationError("Customer not found.")
    if customer.is_active != active:
        customer.is_active = active
        audit.log("customer.activate" if active else "customer.deactivate", "customer", customer.id,
                  old={"is_active": not active}, new={"is_active": active}, user=actor)
        db.session.commit()
    return customer


def delete_customer(actor, customer_id):
    _require(actor, "customer.edit")
    customer = db.session.execute(
        select(Customer).where(Customer.id == customer_id).with_for_update()
    ).scalar_one_or_none()
    if customer is None:
        raise ValidationError("Customer not found.")
    has_generators = db.session.scalar(select(Generator.id).where(Generator.customer_id == customer.id).limit(1))
    has_services = db.session.scalar(
        select(ServiceRequest.id).where(ServiceRequest.customer_id == customer.id).limit(1)
    )
    if has_generators or has_services:
        raise ValidationError("This customer has generator or service history. Deactivate the customer instead.")
    before = _snapshot(customer)
    audit.log("customer.delete", "customer", customer.id, old=before, user=actor)
    db.session.delete(customer)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("This customer is referenced by other records. Deactivate the customer instead.")


def force_delete_customer(actor, customer_id):
    _require(actor, "role.manage")
    customer = db.session.execute(
        select(Customer).where(Customer.id == customer_id).with_for_update()
    ).scalar_one_or_none()
    if customer is None:
        raise ValidationError("Customer not found.")

    from ..models import Invoice
    from . import generator_service, service_request_service
    deleted_services = service_request_service.force_delete_services_for_customer(actor, customer.id)
    generators = db.session.scalars(
        select(Generator).where(Generator.customer_id == customer.id).order_by(Generator.id).with_for_update()
    ).all()
    for generator in generators:
        generator_service._force_delete_generator_rows(actor, generator)
    attachments = db.session.scalars(select(Attachment).where(
        Attachment.owner_type == "customer", Attachment.owner_id == customer.id,
        Attachment.deleted_at.is_(None))).all()
    for attachment in attachments:
        attachment.deleted_at = utcnow()
        audit.log("attachment.delete", "customer", customer.id,
                  old={"attachment_id": attachment.id}, user=actor)
    db.session.execute(sql_delete(CustomerAdvance).where(
        CustomerAdvance.customer_id == customer.id))
    db.session.execute(sql_delete(ServiceEstimate).where(
        ServiceEstimate.customer_id == customer.id, ServiceEstimate.service_request_id.is_(None)))
    before = _snapshot(customer)
    audit.log("customer.force_delete", "customer", customer.id,
              old={**before, "deleted_services": deleted_services, "deleted_generators": len(generators)},
              user=actor)
    db.session.execute(sql_delete(Customer).where(Customer.id == customer.id))
    db.session.commit()
    return deleted_services, len(generators)


def search_customers(q=None, ctype=None, status=None, city=None, sort="name", direction="asc"):
    stmt = select(Customer)
    if q:
        like = f"%{q.strip()}%"
        digits = re.sub(r"\D", "", q)
        conds = [Customer.name.ilike(like), Customer.customer_code.ilike(like), Customer.contact_person.ilike(like),
                 Customer.email.ilike(like), Customer.phone_primary.ilike(like), Customer.phone_alt.ilike(like)]
        if len(digits) >= 4:
            conds += [Customer.normalized_phone.like(f"%{digits}%"), Customer.normalized_phone_alt.like(f"%{digits}%")]
        stmt = stmt.where(or_(*conds))
    if ctype in CUSTOMER_TYPES:
        stmt = stmt.where(Customer.customer_type == ctype)
    if status == "active":
        stmt = stmt.where(Customer.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(Customer.is_active.is_(False))
    if city:
        stmt = stmt.where(func.lower(Customer.city) == city.strip().lower())
    col = SORTS.get(sort, Customer.name)
    return stmt.order_by(col.desc() if direction == "desc" else col.asc(), Customer.id)


def generator_counts(customer_ids):
    if not customer_ids:
        return {}
    rows = db.session.execute(
        select(Generator.customer_id, func.count(Generator.id))
        .where(Generator.customer_id.in_(customer_ids)).group_by(Generator.customer_id))
    return dict(rows.all())


def duplicate_groups():
    """Active customers that share a phone number or email (for the admin review screen)."""
    groups = []
    for label, col in (("Phone", Customer.normalized_phone), ("Email", Customer.email)):
        keys = db.session.scalars(
            select(col).where(Customer.is_active.is_(True), col.is_not(None))
            .group_by(col).having(func.count(Customer.id) > 1).order_by(col)).all()
        for key in keys:
            members = db.session.scalars(
                select(Customer).where(col == key, Customer.is_active.is_(True)).order_by(Customer.id)).all()
            groups.append({"label": label, "key": key, "customers": members})
    return groups
