import io
import os
import threading
from datetime import timedelta
from types import SimpleNamespace

import pytest
from PIL import Image
from sqlalchemy import select
from werkzeug.datastructures import FileStorage

from app import create_app
from app.extensions import db
from app.models import (AuditLog, CustomerAdvance, EmployeeAdvance, Priority, ServiceEvent, ServiceRequest,
                        ServiceType)
from app.services import customer_service, generator_service, service_request_service as svc, service_workflow as wf
from app.services import upload_service
from app.services.errors import PermissionDenied, ValidationError
from app.utils.time import local_now, local_today
from config import TestConfig


@pytest.fixture()
def w(app, make_user):
    admin = make_user("admin@example.com", "admin")
    tech = make_user("tech1@example.com", "staff", name="Tech One")
    tech2 = make_user("tech2@example.com", "staff", name="Tech Two")
    desk = make_user("desk@example.com", "staff", name="Desk Staff")
    cust = customer_service.create_customer(desk, {"name": "Acme Mills", "phone_primary": "9876543210", "city": "Dehradun"})
    gen = generator_service.create_generator(desk, cust.id, {
        "brand": "Cummins", "model": "C100", "serial_number": "SN-1001", "capacity_kva": "100", "location": "Plant 1"})
    return SimpleNamespace(admin=admin, tech=tech, tech2=tech2, desk=desk, cust=cust, gen=gen)


def data(w, **kw):
    base = {"customer_id": w.cust.id, "generator_id": w.gen.id, "complaint": "Engine will not start",
            "service_type_id": db.session.scalar(select(ServiceType.id).where(ServiceType.code == "repair")),
            "priority_id": db.session.scalar(select(Priority.id).where(Priority.code == "normal"))}
    base.update(kw)
    return base


def new(w, actor=None, **kw):
    return svc.create_service_request(actor or w.desk, data(w, **kw))


def tomorrow():
    return local_now() + timedelta(days=1)


def start_job(w, tech=None):
    """Create, assign, schedule and start a job; returns it In Progress."""
    s = new(w)
    svc.assign_technicians(w.admin, s.id, [(tech or w.tech).id], (tech or w.tech).id)
    svc.schedule_visit(w.admin, s.id, tomorrow())
    return svc.change_status(tech or w.tech, s.id, "in_progress")


REPORT = {"diagnosis": "Clogged fuel filter", "work_performed": "Replaced filter, bled system",
          "labor_hours": "2.5", "actual_completion": None}


def report():
    return {**REPORT, "actual_completion": local_today()}


# ------------------------------------------------------------------ Service ID
def test_create_gets_id_and_first_history_row(w):
    s = new(w)
    year = local_today().year
    assert s.service_id == f"GEN-SRV-{year}-0001" and s.status == "new_request"
    assert s.location == "Plant 1"  # defaults to the generator's location
    assert [(h.from_status, h.to_status) for h in s.history] == [(None, "new_request")]
    assert new(w).service_id == f"GEN-SRV-{year}-0002"


def test_yearly_reset_and_ids_never_reused(w, monkeypatch):
    first = new(w)
    second = new(w)
    svc.assign_technicians(w.admin, second.id, [w.tech.id])
    svc.override_status(w.admin, second.id, "cancelled", "Customer withdrew the request")
    third = new(w)
    n = lambda s: int(s.service_id.rsplit("-", 1)[1])
    assert (n(first), n(second), n(third)) == (1, 2, 3)  # cancelled #2 is not recycled
    monkeypatch.setattr(svc, "_current_year", lambda: 2099)
    assert new(w).service_id == "GEN-SRV-2099-0001"  # new year restarts
    monkeypatch.undo()
    assert n(new(w)) == 4  # old year continues where it left off
    assert db.session.get(ServiceRequest, second.id).status == "cancelled"  # history is kept


def test_service_id_cannot_change(w):
    s = new(w)
    s.service_id = "GEN-SRV-2000-9999"
    with pytest.raises(RuntimeError):
        db.session.flush()
    db.session.rollback()


def test_history_is_append_only(w):
    s = new(w)
    s.history[0].remarks = "tampered"
    with pytest.raises(RuntimeError):
        db.session.flush()
    db.session.rollback()
    db.session.delete(s.history[0])
    with pytest.raises(RuntimeError):
        db.session.flush()
    db.session.rollback()


