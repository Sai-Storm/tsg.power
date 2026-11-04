import io
import os
import threading
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from PIL import Image
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from werkzeug.datastructures import FileStorage

from app import create_app
from app.extensions import db
from app.models import AuditLog, CompanySetting, Invoice, Payment, Priority, ServiceEstimate, ServiceType
from app.services import (billing_math as bm, customer_service, estimate_service as est, generator_service,
                          inventory_service as inv, invoice_service as bill, pdf_service,
                          requirement_service as reqs, service_request_service as svc, settings_service)
from app.services.errors import PermissionDenied, ValidationError
from app.utils.time import local_now, local_today
from config import TestConfig

D = Decimal


@pytest.fixture()
def w(app, make_user):
    admin = make_user("admin@example.com", "admin", name="Alice Admin")
    tech = make_user("tech@example.com", "staff", name="Tara Tech")
    tech2 = make_user("tech2@example.com", "staff", name="Other Tech")
    desk = make_user("desk@example.com", "staff", name="Desk Dee")
    cust = customer_service.create_customer(desk, {"name": "Acme Mills", "phone_primary": "9876543210",
                                                   "contact_person": "Mr Rao", "city": "Dehradun"})
    gen = generator_service.create_generator(desk, cust.id, {"brand": "Cummins", "model": "C100",
                                                              "serial_number": "SN-1001", "capacity_kva": "100"})
    oil = inv.create_item(admin, {"name": "Engine oil", "unit": "litre", "opening_stock": "50", "selling_price": "450"})
    return SimpleNamespace(admin=admin, tech=tech, tech2=tech2, desk=desk, cust=cust, gen=gen, oil=oil)


def new_job(w):
    s = svc.create_service_request(w.desk, {
        "customer_id": w.cust.id, "generator_id": w.gen.id, "complaint": "Generator tripping on load",
        "service_type_id": db.session.scalar(select(ServiceType.id)), "priority_id": db.session.scalar(select(Priority.id))})
    svc.assign_technicians(w.admin, s.id, [w.tech.id], w.tech.id)
    svc.schedule_visit(w.admin, s.id, local_now() + timedelta(days=1))
    return svc.change_status(w.tech, s.id, "in_progress")


def completed_job(w, hours="2", used="3", complete=True, approve_report=True):
    s = new_job(w)
    if used:
        r = reqs.add_requirement(w.tech, s.id, {"item_id": w.oil.id, "quantity": "5", "purpose": "Oil change"})
        reqs.submit_requirements(w.tech, s.id)
        reqs.approve(w.admin, r.id)
        reqs.issue(w.admin, r.id)
        reqs.record_usage(w.tech, r.id, used)  # 5 issued, only `used` consumed
    if complete:
        s = svc.complete_service(w.tech, s.id, {"diagnosis": "Loose terminal", "work_performed": "Tightened and tested",
                                                 "labor_hours": hours, "actual_completion": local_today()})
        if approve_report:
            svc.approve_completion_report(w.admin, s.id)
    return s


def issued_invoice(w, hours="2", used="3", discount=None):
    s = completed_job(w, hours, used)
    i = bill.create_draft(w.admin, s.id)
    if discount:
        bill.set_terms(w.admin, i.id, discount, "Loyal customer", "18")
    return bill.issue_invoice(w.admin, i.id)


# ------------------------------------------------------------------ money maths
def test_totals_formula_and_rounding():
    t = bm.compute_totals("1000", "100", "18")
    assert (t["taxable"], t["tax_amount"], t["total"]) == (D("900.00"), D("162.00"), D("1062.00"))
    assert bm.compute_totals("33.33", "0", "18")["tax_amount"] == D("6.00")  # 5.9994 rounds to 6.00
    assert bm.compute_totals("0.05", "0", "10")["tax_amount"] == D("0.01")  # half-up, not banker's rounding
    assert bm.compute_totals("100", "0", "18", apply_tax=False)["total"] == D("100.00")
    assert bm.line_total("2.5", "19.99") == D("49.98")
    for args in (("100", "101", "18"), ("100", "-1", "18"), ("-5", "0", "18")):
        with pytest.raises(ValidationError):
            bm.compute_totals(*args)


