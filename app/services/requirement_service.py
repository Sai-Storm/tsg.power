"""Material / requirement lifecycle on a job:
requested -> pending_approval -> approved -> (partially_available) -> issued -> used / returned, or rejected.
A request, an approval, a stock issue and actual use are four different facts and are stored separately."""
from sqlalchemy import func, select

from ..extensions import db
from ..models import InventoryItem, ServiceRequest, ServiceRequirement
from ..models.inventory import NON_INV_CATEGORIES, UNITS
from ..models.service import FINAL_STATUSES
from ..utils.time import utcnow
from . import audit, inventory_service as inv, service_request_service as svc, service_workflow as wf
from .common import fmt_qty, parse_money, parse_qty, require
from .errors import PermissionDenied, ValidationError

DRAFT_EDITABLE = ("requested",)
UNDECIDED = ("requested", "pending_approval")


def _completion_check(service):
    count = db.session.scalar(select(func.count(ServiceRequirement.id)).where(
        ServiceRequirement.service_request_id == service.id, ServiceRequirement.status.in_(UNDECIDED)))
    return [f"{count} material request line(s) not yet decided (submit or remove them, then get approval)"] if count else []


def register_completion_check():
    if _completion_check not in wf.COMPLETION_CHECKS:
        wf.COMPLETION_CHECKS.append(_completion_check)


def can_request(user, service):
    return (user.has_permission("requirement.request") and svc.can_manage(user, service)
            and service.status not in FINAL_STATUSES + ("completed",))


def can_record_usage(user, service):
    return (user.has_permission("service.update_status") and svc.can_manage(user, service)
            and service.status not in FINAL_STATUSES)


def _lock_req(req_id):
    req = db.session.execute(select(ServiceRequirement).where(ServiceRequirement.id == req_id).with_for_update()
                             .execution_options(populate_existing=True)).scalar_one_or_none()
    if req is None:
        raise ValidationError("Requirement not found.")
    return req


def _service_for(user, req, need_visible=True):
    service = db.session.get(ServiceRequest, req.service_request_id)
    if need_visible and not svc.can_view(user, service):
        raise PermissionDenied("You cannot access this job.")
    return service


def _snap(r):
    return {"service": r.service.service_id, "item": r.description, "status": r.status, "requested": r.requested_qty,
            "approved": r.approved_qty, "issued": r.issued_qty, "used": r.used_qty, "returned": r.returned_qty}


# ---------------------------------------------------------------- request (technician)
def add_requirement(actor, service_pk, data):
    service = db.session.get(ServiceRequest, service_pk)
    if service is None or not svc.can_view(actor, service) or not can_request(actor, service):
        raise PermissionDenied("You cannot request materials for this job.")
    purpose = (data.get("purpose") or "").strip()[:255] or None
    item_id = data.get("item_id")
    if item_id not in (None, "", 0, "0"):
        item = db.session.get(InventoryItem, int(item_id))
        if item is None or not item.is_active:
            raise ValidationError("Select an active stock item.")
        qty = parse_qty(data.get("quantity"), "Quantity", item.unit)
        req = ServiceRequirement(service_request_id=service.id, requirement_type="inventory", item_id=item.id,
                                 description=item.name, unit=item.unit, requested_qty=qty, purpose=purpose,
                                 requested_by_id=actor.id, status="requested")
    else:
        description = (data.get("description") or "").strip()
        if len(description) < 3:
            raise ValidationError("Choose a stock item, or describe the other requirement (transport, tools, external work...).")
        category = data.get("category") or "other"
        if category not in NON_INV_CATEGORIES:
            raise ValidationError("Select a valid requirement type.")
        unit = data.get("unit") or "unit"
        if unit not in UNITS:
            raise ValidationError("Select a valid unit.")
        req = ServiceRequirement(service_request_id=service.id, requirement_type="non_inventory",
                                 description=description[:200], category=category, unit=unit,
                                 requested_qty=parse_qty(data.get("quantity"), "Quantity", unit),
                                 unit_price=parse_money(data.get("unit_price"), "Estimated unit cost"),
                                 purpose=purpose, requested_by_id=actor.id, status="requested")
    db.session.add(req)
    db.session.flush()
    audit.log("requirement.add", "service_requirement", req.id, new=_snap(req), user=actor)
    db.session.commit()
    return req


def delete_draft(actor, req_id):
    req = _lock_req(req_id)
    service = _service_for(actor, req)
    if req.status not in DRAFT_EDITABLE:
        raise ValidationError("Only lines that have not been submitted can be removed.")
    if not (req.requested_by_id == actor.id or actor.has_permission("requirement.approve")):
        raise PermissionDenied("You can only remove your own request lines.")
    audit.log("requirement.delete_draft", "service_requirement", req.id, old=_snap(req), user=actor)
    db.session.delete(req)
    db.session.commit()
    return service


