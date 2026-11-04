import os
import threading
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app import create_app
from app.extensions import db
from app.models import (AuditLog, InventoryItem, InventoryTransaction, Priority, ServiceRequest,
                        ServiceRequirement, ServiceType)
from app.services import (customer_service, generator_service, inventory_service as inv,
                          requirement_service as reqs, service_request_service as svc, supplier_service)
from app.services.errors import PermissionDenied, ValidationError
from app.utils.time import local_now, local_today
from config import TestConfig

D = Decimal


@pytest.fixture()
def w(app, make_user):
    admin = make_user("admin@example.com", "admin")
    tech = make_user("tech1@example.com", "staff", name="Tech One")
    tech2 = make_user("tech2@example.com", "staff", name="Tech Two")
    desk = make_user("desk@example.com", "staff", name="Desk Staff")
    cust = customer_service.create_customer(desk, {"name": "Acme Mills", "phone_primary": "9876543210"})
    gen = generator_service.create_generator(desk, cust.id, {"brand": "Cummins", "model": "C100",
                                                              "serial_number": "SN-1001", "capacity_kva": "100"})
    oil = inv.create_item(admin, {"name": "Engine oil 15W40", "unit": "litre", "min_stock": "10",
                                  "opening_stock": "20", "purchase_price": "300", "selling_price": "450"})
    filt = inv.create_item(admin, {"name": "Oil filter", "unit": "unit", "min_stock": "2", "opening_stock": "3",
                                   "purchase_price": "150", "selling_price": "250", "sku": "of-100"})
    return SimpleNamespace(admin=admin, tech=tech, tech2=tech2, desk=desk, cust=cust, gen=gen, oil=oil, filt=filt)


def job(w, status="in_progress", tech=None):
    tech = tech or w.tech
    s = svc.create_service_request(w.desk, {
        "customer_id": w.cust.id, "generator_id": w.gen.id, "complaint": "Routine service needed",
        "service_type_id": db.session.scalar(select(ServiceType.id)), "priority_id": db.session.scalar(select(Priority.id))})
    svc.assign_technicians(w.admin, s.id, [tech.id], tech.id)
    if status == "in_progress":
        svc.schedule_visit(w.admin, s.id, local_now() + timedelta(days=1))
        s = svc.change_status(tech, s.id, "in_progress")
    return s


def line(w, s, item=None, qty="5", actor=None, **kw):
    item = item or w.oil
    return reqs.add_requirement(actor or w.tech, s.id, {"item_id": item.id, "quantity": qty, "purpose": "Service", **kw})


def approved_line(w, s, item=None, qty="5", approve=None):
    r = line(w, s, item, qty)
    reqs.submit_requirements(w.tech, s.id)
    return reqs.approve(w.admin, r.id, approve)


def stock(item):
    db.session.refresh(item)
    return item.current_stock


# ------------------------------------------------------------------ inventory
def test_create_item_codes_opening_stock_and_ledger(w):
    assert w.oil.part_code == "PRT-000001" and w.filt.part_code == "PRT-000002"
    assert w.oil.current_stock == D("20") and w.filt.sku == "OF-100"
    t = db.session.scalar(select(InventoryTransaction).where(InventoryTransaction.item_id == w.oil.id))
    assert (t.txn_type, t.quantity_delta, t.balance_after) == ("purchase_in", D("20"), D("20"))


def test_item_validation_and_permissions(w):
    with pytest.raises(PermissionDenied):
        inv.create_item(w.tech, {"name": "Fan belt", "unit": "unit"})
    with pytest.raises(ValidationError):
        inv.create_item(w.admin, {"name": "Fan belt", "unit": "unit", "sku": "OF-100"})  # duplicate SKU
    with pytest.raises(ValidationError):
        inv.create_item(w.admin, {"name": "Fan belt", "unit": "unit", "opening_stock": "1.5"})  # countable unit
    with pytest.raises(ValidationError):
        inv.create_item(w.admin, {"name": "Coolant", "unit": "litre", "purchase_price": "-5"})
    with pytest.raises(ValidationError):
        inv.create_item(w.admin, {"name": "X", "unit": "unit"})
    assert inv.create_item(w.admin, {"name": "Coolant", "unit": "litre", "opening_stock": "2.5"}).current_stock == D("2.5")