# ------------------------------------------------------------------ estimates
EST = {"labor_hours": "2", "parts_amount": "450", "other_amount": "100", "other_description": "Transport", "apply_tax": True}


def test_estimate_totals_are_computed_by_the_server(w):
    s = new_job(w)
    e = est.create_estimate(w.tech, s.id, {**EST, "total": "1", "subtotal": "1", "tax_amount": "1"})  # client totals ignored
    assert (e.labor_amount, e.subtotal, e.tax_rate, e.tax_amount, e.total) == \
           (D("1000.00"), D("1550.00"), D("18.00"), D("279.00"), D("1829.00"))
    assert e.status == "draft" and e.version == 1 and e.labor_rate == D("500.00")
    assert est.create_estimate  # noqa
    no_tax = est.update_estimate(w.tech, e.id, {**EST, "apply_tax": False})
    assert no_tax.tax_amount == 0 and no_tax.total == D("1550.00")


def test_only_draft_estimates_can_be_deleted_and_deletion_is_audited(w):
    service = new_job(w)
    draft = est.create_estimate(w.tech, service.id, EST)

    deleted_service = est.delete_draft(w.tech, draft.id)

    assert deleted_service.id == service.id
    assert db.session.get(ServiceEstimate, draft.id) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "estimate.delete_draft", AuditLog.entity_id == str(draft.id)))

    approved = est.create_estimate(w.tech, service.id, EST)
    est.approve_estimate(w.admin, approved.id)
    with pytest.raises(ValidationError, match="Only a draft estimate"):
        est.delete_draft(w.admin, approved.id)
    assert db.session.get(ServiceEstimate, approved.id) is not None


def test_estimate_permissions_and_discount_authority(w):
    s = new_job(w)
    with pytest.raises(PermissionDenied):
        est.create_estimate(w.tech2, s.id, EST)  # not assigned
    with pytest.raises(PermissionDenied):
        est.create_estimate(w.desk, s.id, EST)  # creator but not on the job
    with pytest.raises(PermissionDenied):
        est.create_estimate(w.tech, s.id, {**EST, "discount": "50", "discount_reason": "friend"})
    with pytest.raises(ValidationError):
        est.create_estimate(w.admin, s.id, {**EST, "discount": "50"})  # reason needed
    e = est.create_estimate(w.admin, s.id, {**EST, "discount": "150", "discount_reason": "Loyal customer"})
    assert e.discount == D("150.00") and e.total == D("1652.00")  # (1550-150)*1.18
    with pytest.raises(PermissionDenied):
        est.update_estimate(w.tech, e.id, {**EST, "discount": "0"})  # staff cannot remove an admin discount either
    with pytest.raises(ValidationError):
        est.create_estimate(w.admin, s.id, EST)  # a draft already exists


def test_estimate_lifecycle_versions_and_customer_approval(w):
    s = new_job(w)
    e = est.create_estimate(w.tech, s.id, EST)
    with pytest.raises(ValidationError):
        est.record_customer_decision(w.tech, e.id, "approved", "Mr Rao", "phone")  # admin has not approved
    with pytest.raises(PermissionDenied):
        est.approve_estimate(w.tech, e.id)
    est.approve_estimate(w.admin, e.id)
    with pytest.raises(ValidationError):
        est.update_estimate(w.admin, e.id, EST)  # approved estimates are frozen
    with pytest.raises(PermissionDenied):
        est.record_customer_decision(w.tech2, e.id, "approved", "Mr Rao", "phone")
    for bad in (("approved", "", "phone"), ("approved", "Mr Rao", "carrier-pigeon"), ("maybe", "Mr Rao", "phone"),
                ("rejected", "Mr Rao", "phone")):
        with pytest.raises(ValidationError):
            est.record_customer_decision(w.tech, e.id, *bad)
    e = est.record_customer_decision(w.tech, e.id, "approved", "Mr Rao", "phone", "Confirmed on call")
    assert (e.status, e.customer_decided_by, e.customer_method, e.customer_recorded_by_id) == \
           ("customer_approved", "Mr Rao", "phone", w.tech.id) and e.customer_decided_at
    e2 = est.create_estimate(w.tech, s.id, {**EST, "labor_hours": "3"})  # revision
    db.session.refresh(e)
    assert e2.version == 2 and e.status == "superseded" and e2.status == "draft"
    est.approve_estimate(w.admin, e2.id)
    e2 = est.record_customer_decision(w.admin, e2.id, "rejected", "Mr Rao", "in_person", "Too expensive")
    assert e2.status == "rejected" and "Too expensive" in e2.rejection_reason