def test_create_validation_and_permissions(w, make_user):
    with pytest.raises(ValidationError):
        new(w, complaint="abc")
    with pytest.raises(ValidationError):
        new(w, priority_id=None)
    other = customer_service.create_customer(w.desk, {"name": "Other Co", "phone_primary": "9111111111"})
    with pytest.raises(ValidationError):
        new(w, customer_id=other.id)  # generator belongs to someone else
    generator_service.set_active(w.admin, w.gen.id, False)
    with pytest.raises(ValidationError):
        new(w)
    with pytest.raises(PermissionDenied):
        new(w, actor=make_user("portal@example.com", "customer"))


# ------------------------------------------------------------------ assignment and schedule
def test_assign_multiple_lead_reassign_and_status(w):
    s = new(w)
    svc.assign_technicians(w.admin, s.id, [w.tech.id, w.tech2.id], lead_id=w.tech.id)
    s = db.session.get(ServiceRequest, s.id)
    assert s.status == "assigned" and {t.id for t in s.technicians} == {w.tech.id, w.tech2.id}
    assert [a.user_id for a in s.active_assignments if a.is_lead] == [w.tech.id]
    svc.assign_technicians(w.admin, s.id, [w.tech2.id])  # reassign: tech1 removed
    s = db.session.get(ServiceRequest, s.id)
    assert [t.id for t in s.technicians] == [w.tech2.id]
    assert any(a.user_id == w.tech.id and a.unassigned_at for a in s.assignments)  # history kept
    assert any(e.event_type == "reassigned" for e in s.events)


def test_assign_rules(w):
    s = new(w)
    with pytest.raises(ValidationError):
        svc.assign_technicians(w.admin, s.id, [])
    with pytest.raises(ValidationError):
        svc.assign_technicians(w.admin, s.id, [w.admin.id])  # admins are not technicians
    with pytest.raises(ValidationError):
        svc.assign_technicians(w.admin, s.id, [w.tech.id], lead_id=w.tech2.id)
    with pytest.raises(PermissionDenied):
        svc.assign_technicians(w.tech, s.id, [w.tech.id])  # staff cannot assign
    w.tech2.is_active = False
    db.session.commit()
    with pytest.raises(ValidationError):
        svc.assign_technicians(w.admin, s.id, [w.tech2.id])


def test_schedule_rules(w):
    s = new(w)
    with pytest.raises(ValidationError):
        svc.schedule_visit(w.admin, s.id, tomorrow())  # nobody assigned yet
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    with pytest.raises(ValidationError):
        svc.schedule_visit(w.admin, s.id, local_now() - timedelta(days=1))
    s = svc.schedule_visit(w.admin, s.id, tomorrow(), local_today() + timedelta(days=3))
    assert s.status == "scheduled" and s.scheduled_at is not None
    svc.schedule_visit(w.admin, s.id, tomorrow() + timedelta(hours=3))  # reschedule keeps status
    assert db.session.get(ServiceRequest, s.id).status == "scheduled"
    with pytest.raises(PermissionDenied):
        svc.schedule_visit(w.tech, s.id, tomorrow())


# ------------------------------------------------------------------ workflow
def test_invalid_transitions_rejected(w):
    s = new(w)
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    with pytest.raises(ValidationError):
        svc.change_status(w.tech, s.id, "waiting_parts")  # assigned -> waiting_parts not allowed
    with pytest.raises(ValidationError):
        svc.change_status(w.tech, s.id, "completed")  # must use the completion report
    assert wf.TRANSITIONS["closed"] == () and wf.TRANSITIONS["cancelled"] == ()


def test_only_assigned_staff_can_change_status(w):
    s = new(w)
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    with pytest.raises(PermissionDenied):
        svc.change_status(w.tech2, s.id, "in_progress")
    with pytest.raises(PermissionDenied):
        svc.change_status(w.desk, s.id, "in_progress")  # creator but not assigned
    s = svc.change_status(w.tech, s.id, "in_progress")
    s = svc.change_status(w.tech, s.id, "waiting_parts", "Need injector")
    s = svc.change_status(w.tech, s.id, "in_progress")
    assert [h.to_status for h in s.history] == ["new_request", "assigned", "in_progress", "waiting_parts", "in_progress"]
    assert s.history[3].remarks == "Need injector" and s.history[3].changed_by_id == w.tech.id


