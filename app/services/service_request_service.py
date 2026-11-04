"""All service-request business rules. Web routes and the Android API both call these functions."""
from datetime import datetime, time, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import and_, delete as sql_delete, update as sql_update, exists, false, func, or_, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import (Attachment, AuditLog, Customer, EmployeeAdvance, EmployeeAdvanceRequest, ExpenseClaim,
                      FaultCategory, Generator, InventoryTransaction, Invoice, Permission, Priority, Role,
                      ServiceAssignment, ServiceEstimate, ServiceEvent, ServiceRequest,
                      ServiceRequirement, ServiceStatusHistory, ServiceType, User)
from ..models.service import FINAL_STATUSES, OPEN_STATUSES, STATUSES
from ..models.user import role_permissions
from ..utils.time import local_now, local_today, local_to_utc, utcnow
from ..utils.validators import phone_digits
from . import audit, service_workflow as wf
from .errors import PermissionDenied, ValidationError
from .id_generator import new_service_id


def _current_year():
    return local_today().year


# ---------------------------------------------------------------- access rules
def _assigned_clause(user_id):
    return exists().where(ServiceAssignment.service_request_id == ServiceRequest.id,
                          ServiceAssignment.user_id == user_id, ServiceAssignment.unassigned_at.is_(None))


def visible_clause(user):
    """SQL filter of the services this user may see."""
    if user.has_permission("service.view_all"):
        return True
    if user.has_permission("service.view_assigned"):
        return or_(ServiceRequest.created_by_id == user.id, _assigned_clause(user.id))
    return false()


def is_assigned(user, service):
    return any(a.user_id == user.id for a in service.active_assignments)


def can_view(user, service):
    if user.has_permission("service.view_all"):
        return True
    return user.has_permission("service.view_assigned") and (service.created_by_id == user.id or is_assigned(user, service))


def can_manage(user, service):
    """May act on the job: Admin (view_all) or an assigned technician."""
    return user.has_permission("service.view_all") or (
        user.has_permission("service.view_assigned") and is_assigned(user, service))


def can_edit_core(user, service):
    if service.status in FINAL_STATUSES:
        return False
    return user.has_permission("service.assign") or (
        service.created_by_id == user.id and service.status == "new_request" and user.has_permission("service.create"))


def can_edit_work(user, service):
    return (service.status not in ("new_request", "under_review") + FINAL_STATUSES
            and user.has_permission("service.update_status") and can_manage(user, service))


def can_complete(user, service):
    return service.status == "in_progress" and user.has_permission("service.update_status") and can_manage(user, service)


def can_add_note(user, service):
    return service.status not in FINAL_STATUSES and can_view(user, service)


def can_upload(user, service):
    return service.status not in FINAL_STATUSES and (can_manage(user, service) or (
        service.created_by_id == user.id and user.has_permission("service.create")))


def get_visible(user, service_pk):
    service = db.session.get(ServiceRequest, service_pk)
    return service if service is not None and can_view(user, service) else None


def can_delete_unstarted(user, service):
    if service.status != "new_request" or service.assignments or len(service.history) != 1 \
            or service.history[0].to_status != "new_request" or service.events or service.scheduled_at:
        return False
    has_prior_changes = db.session.scalar(select(AuditLog.id).where(
        AuditLog.entity_type == "service_request",
        AuditLog.entity_id == str(service.id),
        AuditLog.action != "service.create",
    ).limit(1))
    if has_prior_changes:
        return False
    related_checks = (
        select(ServiceRequirement.id).where(ServiceRequirement.service_request_id == service.id),
        select(ServiceEstimate.id).where(ServiceEstimate.service_request_id == service.id),
        select(Invoice.id).where(Invoice.service_request_id == service.id),
        select(InventoryTransaction.id).where(InventoryTransaction.service_request_id == service.id),
        select(Attachment.id).where(Attachment.owner_type == "service", Attachment.owner_id == service.id),
    )
    if any(db.session.scalar(stmt.limit(1)) is not None for stmt in related_checks):
        return False
    return bool(
        user.has_permission("service.assign")
        or (service.created_by_id == user.id and user.has_permission("service.create"))
    )


