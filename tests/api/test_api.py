from datetime import date
from io import BytesIO

from PIL import Image
from sqlalchemy import select

from app.api import init_app
from app.extensions import db
from app.models import (ApiToken, Customer, Generator, Priority, ServiceAssignment,
                        ServiceRequest, ServiceType)
from app.api.tokens import ACCESS_TOKEN_SECONDS
from app.services.auth_service import change_password
from app.services.staff_service import set_active


def _client(app):
    init_app(app)
    return app.test_client()


def _login(client, email):
    response = client.post("/api/v1/auth/login", json={
        "email": email, "password": "Str0ngPassw0rd", "device_name": "test-device",
    })
    assert response.status_code == 200
    return response.json["data"]


def _headers(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def _job(user):
    tag = f"{user.id:03d}"
    customer = Customer(
        customer_code=f"CUS-API-{tag}", name=f"API Customer {tag}", phone_primary=f"9876543{tag}",
        normalized_phone=f"9876543{tag}", customer_type="individual", created_by_id=user.id,
    )
    db.session.add(customer)
    db.session.flush()
    generator = Generator(
        generator_code=f"GEN-API-{tag}", customer_id=customer.id, brand="Acme", brand_key="acme",
        model="A1", serial_number=f"API1234{tag}", capacity_kva=10, fuel_type="diesel", condition="good",
        created_by_id=user.id,
    )
    db.session.add(generator)
    db.session.flush()
    service_type = db.session.scalar(select(ServiceType).where(ServiceType.code == "repair"))
    priority = db.session.scalar(select(Priority).where(Priority.code == "normal"))
    job = ServiceRequest(
        service_id=f"GEN-SRV-2026-{tag}", customer_id=customer.id, generator_id=generator.id,
        service_type_id=service_type.id, priority_id=priority.id, status="in_progress",
        complaint="Generator fails to start", created_by_id=user.id, updated_by_id=user.id,
    )
    db.session.add(job)
    db.session.flush()
    db.session.add(ServiceAssignment(service_request_id=job.id, user_id=user.id,
                                     assigned_by_id=user.id, is_lead=True))
    db.session.commit()
    return job


def test_refresh_rotates_hashed_tokens_and_logout_revokes_access(app, make_user):
    user = make_user("api@example.com")
    client = _client(app)
    tokens = _login(client, user.email)

    assert tokens["expires_in"] == ACCESS_TOKEN_SECONDS == 900
    with app.app_context():
        token_row = db.session.scalar(select(ApiToken))
        assert token_row.token_hash != tokens["refresh_token"]
        assert len(token_row.token_hash) == 64

    refreshed = client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refreshed.status_code == 200
    new_tokens = refreshed.json["data"]
    assert new_tokens["refresh_token"] != tokens["refresh_token"]
    assert client.get("/api/v1/me", headers=_headers(tokens)).status_code == 401
    assert client.post("/api/v1/auth/refresh",
                       json={"refresh_token": tokens["refresh_token"]}).status_code == 401
    assert client.get("/api/v1/me", headers=_headers(new_tokens)).status_code == 200

    assert client.post("/api/v1/auth/logout", headers=_headers(new_tokens)).status_code == 200
    assert client.get("/api/v1/me", headers=_headers(new_tokens)).status_code == 401


def test_staff_job_list_is_scoped_to_assigned_jobs_and_paginated(app, make_user):
    staff = make_user("staff1@example.com")
    other_staff = make_user("staff2@example.com")
    own_job = _job(staff)
    hidden_job = _job(other_staff)
    client = _client(app)
    tokens = _login(client, staff.email)

    response = client.get("/api/v1/jobs?page=1&per_page=1", headers=_headers(tokens))
    assert response.status_code == 200
    assert response.json["meta"] == {"page": 1, "per_page": 1, "total": 1, "pages": 1}
    assert response.json["data"][0]["id"] == own_job.id
    assert hidden_job.id != own_job.id
    assert client.get(f"/api/v1/jobs/{hidden_job.id}", headers=_headers(tokens)).status_code == 403
    assert client.get(f"/api/v1/jobs/{own_job.id}/history", headers=_headers(tokens)).status_code == 200


def test_material_request_uses_service_layer_and_bad_pagination_is_consistent(app, make_user):
    staff = make_user("materials@example.com")
    job = _job(staff)
    client = _client(app)
    tokens = _login(client, staff.email)

    response = client.post(f"/api/v1/jobs/{job.id}/materials", headers=_headers(tokens), json={
        "description": "Replacement filter", "quantity": "2", "unit": "unit",
        "category": "special_material",
    })
    assert response.status_code == 201
    assert response.json["data"]["description"] == "Replacement filter"
    bad_page = client.get("/api/v1/jobs?per_page=1000", headers=_headers(tokens))
    assert bad_page.status_code == 400
    assert bad_page.json["error"]["code"] == "validation_error"


def test_password_change_and_deactivation_revoke_api_sessions(app, make_user):
    password_user = make_user("password-change@example.com")
    client = _client(app)
    password_tokens = _login(client, password_user.email)
    change_password(password_user, "Str0ngPassw0rd", "An0therStrongPass")
    assert client.get("/api/v1/me", headers=_headers(password_tokens)).status_code == 401
    assert client.post("/api/v1/auth/refresh",
                       json={"refresh_token": password_tokens["refresh_token"]}).status_code == 401

    target = make_user("deactivated@example.com")
    admin = make_user("admin@example.com", role="admin")
    deactivation_tokens = _login(client, target.email)
    set_active(admin, target.id, False)
    assert client.get("/api/v1/me", headers=_headers(deactivation_tokens)).status_code == 401
    assert client.post("/api/v1/auth/refresh",
                       json={"refresh_token": deactivation_tokens["refresh_token"]}).status_code == 401


def test_photo_upload_and_completion_report(app, make_user):
    staff = make_user("completion@example.com")
    job = _job(staff)
    client = _client(app)
    tokens = _login(client, staff.email)

    image = BytesIO()
    Image.new("RGB", (4, 4), "blue").save(image, format="PNG")
    uploaded = client.post(
        f"/api/v1/jobs/{job.id}/photos", headers=_headers(tokens),
        data={"photo": (BytesIO(image.getvalue()), "job.png", "image/png")},
        content_type="multipart/form-data",
    )
    assert uploaded.status_code == 201
    photo_id = uploaded.json["data"]["id"]
    assert client.get(f"/api/v1/jobs/{job.id}/photos", headers=_headers(tokens)).status_code == 200
    assert client.get(f"/api/v1/photos/{photo_id}", headers=_headers(tokens)).status_code == 200

    completed = client.post(f"/api/v1/jobs/{job.id}/completion", headers=_headers(tokens), json={
        "diagnosis": "Loose battery connection", "work_performed": "Cleaned and secured terminals",
        "labor_hours": "1.25", "actual_completion": date.today().isoformat(),
        "completion_remarks": "Test run successful",
    })
    assert completed.status_code == 200
    assert completed.json["data"]["status"] == "completed"
