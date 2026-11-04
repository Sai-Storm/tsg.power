"""Estimates: Draft -> Admin approved -> Customer approved (or Rejected). Revisions create a new version."""
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import Customer, Generator, Priority, ServiceEstimate, ServiceRequest, ServiceType
from ..models.billing import APPROVAL_METHODS
from ..models.service import FINAL_STATUSES
from ..utils.time import local_today, utcnow
from . import audit, service_request_service as svc, settings_service
from .billing_math import compute_totals, r2
from .common import parse_money, require
from .errors import PermissionDenied, ValidationError


def can_create(user, service):
    return (user.has_permission("estimate.create") and svc.can_manage(user, service)
            and service.status not in FINAL_STATUSES)


def can_view(user, service):
    return svc.can_view(user, service) and (user.has_permission("estimate.create")
                                            or user.has_permission("estimate.approve")
                                            or user.has_permission("invoice.view"))


def can_view_estimate(user, estimate):
    if estimate.service is not None:
        return svc.can_view(user, estimate.service) and (
            user.has_permission("estimate.create") or user.has_permission("estimate.approve")
            or user.has_permission("invoice.view") or user.has_permission("service.create")
        )
    if estimate.customer is None:
        return False
    return user.has_permission("estimate.approve") or user.has_permission("service.create") or (
        user.has_permission("estimate.create") and estimate.created_by_id == user.id
    )


def latest_estimate(service):
    return service.estimates[-1] if service.estimates else None


def _hours(value):
    if value in (None, ""):
        return Decimal("0.00")
    try:
        hours = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ValidationError("Estimated labor hours must be a number.")
    if hours < 0 or hours > Decimal("9999.99"):
        raise ValidationError("Estimated labor hours must be between 0 and 9999.99.")
    return hours


def suggest_parts_amount(service):
    """Convenience prefill: value of non-rejected material lines (approved quantity if decided, else requested)."""
    total = Decimal("0.00")
    for line in service.requirements:
        if line.status == "rejected":
            continue
        qty = line.approved_qty if line.approved_qty > 0 else line.requested_qty
        price = line.unit_price
        if price is None and line.item is not None:
            price = line.item.selling_price
        total += r2(qty * (price or 0))
    return total


def _compute(actor, data, existing=None):
    hours = _hours(data.get("labor_hours"))
    admin = actor.has_permission("estimate.approve")
    if existing is not None:
        rate = existing.labor_rate
    else:
        rate = settings_service.get_decimal("labor_rate_per_hour", "0")
    if admin and data.get("labor_rate") not in (None, ""):
        rate = parse_money(data["labor_rate"], "Labor rate")
    parts = parse_money(data.get("parts_amount") or 0, "Parts cost")
    other = parse_money(data.get("other_amount") or 0, "Other expenses")
    discount = parse_money(data.get("discount") or 0, "Discount")
    current_discount = existing.discount if existing is not None else Decimal("0.00")
    if discount != current_discount and not admin:
        raise PermissionDenied("Only an administrator can apply or change a discount.")
    reason = (data.get("discount_reason") or "").strip()[:200] or None
    if discount > 0 and (reason is None or len(reason) < 3):
        raise ValidationError("Give a reason for the discount.")
    if existing is not None and not admin:
        reason = existing.discount_reason
    tax_rate = existing.tax_rate if existing is not None else settings_service.get_decimal("tax_rate", "0")
    apply_tax = bool(data.get("apply_tax"))
    labor_amount = r2(hours * rate)
    totals = compute_totals(labor_amount + parts + other, discount, tax_rate, apply_tax)
    return {"labor_hours": hours, "labor_rate": rate, "labor_amount": labor_amount, "parts_amount": parts,
            "other_amount": other, "other_description": (data.get("other_description") or "").strip()[:200] or None,
            "discount": totals["discount"], "discount_reason": reason if totals["discount"] > 0 else None,
            "apply_tax": apply_tax, "tax_rate": tax_rate, "tax_amount": totals["tax_amount"],
            "subtotal": totals["subtotal"], "total": totals["total"],
            "notes": (data.get("notes") or "").strip() or None}


def _snap(e):
    return {"service": e.service.service_id if e.service else None,
            "quotation_number": e.quotation_number,
            "version": e.version, "status": e.status, "labor": e.labor_amount,
            "parts": e.parts_amount, "other": e.other_amount, "discount": e.discount, "tax": e.tax_amount,
            "total": e.total}


def create_estimate(actor, service_pk, data):
    service = svc.lock_service(service_pk)
    if not svc.can_view(actor, service) or not can_create(actor, service):
        raise PermissionDenied("You cannot create an estimate for this job.")
    latest = latest_estimate(service)
    if latest is not None and latest.status == "draft":
        raise ValidationError("A draft estimate already exists for this job. Edit that one instead.")
    values = _compute(actor, data)
    if latest is not None and latest.status in ("approved", "customer_approved"):
        latest.status = "superseded"
    est = ServiceEstimate(service_request_id=service.id, version=(latest.version + 1) if latest else 1,
                          status="draft", created_by_id=actor.id, **values)
    try:
        db.session.add(est)
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("Another estimate was created at the same time. Please reload and try again.")
    db.session.expire(service, ["estimates"])
    svc.add_event(service, "estimate", f"Estimate v{est.version} drafted", actor)
    audit.log("estimate.create", "service_estimate", est.id, new=_snap(est), user=actor)
    db.session.commit()
    return est