def submit_requirements(actor, service_pk):
    service = db.session.get(ServiceRequest, service_pk)
    if service is None or not svc.can_view(actor, service) or not can_request(actor, service):
        raise PermissionDenied("You cannot submit material requests for this job.")
    lines = [r for r in service.requirements if r.status == "requested"]
    if not lines:
        raise ValidationError("There are no new request lines to submit.")
    for r in lines:
        r.status = "pending_approval"
    svc.add_event(service, "materials", f"Material request submitted for approval ({len(lines)} line"
                  f"{'s' if len(lines) != 1 else ''}): " + ", ".join(r.description for r in lines)[:300], actor)
    audit.log("requirement.submit", "service_request", service.id, new={"lines": [r.id for r in lines]}, user=actor)
    db.session.commit()
    return lines


# ---------------------------------------------------------------- decision (admin)
def approve(actor, req_id, approved_qty=None, note=None, unit_price=None):
    require(actor, "requirement.approve")
    req = _lock_req(req_id)
    service = _service_for(actor, req)
    if req.status != "pending_approval":
        raise ValidationError("Only requests that are pending approval can be approved.")
    if service.status in FINAL_STATUSES:
        raise ValidationError("This job is closed.")
    qty = req.requested_qty if approved_qty in (None, "") else parse_qty(approved_qty, "Approved quantity", req.unit)
    if qty > req.requested_qty:
        raise ValidationError(f"Approved quantity cannot exceed the requested {fmt_qty(req.requested_qty)} {req.unit}.")
    if req.is_inventory and not req.item.is_active:
        raise ValidationError("This stock item is inactive.")
    req.approved_qty, req.status = qty, "approved"
    req.approved_by_id, req.decided_at = actor.id, utcnow()
    req.decision_note = (note or "").strip() or None
    if not req.is_inventory and unit_price not in (None, ""):
        req.unit_price = parse_money(unit_price, "Unit cost")
    svc.add_event(service, "materials", f"Approved {fmt_qty(qty)} {req.unit} {req.description}"
                  + (f" (requested {fmt_qty(req.requested_qty)})" if qty != req.requested_qty else ""), actor)
    audit.log("requirement.approve", "service_requirement", req.id, new=_snap(req), user=actor)
    db.session.commit()
    return req


def reject(actor, req_id, note):
    require(actor, "requirement.approve")
    req = _lock_req(req_id)
    service = _service_for(actor, req)
    if req.status != "pending_approval":
        raise ValidationError("Only requests that are pending approval can be rejected.")
    if len((note or "").strip()) < 5:
        raise ValidationError("Give a reason (at least 5 characters) when rejecting a request.")
    req.status, req.approved_by_id, req.decided_at = "rejected", actor.id, utcnow()
    req.decision_note = note.strip()
    svc.add_event(service, "materials", f"Rejected {req.description}: {note.strip()}", actor)
    audit.log("requirement.reject", "service_requirement", req.id, new=_snap(req), user=actor)
    db.session.commit()
    return req


# ---------------------------------------------------------------- store: issue / return
def issue(actor, req_id, qty=None):
    """Issue approved stock to the job. Never goes below zero: if stock is short, issues what exists and flags it.
    Returns (requirement, quantity_issued_now)."""
    require(actor, "inventory.issue")
    req = _lock_req(req_id)
    service = _service_for(actor, req)
    if not req.is_inventory:
        raise ValidationError("Only stock items are issued from the store.")
    if req.status not in ("approved", "partially_available"):
        raise ValidationError("Only approved requests can be issued.")
    if service.status in FINAL_STATUSES:
        raise ValidationError("This job is closed.")
    outstanding = req.approved_qty - req.issued_qty
    want = outstanding if qty in (None, "") else parse_qty(qty, "Quantity to issue", req.unit)
    if want > outstanding:
        raise ValidationError(f"Only {fmt_qty(outstanding)} {req.unit} is still to be issued.")
    item = inv.lock_item(req.item_id)
    now = min(want, item.current_stock)
    if now > 0:
        inv.move(item, -now, "issue", actor, reason=f"Issued to {service.service_id}", reference=service.service_id,
                 requirement=req, service_pk=service.id, approved_by=req.approved_by)
        req.issued_qty += now
        req.issued_at, req.issued_by_id = utcnow(), actor.id
        if req.unit_price is None:
            req.unit_price = item.selling_price  # price snapshot for billing
    short = req.issued_qty < req.approved_qty
    req.status = "partially_available" if short else "issued"
    if now > 0:
        svc.add_event(service, "materials", f"Issued {fmt_qty(now)} {req.unit} {req.description}", actor)
    if short:
        svc.add_event(service, "materials", f"Waiting for stock: {fmt_qty(req.to_issue)} {req.unit} {req.description} "
                      f"still to be issued", actor)
        svc.mark_waiting_for_parts(actor, service, f"Parts not fully available: {req.description}")
    audit.log("requirement.issue", "service_requirement", req.id, new={**_snap(req), "issued_now": now}, user=actor)
    db.session.commit()
    return req, now


