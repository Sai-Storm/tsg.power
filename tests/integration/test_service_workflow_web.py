import io
from datetime import timedelta

from PIL import Image
from sqlalchemy import select

from app.extensions import db
from app.models import Attachment, Customer, Generator, Priority, ServiceRequest, ServiceType
from app.services import customer_service, generator_service, service_request_service
from app.utils.time import local_now, local_today
from tests.conftest import PASSWORD, login


def switch(client, email):
    client.post("/auth/logout")
    return login(client, email)


def png():
    buf = io.BytesIO()
    Image.new("RGB", (30, 30), (9, 9, 9)).save(buf, "PNG")
    return buf.getvalue()


def test_service_list_renders_default_and_selected_filters(client, make_user):
    make_user("admin@example.com", "admin")
    tech = make_user("tech@example.com", "staff")
    login(client, "admin@example.com")
    priority_id = db.session.scalar(select(Priority.id))
    service_type_id = db.session.scalar(select(ServiceType.id))

    empty_filters = client.get("/services/?q=&status=&priority=&type=&payment=&from=&to=")
    assert empty_filters.status_code == 200

    selected_filters = client.get(
        f"/services/?priority={priority_id}&type={service_type_id}&technician={tech.id}"
    )
    assert selected_filters.status_code == 200
    assert f'<option value="{priority_id}" selected>'.encode() in selected_filters.data
    assert f'<option value="{service_type_id}" selected>'.encode() in selected_filters.data
    assert f'<option value="{tech.id}" selected>'.encode() in selected_filters.data


def test_admin_can_clear_staff_workload_without_deleting_jobs(client, make_user):
    admin = make_user("clear-workload-admin@example.com", "admin")
    tech = make_user("clear-workload-tech@example.com", "staff", name="Workload Tech")
    login(client, admin.email)
    customer = customer_service.create_customer(admin, {
        "name": "Workload Customer", "phone_primary": "9811111111",
    })
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Cummins", "model": "C100", "serial_number": "WORK-1001", "capacity_kva": "100",
    })
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Workload clearing test job",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service_request_service.assign_technicians(admin, service.id, [tech.id])

    page = client.get("/staff/")
    assert b"Clear workload" in page.data and tech.staff_code.encode() in page.data
    assert b"Urgent clear workload" in page.data
    response = client.post(f"/staff/{tech.id}/clear-workload", follow_redirects=True)

    db.session.refresh(service)
    assert response.status_code == 200 and b"Removed Workload Tech from 1 active job(s)" in response.data
    assert db.session.get(ServiceRequest, service.id) is not None
    assert service.active_assignments == []


def test_admin_can_urgently_clear_staff_workload_without_generator_or_customer_history(client, make_user):
    admin = make_user("urgent-workload-admin@example.com", "admin")
    tech = make_user("urgent-workload-tech@example.com", "staff", name="Urgent Workload Tech")
    login(client, admin.email)
    customer = customer_service.create_customer(admin, {
        "name": "Urgent Customer", "phone_primary": "9822222222",
    })
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Perkins", "model": "P50", "serial_number": "PERK-5001", "capacity_kva": "50",
    })
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id,
        "generator_id": generator.id,
        "complaint": "Urgent workload test job",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service_request_service.assign_technicians(admin, service.id, [tech.id])

    workload_page = client.get("/services/workload")
    assert b"Urgent clear workload" in workload_page.data
    response = client.post(f"/staff/{tech.id}/urgent-clear-workload", follow_redirects=True)

    db.session.refresh(service)
    assert response.status_code == 200 and b"Urgently removed Urgent Workload Tech from 1 active job(s)" in response.data
    assert service.active_assignments == []


