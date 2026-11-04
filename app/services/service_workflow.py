"""Status transition table and guards. Pure rules: no database writes here."""
from ..models.service import STATUSES
from .errors import PermissionDenied, ValidationError

TRANSITIONS = {
    "new_request": ("under_review", "assigned", "cancelled"),
    "under_review": ("assigned", "cancelled"),
    "assigned": ("scheduled", "in_progress", "cancelled"),
    "scheduled": ("in_progress", "assigned", "cancelled"),
    "in_progress": ("waiting_parts", "waiting_approval", "completed"),
    "waiting_parts": ("in_progress", "cancelled"),
    "waiting_approval": ("in_progress", "cancelled"),
    "completed": ("closed", "in_progress"),  # completed -> in_progress is Admin-only rework
    "closed": (),
    "cancelled": (),
}

TARGET_PERMISSION = {
    "under_review": "service.assign", "assigned": "service.assign", "scheduled": "service.assign",
    "in_progress": "service.update_status", "waiting_parts": "service.update_status",
    "waiting_approval": "service.update_status", "completed": "service.update_status",
    "closed": "service.close", "cancelled": "service.close",
}
REWORK_PERMISSION = "service.override_status"

# Statuses reached through dedicated actions (assignment form, schedule form, completion report).
FORM_TARGETS = ("under_review", "in_progress", "waiting_parts", "waiting_approval", "closed", "cancelled")

# Extra completion guards. Phase 5 registers "no material request left pending approval" here.
COMPLETION_CHECKS = []


def permission_for(current, target):
    return REWORK_PERMISSION if (current == "completed" and target == "in_progress") else TARGET_PERMISSION[target]


def selectable_targets(user, service):
    """Targets shown in the generic 'change status' dropdown for this user."""
    return [(t, STATUSES[t]) for t in TRANSITIONS[service.status]
            if t in FORM_TARGETS and user.has_permission(permission_for(service.status, t))]


def can_cancel(user, service):
    return ("cancelled" in TRANSITIONS[service.status]
            and user.has_permission(permission_for(service.status, "cancelled")))


def completion_problems(service):
    problems = []
    if not (service.diagnosis or "").strip():
        problems.append("fault diagnosis")
    if not (service.work_performed or "").strip():
        problems.append("work performed")
    if service.labor_hours is None:
        problems.append("labor hours")
    if service.actual_completion is None:
        problems.append("actual completion date")
    for check in COMPLETION_CHECKS:
        problems.extend(check(service))
    return problems


def check_transition(actor, service, target, remarks=None):
    current = service.status
    if target not in STATUSES:
        raise ValidationError("Unknown status.")
    if target not in TRANSITIONS[current]:
        raise ValidationError(f"A job that is {STATUSES[current]} cannot move to {STATUSES[target]}.")
    if not actor.has_permission(permission_for(current, target)):
        raise PermissionDenied("You do not have permission to make this status change.")
    if target == "cancelled" and len((remarks or "").strip()) < 5:
        raise ValidationError("A reason is required to cancel a service request.")
    if target in ("assigned", "scheduled", "in_progress", "waiting_parts", "waiting_approval", "completed") \
            and not service.active_assignments:
        raise ValidationError("Assign a technician before moving this job forward.")
    if target == "scheduled" and service.scheduled_at is None:
        raise ValidationError("Set a visit date and time first.")
    if target == "completed":
        problems = completion_problems(service)
        if problems:
            raise ValidationError("Cannot complete the job yet. Missing: " + ", ".join(problems) + ".")
