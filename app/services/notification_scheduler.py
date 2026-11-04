from datetime import timedelta

from sqlalchemy import select

from ..extensions import db
from ..models.service import OPEN_STATUSES, ServiceRequest
from ..utils.time import local_today, utcnow
from .notifications import _notify_many, users_with_permission


def create_scheduled_alerts(visit_window_minutes=None):
    from flask import current_app

    window = visit_window_minutes or current_app.config.get("NOTIFICATION_VISIT_WINDOW_MINUTES", 60)
    now = utcnow()
    cutoff = now + timedelta(minutes=window)
    services = db.session.scalars(select(ServiceRequest).where(
        ServiceRequest.status.in_(OPEN_STATUSES),
    )).all()
    dispatch_ids = {user.id for user in users_with_permission("service.assign")}
    created = 0
    for service in services:
        assigned_ids = {assignment.user_id for assignment in service.active_assignments}
        if not assigned_ids:
            continue
        if service.scheduled_at and now <= service.scheduled_at <= cutoff:
            created += _notify_many(
                assigned_ids,
                "visit_upcoming",
                "Upcoming service visit",
                f"Visit for {service.service_id} is scheduled soon.",
                entity_type="service_request",
                entity_id=service.id,
                dedupe_key=f"visit:{service.id}:{service.scheduled_at.isoformat()}",
            )
        if service.is_overdue:
            created += _notify_many(
                assigned_ids | dispatch_ids,
                "job_overdue",
                "Service job overdue",
                f"{service.service_id} is overdue and needs attention.",
                entity_type="service_request",
                entity_id=service.id,
                dedupe_key=f"overdue:{service.id}:{local_today().isoformat()}",
            )
    return created
