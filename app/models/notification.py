from sqlalchemy import Index, UniqueConstraint

from ..extensions import db
from ..utils.time import utcnow


class Notification(db.Model):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("recipient_id", "dedupe_key", name="uq_notifications_recipient_dedupe"),
        Index("ix_notifications_recipient_unread_created", "recipient_id", "read_at", "created_at"),
    )

    id = db.Column(db.Integer, primary_key=True)
    recipient_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"),
                             nullable=False, index=True)
    event_type = db.Column(db.String(40), nullable=False, index=True)
    title = db.Column(db.String(160), nullable=False)
    message = db.Column(db.Text, nullable=False)
    entity_type = db.Column(db.String(50))
    entity_id = db.Column(db.Integer)
    dedupe_key = db.Column(db.String(180))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)
    read_at = db.Column(db.DateTime)

    recipient = db.relationship("User", lazy="joined")

    @property
    def is_read(self):
        return self.read_at is not None
