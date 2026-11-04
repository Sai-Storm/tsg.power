from sqlalchemy import event

from ..extensions import db
from ..utils.time import utcnow
from .base import TimestampMixin
from .system import BigPK

UNITS = ("unit", "litre", "kg", "gram", "metre", "set", "pair", "box", "pack", "roll")
COUNTABLE_UNITS = {"unit", "set", "pair", "box", "pack", "roll"}  # whole numbers only
TXN_TYPES = ("purchase_in", "issue", "return", "adjustment", "correction")
TXN_LABELS = {"purchase_in": "Stock in", "issue": "Issued to job", "return": "Returned from job",
              "adjustment": "Adjustment", "correction": "Correction"}

REQ_STATUSES = {
    "requested": "Requested", "pending_approval": "Pending Approval", "approved": "Approved",
    "partially_available": "Partially Available", "issued": "Issued", "used": "Used",
    "returned": "Returned", "rejected": "Rejected",
}
REQ_BADGE = {"requested": "secondary", "pending_approval": "warning", "approved": "info",
             "partially_available": "danger", "issued": "primary", "used": "success",
             "returned": "success", "rejected": "dark"}
NON_INV_CATEGORIES = {"transport": "Transport", "external_service": "External service",
                      "tools": "Tools / equipment", "special_material": "Special material", "other": "Other"}
_IN = lambda values: ",".join(f"'{v}'" for v in values)  # noqa: E731


class InventoryCategory(db.Model):
    __tablename__ = "inventory_categories"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(60), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)


class Supplier(TimestampMixin, db.Model):
    __tablename__ = "suppliers"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), unique=True, nullable=False)
    contact_person = db.Column(db.String(120))
    phone = db.Column(db.String(25))
    email = db.Column(db.String(120))
    address = db.Column(db.Text)
    notes = db.Column(db.Text)
    is_active = db.Column(db.Boolean, nullable=False, default=True)


class InventoryItem(TimestampMixin, db.Model):
    __tablename__ = "inventory_items"
    __table_args__ = (
        db.CheckConstraint("current_stock >= 0", name="ck_inventory_items_stock_nonneg"),
        db.CheckConstraint("min_stock >= 0", name="ck_inventory_items_min_nonneg"),
        db.CheckConstraint("purchase_price >= 0", name="ck_inventory_items_purchase_nonneg"),
        db.CheckConstraint("selling_price IS NULL OR selling_price >= 0", name="ck_inventory_items_selling_nonneg"),
        db.CheckConstraint(f"unit IN ({_IN(UNITS)})", name="ck_inventory_items_unit"),
    )

    id = db.Column(db.Integer, primary_key=True)
    part_code = db.Column(db.String(20), unique=True, nullable=False)  # PRT-000001
    name = db.Column(db.String(150), nullable=False, index=True)
    category_id = db.Column(db.Integer, db.ForeignKey("inventory_categories.id", ondelete="RESTRICT"), index=True)
    sku = db.Column(db.String(60), unique=True)  # part number / SKU (optional, unique when present)
    description = db.Column(db.Text)
    unit = db.Column(db.String(10), nullable=False, default="unit")
    current_stock = db.Column(db.Numeric(12, 3), nullable=False, default=0)
    min_stock = db.Column(db.Numeric(12, 3), nullable=False, default=0)
    purchase_price = db.Column(db.Numeric(12, 2), nullable=False, default=0)
    selling_price = db.Column(db.Numeric(12, 2))
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id", ondelete="RESTRICT"), index=True)
    storage_location = db.Column(db.String(100))
    is_active = db.Column(db.Boolean, nullable=False, default=True, index=True)

    category = db.relationship("InventoryCategory", lazy="joined")
    supplier = db.relationship("Supplier", lazy="joined")

    @property
    def is_low(self):
        return self.current_stock <= self.min_stock

    @property
    def is_countable(self):
        return self.unit in COUNTABLE_UNITS


class InventoryTransaction(db.Model):
    """Append-only stock ledger: every change to current_stock has exactly one row here."""

    __tablename__ = "inventory_transactions"
    __table_args__ = (
        db.CheckConstraint("balance_after >= 0", name="ck_inventory_txn_balance_nonneg"),
        db.CheckConstraint("quantity_delta <> 0", name="ck_inventory_txn_nonzero"),
        db.CheckConstraint(f"txn_type IN ({_IN(TXN_TYPES)})", name="ck_inventory_txn_type"),
    )
    id = db.Column(BigPK, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey("inventory_items.id", ondelete="RESTRICT"), nullable=False, index=True)
    requirement_id = db.Column(db.Integer, db.ForeignKey("service_requirements.id", ondelete="RESTRICT"), index=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"), index=True)
    txn_type = db.Column(db.String(20), nullable=False, index=True)
    quantity_delta = db.Column(db.Numeric(12, 3), nullable=False)
    balance_after = db.Column(db.Numeric(12, 3), nullable=False)
    reference = db.Column(db.String(100))
    reason = db.Column(db.Text)
    performed_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    approved_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)

    item = db.relationship("InventoryItem", lazy="joined")
    performed_by = db.relationship("User", foreign_keys=[performed_by_id], lazy="joined")
    approved_by = db.relationship("User", foreign_keys=[approved_by_id], lazy="joined")
    service = db.relationship("ServiceRequest", lazy="joined")


