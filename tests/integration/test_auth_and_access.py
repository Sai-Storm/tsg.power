from flask import g
from sqlalchemy import select

from app.extensions import db
from app.models import ApiToken, Role, User
from app.services import customer_service
from app.utils.time import utcnow
from datetime import timedelta
from tests.conftest import PASSWORD, login


def test_login_success_and_dashboard(client, make_user):
    make_user("admin@example.com", "admin")
    resp = login(client, "admin@example.com")
    assert resp.status_code == 302
    assert client.get("/").status_code == 200


def test_wrong_password_is_generic(client, make_user):
    make_user("admin@example.com", "admin")
    resp = login(client, "admin@example.com", "wrong")
    assert b"Invalid email or password." in resp.data
    resp = login(client, "nobody@example.com", "wrong")
    assert b"Invalid email or password." in resp.data


def test_lockout_after_repeated_failures(client, make_user, app):
    make_user("tech@example.com", "staff")
    for _ in range(app.config["LOGIN_MAX_FAILED"]):
        login(client, "tech@example.com", "bad")
    resp = login(client, "tech@example.com", PASSWORD)  # correct password, but locked
    assert b"Too many failed attempts" in resp.data
    assert client.get("/").status_code == 302


def test_deactivated_user_cannot_log_in(client, make_user):
    make_user("gone@example.com", "staff", active=False)
    resp = login(client, "gone@example.com")
    assert b"deactivated" in resp.data


def test_deactivation_ends_existing_session_and_revokes_tokens(client, make_user, app):
    admin = make_user("admin@example.com", "admin")
    tech = make_user("tech@example.com", "staff")
    db.session.add(ApiToken(user_id=tech.id, token_hash="a" * 64, expires_at=utcnow() + timedelta(days=1)))
    db.session.commit()

    tech_client = app.test_client()
    login(tech_client, "tech@example.com")
    assert tech_client.get("/").status_code == 200
    g.pop("_login_user", None)  # the fixture's long-lived app context would otherwise cache the user

    admin_client = app.test_client()
    login(admin_client, "admin@example.com")
    assert admin_client.post(f"/staff/{tech.id}/deactivate").status_code == 302
    g.pop("_login_user", None)

    assert tech_client.get("/").status_code == 302  # session no longer valid
    assert db.session.scalar(select(ApiToken)).revoked_at is not None


def test_staff_blocked_from_staff_management(client, make_user):
    make_user("tech@example.com", "staff")
    login(client, "tech@example.com")
    assert client.get("/staff/").status_code == 403
    assert client.get("/staff/new").status_code == 403
    assert client.post("/staff/new", data={"full_name": "A B"}).status_code == 403


def test_anonymous_redirected_to_login(client):
    resp = client.get("/staff/")
    assert resp.status_code == 302 and "/auth/login" in resp.headers["Location"]


def test_admin_creates_edits_and_deactivates_staff_via_web(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    staff_role = db.session.scalar(select(Role).where(Role.name == "staff"))

    resp = client.post("/staff/new", data={
        "full_name": "Asha Verma", "email": "asha@example.com", "phone": "+91 98765 43210",
        "role_id": staff_role.id, "availability": "available",
        "password": PASSWORD, "confirm_password": PASSWORD,
    })
    assert resp.status_code == 302
    asha = db.session.scalar(select(User).where(User.email == "asha@example.com"))
    assert asha and asha.staff_code.startswith("STF-")

    resp = client.post(f"/staff/{asha.id}/edit", data={
        "full_name": "Asha V", "email": "asha@example.com", "role_id": staff_role.id,
        "availability": "busy", "specialization": "Diesel engines",
    })
    assert resp.status_code == 302
    db.session.refresh(asha)
    assert asha.full_name == "Asha V" and asha.availability == "busy"

    assert client.post(f"/staff/{asha.id}/deactivate").status_code == 302
    db.session.refresh(asha)
    assert asha.is_active is False
    assert b"Asha V" in client.get("/staff/?status=inactive").data


def test_admin_can_delete_unreferenced_staff_but_not_staff_with_history(client, make_user):
    admin = make_user("staff-delete-admin@example.com", "admin")
    removable = make_user("staff-delete-removable@example.com", "staff")
    referenced = make_user("staff-delete-referenced@example.com", "staff")
    customer_service.create_customer(referenced, {
        "name": "Staff History Customer", "phone_primary": "9876543210",
    })
    login(client, admin.email)

    deleted = client.post(f"/staff/{removable.id}/delete")
    blocked = client.post(f"/staff/{referenced.id}/delete")

    assert deleted.status_code == 302 and db.session.get(User, removable.id) is None
    assert blocked.status_code == 302 and db.session.get(User, referenced.id) is not None


def test_admin_form_requires_password_for_new_account(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    staff_role = db.session.scalar(select(Role).where(Role.name == "staff"))
    resp = client.post("/staff/new", data={
        "full_name": "No Pass", "email": "np@example.com", "role_id": staff_role.id, "availability": "available",
    })
    assert resp.status_code == 200 and b"password is required" in resp.data


def test_open_redirect_is_blocked(client, make_user):
    make_user("admin@example.com", "admin")
    resp = client.post("/auth/login?next=https://evil.example/", data={"email": "admin@example.com", "password": PASSWORD})
    assert resp.headers["Location"].endswith("/")
    assert "evil.example" not in resp.headers["Location"]


def test_security_headers_present(client):
    resp = client.get("/auth/login")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert "Content-Security-Policy" in resp.headers


def test_admin_can_open_their_own_edit_page_but_not_change_own_role(client, make_user):
    """Regression: the edit page used to crash for the signed-in user's own account."""
    admin = make_user("admin@example.com", "admin")
    make_user("admin2@example.com", "admin")
    login(client, "admin@example.com")
    page = client.get(f"/staff/{admin.id}/edit")
    assert page.status_code == 200 and b"You cannot change your own role" in page.data
    role_id = db.session.scalar(select(Role.id).where(Role.name == "staff"))
    resp = client.post(f"/staff/{admin.id}/edit", data={"full_name": "Admin Renamed", "email": "admin@example.com",
                                                        "availability": "available", "role_id": role_id})
    assert resp.status_code == 302
    db.session.refresh(admin)
    assert admin.full_name == "Admin Renamed" and admin.role.name == "admin"  # a forged role_id is ignored
