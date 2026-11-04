from ..extensions import db
from ..utils.time import utcnow


class Attachment(db.Model):
    """Shared file record. owner_type/owner_id point at a generator now and at service requests in Phase 4.
    Files live outside static/ and are served only through an authorised route."""

    __tablename__ = "attachments"
    __table_args__ = (db.Index("ix_attachments_owner", "owner_type", "owner_id"),)

    id = db.Column(db.Integer, primary_key=True)
    owner_type = db.Column(db.String(20), nullable=False)
    owner_id = db.Column(db.Integer, nullable=False)
    kind = db.Column(db.String(10), nullable=False)  # photo | document
    original_filename = db.Column(db.String(200), nullable=False)
    stored_filename = db.Column(db.String(60), unique=True, nullable=False)
    content_type = db.Column(db.String(60), nullable=False)
    size_bytes = db.Column(db.Integer, nullable=False)
    description = db.Column(db.String(200))
    uploaded_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    deleted_at = db.Column(db.DateTime)  # soft delete: the row and audit trail are kept

    uploaded_by = db.relationship("User", lazy="joined")