def delete_unstarted(actor, service_pk):
    """Delete only an untouched new request; retain an audit record of the removal."""
    service = _lock(service_pk)
    if not can_view(actor, service):
        raise PermissionDenied("You cannot access this job.")
    if not can_delete_unstarted(actor, service):
        raise ValidationError(
            "Only an unassigned new request with no materials, files, estimates, or invoices can be deleted."
        )
    old = {"service_id": service.service_id, "status": service.status, "customer_id": service.customer_id,
           "generator_id": service.generator_id, "complaint": service.complaint}
    audit.log("service.delete_unstarted", "service_request", service.id, old=old, user=actor)
    db.session.execute(
        sql_delete(ServiceStatusHistory).where(ServiceStatusHistory.service_request_id == service.id)
    )
    db.session.delete(service)
    db.session.commit()


def _check_force_delete_service(service):
    pass


def _force_delete_service_rows(actor, service):
    service_id = service.id
    before = {"service_id": service.service_id, "status": service.status,
              "customer_id": service.customer_id, "generator_id": service.generator_id,
              "complaint": service.complaint}
    attachments = db.session.scalars(select(Attachment).where(
        Attachment.owner_type == "service", Attachment.owner_id == service_id,
        Attachment.deleted_at.is_(None))).all()
    for attachment in attachments:
        attachment.deleted_at = utcnow()
        audit.log("attachment.delete", "service", service_id,
                  old={"attachment_id": attachment.id}, user=actor)
    audit.log("service.force_delete", "service_request", service_id, old=before, user=actor)

    db.session.execute(sql_update(InventoryTransaction).where(
        InventoryTransaction.service_request_id == service_id).values(service_request_id=None))
    db.session.execute(sql_update(EmployeeAdvance).where(
        EmployeeAdvance.service_request_id == service_id).values(service_request_id=None))
    db.session.execute(sql_update(ExpenseClaim).where(
        ExpenseClaim.service_request_id == service_id).values(service_request_id=None))
    db.session.execute(sql_update(Invoice).where(
        Invoice.service_request_id == service_id).values(service_request_id=None))

    db.session.execute(sql_delete(ServiceRequirement).where(
        ServiceRequirement.service_request_id == service_id))
    db.session.execute(sql_delete(ServiceEstimate).where(
        ServiceEstimate.service_request_id == service_id))
    db.session.execute(sql_delete(EmployeeAdvanceRequest).where(
        EmployeeAdvanceRequest.service_request_id == service_id))
    db.session.execute(sql_delete(ServiceAssignment).where(
        ServiceAssignment.service_request_id == service_id))
    db.session.execute(sql_delete(ServiceStatusHistory).where(
        ServiceStatusHistory.service_request_id == service_id))
    db.session.execute(sql_delete(ServiceEvent).where(ServiceEvent.service_request_id == service_id))
    db.session.execute(sql_delete(ServiceRequest).where(ServiceRequest.id == service_id))


def force_delete_service(actor, service_pk):
    _require(actor, "role.manage")
    service = db.session.execute(
        select(ServiceRequest).where(ServiceRequest.id == service_pk).with_for_update()
    ).scalar_one_or_none()
    if service is None:
        raise ValidationError("Service request not found.")
    if not can_view(actor, service):
        raise PermissionDenied("You cannot access this job.")
    _force_delete_service_rows(actor, service)
    db.session.commit()


def force_delete_services_for_generator(actor, generator_id):
    return _force_delete_services(actor, ServiceRequest.generator_id == generator_id)


def force_delete_services_for_customer(actor, customer_id):
    return _force_delete_services(actor, ServiceRequest.customer_id == customer_id)


def _force_delete_services(actor, clause):
    _require(actor, "role.manage")
    services = db.session.scalars(
        select(ServiceRequest).where(clause)
        .order_by(ServiceRequest.id).with_for_update()
    ).all()
    for service in services:
        _check_force_delete_service(service)
    for service in services:
        _force_delete_service_rows(actor, service)
    return len(services)


def clear_staff_workload(actor, user_id):
    _require(actor, "service.assign")
    _require(actor, "staff.manage")
    user = db.session.get(User, user_id)
    if user is None:
        raise ValidationError("Staff account not found.")
    assignments = db.session.scalars(
        select(ServiceAssignment).join(ServiceRequest)
        .where(ServiceAssignment.user_id == user.id, ServiceAssignment.unassigned_at.is_(None),
               ServiceRequest.status.in_(OPEN_STATUSES))
        .order_by(ServiceRequest.id).with_for_update()
    ).all()
    now = utcnow()
    for assignment in assignments:
        assignment.unassigned_at = now
        _event(assignment.service, "reassigned", f"{user.full_name} removed from active workload", actor)
    audit.log("staff.clear_workload", "user", user.id,
              old={"active_job_count": len(assignments)}, new={"active_job_count": 0}, user=actor)
    db.session.commit()
    return len(assignments)