def test_stock_in_adjust_correction_and_ledger_balances(w):
    inv.stock_in(w.admin, w.oil.id, "10", "INV-77", unit_cost="310")
    assert stock(w.oil) == D("30") and w.oil.purchase_price == D("310.00")
    inv.adjust_stock(w.admin, w.oil.id, "-2", "Stock-take: spillage", "adjustment")
    inv.adjust_stock(w.admin, w.oil.id, "1", "Correct mis-keyed receipt", "correction")
    assert stock(w.oil) == D("29")
    ledger = db.session.scalars(select(InventoryTransaction).where(InventoryTransaction.item_id == w.oil.id)
                                .order_by(InventoryTransaction.id)).all()
    assert sum(t.quantity_delta for t in ledger) == stock(w.oil)  # ledger always reconciles to the stock figure
    assert [t.txn_type for t in ledger] == ["purchase_in", "purchase_in", "adjustment", "correction"]
    assert ledger[-1].balance_after == D("29") and ledger[-1].approved_by_id == w.admin.id


def test_adjustment_rules(w):
    with pytest.raises(PermissionDenied):
        inv.adjust_stock(w.tech, w.oil.id, "-1", "I lost some oil", "adjustment")
    with pytest.raises(PermissionDenied):
        inv.stock_in(w.tech, w.oil.id, "5")
    with pytest.raises(ValidationError):
        inv.adjust_stock(w.admin, w.oil.id, "-1", "  ", "adjustment")  # reason required
    with pytest.raises(ValidationError):
        inv.adjust_stock(w.admin, w.oil.id, "0", "No change at all", "adjustment")
    with pytest.raises(ValidationError) as exc:
        inv.adjust_stock(w.admin, w.oil.id, "-21", "Bigger than stock", "adjustment")  # would go negative
    assert "Not enough stock" in str(exc.value) and stock(w.oil) == D("20")


def test_database_blocks_negative_stock_even_if_code_is_bypassed(w):
    w.oil.current_stock = D("-1")
    with pytest.raises(IntegrityError):
        db.session.flush()
    db.session.rollback()


def test_ledger_is_append_only(w):
    t = db.session.scalar(select(InventoryTransaction))
    t.reason = "tampered"
    with pytest.raises(RuntimeError):
        db.session.flush()
    db.session.rollback()


def test_low_stock_detection(w):
    assert inv.low_stock_count() == 0
    inv.adjust_stock(w.admin, w.oil.id, "-10", "Stock-take shortage found", "adjustment")  # 10 == minimum 10
    assert inv.low_stock_count() == 1
    assert [i.id for i in db.session.scalars(inv.search_items(low=True))] == [w.oil.id]
    inv.adjust_stock(w.admin, w.oil.id, "5", "Found more stock on shelf", "correction")
    assert inv.low_stock_count() == 0


def test_unit_locked_after_movements_and_deactivate_guard(w):
    with pytest.raises(ValidationError):
        inv.update_item(w.admin, w.oil.id, {"name": "Engine oil", "unit": "kg"})
    s = job(w)
    line(w, s)
    reqs.submit_requirements(w.tech, s.id)
    with pytest.raises(ValidationError):
        inv.set_item_active(w.admin, w.oil.id, False)  # open request exists
    sup = supplier_service.create_supplier(w.admin, {"name": "Lube Traders", "phone": "9876500000"})
    with pytest.raises(ValidationError):
        supplier_service.create_supplier(w.admin, {"name": "lube traders"})
    assert sup.id


