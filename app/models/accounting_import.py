from sqlalchemy import UniqueConstraint

from ..extensions import db
from ..utils.time import utcnow


class AccountingImportReference(db.Model):
    __tablename__ = "accounting_import_references"
    __table_args__ = (
        UniqueConstraint("scope", "reference", name="uq_accounting_import_scope_reference"),
    )

    id = db.Column(db.Integer, primary_key=True)
    scope = db.Column(db.String(80), nullable=False)
    reference = db.Column(db.String(120), nullable=False)
    imported_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