def create_standalone_estimate(actor, data):
    require(actor, "estimate.create")
    require(actor, "customer.view")
    require(actor, "generator.view")
    customer = db.session.get(Customer, data.get("customer_id") or 0)
    generator = db.session.get(Generator, data.get("generator_id") or 0)
    if customer is None or generator is None or not customer.is_active or not generator.is_active:
        raise ValidationError("Select an active customer and generator.")
    if generator.customer_id != customer.id:
        raise ValidationError("That generator does not belong to this customer.")
    service_type = db.session.get(ServiceType, data.get("service_type_id") or 0)
    priority = db.session.get(Priority, data.get("priority_id") or 0)
    if service_type is None or not service_type.is_active or priority is None or not priority.is_active:
        raise ValidationError("Select a valid service type and priority.")
    complaint = (data.get("complaint") or "").strip()
    if len(complaint) < 5:
        raise ValidationError("Describe the requested work (at least 5 characters).")
    values = _compute(actor, data)
    estimate = ServiceEstimate(
        service_request_id=None, customer_id=customer.id, generator_id=generator.id,
        service_type_id=service_type.id, priority_id=priority.id, complaint=complaint,
        location=(data.get("location") or "").strip() or generator.location,
        version=1, status="draft", created_by_id=actor.id, **values,
    )
    db.session.add(estimate)
    db.session.flush()
    estimate.quotation_number = f"QT-{local_today().year}-{estimate.id:06d}"
    audit.log("quotation.create", "service_estimate", estimate.id,
              new={**_snap(estimate), "quotation_number": estimate.quotation_number,
                   "customer": customer.customer_code, "generator": generator.generator_code}, user=actor)
    db.session.commit()
    return estimate


def _get(est_id):
    est = db.session.get(ServiceEstimate, est_id)
    if est is None:
        raise ValidationError("Estimate not found.")
    return est


def update_estimate(actor, est_id, data):
    est = _get(est_id)
    if not can_view_estimate(actor, est):
        raise PermissionDenied("You cannot access this quotation.")
    if est.status != "draft":
        raise ValidationError("Only a draft estimate can be edited. Create a revised estimate instead.")
    if est.service is not None and est.service.status in FINAL_STATUSES:
        raise ValidationError("This job is closed.")
    if not (est.created_by_id == actor.id or actor.has_permission("estimate.approve")):
        raise PermissionDenied("You can only edit estimates you created.")
    before = _snap(est)
    standalone_values = None
    if est.service is None:
        complaint = (data.get("complaint") or "").strip()
        if len(complaint) < 5:
            raise ValidationError("Describe the requested work (at least 5 characters).")
        customer = db.session.get(Customer, data.get("customer_id") or 0)
        generator = db.session.get(Generator, data.get("generator_id") or 0)
        service_type = db.session.get(ServiceType, data.get("service_type_id") or 0)
        priority = db.session.get(Priority, data.get("priority_id") or 0)
        if customer is None or generator is None or generator.customer_id != customer.id \
                or not customer.is_active or not generator.is_active:
            raise ValidationError("Select an active customer and a generator that belongs to it.")
        if service_type is None or not service_type.is_active or priority is None or not priority.is_active:
            raise ValidationError("Select a valid service type and priority.")
        standalone_values = (customer, generator, service_type, priority, complaint)
    for key, value in _compute(actor, data, est).items():
        setattr(est, key, value)
    if standalone_values:
        customer, generator, service_type, priority, complaint = standalone_values
        est.customer_id, est.generator_id = customer.id, generator.id
        est.service_type_id, est.priority_id = service_type.id, priority.id
        est.complaint = complaint
        est.location = (data.get("location") or "").strip() or generator.location
    audit.log("estimate.update", "service_estimate", est.id, old=before, new=_snap(est), user=actor)
    db.session.commit()
    return est


def delete_draft(actor, est_id):
    est = _get(est_id)
    if not can_view_estimate(actor, est):
        raise PermissionDenied("You cannot access this quotation.")
    if est.status != "draft":
        raise ValidationError("Only a draft estimate can be deleted. Approved or rejected estimates are retained.")
    if not (est.created_by_id == actor.id or actor.has_permission("estimate.approve")):
        raise PermissionDenied("You can only delete estimates you created.")
    service = est.service
    before = _snap(est)
    audit.log("estimate.delete_draft", "service_estimate", est.id, old=before, user=actor)
    if service is not None:
        svc.add_event(service, "estimate", f"Draft estimate v{est.version} deleted", actor)
    db.session.delete(est)
    db.session.commit()
    return service