def test_completion_requires_details(w):
    s = start_job(w)
    with pytest.raises(ValidationError) as exc:
        svc.complete_service(w.tech, s.id, {"diagnosis": "x"})
    assert "work performed" in str(exc.value) and "labor hours" in str(exc.value)
    assert db.session.get(ServiceRequest, s.id).status == "in_progress"


def test_completion_success_updates_generator_and_history(w):
    s = start_job(w)
    s = svc.complete_service(w.tech, s.id, report())
    assert s.status == "completed" and s.history[-1].to_status == "completed"
    assert db.session.get(type(w.gen), w.gen.id).last_service_date == local_today()
    assert s in svc.history_for(w.admin, generator_id=w.gen.id)  # shows up in service history


def test_completion_extension_hook_can_block(w):
    s = start_job(w)
    wf.COMPLETION_CHECKS.append(lambda sr: ["unapproved material requests"])
    try:
        with pytest.raises(ValidationError) as exc:
            svc.complete_service(w.tech, s.id, report())
        assert "unapproved material requests" in str(exc.value)
    finally:
        wf.COMPLETION_CHECKS.clear()


def test_future_completion_date_rejected(w):
    s = start_job(w)
    with pytest.raises(ValidationError):
        svc.complete_service(w.tech, s.id, {**report(), "actual_completion": local_today() + timedelta(days=2)})


def test_close_cancel_and_override_rules(w):
    s = start_job(w)
    s = svc.complete_service(w.tech, s.id, report())
    with pytest.raises(PermissionDenied):
        svc.change_status(w.tech, s.id, "closed")  # only Admin closes
    with pytest.raises(PermissionDenied):
        svc.change_status(w.tech, s.id, "in_progress")  # rework is Admin only
    s = svc.change_status(w.admin, s.id, "in_progress", "Customer reported leak")  # Admin rework
    s = svc.complete_service(w.admin, s.id, report())
    s = svc.change_status(w.admin, s.id, "closed")
    assert s.status == "closed"
    with pytest.raises(ValidationError):
        svc.change_status(w.admin, s.id, "in_progress")  # terminal

    c = new(w)
    with pytest.raises(PermissionDenied):
        svc.change_status(w.desk, c.id, "cancelled", "no longer needed")
    with pytest.raises(ValidationError):
        svc.change_status(w.admin, c.id, "cancelled", "")  # reason required
    c = svc.change_status(w.admin, c.id, "cancelled", "Duplicate of another request")
    assert c.status == "cancelled" and c.cancellation_reason == "Duplicate of another request"


def test_admin_override_needs_reason_and_is_recorded(w):
    s = new(w)
    with pytest.raises(PermissionDenied):
        svc.override_status(w.tech, s.id, "completed", "because")
    with pytest.raises(ValidationError):
        svc.override_status(w.admin, s.id, "in_progress", "  ")
    with pytest.raises(ValidationError):
        svc.override_status(w.admin, s.id, "new_request", "same status")
    s = svc.override_status(w.admin, s.id, "in_progress", "Work started before the system entry")
    h = s.history[-1]
    assert h.is_override and h.override_reason and h.from_status == "new_request" and h.to_status == "in_progress"
    assert db.session.scalar(select(AuditLog).where(AuditLog.action == "service.status_override")) is not None


def test_acknowledgment_and_notes(w):
    s = start_job(w)
    with pytest.raises(PermissionDenied):
        svc.record_acknowledgment(w.tech, s.id, "Mr Rao")  # not completed yet
    svc.complete_service(w.tech, s.id, report())
    s = svc.record_acknowledgment(w.tech, s.id, "Mr Rao")
    assert s.customer_acknowledged_by == "Mr Rao" and s.customer_acknowledged_at
    svc.add_note(w.tech, s.id, "Left spare filter with the customer")
    assert any(i["kind"] == "note" for i in svc.timeline(s))
    with pytest.raises(PermissionDenied):
        svc.add_note(w.tech2, s.id, "I should not see this job")