def test_reject_needs_reason_and_estimate_tax_is_a_snapshot(w):
    s = new_job(w)
    e = est.create_estimate(w.tech, s.id, EST)
    settings_service.save(w.admin, {**settings_service.get_all(), "tax_rate": "5"})
    assert db.session.get(type(e), e.id).tax_rate == D("18.00")  # later settings changes do not rewrite history
    with pytest.raises(ValidationError):
        est.reject_estimate(w.admin, e.id, "no")
    assert est.reject_estimate(w.admin, e.id, "Quote is incomplete").status == "rejected"
    assert est.create_estimate(w.tech, s.id, EST).tax_rate == D("5.00")  # a new estimate uses the new rate


# ------------------------------------------------------------------ invoices
def test_invoice_built_from_actual_labor_and_used_parts(w):
    s = completed_job(w, hours="2", used="3")
    with pytest.raises(PermissionDenied):
        bill.create_draft(w.tech, s.id)
    i = bill.create_draft(w.admin, s.id)
    kinds = {x.item_type: x for x in i.items}
    assert kinds["labor"].quantity == D("2.00") and kinds["labor"].line_total == D("1000.00")
    assert kinds["part"].quantity == D("3.000") and kinds["part"].line_total == D("1350.00")  # used 3, not the 5 issued
    assert (i.subtotal, i.tax_amount, i.total) == (D("2350.00"), D("423.00"), D("2773.00"))
    assert i.status == "draft" and i.invoice_number is None


def test_invoice_requires_completed_job_and_is_unique_per_job(w):
    open_job = new_job(w)
    with pytest.raises(ValidationError):
        bill.create_draft(w.admin, open_job.id)
    s = completed_job(w)
    i = bill.create_draft(w.admin, s.id)
    with pytest.raises(ValidationError):
        bill.create_draft(w.admin, s.id)
    dup = Invoice(service_request_id=s.id, active_service_id=s.id, status="draft", created_by_id=w.admin.id)
    db.session.add(dup)
    with pytest.raises(IntegrityError):  # the database itself refuses a second live invoice
        db.session.flush()
    db.session.rollback()
    assert i.id


def test_invoice_requires_current_manager_approved_service_report(w):
    s = completed_job(w, approve_report=False)
    with pytest.raises(ValidationError, match="manager must approve"):
        bill.create_draft(w.admin, s.id)

    svc.approve_completion_report(w.admin, s.id)
    draft = bill.create_draft(w.admin, s.id)
    svc.override_status(w.admin, s.id, "in_progress", "Reopen to correct report")
    with pytest.raises(ValidationError, match="manager must approve"):
        bill.issue_invoice(w.admin, draft.id)


def test_service_report_submitter_cannot_approve_their_own_report(w):
    s = new_job(w)
    svc.complete_service(w.admin, s.id, {
        "diagnosis": "Loose terminal", "work_performed": "Tightened and tested",
        "labor_hours": "1", "actual_completion": local_today(),
    })
    with pytest.raises(ValidationError, match="cannot approve it"):
        svc.approve_completion_report(w.admin, s.id)
    w.tech.permission_codes().add("service.report_approve")
    assert svc.approve_completion_report(w.tech, s.id).report_approved_by_id == w.tech.id


def test_acceptance_totals_example(w):
    """labor 2h x 500 + parts 3 x 450 + other 200 = 2550; minus 150 discount = 2400; 18% tax = 432; total 2832."""
    s = completed_job(w, hours="2", used="3")
    i = bill.create_draft(w.admin, s.id)
    bill.add_item(w.admin, i.id, "Crane hire", "1", "200")
    bill.set_terms(w.admin, i.id, "150", "Loyal customer", "18")
    i = db.session.get(Invoice, i.id)
    assert (i.subtotal, i.discount, i.tax_amount, i.total) == (D("2550.00"), D("150.00"), D("432.00"), D("2832.00"))
    assert (i.subtotal_of("labor"), i.subtotal_of("part"), i.subtotal_of("other")) == (D("1000.00"), D("1350.00"), D("200.00"))