class ServiceRequirement(TimestampMixin, db.Model):
    """One required part / material / external need on a job. Request, approval, issue and use are tracked separately."""

    __tablename__ = "service_requirements"
    __table_args__ = (
        db.CheckConstraint("requested_qty > 0 AND approved_qty >= 0 AND issued_qty >= 0 AND used_qty >= 0 "
                           "AND returned_qty >= 0", name="ck_requirements_qty_nonneg"),
        db.CheckConstraint("issued_qty <= approved_qty", name="ck_requirements_issued_le_approved"),
        db.CheckConstraint("used_qty <= approved_qty", name="ck_requirements_used_le_approved"),
        db.CheckConstraint("requirement_type = 'non_inventory' OR used_qty + returned_qty <= issued_qty",
                           name="ck_requirements_use_le_issued"),
        db.CheckConstraint("(requirement_type = 'inventory' AND item_id IS NOT NULL) OR "
                           "(requirement_type = 'non_inventory' AND item_id IS NULL)", name="ck_requirements_type_item"),
        db.CheckConstraint(f"status IN ({_IN(REQ_STATUSES)})", name="ck_requirements_status"),
    )

    id = db.Column(db.Integer, primary_key=True)
    service_request_id = db.Column(db.Integer, db.ForeignKey("service_requests.id", ondelete="RESTRICT"),
                                   nullable=False, index=True)
    requirement_type = db.Column(db.String(15), nullable=False)  # inventory | non_inventory
    item_id = db.Column(db.Integer, db.ForeignKey("inventory_items.id", ondelete="RESTRICT"), index=True)
    description = db.Column(db.String(200), nullable=False)  # item name snapshot, or the external need
    category = db.Column(db.String(20))  # non-inventory kind (transport, tools, ...)
    unit = db.Column(db.String(10), nullable=False, default="unit")
    requested_qty = db.Column(db.Numeric(12, 3), nullable=False)
    approved_qty = db.Column(db.Numeric(12, 3), nullable=False, default=0)
    issued_qty = db.Column(db.Numeric(12, 3), nullable=False, default=0)
    used_qty = db.Column(db.Numeric(12, 3), nullable=False, default=0)
    returned_qty = db.Column(db.Numeric(12, 3), nullable=False, default=0)
    unit_price = db.Column(db.Numeric(12, 2))  # selling price snapshot at issue / quoted cost; used for billing in Phase 6
    purpose = db.Column(db.String(255))
    status = db.Column(db.String(20), nullable=False, default="requested", index=True)
    requested_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    approved_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    decision_note = db.Column(db.Text)
    decided_at = db.Column(db.DateTime)
    issued_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    issued_at = db.Column(db.DateTime)

    service = db.relationship("ServiceRequest", backref=db.backref("requirements", order_by="ServiceRequirement.id"))
    item = db.relationship("InventoryItem", lazy="joined")
    requested_by = db.relationship("User", foreign_keys=[requested_by_id], lazy="joined")
    approved_by = db.relationship("User", foreign_keys=[approved_by_id], lazy="joined")
    issued_by = db.relationship("User", foreign_keys=[issued_by_id], lazy="joined")

    @property
    def is_inventory(self):
        return self.requirement_type == "inventory"

    @property
    def to_issue(self):
        return max(self.approved_qty - self.issued_qty, 0) if self.is_inventory else 0

    @property
    def remaining(self):
        """Inventory: issued but neither used nor returned. Non-inventory: approved but not yet used."""
        if self.is_inventory:
            return self.issued_qty - self.used_qty - self.returned_qty
        return self.approved_qty - self.used_qty

    @property
    def is_waiting_for_stock(self):
        return self.is_inventory and self.status in ("approved", "partially_available") and self.to_issue > 0


def _txn_append_only(_mapper, _conn, _target):
    raise RuntimeError("Inventory transactions are append-only and cannot be changed or deleted.")


event.listen(InventoryTransaction, "before_update", _txn_append_only)
event.listen(InventoryTransaction, "before_delete", _txn_append_only)