def test_edit_core_rules(w):
    s = new(w)
    high = db.session.scalar(select(Priority.id).where(Priority.code == "urgent"))
    s = svc.update_request(w.desk, s.id, data(w, priority_id=high))  # creator may edit while New
    assert s.priority.code == "urgent" and s.service_id.startswith("GEN-SRV-")
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    with pytest.raises(PermissionDenied):
        svc.update_request(w.desk, s.id, data(w))  # no longer New
    svc.update_request(w.admin, s.id, data(w, complaint="Alternator noise as well"))


# ------------------------------------------------------------------ visibility and queries
def test_visibility_rules(w):
    s = new(w)
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    assert svc.get_visible(w.admin, s.id) and svc.get_visible(w.tech, s.id) and svc.get_visible(w.desk, s.id)
    assert svc.get_visible(w.tech2, s.id) is None
    ids = lambda u: [r.id for r in db.session.scalars(svc.search_services(u))]
    assert ids(w.tech) == [s.id] and ids(w.tech2) == [] and ids(w.admin) == [s.id]
    assert ids(w.tech2) == [r.id for r in svc.history_for(w.tech2, customer_id=w.cust.id)]


def test_search_filters(w):
    a = new(w)
    b = new(w, priority_id=db.session.scalar(select(Priority.id).where(Priority.code == "urgent")))
    svc.assign_technicians(w.admin, a.id, [w.tech.id])
    find = lambda **kw: [r.id for r in db.session.scalars(svc.search_services(w.admin, **kw))]
    assert find(q=a.service_id) == [a.id]
    assert find(q="43210") and set(find(q="43210")) == {a.id, b.id}  # by customer phone
    assert find(q="SN-1001") and find(q="Tech One") == [a.id]  # by serial, by technician name
    assert find(status="assigned") == [a.id] and find(unassigned=True) == [b.id]
    assert find(technician_id=w.tech.id) == [a.id] and find(mine=True) == []
    assert find(priority_id=b.priority_id) == [b.id]
    assert find(created_from=local_today(), created_to=local_today()) and not find(created_to=local_today() - timedelta(days=1))


def test_overdue_and_unassigned_detection(w):
    s = new(w)
    assert [r.id for r in db.session.scalars(svc.search_services(w.admin, unassigned=True))] == [s.id]
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    s.estimated_completion = local_today() - timedelta(days=1)
    db.session.commit()
    assert s.is_overdue
    assert [r.id for r in db.session.scalars(svc.search_services(w.admin, overdue=True))] == [s.id]
    assert not db.session.scalars(svc.search_services(w.admin, unassigned=True)).all()


def test_workload(w):
    for _ in range(2):
        s = new(w)
        svc.assign_technicians(w.admin, s.id, [w.tech.id])
    rows = {r["user"].id: r for r in svc.workload()}
    assert rows[w.tech.id]["open"] == 2 and rows[w.tech2.id]["open"] == 0
    assert w.admin.id not in rows


def test_force_delete_service_removes_operational_history_and_keeps_audit(w):
    service = new(w)
    svc.assign_technicians(w.admin, service.id, [w.tech.id])
    service_id = service.id

    svc.force_delete_service(w.admin, service_id)

    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.scalar(select(ServiceEvent.id).where(
        ServiceEvent.service_request_id == service_id)) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "service.force_delete", AuditLog.entity_id == str(service_id)))


def test_force_delete_service_decouples_financial_history_and_succeeds(w):
    service = new(w)
    advance = EmployeeAdvance(
        advance_number="ADV-TEST-1", employee_id=w.tech.id, service_request_id=service.id,
        amount="100.00", reason="Travel", issued_by_id=w.admin.id,
    )
    db.session.add(advance)
    db.session.commit()

    svc.force_delete_service(w.admin, service.id)
    assert db.session.get(ServiceRequest, service.id) is None
    db.session.refresh(advance)
    assert advance.service_request_id is None


def test_force_delete_generator_cascades_operational_history(w):
    service = new(w)
    svc.assign_technicians(w.admin, service.id, [w.tech.id])
    generator_id, service_id = w.gen.id, service.id

    deleted = generator_service.force_delete_generator(w.admin, generator_id)

    assert deleted == 1
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.get(type(w.gen), generator_id) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "generator.force_delete", AuditLog.entity_id == str(generator_id)))