def test_draft_editing_rules_and_recalculation(w):
    s = completed_job(w)
    i = bill.create_draft(w.admin, s.id)
    part = next(x for x in i.items if x.item_type == "part")
    bill.update_item(w.admin, i.id, part.id, "2", "500")
    assert db.session.get(Invoice, i.id).subtotal == D("2000.00")  # 1000 labor + 2 x 500
    with pytest.raises(ValidationError):
        bill.set_terms(w.admin, i.id, "5000", "too big", "18")  # discount > subtotal
    assert db.session.get(Invoice, i.id).discount == 0  # and nothing was half-applied
    with pytest.raises(ValidationError):
        bill.set_terms(w.admin, i.id, "100", "", "18")  # reason missing
    with pytest.raises(ValidationError):
        bill.add_item(w.admin, i.id, "Bad", "0", "10")
    with pytest.raises(ValidationError):
        bill.add_item(w.admin, i.id, "Bad", "1", "-10")
    with pytest.raises(PermissionDenied):
        bill.add_item(w.tech, i.id, "Free labour", "1", "0")
    bill.set_terms(w.admin, i.id, "1500", "Special deal", "18")  # valid while parts are on the invoice
    with pytest.raises(ValidationError):
        bill.delete_item(w.admin, i.id, part.id)  # would leave discount 1500 > subtotal 1000
    i = db.session.get(Invoice, i.id)
    assert len(i.items) == 2 and i.subtotal == D("2000.00") and i.discount == D("1500.00")  # unchanged after the refusal
    bill.set_terms(w.admin, i.id, "0", "", "18")
    bill.delete_item(w.admin, i.id, part.id)
    assert db.session.get(Invoice, i.id).subtotal == D("1000.00")


def test_issue_assigns_number_and_freezes(w):
    first = issued_invoice(w)
    year = local_today().year
    assert first.invoice_number == f"INV-{year}-0001" and first.status == "issued"
    assert first.due_date == local_today() + timedelta(days=15) and first.issued_by_id == w.admin.id
    for call in (lambda: bill.add_item(w.admin, first.id, "x", "1", "1"), lambda: bill.set_terms(w.admin, first.id, "0", "", "18"),
                 lambda: bill.issue_invoice(w.admin, first.id), lambda: bill.discard_draft(w.admin, first.id)):
        with pytest.raises(ValidationError):
            call()
    assert issued_invoice(w).invoice_number == f"INV-{year}-0002"
    empty_job = completed_job(w, hours="0", used=None)
    empty = bill.create_draft(w.admin, empty_job.id)
    with pytest.raises(ValidationError):
        bill.issue_invoice(w.admin, empty.id)  # nothing to bill


def test_discard_draft_and_zero_value_invoice(w):
    s = completed_job(w, hours="1", used="1")
    i = bill.create_draft(w.admin, s.id)
    bill.discard_draft(w.admin, i.id)
    assert db.session.get(Invoice, i.id) is None
    i = bill.create_draft(w.admin, s.id)  # warranty job: everything free
    for x in list(i.items):
        bill.update_item(w.admin, i.id, x.id, x.quantity, "0")
    i = bill.issue_invoice(w.admin, i.id)
    assert i.total == 0 and i.status == "paid" and i.balance == 0


# ------------------------------------------------------------------ payments
def test_partial_then_full_payment(w):
    i = issued_invoice(w)  # total 2773.00
    p1 = bill.record_payment(w.admin, i.id, "payment", "1000", "upi", "UPI-1")
    assert p1.number.startswith("RCT-") and i.status == "partial" and i.amount_paid == D("1000.00") and i.balance == D("1773.00")
    p2 = bill.record_payment(w.admin, i.id, "payment", "1773", "cash")
    assert i.status == "paid" and i.balance == 0 and p2.number != p1.number
    assert [p.amount for p in i.payments] == [D("1000.00"), D("1773.00")]


