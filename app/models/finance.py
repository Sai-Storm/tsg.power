from sqlalchemy import event

from ..extensions import db
from ..utils.time import utcnow
from .base import TimestampMixin

ADVANCE_STATUSES = {"open": "Open", "settled": "Settled"}
CLAIM_STATUSES = {
    "submitted": "Submitted",
    "approved": "Approved - payout due",
    "paid": "Settled",
    "rejected": "Rejected",
}
CLAIM_CATEGORIES = {
    "travel": "Travel",
    "meals": "Meals",
    "fuel": "Fuel",
    "parts": "Parts and supplies",
    "accommodation": "Accommodation",
    "other": "Other",
}
CASH_DIRECTIONS = {"in": "Cash in", "out": "Cash out"}
CASH_CATEGORIES = {
    "income": "Other income",
    "expense": "Other expense",
    "opening": "Opening balance",
}
_IN = lambda values: ",".join(f"'{v}'" for v in values)  # noqa: E731


class EmployeeAdvance(TimestampMixin, db.Model):
    __tablename__ = "employee_advances"
    __table_args__ = (
        db.Index("ix_employee_advances_external_reference", "external_reference", unique=True),
        db.CheckConstraint("amount > 0", name="ck_employee_advances_amount_positive"),
    )

    id = db.Column(db.Integer, primary_key=True)
    advance_number = db.Column(db.String(24), unique=True, nullable=False)
    employee_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"), index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    reason = db.Column(db.String(500), nullable=False)
    external_reference = db.Column(db.String(100))
    issued_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    issued_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)

    employee = db.relationship("User", foreign_keys=[employee_id], lazy="joined")
    service = db.relationship("ServiceRequest", lazy="joined")
    issued_by = db.relationship("User", foreign_keys=[issued_by_id], lazy="joined")
    returns = db.relationship("AdvanceReturn", back_populates="advance", order_by="AdvanceReturn.id")
    claims = db.relationship("ExpenseClaim", back_populates="advance")


class EmployeeAdvanceRequest(db.Model):
    __tablename__ = "employee_advance_requests"
    __table_args__ = (
        db.CheckConstraint("requested_amount > 0", name="ck_advance_requests_amount_positive"),
        db.CheckConstraint("approved_amount IS NULL OR approved_amount > 0",
                           name="ck_advance_requests_approved_positive"),
        db.CheckConstraint("status IN ('requested','approved','rejected','issued')",
                           name="ck_advance_requests_status"),
    )

    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"), index=True)
    requested_amount = db.Column(db.Numeric(12, 2), nullable=False)
    reason = db.Column(db.String(500), nullable=False)
    status = db.Column(db.String(12), nullable=False, default="requested", index=True)
    requested_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    approved_amount = db.Column(db.Numeric(12, 2))
    approved_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    approved_at = db.Column(db.DateTime)
    rejection_reason = db.Column(db.String(500))
    issued_advance_id = db.Column(db.Integer, db.ForeignKey("employee_advances.id", ondelete="RESTRICT"), unique=True)

    employee = db.relationship("User", foreign_keys=[employee_id], lazy="joined")
    service = db.relationship("ServiceRequest", lazy="joined")
    approved_by = db.relationship("User", foreign_keys=[approved_by_id], lazy="joined")
    advance = db.relationship("EmployeeAdvance", lazy="joined")


class AdvanceReturn(db.Model):
    __tablename__ = "advance_returns"
    __table_args__ = (
        db.CheckConstraint("amount > 0", name="ck_advance_returns_amount_positive"),
    )

    id = db.Column(db.Integer, primary_key=True)
    advance_id = db.Column(db.Integer, db.ForeignKey("employee_advances.id", ondelete="RESTRICT"),
                           nullable=False, index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    note = db.Column(db.String(500))
    returned_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    received_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)

    advance = db.relationship("EmployeeAdvance", back_populates="returns")
    received_by = db.relationship("User", lazy="joined")


