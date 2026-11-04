from datetime import timedelta

import click
from sqlalchemy import delete, func, select, update

from ..extensions import db
from ..models.notification import Notification
from ..models.user import Permission, Role, User, role_permissions
from ..utils.time import utcnow


def create_notification(recipient_id, event_type, title, message, *, entity_type=None, entity_id=None,
                        dedupe_key=None):
    """Queue one in-app notification; the caller owns the surrounding transaction."""
    dedupe_key = dedupe_key[:180] if dedupe_key else None
    if dedupe_key:
        existing = db.session.scalar(select(Notification).where(
            Notification.recipient_id == recipient_id,
            Notification.dedupe_key == dedupe_key,
        ))
        if existing:
            return existing, False

    user = db.session.get(User, recipient_id)
    if user is None or not user.is_active:
        return None, False
    notification = Notification(
        recipient_id=recipient_id,
        event_type=event_type[:40],
        title=title.strip()[:160],
        message=message.strip(),
        entity_type=entity_type[:50] if entity_type else None,
        entity_id=entity_id,
        dedupe_key=dedupe_key,
    )
    db.session.add(notification)
    db.session.flush()
    return notification, True


def unread_count(recipient_id):
    return db.session.scalar(select(func.count(Notification.id)).where(
        Notification.recipient_id == recipient_id,
        Notification.read_at.is_(None),
    )) or 0


def notification_feed(recipient_id, *, unread_only=True, limit=20):
    limit = max(1, min(int(limit), 100))
    stmt = select(Notification).where(Notification.recipient_id == recipient_id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    return db.session.scalars(stmt.order_by(Notification.created_at.desc(), Notification.id.desc())
                              .limit(limit)).all()


def mark_read(recipient_id, notification_id):
    result = db.session.execute(update(Notification).where(
        Notification.id == notification_id,
        Notification.recipient_id == recipient_id,
        Notification.read_at.is_(None),
    ).values(read_at=utcnow()))
    db.session.commit()
    return result.rowcount == 1


def mark_all_read(recipient_id):
    result = db.session.execute(update(Notification).where(
        Notification.recipient_id == recipient_id,
        Notification.read_at.is_(None),
    ).values(read_at=utcnow()))
    db.session.commit()
    return result.rowcount or 0


def delete_notification(recipient_id, notification_id):
    result = db.session.execute(delete(Notification).where(
        Notification.id == notification_id,
        Notification.recipient_id == recipient_id,
    ))
    db.session.commit()
    return result.rowcount == 1


def delete_read_notifications(recipient_id):
    result = db.session.execute(delete(Notification).where(
        Notification.recipient_id == recipient_id,
        Notification.read_at.is_not(None),
    ))
    db.session.commit()
    return result.rowcount or 0


def users_with_permission(permission_code):
    stmt = (select(User).join(Role, User.role_id == Role.id)
            .join(role_permissions, role_permissions.c.role_id == Role.id)
            .join(Permission, Permission.id == role_permissions.c.permission_id)
            .where(User.is_active.is_(True), Permission.code == permission_code))
    return db.session.scalars(stmt).unique().all()


def _notify_many(recipient_ids, event_type, title, message, *, entity_type, entity_id, dedupe_key):
    count = 0
    for recipient_id in set(recipient_ids):
        _notification, created = create_notification(
            recipient_id, event_type, title, message, entity_type=entity_type, entity_id=entity_id,
            dedupe_key=f"{dedupe_key}:user:{recipient_id}",
        )
        count += int(created)
    return count


def register_notification_cli(app):
    @app.cli.command("notifications-alerts")
    @click.option("--visit-window-minutes", type=click.IntRange(1, 10080), default=None)
    def notifications_alerts(visit_window_minutes):
        """Create deduplicated upcoming-visit and overdue-job alerts."""
        from .notification_scheduler import create_scheduled_alerts

        created = create_scheduled_alerts(visit_window_minutes=visit_window_minutes)
        db.session.commit()
        click.echo(f"Created {created} notification(s).")