def test_overpayment_and_bad_input_rejected(w):
    i = issued_invoice(w)
    for args in (("payment", "2773.01", "cash"), ("payment", "0", "cash"), ("payment", "-5", "cash"),
                 ("payment", "abc", "cash"), ("payment", "100", "barter"), ("payment", "100", None), ("gift", "100", "cash")):
        with pytest.raises(ValidationError):
            bill.record_payment(w.admin, i.id, *args)
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, i.id, "payment", "100", "cash", paid_at_local=local_now() + timedelta(days=2))
    bill.record_payment(w.admin, i.id, "payment", "2000", "cash")
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, i.id, "payment", "800", "cash")  # only 773 outstanding
    assert i.amount_paid == D("2000.00") and db.session.query(Payment).count() == 1


def test_only_authorised_users_record_money(w):
    i = issued_invoice(w)
    for actor in (w.tech, w.desk):
        with pytest.raises(PermissionDenied):
            bill.record_payment(actor, i.id, "payment", "100", "cash")
        with pytest.raises(PermissionDenied):
            bill.void_invoice(actor, i.id, "let me void this")


def test_refund_and_adjustment_rules(w):
    i = issued_invoice(w)
    bill.record_payment(w.admin, i.id, "payment", "2773", "bank_transfer")
    assert i.status == "paid"
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, i.id, "refund", "100", "cash")  # reason missing
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, i.id, "refund", "3000", "cash", reason="Customer overcharged")  # more than received
    r = bill.record_payment(w.admin, i.id, "refund", "500", "cash", reason="Part returned unused")
    assert r.number.startswith("REF-") and i.amount_paid == D("2273.00") and i.status == "partial" and i.balance == D("500.00")
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, i.id, "adjustment", "600", reason="Goodwill write-off")  # more than the balance
    a = bill.record_payment(w.admin, i.id, "adjustment", "500", reason="Goodwill write-off agreed with customer")
    assert a.number.startswith("ADJ-") and i.adjustment_total == D("500.00") and i.status == "paid" and i.balance == 0


def test_payments_are_append_only_and_balance_is_reverified(w):
    i = issued_invoice(w)
    p = bill.record_payment(w.admin, i.id, "payment", "1000", "cash")
    p.amount = D("1")
    with pytest.raises(RuntimeError):
        db.session.flush()
    db.session.rollback()
    i = db.session.get(Invoice, i.id)
    i.amount_paid = D("2500.00")  # simulate a corrupted cached figure
    db.session.commit()
    bill.record_payment(w.admin, i.id, "payment", "100", "cash")
    assert db.session.get(Invoice, i.id).amount_paid == D("1100.00")  # rebuilt from the real payment records


def test_cannot_pay_draft_or_void(w):
    s = completed_job(w)
    d = bill.create_draft(w.admin, s.id)
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, d.id, "payment", "10", "cash")
    d = bill.issue_invoice(w.admin, d.id)
    bill.void_invoice(w.admin, d.id, "Issued by mistake")
    with pytest.raises(ValidationError):
        bill.record_payment(w.admin, d.id, "payment", "10", "cash")


def test_void_rules_and_reissue(w):
    i = issued_invoice(w)
    number = i.invoice_number
    with pytest.raises(ValidationError):
        bill.void_invoice(w.admin, i.id, "no")
    bill.record_payment(w.admin, i.id, "payment", "100", "cash")
    with pytest.raises(ValidationError):
        bill.void_invoice(w.admin, i.id, "Wrong customer billed")  # money held
    bill.record_payment(w.admin, i.id, "refund", "100", "cash", reason="Refund before void")
    bill.void_invoice(w.admin, i.id, "Wrong customer billed")
    assert i.status == "void" and i.active_service_id is None and i.invoice_number == number
    new = bill.create_draft(w.admin, i.service_request_id)  # job can be billed again
    new = bill.issue_invoice(w.admin, new.id)
    assert new.invoice_number != number  # voided numbers are never reused


