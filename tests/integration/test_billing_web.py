import io
from datetime import timedelta

from PIL import Image
from sqlalchemy import select

from app.extensions import db
from app.models import Customer, Generator, Invoice, Payment, Priority, ServiceEstimate, ServiceRequest, ServiceType
from app.services import customer_service, generator_service, inventory_service as inv, requirement_service as reqs
from app.services import service_request_service as svc
from app.utils.time import local_now, local_today
from tests.conftest import login


def switch(client, email):
    client.post("/auth/logout")
    return login(client, email)


def make_job(w):
    cust = customer_service.create_customer(w["desk"], {"name": "Acme Mills", "phone_primary": "9876543210"})
    gen = generator_service.create_generator(w["desk"], cust.id, {"brand": "Cummins", "model": "C100",
                                                                   "serial_number": "SN-1001", "capacity_kva": "100"})
    s = svc.create_service_request(w["desk"], {"customer_id": cust.id, "generator_id": gen.id, "complaint": "Trips on load",
                                               "service_type_id": db.session.scalar(select(ServiceType.id)),
                                               "priority_id": db.session.scalar(select(Priority.id))})
    svc.assign_technicians(w["admin"], s.id, [w["tech"].id], w["tech"].id)
    svc.schedule_visit(w["admin"], s.id, local_now() + timedelta(days=1))
    return svc.change_status(w["tech"], s.id, "in_progress")


def world(make_user):
    return {"admin": make_user("admin@example.com", "admin"), "tech": make_user("tech@example.com", "staff", name="Tara Tech"),
            "desk": make_user("desk@example.com", "staff"), "other": make_user("other@example.com", "staff")}