def test_force_delete_customer_cascades_operational_history(w):
    service = new(w)
    svc.assign_technicians(w.admin, service.id, [w.tech.id])
    customer_id, generator_id, service_id = w.cust.id, w.gen.id, service.id
    deleted_services, deleted_generators = customer_service.force_delete_customer(w.admin, customer_id)
    assert (deleted_services, deleted_generators) == (1, 1)
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.get(type(w.gen), generator_id) is None
    assert db.session.get(type(w.cust), customer_id) is None


def test_force_delete_customer_decouples_deposit_history_and_succeeds(w):
    deposit = CustomerAdvance(
        advance_number="CAD-TEST-1", customer_id=w.cust.id, amount="100.00", method="cash",
        received_by_id=w.admin.id,
    )
    db.session.add(deposit)
    db.session.commit()
    deposit_id = deposit.id

    customer_service.force_delete_customer(w.admin, w.cust.id)
    assert db.session.get(type(w.cust), w.cust.id) is None
    assert db.session.get(CustomerAdvance, deposit_id) is None


def test_clear_staff_workload_unassigns_only_active_open_jobs(w):
    service = new(w)
    svc.assign_technicians(w.admin, service.id, [w.tech.id])

    cleared = svc.clear_staff_workload(w.admin, w.tech.id)

    db.session.refresh(service)
    assert cleared == 1
    assert not service.active_assignments
    assert db.session.get(ServiceRequest, service.id) is not None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "staff.clear_workload", AuditLog.entity_id == str(w.tech.id)))


# ------------------------------------------------------------------ attachments on services
def _png():
    buf = io.BytesIO()
    Image.new("RGB", (20, 20), (5, 5, 5)).save(buf, "PNG")
    return FileStorage(stream=io.BytesIO(buf.getvalue()), filename="evidence.png")


def test_service_attachment_permissions(w):
    s = new(w)
    svc.assign_technicians(w.admin, s.id, [w.tech.id])
    att = upload_service.save_upload(w.tech, "service", s.id, _png(), "Leak")
    assert upload_service.can_view(w.tech, att) and upload_service.can_view(w.admin, att)
    assert not upload_service.can_view(w.tech2, att)
    with pytest.raises(PermissionDenied):
        upload_service.save_upload(w.tech2, "service", s.id, _png())
    svc.override_status(w.admin, s.id, "cancelled", "Job withdrawn by the customer")
    with pytest.raises(PermissionDenied):
        upload_service.save_upload(w.tech, "service", s.id, _png())  # closed jobs are frozen


# ------------------------------------------------------------------ MySQL-only race test
MYSQL_URL = os.environ.get("TEST_MYSQL_URL")


@pytest.mark.skipif(not MYSQL_URL, reason="Set TEST_MYSQL_URL to run the MySQL concurrency test")
def test_concurrent_service_creation_yields_unique_ids():
    class Cfg(TestConfig):
        SQLALCHEMY_DATABASE_URI = MYSQL_URL
        SQLALCHEMY_ENGINE_OPTIONS = {"pool_size": 30, "max_overflow": 10}

    app = create_app(Cfg)
    with app.app_context():
        db.drop_all()
        db.create_all()
        from app.models import Role, User
        from app.security.seed import seed_rbac
        seed_rbac()
        role = db.session.scalar(select(Role).where(Role.name == "admin"))
        u = User(staff_code="STF-0001", full_name="A", email="a@example.com", role=role)
        u.set_password("Str0ngPassw0rd")
        db.session.add(u)
        db.session.commit()
        c = customer_service.create_customer(u, {"name": "Race Co", "phone_primary": "9999999999"})
        g = generator_service.create_generator(u, c.id, {"brand": "B", "model": "M", "serial_number": "RACE-001", "capacity_kva": "10"})
        base = {"customer_id": c.id, "generator_id": g.id, "complaint": "Concurrent test",
                "service_type_id": db.session.scalar(select(ServiceType.id)), "priority_id": db.session.scalar(select(Priority.id)),
                "uid": u.id}
    ids, errors = [], []

    def worker():
        try:
            with app.app_context():
                actor = db.session.get(User, base["uid"])
                ids.append(svc.create_service_request(actor, {k: v for k, v in base.items() if k != "uid"}).service_id)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(40)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    with app.app_context():
        db.drop_all()
    assert not errors and len(ids) == 40 and len(set(ids)) == 40
