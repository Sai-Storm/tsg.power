from ..extensions import db
from ..utils.time import utcnow

BigPK = db.BigInteger().with_variant(db.Integer, "sqlite")


class AuditLog(db.Model):
    __tablename__ = "audit_logs"
    __table_args__ = (db.Index("ix_audit_entity", "entity_type", "entity_id"),)

    id = db.Column(BigPK, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), index=True)
    action = db.Column(db.String(60), nullable=False, index=True)
    entity_type = db.Column(db.String(60), nullable=False)
    entity_id = db.Column(db.String(40))
    old_values = db.Column(db.JSON)
    new_values = db.Column(db.JSON)
    ip_address = db.Column(db.String(45))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)

    user = db.relationship("User", lazy="joined")


class CompanySetting(db.Model):
    __tablename__ = "company_settings"
    key = db.Column(db.String(80), primary_key=True)
    value = db.Column(db.Text, nullable=False, default="")
    updated_at = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    @classmethod
    def get(cls, key, default=None):
        row = db.session.get(cls, key)
        return row.value if row else default
