import io

from flask import g
from PIL import Image
from sqlalchemy import select

from app.extensions import db
from app.models import (Attachment, AuditLog, Customer, Generator, Priority, ServiceRequest,
                        ServiceStatusHistory, ServiceType)
from app.services import service_request_service
from tests.conftest import login

CUST = {"name": "Sharma Textiles", "customer_type": "business", "phone_primary": "9876543210",
        "city": "Saharanpur", "state": "Uttar Pradesh", "contact_person": "Mr Sharma"}
GEN = {"brand": "Kirloskar", "model": "KG1-62.5", "serial_number": "KRL-77-1001", "capacity_kva": "62.5",
       "fuel_type": "diesel", "condition": "good", "installation_date": "2024-03-01"}


def png():
    buf = io.BytesIO()
    Image.new("RGB", (50, 40), (10, 90, 160)).save(buf, "PNG")
    return buf.getvalue()


def test_staff_registers_customer_then_generator(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    resp = client.post("/customers/new", data=CUST)
    assert resp.status_code == 302
    cust = db.session.scalar(select(Customer))
    assert cust.customer_code == "CUS-000001"

    page = client.get(f"/customers/{cust.id}")
    assert b"Sharma Textiles" in page.data and b"No generators registered yet" in page.data

    resp = client.post("/generators/new", data={**GEN, "customer_id": cust.id})
    assert resp.status_code == 302
    gen = db.session.scalar(select(Generator))
    assert gen.generator_code == "GEN-000001" and gen.customer_id == cust.id
    assert b"KRL-77-1001" in client.get(f"/generators/{gen.id}").data


def test_duplicate_warning_then_confirm(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    client.post("/customers/new", data=CUST)
    dup = {**CUST, "name": "Someone Else", "phone_primary": "+91 98765 43210"}
    resp = client.post("/customers/new", data=dup)
    assert resp.status_code == 200
    assert b"may already exist" in resp.data and b"Same primary phone" in resp.data
    assert db.session.query(Customer).count() == 1  # nothing saved yet
    resp = client.post("/customers/new", data={**dup, "confirm_duplicate": "1"})
    assert resp.status_code == 302 and db.session.query(Customer).count() == 2


def test_staff_cannot_edit_or_deactivate_but_can_view(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    client.post("/customers/new", data=CUST)
    cid = db.session.scalar(select(Customer.id))
    assert client.get(f"/customers/{cid}").status_code == 200
    assert client.get(f"/customers/{cid}/edit").status_code == 403
    assert client.post(f"/customers/{cid}/deactivate").status_code == 403
    assert client.post(f"/customers/{cid}/delete").status_code == 403
    assert client.get("/customers/duplicates").status_code == 403


def test_admin_edits_and_deactivates_customer_and_generator(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    client.post("/customers/new", data=CUST)
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": cust.id})
    gen = db.session.scalar(select(Generator))

    assert client.post(f"/customers/{cust.id}/edit", data={**CUST, "city": "Delhi"}).status_code == 302
    assert client.post(f"/generators/{gen.id}/edit", data={**GEN, "condition": "fair"}).status_code == 302
    db.session.refresh(cust); db.session.refresh(gen)
    assert cust.city == "Delhi" and gen.condition == "fair"

    client.post(f"/generators/{gen.id}/deactivate")
    client.post(f"/customers/{cust.id}/deactivate")
    db.session.refresh(cust); db.session.refresh(gen)
    assert not cust.is_active and not gen.is_active
    # inactive customer: new generator registration is refused with a clear message
    resp = client.post("/generators/new", data={**GEN, "serial_number": "KRL-77-2002", "customer_id": cust.id})
    assert resp.status_code == 200 and b"inactive" in resp.data
    assert b"Sharma Textiles" in client.get("/customers/?status=inactive").data


def test_unreferenced_customers_and_generators_can_be_deleted(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    assert b"Permanently delete customer" in client.get(f"/customers/{customer.id}").data
    response = client.post(f"/customers/{customer.id}/delete")
    assert response.status_code == 302
    assert db.session.get(Customer, customer.id) is None

    client.post("/customers/new", data={**CUST, "phone_primary": "9876543211"})
    customer = db.session.scalar(select(Customer).order_by(Customer.id.desc()))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    assert b"Permanently delete generator" in client.get(f"/generators/{generator.id}").data
    response = client.post(f"/generators/{generator.id}/delete")
    assert response.status_code == 302
    assert db.session.get(Generator, generator.id) is None
    assert client.post(f"/customers/{customer.id}/delete").status_code == 302
    assert db.session.get(Customer, customer.id) is None
    assert db.session.scalar(select(AuditLog).where(AuditLog.action == "customer.delete"))
    assert db.session.scalar(select(AuditLog).where(AuditLog.action == "generator.delete"))


def test_customer_with_generators_cannot_be_permanently_deleted(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})

    response = client.post(f"/customers/{customer.id}/delete", follow_redirects=True)
    assert b"Deactivate the customer instead" in response.data
    assert db.session.get(Customer, customer.id) is not None


def test_generator_delete_also_removes_untouched_linked_service_requests(client, make_user):
    admin = make_user("generator-cascade-admin@example.com", "admin")
    login(client, admin.email)
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Untouched generator service request",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    generator_id, service_id = generator.id, service.id

    response = client.post(f"/generators/{generator_id}/delete", follow_redirects=True)

    assert response.status_code == 200 and b"1 untouched service request" in response.data
    assert db.session.get(Generator, generator_id) is None
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.scalar(select(ServiceStatusHistory.id).where(
        ServiceStatusHistory.service_request_id == service_id)) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "service.delete_unstarted", AuditLog.entity_id == str(service_id)))
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "generator.delete", AuditLog.entity_id == str(generator_id)))


