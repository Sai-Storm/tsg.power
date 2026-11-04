from flask import jsonify, redirect, render_template, request, url_for
from flask_login import current_user, login_required
from sqlalchemy import func, select

from ...extensions import db
from ...models.notification import Notification
from ...services.notifications import (delete_notification, delete_read_notifications, mark_all_read, mark_read,
                                      notification_feed, unread_count)
from . import bp


@bp.route("/")
@login_required
def index():
    notifications = notification_feed(current_user.id, unread_only=False, limit=100)
    read_count = db.session.scalar(select(func.count(Notification.id)).where(
        Notification.recipient_id == current_user.id, Notification.read_at.is_not(None)))
    return render_template("notifications/index.html", notifications=notifications,
                           unread_count=unread_count(current_user.id), read_count=read_count)


@bp.get("/api/feed")
@login_required
def feed():
    unread_only = request.args.get("unread_only", "1").lower() not in ("0", "false", "no")
    notifications = notification_feed(current_user.id, unread_only=unread_only,
                                       limit=request.args.get("limit", 20, type=int))
    return jsonify(
        unread_count=unread_count(current_user.id),
        notifications=[{
            "id": item.id,
            "event_type": item.event_type,
            "title": item.title,
            "message": item.message,
            "entity_type": item.entity_type,
            "entity_id": item.entity_id,
            "created_at": item.created_at.isoformat() + "Z",
            "read": item.is_read,
        } for item in notifications],
    )


@bp.get("/api/unread-count")
@login_required
def count():
    return jsonify(unread_count=unread_count(current_user.id))


@bp.post("/api/<int:notification_id>/read")
@login_required
def read(notification_id):
    changed = mark_read(current_user.id, notification_id)
    if not changed:
        return jsonify(error={"code": 404, "message": "Notification not found."}), 404
    if request.accept_mimetypes.best == "application/json":
        return jsonify(updated=changed, unread_count=unread_count(current_user.id))
    return redirect(url_for("notifications.index"))


@bp.post("/api/read-all")
@login_required
def read_all():
    changed = mark_all_read(current_user.id)
    if request.accept_mimetypes.best != "application/json":
        return redirect(url_for("notifications.index"))
    return jsonify(updated=changed, unread_count=unread_count(current_user.id))


@bp.post("/api/<int:notification_id>/delete")
@login_required
def delete(notification_id):
    changed = delete_notification(current_user.id, notification_id)
    if not changed:
        return jsonify(error={"code": 404, "message": "Notification not found."}), 404
    if request.accept_mimetypes.best == "application/json":
        return jsonify(deleted=changed)
    return redirect(url_for("notifications.index"))


@bp.post("/api/delete-read")
@login_required
def delete_read():
    deleted = delete_read_notifications(current_user.id)
    if request.accept_mimetypes.best == "application/json":
        return jsonify(deleted=deleted)
    return redirect(url_for("notifications.index"))


@bp.get("/api/<int:notification_id>")
@login_required
def get_notification(notification_id):
    item = db.session.scalar(select(Notification).where(
        Notification.id == notification_id,
        Notification.recipient_id == current_user.id,
    ))
    if item is None:
        return jsonify(error={"code": 404, "message": "Notification not found."}), 404
    return jsonify(id=item.id, title=item.title, message=item.message, read=item.is_read)
