from sqlalchemy import event

from ..extensions import db
from ..utils.time import local_today, utcnow
from .base import TimestampMixin

ESTIMATE_STATUSES = {"draft": "Draft", "approved": "Approved", "customer_approved": "Customer approved",
                     "rejected": "Rejected", "superseded": "Superseded"}
ESTIMATE_BADGE = {"draft": "secondary", "approved": "info", "customer_approved": "success",
                  "rejected": "dark", "superseded": "light"}
INVOICE_STATUSES = {"draft": "Draft", "issued": "Unpaid", "partial": "Partially paid", "paid": "Paid", "void": "Void"}
INVOICE_BADGE = {"draft": "secondary", "issued": "danger", "partial": "warning", "paid": "success", "void": "dark"}
PAYMENT_METHODS = {"cash": "Cash", "upi": "UPI", "bank_transfer": "Bank transfer", "card": "Card",
                   "cheque": "Cheque", "other": "Other", "customer_credit": "Customer advance"}
PAYMENT_TYPES = {"payment": "Payment", "refund": "Refund", "adjustment": "Adjustment / write-off"}
APPROVAL_METHODS = {"phone": "Phone call", "in_person": "In person", "written": "Written / signed",
                    "whatsapp": "WhatsApp / message", "email": "Email"}
ITEM_TYPES = {"labor": "Labor", "part": "Parts", "other": "Other"}
_IN = lambda values: ",".join(f"'{v}'" for v in values)  # noqa: E731


class ServiceEstimate(TimestampMixin, db.Model):
    __tablename__ = "service_estimates"
    __table_args__ = (
        db.UniqueConstraint("service_request_id", "version", name="uq_estimates_service_version"),
        db.CheckConstraint("labor_hours >= 0 AND labor_rate >= 0 AND labor_amount >= 0 AND parts_amount >= 0 AND "
                           "other_amount >= 0 AND discount >= 0 AND tax_amount >= 0 AND subtotal >= 0 AND total >= 0",
                           name="ck_estimates_amounts_nonneg"),
        db.CheckConstraint(f"status IN ({_IN(ESTIMATE_STATUSES)})", name="ck_estimates_status"),
    )
    id = db.Column(db.Integer, primary_key=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"),
                                   nullable=True, index=True)
    quotation_number = db.Column(db.String(24), unique=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id", ondelete="RESTRICT"), index=True)
    generator_id = db.Column(db.Integer, db.ForeignKey("generators.id", ondelete="RESTRICT"), index=True)
    service_type_id = db.Column(db.Integer, db.ForeignKey("service_types.id", ondelete="RESTRICT"))
    priority_id = db.Column(db.Integer, db.ForeignKey("priorities.id", ondelete="RESTRICT"))
    complaint = db.Column(db.Text)
    location = db.Column(db.String(255))
    version = db.Column(db.Integer, nullable=False, default=1)
    status = db.Column(db.String(20), nullable=False, default="draft", index=True)
    labor_hours = db.Column(db.Numeric(8, 2), nullable=False, default=0)
    labor_rate = db.Column(db.Numeric(10, 2), nullable=False, default=0)
    labor_amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    parts_amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    other_amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    other_description = db.Column(db.String(200))
    subtotal = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    discount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    discount_reason = db.Column(db.String(200))
    apply_tax = db.Column(db.Boolean, nullable=False, default=True)
    tax_rate = db.Column(db.Numeric(5, 2), nullable=False, default=0)
    tax_amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    total = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    notes = db.Column(db.Text)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    approved_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    approved_at = db.Column(db.DateTime)
    rejection_reason = db.Column(db.Text)
    # customer approval record
    customer_decision = db.Column(db.String(10))  # approved | rejected
    customer_decided_by = db.Column(db.String(120))  # name of the customer representative
    customer_decided_at = db.Column(db.DateTime)
    customer_method = db.Column(db.String(20))
    customer_note = db.Column(db.Text)
    customer_recorded_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))

    service = db.relationship("ServiceRequest", backref=db.backref("estimates", order_by="ServiceEstimate.version"))
    customer = db.relationship("Customer", lazy="joined")
    generator = db.relationship("Generator", lazy="joined")
    service_type = db.relationship("ServiceType", lazy="joined")
    priority = db.relationship("Priority", lazy="joined")
    created_by = db.relationship("User", foreign_keys=[created_by_id], lazy="joined")
    approved_by = db.relationship("User", foreign_keys=[approved_by_id], lazy="joined")
    customer_recorded_by = db.relationship("User", foreign_keys=[customer_recorded_by_id], lazy="joined")


