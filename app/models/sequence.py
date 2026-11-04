from ..extensions import db


class IdSequence(db.Model):
    """Database-backed counters. One row per (name, period), e.g. ('service', 2026)."""

    __tablename__ = "id_sequences"
    __table_args__ = (db.UniqueConstraint("name", "period", name="uq_id_sequences_name_period"),)

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(30), nullable=False)
    period = db.Column(db.Integer, nullable=False, default=0)  # year, or 0 for non-yearly counters
    last_value = db.Column(db.Integer, nullable=False, default=0)
