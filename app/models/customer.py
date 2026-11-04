from ..extensions import db
from .base import TimestampMixin

CUSTOMER_TYPES = ("individual", "business")


class Customer(TimestampMixin, db.Model):
    __tablename__ = "customers"
    __table_args__ = (
        db.CheckConstraint("customer_type IN ('individual','business')", name="ck_customers_type"),
    )

    id = db.Column(db.Integer, primary_key=True)
    customer_code = db.Column(db.String(20), unique=True, nullable=False)  # CUS-000001
    name = db.Column(db.String(150), nullable=False, index=True)
    contact_person = db.Column(db.String(120))
    phone_primary = db.Column(db.String(25), nullable=False)
    phone_alt = db.Column(db.String(25))
    normalized_phone = db.Column(db.String(15), nullable=False, index=True)
    normalized_phone_alt = db.Column(db.String(15), index=True)
    email = db.Column(db.String(120), index=True)
    address = db.Column(db.Text)
    city = db.Column(db.String(80), index=True)
    state = db.Column(db.String(80))
    customer_type = db.Column(db.String(12), nullable=False, default="individual")
    notes = db.Column(db.Text)
    is_active = db.Column(db.Boolean, nullable=False, default=True, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))

    created_by = db.relationship("User", lazy="joined")
    generators = db.relationship("Generator", back_populates="customer", order_by="Generator.id")