# ------------------------------------------------------------------ requirements: request & approval
def test_who_can_request_materials(w):
    s = job(w)
    assert line(w, s).status == "requested"
    for stranger in (w.tech2, w.desk):  # not assigned (desk only created it)
        with pytest.raises(PermissionDenied):
            line(w, s, actor=stranger)
    assert line(w, s, actor=w.admin).requested_by_id == w.admin.id
    with pytest.raises(ValidationError):
        line(w, s, qty="1.5", item=w.filt)  # whole units only
    with pytest.raises(ValidationError):
        line(w, s, qty="0")
    with pytest.raises(ValidationError):
        reqs.add_requirement(w.tech, s.id, {"quantity": "1"})  # neither item nor description


def test_non_inventory_requirement(w):
    s = job(w)
    r = reqs.add_requirement(w.tech, s.id, {"description": "Crane hire", "category": "external_service",
                                            "quantity": "1", "unit_price": "5000", "purpose": "Lift alternator"})
    assert not r.is_inventory and r.item_id is None and r.unit_price == D("5000.00")
    reqs.submit_requirements(w.tech, s.id)
    r = reqs.approve(w.admin, r.id, note="OK to hire")
    with pytest.raises(ValidationError):
        reqs.issue(w.admin, r.id)  # not a stock item
    r = reqs.record_usage(w.tech, r.id, "1")
    assert r.status == "used" and r.used_qty == D("1")


def test_submit_approve_reject_flow_never_auto_approves(w):
    s = job(w)
    a, b = line(w, s, qty="5"), line(w, s, w.filt, "1")
    with pytest.raises(ValidationError):
        reqs.approve(w.admin, a.id)  # still a draft, not submitted
    reqs.submit_requirements(w.tech, s.id)
    db.session.refresh(a)
    assert a.status == "pending_approval" and a.approved_qty == 0  # submission alone approves nothing
    with pytest.raises(PermissionDenied):
        reqs.approve(w.tech, a.id)
    with pytest.raises(ValidationError):
        reqs.approve(w.admin, a.id, "6")  # more than requested
    a = reqs.approve(w.admin, a.id, "4", "Reduced to 4")
    assert (a.status, a.approved_qty, a.approved_by_id) == ("approved", D("4"), w.admin.id)
    with pytest.raises(ValidationError):
        reqs.reject(w.admin, b.id, "no")
    b = reqs.reject(w.admin, b.id, "Not needed for this visit")
    assert b.status == "rejected" and b.decision_note
    assert any("Rejected" in i["detail"] for i in svc.timeline(db.session.get(ServiceRequest, s.id)) if i["kind"] == "materials")
    assert db.session.scalar(select(AuditLog).where(AuditLog.action == "requirement.reject"))


def test_completion_blocked_until_requests_decided(w):
    s = job(w)
    r = line(w, s)
    report = {"diagnosis": "d", "work_performed": "w", "labor_hours": "1", "actual_completion": local_today()}
    with pytest.raises(ValidationError) as exc:
        svc.complete_service(w.tech, s.id, report)
    assert "material request" in str(exc.value)
    reqs.delete_draft(w.tech, r.id)  # removing the draft unblocks
    assert svc.complete_service(w.tech, s.id, report).status == "completed"


def test_draft_removal_rules(w):
    s = job(w)
    r = line(w, s)
    with pytest.raises(PermissionDenied):
        reqs.delete_draft(w.tech2, r.id)
    reqs.submit_requirements(w.tech, s.id)
    with pytest.raises(ValidationError):
        reqs.delete_draft(w.tech, r.id)  # submitted lines cannot be deleted


# ------------------------------------------------------------------ issue / shortage / return / usage
def test_issue_deducts_stock_and_writes_ledger(w):
    s = job(w)
    r = approved_line(w, s, qty="5")
    assert stock(w.oil) == D("20")  # approval does not move stock
    r, now = reqs.issue(w.admin, r.id)
    assert now == D("5") and r.status == "issued" and r.issued_qty == D("5") and stock(w.oil) == D("15")
    assert r.unit_price == D("450.00")  # selling price snapshot for billing
    t = db.session.scalars(select(InventoryTransaction).where(InventoryTransaction.requirement_id == r.id)).one()
    assert (t.txn_type, t.quantity_delta, t.reference) == ("issue", D("-5"), s.service_id)
    assert t.service_request_id == s.id and t.approved_by_id == w.admin.id