def test_service_list_shows_delete_only_for_untouched_requests(client, make_user):
    admin = make_user("service-list-delete@example.com", "admin")
    login(client, admin.email)
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Untouched request",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })

    url = f"/services/{service.id}/delete".encode()
    assert url in client.get("/services/").data

    service_request_service.add_event(service, "note", "Work started", admin)
    db.session.commit()
    assert url not in client.get("/services/").data


def test_generator_delete_is_blocked_atomically_when_linked_service_has_history(client, make_user):
    admin = make_user("generator-cascade-history-admin@example.com", "admin")
    login(client, admin.email)
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Service request with status history",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service_request_service.change_status(admin, service.id, "under_review", remarks="Reviewed")

    response = client.post(f"/generators/{generator.id}/delete", follow_redirects=True)

    assert response.status_code == 200 and b"No records were deleted" in response.data
    assert db.session.get(Generator, generator.id) is not None
    assert db.session.get(ServiceRequest, service.id) is not None


def test_admin_urgent_delete_removes_generator_job_history_and_keeps_audit(client, make_user):
    admin = make_user("urgent-generator-admin@example.com", "admin")
    tech = make_user("urgent-generator-tech@example.com", "staff")
    login(client, admin.email)
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Urgent deletion test job",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service_request_service.assign_technicians(admin, service.id, [tech.id])
    generator_id, service_id = generator.id, service.id

    detail = client.get(f"/generators/{generator_id}")
    assert b"Urgent delete" in detail.data and b"data-confirm-text=" in detail.data
    response = client.post(f"/generators/{generator_id}/urgent-delete", follow_redirects=True)

    assert response.status_code == 200 and b"1 linked job(s)" in response.data
    assert db.session.get(Generator, generator_id) is None
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "service.force_delete", AuditLog.entity_id == str(service_id)))
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "generator.force_delete", AuditLog.entity_id == str(generator_id)))


def test_admin_can_urgently_delete_a_service_with_operational_history(client, make_user):
    admin = make_user("urgent-service-admin@example.com", "admin")
    tech = make_user("urgent-service-tech@example.com", "staff")
    login(client, admin.email)
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Urgent service deletion test",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service_request_service.assign_technicians(admin, service.id, [tech.id])
    service_id = service.id

    detail = client.get(f"/services/{service_id}")
    assert b"Urgent delete" in detail.data and b"data-confirm-text=" in detail.data
    response = client.post(f"/services/{service_id}/urgent-delete", follow_redirects=True)

    assert response.status_code == 200 and b"operational history were deleted" in response.data
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "service.force_delete", AuditLog.entity_id == str(service_id)))


def test_admin_urgent_delete_customer_cascades_and_staff_is_forbidden(client, make_user):
    admin = make_user("urgent-customer-admin@example.com", "admin")
    tech = make_user("urgent-customer-tech@example.com", "staff")
    login(client, admin.email)
    client.post("/customers/new", data=CUST)
    customer = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": customer.id})
    generator = db.session.scalar(select(Generator))
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Urgent customer deletion test job",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service_request_service.assign_technicians(admin, service.id, [tech.id])
    customer_id, generator_id, service_id = customer.id, generator.id, service.id

    client.post("/auth/logout")
    login(client, tech.email)
    assert client.post(f"/customers/{customer_id}/urgent-delete").status_code == 403
    client.post("/auth/logout")
    login(client, admin.email)
    detail = client.get(f"/customers/{customer_id}")
    assert b"Urgent delete" in detail.data and b"data-confirm-text=" in detail.data
    assert client.post(f"/customers/{customer_id}/urgent-delete").status_code == 302
    assert db.session.get(Customer, customer_id) is None
    assert db.session.get(Generator, generator_id) is None
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "customer.force_delete", AuditLog.entity_id == str(customer_id)))


