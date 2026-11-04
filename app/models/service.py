from sqlalchemy import event, inspect

from ..extensions import db
from ..utils.time import local_today, utcnow
from .base import TimestampMixin
from .system import BigPK

STATUSES = {
    "new_request": "New Request", "under_review": "Under Review", "assigned": "Assigned",
    "scheduled": "Scheduled", "in_progress": "In Progress", "waiting_parts": "Waiting for Spare Parts",
    "waiting_approval": "Waiting for Customer Approval", "completed": "Completed",
    "closed": "Closed", "cancelled": "Cancelled",
}
STATUS_BADGE = {
    "new_request": "primary", "under_review": "info", "assigned": "info", "scheduled": "info",
    "in_progress": "warning", "waiting_parts": "danger", "waiting_approval": "danger",
    "completed": "success", "closed": "secondary", "cancelled": "dark",
}
PRIORITY_BADGE = {"low": "secondary", "normal": "info", "high": "warning", "urgent": "danger"}
FINAL_STATUSES = ("closed", "cancelled")
OPEN_STATUSES = tuple(s for s in STATUSES if s not in ("completed", "closed", "cancelled"))
_IN = ",".join(f"'{s}'" for s in STATUSES)


class ServiceType(db.Model):
    __tablename__ = "service_types"
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(30), unique=True, nullable=False)
    name = db.Column(db.String(60), nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)


class Priority(db.Model):
    __tablename__ = "priorities"
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(20), unique=True, nullable=False)
    name = db.Column(db.String(30), nullable=False)
    rank = db.Column(db.Integer, nullable=False)  # higher = more urgent
    is_active = db.Column(db.Boolean, nullable=False, default=True)


class FaultCategory(db.Model):
    __tablename__ = "fault_categories"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(60), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)


class ServiceRequest(TimestampMixin, db.Model):
    __tablename__ = "service_requests"
    __table_args__ = (
        db.CheckConstraint(f"status IN ({_IN})", name="ck_service_requests_status"),
        db.CheckConstraint("labor_hours IS NULL OR labor_hours >= 0", name="ck_service_requests_labor"),
    )

    id = db.Column(db.Integer, primary_key=True)
    service_id = db.Column(db.String(24), unique=True, nullable=False)  # GEN-SRV-2026-0001; never changes
    source_quotation_number = db.Column(db.String(24), unique=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True)
    generator_id = db.Column(db.Integer, db.ForeignKey("generators.id", ondelete="RESTRICT"), nullable=False, index=True)
    service_type_id = db.Column(db.Integer, db.ForeignKey("service_types.id", ondelete="RESTRICT"), nullable=False)
    priority_id = db.Column(db.Integer, db.ForeignKey("priorities.id", ondelete="RESTRICT"), nullable=False, index=True)
    fault_category_id = db.Column(db.Integer, db.ForeignKey("fault_categories.id", ondelete="RESTRICT"))
    status = db.Column(db.String(30), nullable=False, default="new_request", index=True)
    complaint = db.Column(db.Text, nullable=False)
    location = db.Column(db.String(255))
    scheduled_at = db.Column(db.DateTime, index=True)  # UTC
    estimated_completion = db.Column(db.Date)
    actual_completion = db.Column(db.Date)
    diagnosis = db.Column(db.Text)
    work_performed = db.Column(db.Text)
    labor_hours = db.Column(db.Numeric(6, 2))
    completion_remarks = db.Column(db.Text)
    cancellation_reason = db.Column(db.Text)
    customer_acknowledged_at = db.Column(db.DateTime)
    customer_acknowledged_by = db.Column(db.String(120))
    report_submitted_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    report_approved_at = db.Column(db.DateTime)
    report_approved_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    report_approval_note = db.Column(db.String(500))
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    updated_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))

    customer = db.relationship("Customer", lazy="joined")
    generator = db.relationship("Generator", lazy="joined")
    service_type = db.relationship("ServiceType", lazy="joined")
    priority = db.relationship("Priority", lazy="joined")
    fault_category = db.relationship("FaultCategory", lazy="joined")
    created_by = db.relationship("User", foreign_keys=[created_by_id], lazy="joined")
    updated_by = db.relationship("User", foreign_keys=[updated_by_id], lazy="joined")
    report_submitted_by = db.relationship("User", foreign_keys=[report_submitted_by_id], lazy="joined")
    report_approved_by = db.relationship("User", foreign_keys=[report_approved_by_id], lazy="joined")
    assignments = db.relationship("ServiceAssignment", back_populates="service", order_by="ServiceAssignment.id")
    history = db.relationship("ServiceStatusHistory", back_populates="service",
                              order_by="ServiceStatusHistory.id")
    events = db.relationship("ServiceEvent", back_populates="service", order_by="ServiceEvent.id")

    @property
    def active_assignments(self):
        return [a for a in self.assignments if a.unassigned_at is None]

    @property
    def technicians(self):
        return [a.user for a in self.active_assignments]

    @property
    def status_label(self):
        return STATUSES[self.status]

    @property
    def is_open(self):
        return self.status in OPEN_STATUSES

    @property
    def is_overdue(self):
        if not self.is_open:
            return False
        if self.estimated_completion and self.estimated_completion < local_today():
            return True
        return bool(self.scheduled_at and self.scheduled_at < utcnow() and self.status in ("assigned", "scheduled"))


class ServiceAssignment(db.Model):
    __tablename__ = "service_assignments"
    id = db.Column(db.Integer, primary_key=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"),
                                   nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    is_lead = db.Column(db.Boolean, nullable=False, default=False)
    assigned_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    assigned_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    unassigned_at = db.Column(db.DateTime)  # NULL = currently assigned

    service = db.relationship("ServiceRequest", back_populates="assignments")
    user = db.relationship("User", foreign_keys=[user_id], lazy="joined")
    assigned_by = db.relationship("User", foreign_keys=[assigned_by_id], lazy="joined")


class ServiceStatusHistory(db.Model):
    """Append-only. Rows are never updated or deleted."""

    __tablename__ = "service_status_history"
    id = db.Column(BigPK, primary_key=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"),
                                   nullable=False, index=True)
    from_status = db.Column(db.String(30))
    to_status = db.Column(db.String(30), nullable=False)
    changed_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    changed_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    remarks = db.Column(db.Text)
    is_override = db.Column(db.Boolean, nullable=False, default=False)
    override_reason = db.Column(db.Text)

    service = db.relationship("ServiceRequest", back_populates="history")
    changed_by = db.relationship("User", lazy="joined")


class ServiceEvent(db.Model):
    """Append-only timeline entries that are not status changes (assignment, schedule, notes, ...)."""

    __tablename__ = "service_events"
    id = db.Column(BigPK, primary_key=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"),
                                   nullable=False, index=True)
    event_type = db.Column(db.String(30), nullable=False)
    message = db.Column(db.Text, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)

    service = db.relationship("ServiceRequest", back_populates="events")
    user = db.relationship("User", lazy="joined")


def _append_only(_mapper, _conn, _target):
    raise RuntimeError("History records are append-only and cannot be changed or deleted.")


for _model in (ServiceStatusHistory, ServiceEvent):
    event.listen(_model, "before_update", _append_only)
    event.listen(_model, "before_delete", _append_only)


@event.listens_for(ServiceRequest, "before_update")
def _service_id_is_immutable(_mapper, _conn, target):
    if inspect(target).attrs.service_id.history.has_changes():
        raise RuntimeError("A Service ID can never be changed once issued.")
