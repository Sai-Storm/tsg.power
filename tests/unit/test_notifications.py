from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.blueprints.notifications import bp as notifications_bp
from app.extensions import db
from app.models import Priority, ServiceType
from app.models.notification import Notification
from app.services import customer_service, generator_service, service_request_service
from app.services.notification_events import (
    notify_assignment,
    notify_completion,
    notify_estimate_awaiting_approval,
    notify_low_stock,
    notify_material_decision,
    notify_urgent_request,
)
from app.services.notification_providers import EmailProvider, SMSProvider, WhatsAppProvider
from app.services.notifications import (
    create_notification,
    mark_all_read,
    mark_read,
    notification_feed,
    unread_count,
    register_notification_cli,
)
from app.services.notification_scheduler import create_scheduled_alerts
from app.utils.time import utcnow
from tests.conftest import login


@pytest.fixture()
def notification_client(app, client):
    app.register_blueprint(notifications_bp)
    return client


def test_feed_count_and_mark_read_are_recipient_scoped(notification_client, make_user):
    recipient = make_user("recipient@example.com", "staff")
    other = make_user("other@example.com", "staff")
    own, _created = create_notification(recipient.id, "job_assigned", "Assigned", "Your job was assigned.",
                                        dedupe_key="own")
    theirs, _created = create_notification(other.id, "job_assigned", "Assigned", "Another user's notification.",
                                           dedupe_key="other")
    db.session.commit()

    login(notification_client, recipient.email)
    feed = notification_client.get("/notifications/api/feed")
    assert feed.status_code == 200
    assert feed.json["unread_count"] == 1
    assert [item["id"] for item in feed.json["notifications"]] == [own.id]

    assert notification_client.post(f"/notifications/api/{theirs.id}/read",
                                    headers={"Accept": "application/json"}).status_code == 404
    assert notification_client.post(f"/notifications/api/{own.id}/read",
                                    headers={"Accept": "application/json"}).json == {
                                        "updated": True, "unread_count": 0}
    db.session.refresh(theirs)
    assert theirs.read_at is None


def test_feed_limit_and_mark_all_read(app, make_user):
    user = make_user("reader@example.com", "staff")
    for index in range(3):
        create_notification(user.id, "test", f"Title {index}", "Message", dedupe_key=f"test:{index}")
    db.session.commit()

    assert unread_count(user.id) == 3
    assert len(notification_feed(user.id, limit=2)) == 2
    assert mark_all_read(user.id) == 3
    assert unread_count(user.id) == 0


def test_notification_deletion_is_recipient_scoped(notification_client, make_user):
    owner = make_user("notification-delete-owner@example.com", "staff")
    other = make_user("notification-delete-other@example.com", "staff")
    own, _ = create_notification(owner.id, "test", "Own", "Own notification", dedupe_key="delete:own")
    theirs, _ = create_notification(other.id, "test", "Other", "Other notification", dedupe_key="delete:other")
    read_item, _ = create_notification(owner.id, "test", "Read", "Read item", dedupe_key="delete:read")
    db.session.commit()
    own_id, other_id, read_id = own.id, theirs.id, read_item.id
    mark_read(owner.id, read_item.id)

    login(notification_client, owner.email)
    response = notification_client.post(f"/notifications/api/{own_id}/delete",
                                        headers={"Accept": "application/json"})
    assert response.status_code == 200 and response.json["deleted"] is True
    assert notification_client.post(f"/notifications/api/{other_id}/delete",
                                    headers={"Accept": "application/json"}).status_code == 404
    assert notification_client.post("/notifications/api/delete-read",
                                    headers={"Accept": "application/json"}).json["deleted"] == 1
    assert db.session.get(Notification, own_id) is None
    assert db.session.get(Notification, read_id) is None
    assert db.session.get(Notification, other_id) is not None


def test_event_triggers_cover_assignment_urgent_and_material_decision(make_user):
    tech = make_user("assigned@example.com", "staff")
    tech2 = make_user("assigned2@example.com", "staff")
    manager = make_user("manager@example.com", "admin")
    assignment = SimpleNamespace(user_id=tech2.id)
    service = SimpleNamespace(id=12, service_id="GEN-SRV-2026-0012", active_assignments=[assignment],
                              priority=SimpleNamespace(code="urgent"), created_by_id=tech.id)

    assert notify_assignment(service, [tech.id], event_key="assignment:1") == 1
    assert notify_urgent_request(service) >= 1
    requirement = SimpleNamespace(id=8, service=service, requested_by_id=tech.id, description="Fuel filter")
    assert notify_material_decision(requirement, "approved") == 2
    with pytest.raises(ValueError):
        notify_material_decision(requirement, "pending")
    db.session.commit()

    events = db.session.scalars(select(Notification.event_type)).all()
    assert events.count("job_assigned") == 1
    assert events.count("urgent_request") >= 1
    assert events.count("material_approved") == 2
    assert manager.id != tech.id


def test_low_stock_completion_and_estimate_events(make_user):
    stock_manager = make_user("stock@example.com", "admin")
    tech = make_user("tech@example.com", "staff")
    service = SimpleNamespace(id=21, service_id="GEN-SRV-2026-0021", created_by_id=tech.id,
                              active_assignments=[SimpleNamespace(user_id=tech.id)])
    item = SimpleNamespace(id=5, name="Oil filter", is_active=True, is_low=True)
    estimate = SimpleNamespace(id=4, version=1, created_by_id=tech.id, service=service)

    assert notify_low_stock(item, event_key="stock-transaction:5") >= 1
    assert notify_completion(service) >= 1
    assert notify_estimate_awaiting_approval(estimate) >= 1
    db.session.commit()

    events = db.session.scalars(select(Notification.event_type)).all()
    assert "low_stock" in events
    assert "job_completed" in events
    assert "estimate_awaiting_approval" in events
    assert unread_count(stock_manager.id) >= 1


def test_scheduled_alerts_are_recipient_scoped_and_idempotent(app, make_user):
    admin = make_user("scheduler-admin@example.com", "admin")
    tech = make_user("scheduler-tech@example.com", "staff")
    customer = customer_service.create_customer(admin, {
        "name": "Scheduled Alerts Co", "phone_primary": "9876543210",
    })
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Cummins", "model": "C100", "serial_number": "SCHED-100",
        "capacity_kva": "100",
    })
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Routine service is due",
        "service_type_id": db.session.scalar(select(ServiceType.id).where(ServiceType.code == "repair")),
        "priority_id": db.session.scalar(select(Priority.id).where(Priority.code == "normal")),
    })
    service_request_service.assign_technicians(admin, service.id, [tech.id])

    service.scheduled_at = utcnow() + timedelta(minutes=10)
    db.session.commit()
    assert create_scheduled_alerts(visit_window_minutes=60) == 1
    assert create_scheduled_alerts(visit_window_minutes=60) == 0
    assert unread_count(tech.id) == 1
    assert unread_count(admin.id) == 0

    service.scheduled_at = utcnow() - timedelta(minutes=5)
    db.session.commit()
    assert create_scheduled_alerts(visit_window_minutes=60) >= 2
    assert create_scheduled_alerts(visit_window_minutes=60) == 0

    register_notification_cli(app)
    result = app.test_cli_runner().invoke(args=["notifications-alerts"])
    assert result.exit_code == 0
    assert "Created 0 notification(s)." in result.output


@pytest.mark.parametrize("provider", [EmailProvider, SMSProvider, WhatsAppProvider])
def test_delivery_providers_are_explicit_unconfigured_stubs(provider):
    with pytest.raises(NotImplementedError):
        provider().send("recipient", "subject", "message")