def test_full_job_lifecycle_through_the_web(client, make_user):
    make_user("admin@example.com", "admin")
    tech = make_user("tech@example.com", "staff", name="Tara Tech")
    other = make_user("other@example.com", "staff", name="Other Tech")
    make_user("desk@example.com", "staff", name="Desk Dee")

    # 1. Front-desk staff registers customer + generator and opens a request through the wizard
    login(client, "desk@example.com")
    client.post("/customers/new", data={"name": "Rao Hospital", "customer_type": "business", "phone_primary": "9812345678"})
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={"customer_id": cust.id, "brand": "Perkins", "model": "P250", "serial_number": "PK-5001",
                                         "capacity_kva": "250", "fuel_type": "diesel", "condition": "good"})
    gen = db.session.scalar(select(Generator))
    assert b"Step 2 of 3" in client.get(f"/services/new?customer_id={cust.id}").data
    assert b"Step 3 of 3" in client.get(f"/services/new?generator_id={gen.id}").data
    resp = client.post("/services/new", data={
        "generator_id": gen.id, "complaint": "Generator trips on load", "location": "Hospital basement",
        "service_type_id": db.session.scalar(select(ServiceType.id).where(ServiceType.code == "emergency")),
        "priority_id": db.session.scalar(select(Priority.id).where(Priority.code == "urgent")), "fault_category_id": 0})
    assert resp.status_code == 302
    s = db.session.scalar(select(ServiceRequest))
    assert s.service_id == f"GEN-SRV-{local_today().year}-0001"
    page = client.get(f"/services/{s.id}")
    assert s.service_id.encode() in page.data and b"Not assigned" in page.data
    assert b"Assign or reassign" not in page.data  # desk staff cannot assign

    # 2. Admin assigns and schedules
    switch(client, "admin@example.com")
    assert b"Unassigned" in client.get("/services/?unassigned=1").data
    client.post(f"/services/{s.id}/assign", data={"technicians": [tech.id], "lead_id": tech.id})
    when = (local_now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")
    client.post(f"/services/{s.id}/schedule", data={"scheduled_at": when})
    db.session.refresh(s)
    assert s.status == "scheduled" and [t.id for t in s.technicians] == [tech.id]

    # 3. An unrelated technician cannot see it; the assigned one can
    switch(client, "other@example.com")
    assert client.get(f"/services/{s.id}").status_code == 404
    assert client.post(f"/services/{s.id}/status", data={"to_status": "in_progress"}).status_code == 404
    assert s.service_id.encode() not in client.get("/services/").data
    switch(client, "tech@example.com")
    assert s.service_id.encode() in client.get("/services/?mine=1").data
    assert client.get(f"/services/{s.id}/edit").status_code == 403  # staff cannot edit once assigned

    # 4. Technician works the job
    client.post(f"/services/{s.id}/status", data={"to_status": "in_progress", "remarks": "On site"})
    client.post(f"/services/{s.id}/status", data={"to_status": "waiting_parts", "remarks": "Need relay"})
    db.session.refresh(s)
    assert s.status == "waiting_parts"
    client.post(f"/services/{s.id}/status", data={"to_status": "closed"})  # not offered to staff
    db.session.refresh(s)
    assert s.status == "waiting_parts"
    client.post(f"/services/{s.id}/status", data={"to_status": "in_progress"})
    client.post(f"/services/{s.id}/note", data={"note": "Customer gave basement access"})
    up = client.post(f"/services/{s.id}/attachments", data={"files": (io.BytesIO(png()), "relay.png"), "description": "Relay"},
                     content_type="multipart/form-data")
    assert up.status_code == 302
    att = db.session.scalar(select(Attachment))
    assert att.owner_type == "service" and client.get(f"/files/{att.id}").status_code == 200

    # 5. Completion report is validated, then accepted
    bad = client.post(f"/services/{s.id}/complete", data={"diagnosis": "Relay burnt"}, follow_redirects=True)
    assert b"Work performed" in bad.data
    db.session.refresh(s)
    assert s.status == "in_progress"
    client.post(f"/services/{s.id}/complete", data={
        "diagnosis": "Burnt relay", "work_performed": "Replaced relay and tested on load", "labor_hours": "3",
        "actual_completion": local_today().isoformat()})
    db.session.refresh(s)
    assert s.status == "completed"
    detail = client.get(f"/services/{s.id}").data
    for text in (b"Replaced relay", b"Need relay", b"Customer gave basement access", b"Completed", b"Tara Tech"):
        assert text in detail

    # 6. The other technician still cannot download the evidence; admin closes the job
    switch(client, "other@example.com")
    assert client.get(f"/files/{att.id}").status_code == 404
    switch(client, "admin@example.com")
    client.post(f"/services/{s.id}/status", data={"to_status": "closed"})
    db.session.refresh(s)
    assert s.status == "closed"
    assert s.service_id.encode() in client.get(f"/customers/{cust.id}").data  # appears in history
    assert s.service_id.encode() in client.get(f"/generators/{gen.id}").data
    assert [h.to_status for h in s.history] == ["new_request", "assigned", "scheduled", "in_progress",
                                               "waiting_parts", "in_progress", "completed", "closed"]


def test_service_id_search_jumps_to_job_and_hides_others(client, make_user):
    make_user("admin@example.com", "admin")
    make_user("tech@example.com", "staff")
    login(client, "admin@example.com")
    client.post("/customers/new", data={"name": "Acme", "customer_type": "individual", "phone_primary": "9000000001"})
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={"customer_id": cust.id, "brand": "X", "model": "Y", "serial_number": "ABC-123",
                                         "capacity_kva": "10", "fuel_type": "diesel", "condition": "good"})
    gen = db.session.scalar(select(Generator))
    client.post("/services/new", data={"generator_id": gen.id, "complaint": "No output voltage", "fault_category_id": 0,
                                       "service_type_id": db.session.scalar(select(ServiceType.id)),
                                       "priority_id": db.session.scalar(select(Priority.id))})
    s = db.session.scalar(select(ServiceRequest))
    hit = client.get(f"/services/?q={s.service_id.lower()}")
    assert hit.status_code == 302 and hit.headers["Location"].endswith(f"/services/{s.id}")
    switch(client, "tech@example.com")  # staff who is not involved: search shows nothing, no redirect
    miss = client.get(f"/services/?q={s.service_id}")
    assert miss.status_code == 200 and b"No service requests match" in miss.data