def test_issue_permissions_and_state_rules(w):
    s = job(w)
    r = line(w, s)
    with pytest.raises(ValidationError):
        reqs.issue(w.admin, r.id)  # not approved
    reqs.submit_requirements(w.tech, s.id)
    reqs.approve(w.admin, r.id, "4")
    with pytest.raises(PermissionDenied):
        reqs.issue(w.tech, r.id)  # technicians cannot issue stock to themselves
    with pytest.raises(ValidationError):
        reqs.issue(w.admin, r.id, "5")  # more than approved
    reqs.issue(w.admin, r.id, "4")
    with pytest.raises(ValidationError):
        reqs.issue(w.admin, r.id)  # already issued


def test_shortage_issues_what_exists_flags_waiting_and_never_goes_negative(w):
    s = job(w)
    r = approved_line(w, s, w.filt, qty="5")  # only 3 in stock
    r, now = reqs.issue(w.admin, r.id)
    assert now == D("3") and r.status == "partially_available" and r.to_issue == D("2")
    assert stock(w.filt) == D("0")
    s = db.session.get(ServiceRequest, s.id)
    assert s.status == "waiting_parts"  # job flagged
    assert any(h.to_status == "waiting_parts" and h.changed_by_id == w.admin.id for h in s.history)
    assert s in reqs.waiting_for_parts(w.admin) and s in reqs.waiting_for_parts(w.tech)
    assert s not in reqs.waiting_for_parts(w.tech2)

    r2, none_now = reqs.issue(w.admin, r.id)  # nothing in stock: no ledger row, still waiting
    assert none_now == 0 and r2.status == "partially_available" and stock(w.filt) == D("0")
    assert db.session.scalar(select(func.count(InventoryTransaction.id)).where(
        InventoryTransaction.requirement_id == r.id)) == 1

    inv.stock_in(w.admin, w.filt.id, "10", "PO-5")
    r3, now3 = reqs.issue(w.admin, r.id)
    assert now3 == D("2") and r3.status == "issued" and stock(w.filt) == D("8")
    svc.change_status(w.tech, s.id, "in_progress")  # technician resumes
    assert s not in reqs.waiting_for_parts(w.admin)


def test_two_jobs_competing_for_limited_stock(w):
    s1, s2 = job(w), job(w, tech=w.tech2)
    a = approved_line(w, s1, w.filt, "2")
    r = line(w, s2, w.filt, "2", actor=w.tech2)
    reqs.submit_requirements(w.tech2, s2.id)
    b = reqs.approve(w.admin, r.id)
    reqs.issue(w.admin, a.id)
    _, got = reqs.issue(w.admin, b.id)
    assert got == D("1") and stock(w.filt) == D("0")  # second job gets the last unit only


def test_usage_and_return_lifecycle(w):
    s = job(w)
    r = approved_line(w, s, qty="5")
    with pytest.raises(ValidationError):
        reqs.record_usage(w.tech, r.id, "1")  # nothing issued yet
    reqs.issue(w.admin, r.id)
    with pytest.raises(PermissionDenied):
        reqs.record_usage(w.tech2, r.id, "1")
    with pytest.raises(ValidationError):
        reqs.record_usage(w.tech, r.id, "6")  # more than issued
    r = reqs.record_usage(w.tech, r.id, "3")
    assert r.status == "issued" and r.remaining == D("2")  # 2 litres still unaccounted for
    with pytest.raises(PermissionDenied):
        reqs.return_unused(w.tech, r.id, "2")  # the store confirms returns
    with pytest.raises(ValidationError):
        reqs.return_unused(w.admin, r.id, "3")  # only 2 are unused
    r = reqs.return_unused(w.admin, r.id, "2", "Unused oil back to shelf")
    assert r.status == "used" and r.returned_qty == D("2") and r.remaining == 0
    assert stock(w.oil) == D("17")  # 20 - 5 issued + 2 returned
    assert [t.txn_type for t in db.session.scalars(select(InventoryTransaction).where(
        InventoryTransaction.requirement_id == r.id).order_by(InventoryTransaction.id))] == ["issue", "return"]
    r = reqs.record_usage(w.tech, r.id, "2")  # correction downwards: 5 issued - 2 returned = 3 max
    assert r.used_qty == D("2") and r.status == "issued"  # 1 litre unaccounted again