class ExpenseClaim(TimestampMixin, db.Model):
    __tablename__ = "expense_claims"
    __table_args__ = (
        db.CheckConstraint("amount > 0 AND advance_offset >= 0 AND advance_offset <= amount "
                           "AND reimbursement_paid >= 0", name="ck_expense_claims_amounts"),
        db.CheckConstraint(f"status IN ({_IN(CLAIM_STATUSES)})", name="ck_expense_claims_status"),
        db.CheckConstraint(f"category IN ({_IN(CLAIM_CATEGORIES)})", name="ck_expense_claims_category"),
    )

    id = db.Column(db.Integer, primary_key=True)
    claim_number = db.Column(db.String(24), unique=True, nullable=False)
    employee_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    advance_id = db.Column(db.Integer, db.ForeignKey("employee_advances.id", ondelete="RESTRICT"), index=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"), index=True)
    category = db.Column(db.String(20), nullable=False)
    description = db.Column(db.String(500), nullable=False)
    receipt_reference = db.Column(db.String(120))
    incurred_on = db.Column(db.Date, nullable=False, index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    advance_offset = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    reimbursement_paid = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    reimbursement_method = db.Column(db.String(15))
    status = db.Column(db.String(12), nullable=False, default="submitted", index=True)
    submitted_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    approved_at = db.Column(db.DateTime, index=True)
    approved_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    rejection_reason = db.Column(db.String(500))
    paid_at = db.Column(db.DateTime)

    employee = db.relationship("User", foreign_keys=[employee_id], lazy="joined")
    approved_by = db.relationship("User", foreign_keys=[approved_by_id], lazy="joined")
    advance = db.relationship("EmployeeAdvance", back_populates="claims")
    service = db.relationship("ServiceRequest", lazy="joined")

    @property
    def reimbursement_due(self):
        return self.amount - self.advance_offset - self.reimbursement_paid


class CashEntry(db.Model):
    __tablename__ = "cash_entries"
    __table_args__ = (
        db.CheckConstraint("amount > 0", name="ck_cash_entries_amount_positive"),
        db.CheckConstraint(f"direction IN ({_IN(CASH_DIRECTIONS)})", name="ck_cash_entries_direction"),
        db.CheckConstraint(f"category IN ({_IN(CASH_CATEGORIES)})", name="ck_cash_entries_category"),
    )

    id = db.Column(db.Integer, primary_key=True)
    entry_number = db.Column(db.String(24), unique=True, nullable=False)
    direction = db.Column(db.String(3), nullable=False)
    category = db.Column(db.String(10), nullable=False)
    description = db.Column(db.String(500), nullable=False)
    reference = db.Column(db.String(120))
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    occurred_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    recorded_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)

    recorded_by = db.relationship("User", lazy="joined")


class CustomerAdvance(db.Model):
    __tablename__ = "customer_advances"
    __table_args__ = (
        db.CheckConstraint("amount > 0", name="ck_customer_advances_amount_positive"),
        db.CheckConstraint("method IN ('cash','upi','bank_transfer','card','cheque','other')",
                           name="ck_customer_advances_method"),
    )

    id = db.Column(db.Integer, primary_key=True)
    advance_number = db.Column(db.String(24), unique=True, nullable=False)
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    method = db.Column(db.String(15), nullable=False)
    reference = db.Column(db.String(100), unique=True)
    received_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    received_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    notes = db.Column(db.String(500))

    customer = db.relationship("Customer", lazy="joined")
    received_by = db.relationship("User", lazy="joined")


class FinancialTransaction(db.Model):
    """Immutable double-entry journal transaction; operational tables remain typed subledgers."""

    __tablename__ = "financial_transactions"
    __table_args__ = (
        db.UniqueConstraint("source_type", "source_id", "event_key", name="uq_financial_source_event"),
        db.CheckConstraint("amount > 0", name="ck_financial_transactions_amount_positive"),
    )

    id = db.Column(db.BigInteger().with_variant(db.Integer, "sqlite"), primary_key=True)
    transaction_type = db.Column(db.String(40), nullable=False, index=True)
    source_type = db.Column(db.String(40), nullable=False)
    source_id = db.Column(db.String(40), nullable=False)
    event_key = db.Column(db.String(40), nullable=False)
    occurred_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    debit_account = db.Column(db.String(60), nullable=False, index=True)
    credit_account = db.Column(db.String(60), nullable=False, index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    reference = db.Column(db.String(120))
    description = db.Column(db.String(500), nullable=False)
    actor_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), index=True)
    reverses_id = db.Column(db.BigInteger().with_variant(db.Integer, "sqlite"),
                            db.ForeignKey("financial_transactions.id", ondelete="SET NULL"))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)

    actor = db.relationship("User", lazy="joined")
    reversal = db.relationship("FinancialTransaction", remote_side=[id], lazy="joined")


def _append_only(_mapper, _connection, _target):
    raise RuntimeError("Finance ledger entries are append-only. Record a correcting entry instead.")


for _model in (AdvanceReturn, CashEntry, FinancialTransaction, CustomerAdvance):
    event.listen(_model, "before_update", _append_only)
    event.listen(_model, "before_delete", _append_only)

event.listen(EmployeeAdvance, "before_update", _append_only)
event.listen(EmployeeAdvance, "before_delete", _append_only)
event.listen(ExpenseClaim, "before_delete", _append_only)