class Invoice(TimestampMixin, db.Model):
    __tablename__ = "invoices"
    __table_args__ = (
        db.CheckConstraint("subtotal >= 0 AND discount >= 0 AND tax_amount >= 0 AND total >= 0 AND amount_paid >= 0 "
                           "AND adjustment_total >= 0", name="ck_invoices_amounts_nonneg"),
        db.CheckConstraint("amount_paid + adjustment_total <= total", name="ck_invoices_not_overpaid"),
        db.CheckConstraint(f"status IN ({_IN(INVOICE_STATUSES)})", name="ck_invoices_status"),
    )
    id = db.Column(db.Integer, primary_key=True)
    invoice_number = db.Column(db.String(24), unique=True)  # assigned when issued; drafts have none
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"),
                                   nullable=False, index=True)
    # Equals service_request_id while the invoice is not void, else NULL: a UNIQUE index on it means
    # a job can only ever have one live invoice, enforced by the database.
    active_service_id = db.Column(db.Integer, unique=True)
    status = db.Column(db.String(10), nullable=False, default="draft", index=True)
    subtotal = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    discount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    discount_reason = db.Column(db.String(200))
    tax_name = db.Column(db.String(20), nullable=False, default="Tax")
    tax_rate = db.Column(db.Numeric(5, 2), nullable=False, default=0)
    tax_amount = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    total = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    amount_paid = db.Column(db.Numeric(12, 2), nullable=False, default=0)  # net cash: payments minus refunds
    adjustment_total = db.Column(db.Numeric(12, 2), nullable=False, default=0)  # authorised credits / write-offs
    notes = db.Column(db.Text)
    issued_at = db.Column(db.DateTime, index=True)
    due_date = db.Column(db.Date)
    issued_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    void_reason = db.Column(db.Text)
    voided_at = db.Column(db.DateTime)
    voided_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))

    service = db.relationship("ServiceRequest", lazy="joined", backref=db.backref("invoices", order_by="Invoice.id"))
    items = db.relationship("InvoiceItem", back_populates="invoice", order_by="InvoiceItem.id",
                            cascade="all, delete-orphan")
    payments = db.relationship("Payment", back_populates="invoice", order_by="Payment.id")
    created_by = db.relationship("User", foreign_keys=[created_by_id], lazy="joined")
    issued_by = db.relationship("User", foreign_keys=[issued_by_id], lazy="joined")

    @property
    def balance(self):
        return self.total - self.amount_paid - self.adjustment_total

    @property
    def is_overdue(self):
        return bool(self.status in ("issued", "partial") and self.due_date and self.due_date < local_today()
                    and self.balance > 0)

    @property
    def display_number(self):
        return self.invoice_number or f"Draft #{self.id}"

    def items_of(self, item_type):
        return [i for i in self.items if i.item_type == item_type]

    def subtotal_of(self, item_type):
        return sum((i.line_total for i in self.items_of(item_type)), start=type(self.total)(0))


class InvoiceItem(db.Model):
    __tablename__ = "invoice_items"
    __table_args__ = (
        db.CheckConstraint("quantity > 0 AND unit_price >= 0 AND line_total >= 0", name="ck_invoice_items_amounts"),
        db.CheckConstraint(f"item_type IN ({_IN(ITEM_TYPES)})", name="ck_invoice_items_type"),
    )
    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False, index=True)
    item_type = db.Column(db.String(10), nullable=False)
    description = db.Column(db.String(200), nullable=False)
    quantity = db.Column(db.Numeric(12, 3), nullable=False)
    unit = db.Column(db.String(10), nullable=False, default="unit")
    unit_price = db.Column(db.Numeric(12, 2), nullable=False)
    line_total = db.Column(db.Numeric(12, 2), nullable=False)
    requirement_id = db.Column(db.Integer, db.ForeignKey("service_requirements.id", ondelete="SET NULL"))

    invoice = db.relationship("Invoice", back_populates="items")


class Payment(db.Model):
    """Append-only money record: payment received, refund paid out, or authorised adjustment (credit / write-off)."""

    __tablename__ = "payments"
    __table_args__ = (
        db.CheckConstraint("amount > 0", name="ck_payments_amount_positive"),
        db.CheckConstraint(f"payment_type IN ({_IN(PAYMENT_TYPES)})", name="ck_payments_type"),
    )
    id = db.Column(db.Integer, primary_key=True)
    invoice_id = db.Column(db.Integer, db.ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False, index=True)
    customer_advance_id = db.Column(db.Integer, db.ForeignKey("customer_advances.id", ondelete="RESTRICT"), index=True)
    payment_type = db.Column(db.String(12), nullable=False, default="payment")
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    method = db.Column(db.String(15))
    reference = db.Column(db.String(100))
    reason = db.Column(db.Text)
    paid_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    number = db.Column(db.String(24), unique=True, nullable=False)  # RCT- / REF- / ADJ-
    received_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)

    invoice = db.relationship("Invoice", back_populates="payments")
    customer_advance = db.relationship("CustomerAdvance", lazy="joined")
    received_by = db.relationship("User", lazy="joined")


def _payment_append_only(_mapper, _conn, _target):
    raise RuntimeError("Payment records are append-only. Record a refund or adjustment instead.")


event.listen(Payment, "before_update", _payment_append_only)
event.listen(Payment, "before_delete", _payment_append_only)