def test_completed_is_not_paid_and_payment_status_filter(w):
    s = completed_job(w)
    assert s.status == "completed"
    fin = bill.service_financials(s)
    assert fin["payment_status"] == "No invoice" and fin["balance"] is None
    ids = lambda **kw: [r.id for r in db.session.scalars(svc.search_services(w.admin, **kw))]
    assert ids(payment="none") == [s.id] and ids(payment="paid") == []
    i = bill.issue_invoice(w.admin, bill.create_draft(w.admin, s.id).id)
    assert bill.service_financials(s)["payment_status"] == "Unpaid" and ids(payment="unpaid") == [s.id]
    bill.record_payment(w.admin, i.id, "payment", "100", "cash")
    assert bill.service_financials(s)["payment_status"] == "Partially paid" and ids(payment="partial") == [s.id]
    bill.record_payment(w.admin, i.id, "payment", i.balance, "cash")
    assert bill.service_financials(s)["payment_status"] == "Paid" and ids(payment="paid") == [s.id]
    assert [r.id for r in db.session.scalars(svc.search_services(w.tech, payment="none"))] == [s.id]  # staff: filter ignored


def test_invoice_search_and_outstanding_summary(w):
    a = issued_invoice(w)
    b = issued_invoice(w)
    bill.record_payment(w.admin, b.id, "payment", b.total, "cash")
    assert bill.outstanding_summary() == {"amount": a.total, "count": 1}
    find = lambda **kw: [x.id for x in db.session.scalars(bill.search_invoices(**kw))]
    assert find(outstanding=True) == [a.id] and find(status="paid") == [b.id]
    assert find(q=a.invoice_number) == [a.id] and find(q="Acme") and find(q="GEN-SRV") and not find(q="nobody")
    assert find(q="987 654 3210") == [b.id, a.id]
    assert find(q="SN-1001") == [b.id, a.id]
    assert find(q="CUMMINS") == [b.id, a.id]
    a.due_date = local_today() - timedelta(days=1)
    db.session.commit()
    assert find(overdue=True) == [a.id] and a.is_overdue


# ------------------------------------------------------------------ settings
def test_settings_validation_and_permissions(w):
    good = settings_service.get_all()
    with pytest.raises(PermissionDenied):
        settings_service.save(w.tech, good)
    for bad in ({"tax_rate": "101"}, {"tax_rate": "x"}, {"labor_rate_per_hour": "-1"}, {"payment_terms_days": "400"},
                {"company_name": ""}, {"currency_code": ""}):
        with pytest.raises(ValidationError):
            settings_service.save(w.admin, {**good, **bad})
    settings_service.save(w.admin, {**good, "company_name": "Himalaya Power", "labor_rate_per_hour": "650"})
    assert settings_service.get("company_name") == "Himalaya Power" and settings_service.get_decimal("labor_rate_per_hour") == D("650.00")


def _png(name="logo.png"):
    buf = io.BytesIO()
    Image.new("RGB", (120, 60), (200, 100, 0)).save(buf, "PNG")
    return FileStorage(stream=io.BytesIO(buf.getvalue()), filename=name)


def test_logo_upload_rules(w):
    with pytest.raises(PermissionDenied):
        settings_service.save_logo(w.tech, _png())
    with pytest.raises(ValidationError):
        settings_service.save_logo(w.admin, FileStorage(stream=io.BytesIO(b"<svg/>"), filename="logo.svg"))
    with pytest.raises(ValidationError):
        settings_service.save_logo(w.admin, FileStorage(stream=io.BytesIO(b"not an image"), filename="logo.png"))
    settings_service.save_logo(w.admin, _png())
    assert settings_service.logo_path() and os.path.isfile(settings_service.logo_path())


# ------------------------------------------------------------------ PDFs
def text_of(pdf_bytes):
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(page.extract_text() for page in reader.pages)


def test_invoice_pdf_contents(w):
    settings_service.save(w.admin, {**settings_service.get_all(), "company_name": "Himalaya Power Solutions",
                                    "company_address": "12 Rajpur Road, Dehradun", "company_tax_id": "05ABCDE1234F1Z5"})
    settings_service.save_logo(w.admin, _png())
    i = issued_invoice(w, discount="150")
    bill.record_payment(w.admin, i.id, "payment", "1000", "upi", "UPI-77")
    data = pdf_service.build_invoice(i)
    assert data.startswith(b"%PDF")
    text = text_of(data)
    for expected in ("Himalaya Power Solutions", i.invoice_number, i.service.service_id, "Acme Mills", "Cummins C100",
                     "SN-1001", "Engine oil", "Partially paid", "Ks 2,596.00", "BALANCE DUE", "Ks 1,596.00", "05ABCDE1234F1Z5", "18%"):
        assert expected in text, expected