def test_fully_returned_line_status(w):
    s = job(w)
    r = approved_line(w, s, w.filt, "2")
    reqs.issue(w.admin, r.id)
    r = reqs.return_unused(w.admin, r.id, "2")
    assert r.status == "returned" and stock(w.filt) == D("3")


def test_closed_job_freezes_materials(w):
    s = job(w)
    issued = approved_line(w, s, qty="2")
    reqs.issue(w.admin, issued.id)
    waiting = line(w, s, w.filt, "1")  # approved but not yet issued when the job is cancelled
    reqs.submit_requirements(w.tech, s.id)
    reqs.approve(w.admin, waiting.id)
    svc.override_status(w.admin, s.id, "cancelled", "Customer cancelled the job")
    with pytest.raises(ValidationError) as exc:
        reqs.issue(w.admin, waiting.id)
    assert "closed" in str(exc.value) and stock(w.filt) == D("3")  # no stock left the store
    with pytest.raises(PermissionDenied):
        reqs.record_usage(w.tech, issued.id, "1")
    with pytest.raises(PermissionDenied):
        line(w, s)


# ------------------------------------------------------------------ MySQL-only race test
MYSQL_URL = os.environ.get("TEST_MYSQL_URL")


@pytest.mark.skipif(not MYSQL_URL, reason="Set TEST_MYSQL_URL to run the MySQL concurrency test")
def test_concurrent_issues_never_oversell_on_mysql():
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
        admin = User(staff_code="STF-0001", full_name="A", email="a@example.com", role=role)
        admin.set_password("Str0ngPassw0rd")
        db.session.add(admin)
        db.session.commit()
        cust = customer_service.create_customer(admin, {"name": "Race Co", "phone_primary": "9999999999"})
        gen = generator_service.create_generator(admin, cust.id, {"brand": "B", "model": "M", "serial_number": "RACE-001", "capacity_kva": "10"})
        item = inv.create_item(admin, {"name": "Scarce part", "unit": "unit", "opening_stock": "10"})
        s = svc.create_service_request(admin, {"customer_id": cust.id, "generator_id": gen.id, "complaint": "Race test",
                                               "service_type_id": db.session.scalar(select(ServiceType.id)),
                                               "priority_id": db.session.scalar(select(Priority.id))})
        ids = []
        for _ in range(20):
            r = ServiceRequirement(service_request_id=s.id, requirement_type="inventory", item_id=item.id,
                                   description=item.name, unit="unit", requested_qty=1, approved_qty=1,
                                   status="approved", requested_by_id=admin.id, approved_by_id=admin.id)
            db.session.add(r)
            db.session.flush()
            ids.append(r.id)
        db.session.commit()
        admin_id, item_id = admin.id, item.id
    errors = []

    def worker(rid):
        try:
            with app.app_context():
                reqs.issue(db.session.get(User, admin_id), rid)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in ids]
    [t.start() for t in threads]
    [t.join() for t in threads]
    with app.app_context():
        final = db.session.get(InventoryItem, item_id).current_stock
        issued = db.session.scalar(select(func.coalesce(func.sum(ServiceRequirement.issued_qty), 0)))
        db.drop_all()
    assert not errors and final == 0 and issued == 10  # exactly 10 units left the store, never 11