def return_unused(actor, req_id, qty, reason=None):
    """Unused issued stock goes back to the store (adds stock, writes a 'return' ledger entry)."""
    require(actor, "inventory.issue")
    req = _lock_req(req_id)
    service = _service_for(actor, req)
    if not req.is_inventory or req.issued_qty <= 0:
        raise ValidationError("Nothing has been issued on this line.")
    qty = parse_qty(qty, "Quantity to return", req.unit)
    if qty > req.remaining:
        raise ValidationError(f"Only {fmt_qty(req.remaining)} {req.unit} is issued but not yet used or returned.")
    item = inv.lock_item(req.item_id)
    inv.move(item, qty, "return", actor, reason=(reason or "").strip() or f"Returned from {service.service_id}",
             reference=service.service_id, requirement=req, service_pk=service.id)
    req.returned_qty += qty
    _settle(req)
    svc.add_event(service, "materials", f"Returned {fmt_qty(qty)} {req.unit} {req.description} to stock", actor)
    audit.log("requirement.return", "service_requirement", req.id, new={**_snap(req), "returned_now": qty}, user=actor)
    db.session.commit()
    return req


# ---------------------------------------------------------------- usage (technician)
def _settle(req):
    """Derive the status from the quantities after use/return."""
    if req.status in ("requested", "pending_approval", "rejected"):
        return
    if not req.is_inventory:
        req.status = "used" if req.used_qty >= req.approved_qty else "approved"
        return
    if req.issued_qty == 0:
        return
    if req.issued_qty < req.approved_qty:
        req.status = "partially_available"
        return
    accounted = req.used_qty + req.returned_qty
    req.status = "issued" if accounted < req.issued_qty else ("returned" if req.used_qty == 0 else "used")


def record_usage(actor, req_id, used_qty):
    """Set the TOTAL quantity actually consumed (can be corrected downwards while still within the issued stock)."""
    req = _lock_req(req_id)
    service = _service_for(actor, req)
    if not can_record_usage(actor, service):
        raise PermissionDenied("Only the assigned technician or an admin can record usage on an open job.")
    if req.status in ("requested", "pending_approval", "rejected"):
        raise ValidationError("This line has not been approved.")
    if req.is_inventory and req.issued_qty <= 0:
        raise ValidationError("Nothing has been issued yet, so nothing can be marked as used.")
    used = parse_qty(used_qty, "Quantity used", req.unit, allow_zero=True)
    limit = req.issued_qty - req.returned_qty if req.is_inventory else req.approved_qty
    if used > limit:
        raise ValidationError(f"Quantity used cannot exceed {fmt_qty(limit)} {req.unit}.")
    before = req.used_qty
    req.used_qty = used
    _settle(req)
    svc.add_event(service, "materials", f"Used {fmt_qty(used)} {req.unit} {req.description}"
                  + (f" (was {fmt_qty(before)})" if before else ""), actor)
    audit.log("requirement.usage", "service_requirement", req.id, old={"used": before}, new=_snap(req), user=actor)
    db.session.commit()
    return req


# ---------------------------------------------------------------- queries
def pending_approvals():
    return db.session.scalars(select(ServiceRequirement).where(ServiceRequirement.status == "pending_approval")
                              .order_by(ServiceRequirement.created_at)).all()


def issue_queue():
    return db.session.scalars(select(ServiceRequirement).where(
        ServiceRequirement.requirement_type == "inventory",
        ServiceRequirement.status.in_(("approved", "partially_available")))
        .order_by(ServiceRequirement.decided_at)).all()


def pending_count():
    return db.session.scalar(select(func.count(ServiceRequirement.id)).where(ServiceRequirement.status == "pending_approval"))


def waiting_for_parts(user):
    """Open jobs that are in 'Waiting for Spare Parts' or have approved stock lines not yet fully issued."""
    from sqlalchemy import exists, or_
    unfulfilled = exists().where(
        ServiceRequirement.service_request_id == ServiceRequest.id, ServiceRequirement.requirement_type == "inventory",
        ServiceRequirement.status.in_(("approved", "partially_available")),
        ServiceRequirement.issued_qty < ServiceRequirement.approved_qty)
    stmt = (select(ServiceRequest).where(svc.visible_clause(user), ServiceRequest.status.notin_(FINAL_STATUSES + ("completed",)),
                                         or_(ServiceRequest.status == "waiting_parts", unfulfilled))
            .order_by(ServiceRequest.created_at))
    return db.session.scalars(stmt).all()