def test_estimate_to_payment_through_the_web(client, make_user):
    w = world(make_user)
    oil = inv.create_item(w["admin"], {"name": "Engine oil", "unit": "litre", "opening_stock": "20", "selling_price": "450"})
    s = make_job(w)

    # technician drafts an estimate; the server decides every total
    login(client, "tech@example.com")
    assert b"New estimate" in client.get(f"/services/{s.id}").data
    assert b"Create invoice" not in client.get(f"/services/{s.id}").data  # no invoice controls for staff
    assert b"discount" not in client.get(f"/estimates/new?service={s.id}").data.lower()  # staff cannot discount
    resp = client.post("/estimates/new", data={"service": s.id, "labor_hours": "2", "parts_amount": "450",
                                                "other_amount": "100", "apply_tax": "y", "total": "1"})
    assert resp.status_code == 302
    e = db.session.scalar(select(ServiceEstimate))
    assert (e.subtotal, e.total) == (1550, 1829)
    quotation = client.get(f"/estimates/{e.id}/quotation.pdf")
    assert quotation.status_code == 200 and quotation.mimetype == "application/pdf"
    assert quotation.data.startswith(b"%PDF")
    own_quotes = client.get("/estimates/")
    assert own_quotes.status_code == 200 and s.service_id.encode() in own_quotes.data

    # admin approves; technician records the customer's phone approval
    switch(client, "admin@example.com")
    assert b"Estimate" in client.get("/estimates/").data and s.service_id.encode() in client.get("/estimates/").data
    client.post(f"/estimates/{e.id}/approve")
    switch(client, "tech@example.com")
    client.post(f"/estimates/{e.id}/customer", data={"decision": "approved", "name": "Mr Rao", "method": "phone", "note": ""})
    db.session.refresh(e)
    assert e.status == "customer_approved" and e.customer_decided_by == "Mr Rao"
    page = client.get(f"/estimates/{e.id}").data
    assert b"Mr Rao" in page and b"Phone call" in page

    # materials, then the technician completes the job
    r = reqs.add_requirement(w["tech"], s.id, {"item_id": oil.id, "quantity": "3"})
    reqs.submit_requirements(w["tech"], s.id)
    reqs.approve(w["admin"], r.id)
    reqs.issue(w["admin"], r.id)
    reqs.record_usage(w["tech"], r.id, "3")
    client.post(f"/services/{s.id}/complete", data={"diagnosis": "Loose terminal", "work_performed": "Tightened and tested",
                                                      "labor_hours": "2", "actual_completion": local_today().isoformat()})
    db.session.refresh(s)
    assert s.status == "completed"

    # staff can print the service report, but without any money
    pdf = client.get(f"/services/{s.id}/report.pdf")
    assert pdf.status_code == 200 and pdf.mimetype == "application/pdf" and pdf.data.startswith(b"%PDF")
    assert client.get("/invoices/").status_code == 403
    assert client.post(f"/invoices/from-service/{s.id}").status_code == 403

    # admin invoices the job, edits the draft, issues it and takes payments
    switch(client, "admin@example.com")
    page = client.get(f"/services/{s.id}").data
    assert b"Payment status: No invoice" in page and b"does not mean it has been paid" in page
    blocked = client.post(f"/invoices/from-service/{s.id}", follow_redirects=True)
    assert b"manager must approve the service delivery report" in blocked.data
    assert db.session.query(Invoice).count() == 0
    approved = client.post(
        f"/services/{s.id}/report/approve",
        data={"note": "Reviewed and approved"},
        follow_redirects=True,
    )
    assert b"Reviewed and approved" in approved.data
    assert client.post(f"/invoices/from-service/{s.id}").status_code == 302
    i = db.session.scalar(select(Invoice))
    assert i.status == "draft" and i.total == 1829
    draft_list = client.get("/invoices/")
    assert b"Delete draft" in draft_list.data and f"/invoices/{i.id}/discard".encode() in draft_list.data
    client.post(f"/invoices/{i.id}/items", data={"description": "Crane hire", "quantity": "1", "unit_price": "200", "item_type": "other"})
    client.post(f"/invoices/{i.id}/terms", data={"discount": "150", "discount_reason": "Loyal customer", "tax_rate": "18"})
    db.session.refresh(i)
    assert (i.subtotal, i.discount, i.total) == (1750, 150, 1888)
    assert b"Estimate v1 vs final" in client.get(f"/invoices/{i.id}").data
    client.post(f"/invoices/{i.id}/issue")
    db.session.refresh(i)
    assert i.status == "issued" and i.invoice_number.startswith("INV-")
    assert b'value="customer_credit"' not in client.get(f"/invoices/{i.id}").data
    invoice_list = client.get("/invoices/")
    assert invoice_list.status_code == 200 and b"Partially paid" in invoice_list.data
    for query in (i.invoice_number, s.service_id, "Acme Mills", "987 654 3210", "SN-1001"):
        assert i.display_number.encode() in client.get(f"/invoices/?q={query.replace(' ', '+')}").data
    assert i.display_number.encode() in client.get("/invoices/?status=issued").data
    assert i.display_number.encode() not in client.get("/invoices/?status=paid").data
    assert client.post(f"/invoices/{i.id}/items", data={"description": "Sneaky", "quantity": "1", "unit_price": "1"},
                       follow_redirects=True).data.count(b"cannot be edited") >= 1

    bad = client.post(f"/invoices/{i.id}/payments", data={"kind": "payment", "amount": "99999", "method": "cash"}, follow_redirects=True)
    assert b"exceeds the outstanding balance" in bad.data and db.session.query(Payment).count() == 0
    client.post(f"/invoices/{i.id}/payments", data={"kind": "payment", "amount": "1000", "method": "upi", "reference": "UPI-9"})
    db.session.refresh(i)
    assert i.status == "partial" and i.balance == 888
    assert b"Payment status: Partially paid" in client.get(f"/services/{s.id}").data
    assert s.service_id.encode() in client.get("/services/?payment=partial").data
    assert s.service_id.encode() not in client.get("/services/?payment=paid").data
    assert b"888.00" in client.get("/invoices/?outstanding=1").data

    inv_pdf = client.get(f"/invoices/{i.id}/pdf")
    assert inv_pdf.status_code == 200 and inv_pdf.data.startswith(b"%PDF")
    pay = db.session.scalar(select(Payment))
    assert client.get(f"/invoices/payments/{pay.id}/receipt.pdf").data.startswith(b"%PDF")

    client.post(f"/invoices/{i.id}/payments", data={"kind": "payment", "amount": "888", "method": "cash"})
    db.session.refresh(i)
    assert i.status == "paid" and i.balance == 0
    assert b"Payment status: Paid" in client.get(f"/services/{s.id}").data
    receipt_register = client.get("/finance/receipts")
    assert receipt_register.status_code == 200 and b"RCT-" in receipt_register.data
    assert client.get("/finance/receipts.csv").status_code == 200
    cash_ledger = client.get("/finance/cash")
    assert cash_ledger.status_code == 200 and b"888.00" in cash_ledger.data
    financial_report = client.get("/reports/?type=financial")
    assert financial_report.status_code == 200 and b"1,888.00" in financial_report.data