def test_duplicate_serial_message_on_form(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    client.post("/customers/new", data=CUST)
    cid = db.session.scalar(select(Customer.id))
    client.post("/generators/new", data={**GEN, "customer_id": cid})
    resp = client.post("/generators/new", data={**GEN, "brand": "KIRLOSKAR", "serial_number": "krl-77-1001", "customer_id": cid})
    assert resp.status_code == 200 and b"already registered" in resp.data and b"GEN-000001" in resp.data
    assert db.session.query(Generator).count() == 1


def test_form_validation_errors_shown(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    resp = client.post("/customers/new", data={"name": "A", "phone_primary": "12"})
    assert resp.status_code == 200 and b"is-invalid" in resp.data
    assert db.session.query(Customer).count() == 0


def test_generator_customer_picker_and_search(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    client.post("/customers/new", data=CUST)
    resp = client.get("/generators/new?q=98765")
    assert b"CUS-000001" in resp.data and b"Select" in resp.data
    assert b"No active customer found" in client.get("/generators/new?q=zzzzzz").data


def test_list_pagination_search_sort(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    for i in range(18):
        client.post("/customers/new", data={"name": f"Customer {i:02d}", "customer_type": "individual", "phone_primary": f"90000000{i:02d}"})
    p1 = client.get("/customers/?sort=name&dir=asc")
    assert b"Customer 00" in p1.data and b"Customer 17" not in p1.data and b"Next" in p1.data
    p2 = client.get("/customers/?sort=name&dir=asc&page=2")
    assert b"Customer 17" in p2.data
    assert b"Customer 05" in client.get("/customers/?q=0005").data
    assert client.get("/customers/?page=999").status_code == 200  # out-of-range page is handled


def test_names_are_html_escaped(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    client.post("/customers/new", data={"name": "<script>alert(1)</script>", "customer_type": "individual", "phone_primary": "9876501234"})
    cid = db.session.scalar(select(Customer.id))
    html = client.get(f"/customers/{cid}").data
    assert b"<script>alert(1)</script>" not in html and b"&lt;script&gt;" in html


def test_upload_and_authorised_download(client, make_user, app):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    client.post("/customers/new", data=CUST)
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": cust.id})
    gen = db.session.scalar(select(Generator))

    resp = client.post(f"/generators/{gen.id}/attachments", data={
        "files": [(io.BytesIO(png()), "plate.png"), (io.BytesIO(b"MZ-not-an-image"), "bad.jpg")],
        "description": "Name plate"}, content_type="multipart/form-data", follow_redirects=True)
    assert b"1 file uploaded" in resp.data and b"bad.jpg" in resp.data  # one saved, one rejected with a reason
    att = db.session.scalar(select(Attachment))
    dl = client.get(f"/files/{att.id}")
    assert dl.status_code == 200 and dl.mimetype == "image/png" and dl.headers["X-Content-Type-Options"] == "nosniff"
    assert client.get("/files/99999").status_code == 404

    g.pop("_login_user", None)
    anon = app.test_client()
    resp = anon.get(f"/files/{att.id}")
    assert resp.status_code == 302 and "/auth/login" in resp.headers["Location"]


def test_removed_file_is_no_longer_downloadable(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    client.post("/customers/new", data=CUST)
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": cust.id})
    gen = db.session.scalar(select(Generator))
    client.post(f"/generators/{gen.id}/attachments", data={"files": (io.BytesIO(png()), "a.png")},
               content_type="multipart/form-data")
    att = db.session.scalar(select(Attachment))
    assert client.post(f"/generators/attachments/{att.id}/delete").status_code == 302
    assert client.get(f"/files/{att.id}").status_code == 404


def test_customer_without_generator_view_cannot_download(app, client, make_user):
    # A role lacking generator.view must get 404 for a file, not the bytes.
    from app.models import Permission, Role
    staff_role = db.session.scalar(select(Role).where(Role.name == "staff"))
    staff_role.permissions = [p for p in staff_role.permissions if p.code != "generator.view"]
    db.session.commit()
    admin = make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    client.post("/customers/new", data=CUST)
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={**GEN, "customer_id": cust.id})
    gen = db.session.scalar(select(Generator))
    client.post(f"/generators/{gen.id}/attachments", data={"files": (io.BytesIO(png()), "a.png")},
               content_type="multipart/form-data")
    att_id = db.session.scalar(select(Attachment.id))
    g.pop("_login_user", None)
    c2 = app.test_client()
    make_user("limited@example.com", "staff")
    login(c2, "limited@example.com")
    assert c2.get(f"/files/{att_id}").status_code == 404
    assert c2.get("/generators/").status_code == 403