def delete_unstarted_for_generator(actor, generator_id):
    """Stage removal of a generator's service requests only when every request is untouched."""
    services = db.session.scalars(
        select(ServiceRequest).where(ServiceRequest.generator_id == generator_id)
        .order_by(ServiceRequest.id).with_for_update()
    ).all()
    for service in services:
        if not can_view(actor, service) or not can_delete_unstarted(actor, service):
            raise ValidationError(
                "The generator has service requests with history or linked records. "
                "No records were deleted; deactivate the generator instead."
            )

    for service in services:
        old = {"service_id": service.service_id, "status": service.status, "customer_id": service.customer_id,
               "generator_id": service.generator_id, "complaint": service.complaint}
        audit.log("service.delete_unstarted", "service_request", service.id, old=old, user=actor)
        db.session.execute(
            sql_delete(ServiceStatusHistory).where(ServiceStatusHistory.service_request_id == service.id)
        )
        db.session.delete(service)
    return len(services)


def _require(user, code):
    if user is None or not user.is_authenticated or not user.has_permission(code):
        raise PermissionDenied("You do not have permission to do that.")


def _lock(service_pk):
    service = db.session.execute(
        select(ServiceRequest).where(ServiceRequest.id == service_pk).with_for_update()
        .execution_options(populate_existing=True)).scalar_one_or_none()
    if service is None:
        raise ValidationError("Service request not found.")
    return service


def lock_service(service_pk):
    return _lock(service_pk)


def _event(service, kind, message, actor):
    db.session.add(ServiceEvent(service_request_id=service.id, event_type=kind, message=message, user_id=actor.id))


def _apply_status(service, target, actor, remarks=None, override_reason=None):
    previous = service.status
    service.status = target
    service.updated_by_id = actor.id
    if target not in ("completed", "closed"):
        service.report_approved_at = None
        service.report_approved_by_id = None
        service.report_approval_note = None
    db.session.add(ServiceStatusHistory(
        service_request_id=service.id, from_status=previous, to_status=target, changed_by_id=actor.id,
        remarks=(remarks or "").strip() or None, is_override=override_reason is not None,
        override_reason=override_reason))
    if target == "cancelled":
        service.cancellation_reason = (remarks or override_reason or "").strip()
    audit.log("service.status_override" if override_reason else "service.status", "service_request", service.id,
              old={"status": previous}, new={"status": target, "remarks": remarks, "override_reason": override_reason},
              user=actor)


def add_event(service, kind, message, actor):
    """Public wrapper so other service modules can add timeline entries."""
    _event(service, kind, message, actor)


def mark_waiting_for_parts(actor, service, remarks):
    """Move an In Progress job to Waiting for Spare Parts (recorded in history). Returns True if it moved."""
    if service.status != "in_progress":
        return False
    _apply_status(service, "waiting_parts", actor, remarks=remarks)
    return True


# ---------------------------------------------------------------- create / edit
def _lookup(model, pk, label, required=True):
    if pk in (None, "", 0):
        if required:
            raise ValidationError(f"Select a {label}.")
        return None
    row = db.session.get(model, int(pk))
    if row is None or not row.is_active:
        raise ValidationError(f"Select a valid {label}.")
    return row


def _core_values(data):
    complaint = (data.get("complaint") or "").strip()
    if len(complaint) < 5:
        raise ValidationError("Describe the customer's complaint or the service requested (at least 5 characters).")
    return {
        "service_type": _lookup(ServiceType, data.get("service_type_id"), "service type"),
        "priority": _lookup(Priority, data.get("priority_id"), "priority"),
        "fault_category": _lookup(FaultCategory, data.get("fault_category_id"), "fault category", required=False),
        "complaint": complaint,
        "location": (data.get("location") or "").strip() or None,
    }