def test_standalone_quotation_acceptance_creates_one_job_order(client, make_user):
    w = world(make_user)
    make_user("operations@example.com", role="operations")
    customer = customer_service.create_customer(w["desk"], {
        "name": "Standalone Quote Customer", "phone_primary": "9876543210",
        "contact_person": "Ms Customer",
    })
    generator = generator_service.create_generator(w["desk"], customer.id, {
        "brand": "Cummins", "model": "C200", "serial_number": "SN-2002", "capacity_kva": "200",
    })
    service_type = db.session.scalar(select(ServiceType))
    priority = db.session.scalar(select(Priority))

    login(client, "desk@example.com")
    response = client.get("/estimates/new")
    assert response.status_code == 200 and b"Create a quotation" in response.data
    response = client.post("/estimates/new", data={
        "customer_id": customer.id, "generator_id": generator.id,
        "service_type_id": service_type.id, "priority_id": priority.id,
        "complaint": "Generator stops under full load", "location": "Customer site",
        "labor_hours": "2", "parts_amount": "300", "other_amount": "50",
        "other_description": "Travel", "apply_tax": "y", "notes": "Offer valid for 30 days",
    })
    assert response.status_code == 302
    quotation = db.session.scalar(select(ServiceEstimate))
    assert quotation.service is None and quotation.quotation_number.startswith("QT-")
    assert quotation.total == 1593
    detail_page = client.get(f"/estimates/{quotation.id}")
    assert b'data-print-page' in detail_page.data and b'onclick="window.print()"' not in detail_page.data
    assert "script-src 'self'" in detail_page.headers["Content-Security-Policy"]
    assert b"window.print()" in client.get("/static/js/app.js").data
    assert b".global-search" in client.get("/static/css/app.css").data
    pdf = client.get(f"/estimates/{quotation.id}/quotation.pdf")
    assert pdf.status_code == 200 and pdf.data.startswith(b"%PDF")

    switch(client, "admin@example.com")
    assert client.post(f"/estimates/{quotation.id}/approve").status_code == 302
    switch(client, "desk@example.com")
    accepted = client.post(f"/estimates/{quotation.id}/customer", data={
        "decision": "approved", "name": "Ms Customer", "method": "email", "note": "",
    })
    assert accepted.status_code == 302
    db.session.refresh(quotation)
    assert quotation.status == "customer_approved" and quotation.service is None

    switch(client, "operations@example.com")
    accepted_quotes = client.get("/estimates/")
    assert accepted_quotes.status_code == 200 and quotation.quotation_number.encode() in accepted_quotes.data
    created = client.post(f"/estimates/{quotation.id}/convert")
    assert created.status_code == 302
    db.session.refresh(quotation)
    job = quotation.service
    assert job is not None and job.source_quotation_number == quotation.quotation_number
    assert job.customer_id == customer.id and job.generator_id == generator.id
    repeated = client.post(f"/estimates/{quotation.id}/convert")
    db.session.refresh(quotation)
    assert repeated.status_code == 302 and quotation.service.id == job.id



def test_other_staff_and_anonymous_cannot_reach_documents(client, make_user, app):
    w = world(make_user)
    s = make_job(w)
    login(client, "other@example.com")  # staff not on this job
    assert client.get(f"/services/{s.id}/report.pdf").status_code == 404
    assert client.get(f"/estimates/new?service={s.id}").status_code == 404
    assert client.get("/invoices/1/pdf").status_code == 403
    assert client.get("/invoices/payments/1/receipt.pdf").status_code == 403
    assert client.get("/settings/").status_code == 403
    client.post("/auth/logout")
    from flask import g
    g.pop("_login_user", None)
    anon = app.test_client()
    for url in (f"/services/{s.id}/report.pdf", "/invoices/", "/invoices/1/pdf", "/settings/logo"):
        assert anon.get(url).status_code == 302, url


def test_settings_page_and_logo(client, make_user):
    w = world(make_user)
    login(client, "admin@example.com")
    assert client.get("/settings/").status_code == 200
    resp = client.post("/settings/", data={
        "company_name": "Himalaya Power", "company_address": "Dehradun", "company_phone": "0135 000000", "company_email": "",
        "company_tax_id": "05ABC", "currency_code": "INR", "currency_symbol": "x", "tax_name": "GST", "tax_rate": "12",
        "labor_rate_per_hour": "650", "payment_terms_days": "30", "invoice_footer": "Thanks"})
    assert resp.status_code == 302
    assert b"Himalaya Power" in client.get("/settings/").data
    bad = client.post("/settings/", data={"company_name": "X Co", "currency_code": "INR", "tax_rate": "500",
                                          "labor_rate_per_hour": "1", "payment_terms_days": "5"})
    assert bad.status_code == 200 and b"is-invalid" in bad.data
    buf = io.BytesIO()
    Image.new("RGB", (60, 30), (1, 2, 3)).save(buf, "PNG")
    up = client.post("/settings/logo", data={"logo": (io.BytesIO(buf.getvalue()), "logo.png")}, content_type="multipart/form-data")
    assert up.status_code == 302 and client.get("/settings/logo").mimetype == "image/png"
