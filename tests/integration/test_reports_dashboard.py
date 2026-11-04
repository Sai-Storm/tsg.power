import re
from datetime import timedelta

from sqlalchemy import select

from app.extensions import db
from app.models import AuditLog, Priority, ServiceRequest, ServiceStatusHistory, ServiceType
from app.services import customer_service, generator_service
from app.services import service_request_service as services
from app.utils.time import local_today
from tests.conftest import login


def _job(admin, suffix):
    customer = customer_service.create_customer(
        admin, {"name": f"Report Customer {suffix}", "phone_primary": f"98765432{suffix:02d}"}
    )
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Cummins", "model": f"R{suffix}", "serial_number": f"RPT-{suffix:04d}",
        "capacity_kva": "100",
    })
    return services.create_service_request(admin, {
        "customer_id": customer.id, "generator_id": generator.id,
        "complaint": "Dashboard report test",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })


def test_dashboard_filters_match_seeded_counts_and_exports(client, make_user):
    admin = make_user("report-admin@example.com", "admin")
    first = _job(admin, 1)
    second = _job(admin, 2)
    services.change_status(admin, second.id, "under_review", remarks="Reviewed")

    login(client, admin.email)
    page = client.get("/?from=2020-01-01&to=2099-12-31")
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert re.search(r"New jobs</div>\s*<div class=\"display-6 fw-semibold\">1</div>", html)
    assert re.search(r"Pending jobs</div>\s*<div class=\"display-6 fw-semibold\">1</div>", html)
    assert b"Customers" in page.data and b"Generators" in page.data

    filtered = client.get("/?status=new_request&from=2020-01-01&to=2099-12-31")
    assert filtered.status_code == 200
    filtered_html = filtered.get_data(as_text=True)
    assert re.search(r"New jobs</div>\s*<div class=\"display-6 fw-semibold\">1</div>", filtered_html)
    assert re.search(r"Pending jobs</div>\s*<div class=\"display-6 fw-semibold\">0</div>", filtered_html)

    csv_report = client.get("/reports/export/services.csv?from=2020-01-01&to=2099-12-31")
    assert csv_report.status_code == 200
    assert b"Service ID,Customer,Generator,Status" in csv_report.data
    assert first.service_id.encode() in csv_report.data and second.service_id.encode() in csv_report.data
    pdf_report = client.get("/reports/export/services.pdf")
    assert pdf_report.status_code == 200 and pdf_report.mimetype == "application/pdf"
    assert pdf_report.data.startswith(b"%PDF")


def test_global_search_and_admin_audit_log(client, make_user):
    admin = make_user("search-admin@example.com", "admin")
    job = _job(admin, 3)
    login(client, admin.email)

    results = client.get("/reports/search?q=RPT-0003")
    assert results.status_code == 200
    assert job.service_id.encode() in results.data
    assert b"RPT-0003" in results.data

    audit = client.get("/reports/audit")
    assert audit.status_code == 200


def test_global_search_shows_recent_records_and_supports_bulk_actions(client, make_user):
    admin = make_user("search-bulk-admin@example.com", "admin")
    technician = make_user("search-bulk-tech@example.com", "staff", name="Bulk Technician")
    job = _job(admin, 7)
    login(client, admin.email)

    recent = client.get("/reports/search")
    assert recent.status_code == 200
    assert b"Recent records are listed below" in recent.data
    assert job.service_id.encode() in recent.data
    assert job.customer.customer_code.encode() in recent.data

    exported = client.post("/reports/search/actions", data={
        "selected": [f"service:{job.id}", f"customer:{job.customer_id}"],
        "action": "export",
    })
    assert exported.status_code == 200
    assert exported.mimetype == "text/csv"
    assert job.service_id.encode() in exported.data
    assert job.customer.customer_code.encode() in exported.data

    mixed_action = client.post("/reports/search/actions", data={
        "selected": [f"service:{job.id}", f"customer:{job.customer_id}"],
        "action": "status", "status": "under_review",
    }, follow_redirects=True)
    assert b"require only service jobs to be selected" in mixed_action.data
    db.session.refresh(job)
    assert job.status == "new_request"

    status_update = client.post("/reports/search/actions", data={
        "selected": f"service:{job.id}", "action": "status", "status": "under_review",
        "remarks": "Bulk review",
    }, follow_redirects=True)
    assert status_update.status_code == 200
    db.session.refresh(job)
    assert job.status == "under_review"

    assignment = client.post("/reports/search/actions", data={
        "selected": f"service:{job.id}", "action": "assign", "technician_id": technician.id,
    }, follow_redirects=True)
    assert assignment.status_code == 200
    db.session.refresh(job)
    assert job.status == "assigned"
    assert [row.user_id for row in job.active_assignments] == [technician.id]


def test_dashboard_rejects_bad_filter_dates(client, make_user):
    admin = make_user("bad-filter@example.com", "admin")
    login(client, admin.email)
    assert client.get("/?from=not-a-date").status_code == 400
    assert client.get("/?from=2026-12-01&to=2026-01-01").status_code == 400


def test_unstarted_service_request_can_be_deleted_and_audited(client, make_user):
    admin = make_user("delete-service-admin@example.com", "admin")
    job = _job(admin, 4)
    service_id = job.id
    login(client, admin.email)

    response = client.post(f"/services/{service_id}/delete")

    assert response.status_code == 302
    assert db.session.get(ServiceRequest, service_id) is None
    assert db.session.scalar(select(ServiceStatusHistory.id).where(
        ServiceStatusHistory.service_request_id == service_id)) is None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "service.delete_unstarted", AuditLog.entity_id == str(service_id)))


def test_service_request_with_status_history_cannot_be_deleted(client, make_user):
    admin = make_user("delete-service-history-admin@example.com", "admin")
    job = _job(admin, 5)
    service_id = job.id
    services.change_status(admin, service_id, "under_review", remarks="Reviewed")
    login(client, admin.email)

    response = client.post(f"/services/{service_id}/delete")

    assert response.status_code == 302
    assert db.session.get(ServiceRequest, service_id) is not None
    assert db.session.scalar(select(AuditLog.id).where(
        AuditLog.action == "service.delete_unstarted", AuditLog.entity_id == str(service_id))) is None


def test_service_can_be_cancelled_with_reason_and_history_is_retained(client, make_user):
    admin = make_user("cancel-service-admin@example.com", "admin")
    job = _job(admin, 6)
    services.change_status(admin, job.id, "under_review", remarks="Review started")
    service_id = job.id
    login(client, admin.email)

    detail = client.get(f"/services/{service_id}")
    assert detail.status_code == 200 and b"Cancel service" in detail.data
    rejected = client.post(f"/services/{service_id}/cancel", data={"reason": "No"}, follow_redirects=True)
    assert rejected.status_code == 200
    db.session.refresh(job)
    assert job.status == "under_review"

    response = client.post(f"/services/{service_id}/cancel",
                           data={"reason": "Customer no longer needs the repair"}, follow_redirects=True)
    assert response.status_code == 200 and b"Service request cancelled" in response.data
    db.session.refresh(job)
    assert job.status == "cancelled"
    assert job.cancellation_reason == "Customer no longer needs the repair"
    assert db.session.scalar(select(ServiceStatusHistory.id).where(
        ServiceStatusHistory.service_request_id == service_id,
        ServiceStatusHistory.to_status == "cancelled"))
