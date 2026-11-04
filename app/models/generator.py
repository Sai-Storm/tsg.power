from ..extensions import db
from ..utils.time import local_today
from .base import TimestampMixin

FUEL_TYPES = {"diesel": "Diesel", "petrol": "Petrol", "natural_gas": "Natural gas", "lpg": "LPG", "dual_fuel": "Dual fuel"}
CONDITIONS = {"excellent": "Excellent", "good": "Good", "fair": "Fair", "poor": "Poor", "out_of_service": "Out of service"}


def _in(values):
    return ",".join(f"'{v}'" for v in values)


class Generator(TimestampMixin, db.Model):
    __tablename__ = "generators"
    __table_args__ = (
        db.UniqueConstraint("brand_key", "serial_number", name="uq_generators_brand_serial"),
        db.CheckConstraint("capacity_kva > 0", name="ck_generators_capacity"),
        db.CheckConstraint(f"fuel_type IN ({_in(FUEL_TYPES)})", name="ck_generators_fuel"),
        db.CheckConstraint(f"`condition` IN ({_in(CONDITIONS)})", name="ck_generators_condition"),
        db.CheckConstraint(
            "warranty_start IS NULL OR warranty_end IS NULL OR warranty_end >= warranty_start",
            name="ck_generators_warranty_dates",
        ),
    )

    id = db.Column(db.Integer, primary_key=True)
    generator_code = db.Column(db.String(20), unique=True, nullable=False)  # GEN-000001
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True)
    brand = db.Column(db.String(60), nullable=False)
    brand_key = db.Column(db.String(60), nullable=False)  # lower-cased brand; keeps uniqueness collation-independent
    model = db.Column(db.String(80), nullable=False, index=True)
    serial_number = db.Column(db.String(40), nullable=False, index=True)  # stored upper-case
    capacity_kva = db.Column(db.Numeric(8, 2), nullable=False)
    fuel_type = db.Column(db.String(20), nullable=False, default="diesel")
    installation_date = db.Column(db.Date)
    location = db.Column(db.String(255))
    warranty_start = db.Column(db.Date)
    warranty_end = db.Column(db.Date)
    condition = db.Column(db.String(20), nullable=False, default="good")
    last_service_date = db.Column(db.Date)
    next_maintenance_date = db.Column(db.Date, index=True)
    notes = db.Column(db.Text)
    is_active = db.Column(db.Boolean, nullable=False, default=True, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))

    customer = db.relationship("Customer", back_populates="generators", lazy="joined")
    created_by = db.relationship("User", lazy="joined")

    @property
    def warranty_status(self):
        if not self.warranty_end:
            return "none"
        return "active" if self.warranty_end >= local_today() else "expired"

    @property
    def maintenance_overdue(self):
        return bool(self.next_maintenance_date and self.next_maintenance_date < local_today())

    @property
    def title(self):
        return f"{self.brand} {self.model} ({self.capacity_kva:g} kVA)"