def test_admin_override_and_workload_pages(client, make_user):
    make_user("admin@example.com", "admin")
    make_user("tech@example.com", "staff", name="Wanda Worker")
    login(client, "admin@example.com")
    client.post("/customers/new", data={"name": "Acme", "customer_type": "individual", "phone_primary": "9000000001"})
    cust = db.session.scalar(select(Customer))
    client.post("/generators/new", data={"customer_id": cust.id, "brand": "X", "model": "Y", "serial_number": "ABC-123",
                                         "capacity_kva": "10", "fuel_type": "diesel", "condition": "good"})
    gen = db.session.scalar(select(Generator))
    client.post("/services/new", data={"generator_id": gen.id, "complaint": "Noisy engine", "fault_category_id": 0,
                                       "service_type_id": db.session.scalar(select(ServiceType.id)),
                                       "priority_id": db.session.scalar(select(Priority.id))})
    s = db.session.scalar(select(ServiceRequest))
    bad = client.post(f"/services/{s.id}/override", data={"to_status": "in_progress", "reason": ""}, follow_redirects=True)
    assert b"Reason for override" in bad.data
    client.post(f"/services/{s.id}/override", data={"to_status": "in_progress", "reason": "Started by phone instruction"})
    db.session.refresh(s)
    assert s.status == "in_progress"
    assert b"Admin override" in client.get(f"/services/{s.id}").data
    assert b"Wanda Worker" in client.get("/services/workload").data


def test_staff_cannot_use_admin_endpoints(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    assert client.get("/services/workload").status_code == 403
    assert client.post("/services/1/assign", data={"technicians": [1]}).status_code == 403
    assert client.post("/services/1/override", data={"to_status": "closed", "reason": "hack attempt"}).status_code == 403
    assert client.get("/services/999").status_code == 404