def create_service_request(actor, data, source_quotation_number=None):
    _require(actor, "service.create")
    customer = db.session.get(Customer, data.get("customer_id") or 0)
    generator = db.session.get(Generator, data.get("generator_id") or 0)
    if customer is None or generator is None:
        raise ValidationError("Select a customer and a generator.")
    if generator.customer_id != customer.id:
        raise ValidationError("That generator does not belong to this customer.")
    if not customer.is_active or not generator.is_active:
        raise ValidationError("The customer and generator must both be active.")
    values = _core_values(data)
    values["location"] = values["location"] or generator.location

    service = ServiceRequest(service_id=new_service_id(_current_year()), customer_id=customer.id,
                             generator_id=generator.id, source_quotation_number=source_quotation_number,
                             status="new_request", created_by_id=actor.id,
                             updated_by_id=actor.id, **values)
    try:
        db.session.add(service)
        db.session.flush()
        db.session.add(ServiceStatusHistory(service_request_id=service.id, from_status=None,
                                            to_status="new_request", changed_by_id=actor.id,
                                            remarks="Service request registered"))
        audit.log("service.create", "service_request", service.id,
                  new={"service_id": service.service_id, "customer": customer.customer_code,
                       "generator": generator.generator_code, "priority": service.priority.code,
                       "source_quotation": source_quotation_number}, user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("Could not allocate a unique Service ID. Please try again.")
    return service


def update_request(actor, service_pk, data):
    """Edit type, priority, fault category, complaint, location. Service ID, customer and generator are fixed."""
    service = _lock(service_pk)
    if not can_view(actor, service) or not can_edit_core(actor, service):
        raise PermissionDenied("You cannot edit this service request.")
    values = _core_values(data)
    before = {"service_type": service.service_type.code, "priority": service.priority.code,
              "complaint": service.complaint, "location": service.location}
    for key, value in values.items():
        setattr(service, key, value)
    service.updated_by_id = actor.id
    db.session.flush()
    _event(service, "updated", "Request details updated", actor)
    audit.log("service.update", "service_request", service.id, old=before,
              new={"service_type": service.service_type.code, "priority": service.priority.code,
                   "complaint": service.complaint, "location": service.location}, user=actor)
    db.session.commit()
    return service


# ---------------------------------------------------------------- work details / completion
def _work_values(data, require_all=False):
    values = {}
    for field in ("diagnosis", "work_performed", "completion_remarks"):
        if field in data:
            values[field] = (data[field] or "").strip() or None
    if "labor_hours" in data and data["labor_hours"] not in (None, ""):
        try:
            hours = Decimal(str(data["labor_hours"])).quantize(Decimal("0.01"))
        except (InvalidOperation, TypeError):
            raise ValidationError("Labor hours must be a number.")
        if hours < 0 or hours > Decimal("999.99"):
            raise ValidationError("Labor hours must be between 0 and 999.99.")
        values["labor_hours"] = hours
    for field, label in (("estimated_completion", "Estimated completion"), ("actual_completion", "Actual completion")):
        if data.get(field):
            values[field] = data[field]
    if "fault_category_id" in data:
        values["fault_category"] = _lookup(FaultCategory, data["fault_category_id"], "fault category", required=False)
    if values.get("actual_completion") and values["actual_completion"] > local_today():
        raise ValidationError("Actual completion date cannot be in the future.")
    return values


def save_work_details(actor, service_pk, data):
    service = _lock(service_pk)
    if not can_view(actor, service) or not can_edit_work(actor, service):
        raise PermissionDenied("You cannot record work details on this job.")
    values = _work_values(data)
    report_changed = any(getattr(service, key) != value for key, value in values.items())
    for key, value in values.items():
        setattr(service, key, value)
    if report_changed:
        service.report_approved_at = None
        service.report_approved_by_id = None
        service.report_approval_note = None
    service.updated_by_id = actor.id
    _event(service, "details", "Diagnosis / work details updated", actor)
    audit.log("service.work_details", "service_request", service.id, new={k: data.get(k) for k in data}, user=actor)
    db.session.commit()
    return service


def complete_service(actor, service_pk, data):
    """Completion report: saves the details and moves the job to Completed in one transaction."""
    service = _lock(service_pk)
    if not can_view(actor, service) or not can_complete(actor, service):
        raise PermissionDenied("You cannot complete this job.")
    values = _work_values(data)
    report_changed = any(getattr(service, key) != value for key, value in values.items())
    for key, value in values.items():
        setattr(service, key, value)
    service.report_submitted_by_id = actor.id
    if report_changed:
        service.report_approved_at = None
        service.report_approved_by_id = None
        service.report_approval_note = None
    wf.check_transition(actor, service, "completed")
    _apply_status(service, "completed", actor, remarks=service.completion_remarks or "Completion report submitted")
    service.generator.last_service_date = service.actual_completion
    _event(service, "completion", "Completion report submitted", actor)
    db.session.commit()
    return service


def approve_completion_report(actor, service_pk, note=None):
    _require(actor, "service.report_approve")
    service = _lock(service_pk)
    if service.status not in ("completed", "closed"):
        raise ValidationError("Only a completed service report can be approved.")
    if service.report_approved_at is not None:
        raise ValidationError("This service report has already been approved.")
    if service.report_submitted_by_id == actor.id:
        raise ValidationError("The person who submitted the service report cannot approve it.")
    note = (note or "").strip()
    if len(note) > 500:
        raise ValidationError("Approval note must be 500 characters or fewer.")
    service.report_approved_at = utcnow()
    service.report_approved_by_id = actor.id
    service.report_approval_note = note or None
    _event(service, "report_approved", "Service delivery report approved for invoicing", actor)
    audit.log("service.report_approved", "service_request", service.id,
              new={"approved_at": service.report_approved_at, "note": service.report_approval_note}, user=actor)
    db.session.commit()
    return service


def record_acknowledgment(actor, service_pk, name):
    service = _lock(service_pk)
    if not can_view(actor, service) or not can_manage(actor, service) or service.status != "completed":
        raise PermissionDenied("Customer acknowledgment can be recorded on completed jobs by the assigned team.")
    name = (name or "").strip()
    if len(name) < 2:
        raise ValidationError("Enter the name of the person acknowledging the work.")
    service.customer_acknowledged_at = utcnow()
    service.customer_acknowledged_by = name[:120]
    _event(service, "acknowledged", f"Customer acknowledgment recorded ({name})", actor)
    audit.log("service.acknowledged", "service_request", service.id, new={"by": name}, user=actor)
    db.session.commit()
    return service


def add_note(actor, service_pk, text):
    service = db.session.get(ServiceRequest, service_pk)
    if service is None or not can_add_note(actor, service):
        raise PermissionDenied("You cannot add notes to this job.")
    text = (text or "").strip()
    if len(text) < 3:
        raise ValidationError("Note is too short.")
    _event(service, "note", text[:1000], actor)
    db.session.commit()
    return service


# ---------------------------------------------------------------- status
def change_status(actor, service_pk, target, remarks=None):
    service = _lock(service_pk)
    if not can_view(actor, service) or not can_manage(actor, service):
        raise PermissionDenied("You are not assigned to this job.")
    if target == "completed":
        raise ValidationError("Submit the completion report to complete a job.")
    wf.check_transition(actor, service, target, remarks)
    _apply_status(service, target, actor, remarks)
    db.session.commit()
    return service


def override_status(actor, service_pk, target, reason):
    """Admin correction: any status, but a reason is mandatory and the action is flagged in history and audit."""
    _require(actor, "service.override_status")
    service = _lock(service_pk)
    reason = (reason or "").strip()
    if target not in STATUSES:
        raise ValidationError("Unknown status.")
    if target == service.status:
        raise ValidationError("The job already has that status.")
    if len(reason) < 5:
        raise ValidationError("A reason (at least 5 characters) is required for an override.")
    _apply_status(service, target, actor, remarks=f"Admin override: {reason}", override_reason=reason)
    db.session.commit()
    return service


# ---------------------------------------------------------------- assignment / schedule
def technician_options():
    """Active non-admin users who can work on jobs."""
    stmt = (select(User).join(Role, User.role_id == Role.id)
            .join(role_permissions, role_permissions.c.role_id == Role.id)
            .join(Permission, Permission.id == role_permissions.c.permission_id)
            .where(Permission.code == "service.update_status", User.is_active.is_(True), Role.name != "admin")
            .order_by(User.full_name))
    return db.session.scalars(stmt).all()


def assign_technicians(actor, service_pk, user_ids, lead_id=None, remarks=None):
    _require(actor, "service.assign")
    service = _lock(service_pk)
    if service.status not in OPEN_STATUSES:
        raise ValidationError("Technicians can only be changed on open jobs.")
    wanted = {int(i) for i in user_ids or []}
    if not wanted:
        raise ValidationError("Select at least one technician.")
    allowed = {u.id: u for u in technician_options()}
    if not wanted <= set(allowed):
        raise ValidationError("Only active technicians can be assigned.")
    lead_id = int(lead_id) if lead_id else None
    if lead_id and lead_id not in wanted:
        raise ValidationError("The lead technician must be one of the assigned technicians.")

    current = {a.user_id: a for a in service.active_assignments}
    now = utcnow()
    added = wanted - set(current)
    removed = set(current) - wanted
    for uid in removed:
        current[uid].unassigned_at = now
    for uid in added:
        db.session.add(ServiceAssignment(service_request_id=service.id, user_id=uid, assigned_by_id=actor.id,
                                         is_lead=(uid == lead_id)))
    for uid, assignment in current.items():
        if uid in wanted:
            assignment.is_lead = (uid == lead_id)
    db.session.flush()
    db.session.expire(service, ["assignments"])

    parts = []
    if added:
        parts.append("assigned " + ", ".join(allowed[u].full_name for u in sorted(added)))
    if removed:
        names = [u.full_name for u in db.session.scalars(select(User).where(User.id.in_(removed)))]
        parts.append("removed " + ", ".join(names))
    if parts:
        _event(service, "reassigned" if (removed and current) else "assigned",
               "Technicians: " + "; ".join(parts) + (f". {remarks.strip()}" if (remarks or "").strip() else ""), actor)
    if service.status in ("new_request", "under_review"):
        _apply_status(service, "assigned", actor, remarks="Technician assigned")
    service.updated_by_id = actor.id
    audit.log("service.assign", "service_request", service.id,
              new={"technicians": sorted(wanted), "lead": lead_id}, user=actor)
    db.session.commit()
    return service


def schedule_visit(actor, service_pk, scheduled_local, estimated_completion=None):
    """scheduled_local: naive datetime as entered in company local time."""
    _require(actor, "service.assign")
    service = _lock(service_pk)
    if service.status not in OPEN_STATUSES:
        raise ValidationError("Only open jobs can be scheduled.")
    if not service.active_assignments:
        raise ValidationError("Assign a technician before scheduling a visit.")
    if scheduled_local is None:
        raise ValidationError("Enter the visit date and time.")
    if scheduled_local < local_now() - timedelta(minutes=5):
        raise ValidationError("The visit cannot be scheduled in the past.")
    if estimated_completion and estimated_completion < scheduled_local.date():
        raise ValidationError("Estimated completion cannot be before the visit date.")
    rescheduled = service.scheduled_at is not None
    service.scheduled_at = local_to_utc(scheduled_local)
    if estimated_completion:
        service.estimated_completion = estimated_completion
    service.updated_by_id = actor.id
    _event(service, "scheduled", ("Visit rescheduled to " if rescheduled else "Visit scheduled for ")
           + scheduled_local.strftime("%d %b %Y, %H:%M"), actor)
    if service.status == "assigned":
        _apply_status(service, "scheduled", actor, remarks="Visit scheduled")
    audit.log("service.schedule", "service_request", service.id,
              new={"scheduled_at": service.scheduled_at, "estimated_completion": service.estimated_completion},
              user=actor)
    db.session.commit()
    return service


# ---------------------------------------------------------------- queries
def overdue_clause():
    return and_(ServiceRequest.status.in_(OPEN_STATUSES), or_(
        ServiceRequest.estimated_completion < local_today(),
        and_(ServiceRequest.scheduled_at < utcnow(), ServiceRequest.status.in_(("assigned", "scheduled")))))


def unassigned_clause():
    return and_(ServiceRequest.status.in_(OPEN_STATUSES), ~exists().where(
        ServiceAssignment.service_request_id == ServiceRequest.id, ServiceAssignment.unassigned_at.is_(None)))


SORTS = {"created": ServiceRequest.created_at, "scheduled": ServiceRequest.scheduled_at,
         "priority": Priority.rank, "status": ServiceRequest.status, "service_id": ServiceRequest.service_id}


def search_services(user, q=None, status=None, priority_id=None, type_id=None, technician_id=None,
                    created_from=None, created_to=None, overdue=False, unassigned=False, mine=False,
                    payment=None, sort="created", direction="desc"):
    stmt = (select(ServiceRequest).join(Customer, ServiceRequest.customer_id == Customer.id)
            .join(Generator, ServiceRequest.generator_id == Generator.id)
            .join(Priority, ServiceRequest.priority_id == Priority.id)
            .where(visible_clause(user)))
    if q:
        like = f"%{q.strip()}%"
        digits = phone_digits(q)
        conds = [ServiceRequest.service_id.ilike(like), Customer.name.ilike(like), Customer.customer_code.ilike(like),
                 Generator.serial_number.ilike(like), Generator.model.ilike(like), Generator.generator_code.ilike(like),
                 exists().where(ServiceAssignment.service_request_id == ServiceRequest.id,
                                ServiceAssignment.user_id == User.id, User.full_name.ilike(like))]
        if len(digits) >= 4:
            conds += [Customer.normalized_phone.like(f"%{digits}%"), Customer.normalized_phone_alt.like(f"%{digits}%")]
        stmt = stmt.where(or_(*conds))
    if status in STATUSES:
        stmt = stmt.where(ServiceRequest.status == status)
    if priority_id:
        stmt = stmt.where(ServiceRequest.priority_id == priority_id)
    if type_id:
        stmt = stmt.where(ServiceRequest.service_type_id == type_id)
    if technician_id:
        stmt = stmt.where(_assigned_clause(technician_id))
    if mine:
        stmt = stmt.where(_assigned_clause(user.id))
    if created_from:
        stmt = stmt.where(ServiceRequest.created_at >= local_to_utc(datetime.combine(created_from, time.min)))
    if created_to:
        stmt = stmt.where(ServiceRequest.created_at < local_to_utc(datetime.combine(created_to + timedelta(days=1), time.min)))
    if payment and user.has_permission("invoice.view"):
        from .invoice_service import payment_clause
        clause = payment_clause(payment)
        if clause is not None:
            stmt = stmt.where(clause)
    if overdue:
        stmt = stmt.where(overdue_clause())
    if unassigned:
        stmt = stmt.where(unassigned_clause())
    col = SORTS.get(sort, ServiceRequest.created_at)
    return stmt.order_by(col.asc() if direction == "asc" else col.desc(), ServiceRequest.id.desc())


def history_for(user, customer_id=None, generator_id=None, limit=50):
    stmt = select(ServiceRequest).where(visible_clause(user))
    if customer_id:
        stmt = stmt.where(ServiceRequest.customer_id == customer_id)
    if generator_id:
        stmt = stmt.where(ServiceRequest.generator_id == generator_id)
    return db.session.scalars(stmt.order_by(ServiceRequest.created_at.desc()).limit(limit)).all()


def workload():
    """Per technician: open jobs by status and how many are overdue (live from the database)."""
    rows = db.session.execute(
        select(ServiceAssignment.user_id, ServiceRequest)
        .join(ServiceRequest, ServiceRequest.id == ServiceAssignment.service_request_id)
        .where(ServiceAssignment.unassigned_at.is_(None), ServiceRequest.status.in_(OPEN_STATUSES))).all()
    result = {u.id: {"user": u, "open": 0, "overdue": 0, "by_status": {}} for u in technician_options()}
    for user_id, service in rows:
        entry = result.get(user_id)
        if entry is None:
            continue
        entry["open"] += 1
        entry["overdue"] += 1 if service.is_overdue else 0
        entry["by_status"][service.status] = entry["by_status"].get(service.status, 0) + 1
    return sorted(result.values(), key=lambda e: (-e["open"], e["user"].full_name))


def timeline(service):
    """Status changes and other events merged in time order (newest last)."""
    items = []
    for h in service.history:
        label = STATUSES[h.to_status]
        title = f"Status: {label}" if h.from_status else f"Request registered ({label})"
        items.append({"at": h.changed_at, "kind": "override" if h.is_override else "status", "status": h.to_status,
                      "title": title, "detail": h.remarks, "by": h.changed_by.full_name,
                      "from_label": STATUSES.get(h.from_status)})
    for e in service.events:
        items.append({"at": e.created_at, "kind": e.event_type, "status": None, "title": None,
                      "detail": e.message, "by": e.user.full_name, "from_label": None})
    return sorted(items, key=lambda i: i["at"])