def test_draft_invoice_and_receipt_pdfs(w):
    s = completed_job(w)
    draft = bill.create_draft(w.admin, s.id)
    assert "DRAFT" in text_of(pdf_service.build_invoice(draft))
    i = bill.issue_invoice(w.admin, draft.id)
    p = bill.record_payment(w.admin, i.id, "payment", "500", "cash", "Counter")
    r = text_of(pdf_service.build_receipt(p))
    for expected in (p.number, "PAYMENT RECEIPT", i.invoice_number, "Acme Mills", "Ks 500.00", "Balance due"):
        assert expected in r, expected
    refund = bill.record_payment(w.admin, i.id, "refund", "100", "cash", reason="Part returned unused")
    assert "REFUND VOUCHER" in text_of(pdf_service.build_receipt(refund))


def test_service_report_pdf_hides_money_from_staff(w):
    s = completed_job(w)
    bill.issue_invoice(w.admin, bill.create_draft(w.admin, s.id).id)
    staff_text = text_of(pdf_service.build_service_report(s, include_financials=False))
    admin_text = text_of(pdf_service.build_service_report(s, include_financials=True))
    assert "100 kVA" in staff_text and "100.00 kVA" not in staff_text  # no stray trailing zeros
    for expected in (s.service_id, "SERVICE REPORT", "Acme Mills", "Loose terminal", "Tightened and tested", "Tara Tech", "Engine oil"):
        assert expected in staff_text, expected
    assert "Costs and payment" not in staff_text and "Ks " not in staff_text
    assert "Costs and payment" in admin_text and "Unpaid" in admin_text and "Ks 2,773.00" in admin_text


def test_pdf_survives_awkward_text(w):
    w.cust.name = "A & B <Traders> \u0930\u093e\u092e"
    s = completed_job(w)
    db.session.commit()
    i = bill.issue_invoice(w.admin, bill.create_draft(w.admin, s.id).id)
    text = text_of(pdf_service.build_invoice(i))
    assert "A & B <Traders>" in text  # markup characters are escaped, never interpreted


# ------------------------------------------------------------------ MySQL-only race test
MYSQL_URL = os.environ.get("TEST_MYSQL_URL")


@pytest.mark.skipif(not MYSQL_URL, reason="Set TEST_MYSQL_URL to run the MySQL concurrency test")
def test_concurrent_payments_cannot_overpay_on_mysql():
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
        admin = User(staff_code="STF-0001", full_name="A", email="a@example.com",
                     role=db.session.scalar(select(Role).where(Role.name == "admin")))
        admin.set_password("Str0ngPassw0rd")
        db.session.add(admin)
        db.session.commit()
        cust = customer_service.create_customer(admin, {"name": "Race Co", "phone_primary": "9999999999"})
        gen = generator_service.create_generator(admin, cust.id, {"brand": "B", "model": "M", "serial_number": "RACE-001", "capacity_kva": "10"})
        s = svc.create_service_request(admin, {"customer_id": cust.id, "generator_id": gen.id, "complaint": "Race test",
                                               "service_type_id": db.session.scalar(select(ServiceType.id)),
                                               "priority_id": db.session.scalar(select(Priority.id))})
        s.status = "completed"
        db.session.commit()
        svc.approve_completion_report(admin, s.id)
        i = Invoice(service_request_id=s.id, active_service_id=s.id, status="draft", created_by_id=admin.id, tax_rate=0)
        db.session.add(i)
        db.session.commit()
        bill.add_item(admin, i.id, "Service", "1", "100")
        bill.issue_invoice(admin, i.id)
        admin_id, inv_id = admin.id, i.id
    ok, failed = [], []

    def worker():
        try:
            with app.app_context():
                bill.record_payment(db.session.get(User, admin_id), inv_id, "payment", "30", "cash")
                ok.append(1)
        except ValidationError:
            failed.append(1)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    with app.app_context():
        paid = db.session.get(Invoice, inv_id).amount_paid
        db.drop_all()
    assert len(ok) == 3 and len(failed) == 7 and paid == D("90.00")  # 3 x 30 fits in 100; the rest are refused