def approve_estimate(actor, est_id):
    require(actor, "estimate.approve")
    est = _get(est_id)
    if est.status != "draft":
        raise ValidationError("Only a draft estimate can be approved.")
    if est.created_by_id == actor.id:
        raise ValidationError("The person who prepared the quotation cannot approve it.")
    if est.service is not None and est.service.status in FINAL_STATUSES:
        raise ValidationError("This job is closed.")
    est.status, est.approved_by_id, est.approved_at = "approved", actor.id, utcnow()
    if est.service is not None:
        svc.add_event(est.service, "estimate", f"Estimate v{est.version} approved (total {est.total})", actor)
    audit.log("estimate.approve", "service_estimate", est.id, new=_snap(est), user=actor)
    db.session.commit()
    return est


def reject_estimate(actor, est_id, reason):
    require(actor, "estimate.approve")
    est = _get(est_id)
    if est.status not in ("draft", "approved"):
        raise ValidationError("This estimate can no longer be rejected.")
    if est.created_by_id == actor.id:
        raise ValidationError("The person who prepared the quotation cannot reject it.")
    if len((reason or "").strip()) < 5:
        raise ValidationError("Give a reason (at least 5 characters) for rejecting the estimate.")
    est.status, est.rejection_reason = "rejected", reason.strip()
    if est.service is not None:
        svc.add_event(est.service, "estimate", f"Estimate v{est.version} rejected: {reason.strip()}", actor)
    audit.log("estimate.reject", "service_estimate", est.id, new=_snap(est), user=actor)
    db.session.commit()
    return est


def record_customer_decision(actor, est_id, decision, name, method, note=None):
    """The customer's answer on an Admin-approved estimate, recorded with who gave it, how and when."""
    est = _get(est_id)
    service = est.service
    if not can_view_estimate(actor, est):
        raise PermissionDenied("You cannot record a customer decision on this estimate.")
    if est.status != "approved":
        raise ValidationError("The estimate must be approved by an administrator before the customer decides.")
    if decision not in ("approved", "rejected"):
        raise ValidationError("Choose whether the customer approved or rejected the estimate.")
    if len((name or "").strip()) < 2:
        raise ValidationError("Enter the name of the customer representative.")
    if method not in APPROVAL_METHODS:
        raise ValidationError("Select how the customer gave their answer.")
    note = (note or "").strip() or None
    if decision == "rejected" and (note is None or len(note) < 5):
        raise ValidationError("Note the customer's reason for rejecting.")
    est.customer_decision, est.customer_decided_by, est.customer_decided_at = decision, name.strip()[:120], utcnow()
    est.customer_method, est.customer_note, est.customer_recorded_by_id = method, note, actor.id
    est.status = "customer_approved" if decision == "approved" else "rejected"
    if decision == "rejected":
        est.rejection_reason = f"Rejected by customer: {note}"
    if service is not None:
        svc.add_event(service, "estimate", f"Customer {decision} estimate v{est.version} "
                      f"({APPROVAL_METHODS[method]}, {name.strip()})", actor)
    audit.log("estimate.customer_decision", "service_estimate", est.id,
              new={**_snap(est), "decision": decision, "by": name, "method": method}, user=actor)
    db.session.commit()
    return est


def convert_accepted_quotation(actor, est_id):
    require(actor, "service.create")
    est = db.session.scalar(select(ServiceEstimate).where(ServiceEstimate.id == est_id).with_for_update())
    if est is None:
        raise ValidationError("Quotation not found.")
    if est.status != "customer_approved":
        raise ValidationError("Only a customer-approved quotation can be converted to a Job Order.")
    if est.service is not None:
        return est.service
    existing = db.session.scalar(select(ServiceRequest).where(
        ServiceRequest.source_quotation_number == est.quotation_number))
    if existing is not None:
        est.service_request_id = existing.id
        db.session.commit()
        return existing
    service = svc.create_service_request(actor, {
        "customer_id": est.customer_id,
        "generator_id": est.generator_id,
        "service_type_id": est.service_type_id,
        "priority_id": est.priority_id,
        "fault_category_id": 0,
        "complaint": est.complaint,
        "location": est.location,
    }, source_quotation_number=est.quotation_number)
    est.service_request_id = service.id
    audit.log("quotation.convert", "service_estimate", est.id,
              new={"quotation_number": est.quotation_number, "service_id": service.service_id}, user=actor)
    db.session.commit()
    return service


def list_estimates(status=None, actor=None):
    stmt = select(ServiceEstimate)
    if actor is not None and not actor.has_permission("estimate.approve"):
        if actor.has_permission("estimate.create"):
            stmt = stmt.where(ServiceEstimate.created_by_id == actor.id)
        elif actor.has_permission("service.create"):
            stmt = stmt.where(ServiceEstimate.status == "customer_approved")
            status = None
        else:
            stmt = stmt.where(ServiceEstimate.id == 0)
    if status:
        stmt = stmt.where(ServiceEstimate.status == status)
    return stmt.order_by(ServiceEstimate.created_at.desc())


def pending_count():
    return db.session.scalar(select(func.count(ServiceEstimate.id)).where(ServiceEstimate.status == "draft"))
