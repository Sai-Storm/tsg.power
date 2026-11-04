import pytest
from sqlalchemy import select

from app.extensions import db
from app.models import AuditLog, Role
from app.services import staff_service
from app.services.auth_service import password_problems
from app.services.errors import PermissionDenied, ValidationError


def _role_id(name):
    return db.session.scalar(select(Role.id).where(Role.name == name))


def test_password_policy():
    assert password_problems("short1A")
    assert password_problems("alllowercase123")
    assert not password_problems("Str0ngPassw0rd")


def test_admin_creates_staff_and_audit_is_written(app, make_user):
    admin = make_user("admin@example.com", "admin")
    user = staff_service.create_staff(admin, {
        "full_name": "Ravi Kumar", "email": "Ravi@Example.com", "role_id": _role_id("staff"),
        "password": "Str0ngPassw0rd", "availability": "available",
    })
    assert user.staff_code.startswith("STF-") and user.email == "ravi@example.com"
    assert db.session.scalar(select(AuditLog).where(AuditLog.action == "staff.create")) is not None


def test_staff_cannot_manage_accounts(app, make_user):
    tech = make_user("tech@example.com", "staff")
    with pytest.raises(PermissionDenied):
        staff_service.create_staff(tech, {"full_name": "X Y", "email": "x@example.com",
                                          "role_id": _role_id("staff"), "password": "Str0ngPassw0rd"})


def test_duplicate_email_rejected(app, make_user):
    admin = make_user("admin@example.com", "admin")
    with pytest.raises(ValidationError):
        staff_service.create_staff(admin, {"full_name": "Dup", "email": "ADMIN@example.com",
                                           "role_id": _role_id("staff"), "password": "Str0ngPassw0rd"})


def test_cannot_change_own_role(app, make_user):
    admin = make_user("admin@example.com", "admin")
    make_user("admin2@example.com", "admin")
    with pytest.raises(PermissionDenied):
        staff_service.update_staff(admin, admin.id, {"role_id": _role_id("staff")})


def test_cannot_deactivate_self(app, make_user):
    admin = make_user("admin@example.com", "admin")
    with pytest.raises(PermissionDenied):
        staff_service.set_active(admin, admin.id, False)


def test_last_active_admin_is_protected(app, make_user):
    from app.models import Permission

    sole_admin = make_user("admin@example.com", "admin")
    # A non-admin manager who was granted staff.manage tries to remove the only admin.
    staff_role = db.session.scalar(select(Role).where(Role.name == "staff"))
    staff_role.permissions.append(db.session.scalar(select(Permission).where(Permission.code == "staff.manage")))
    db.session.commit()
    manager = make_user("manager@example.com", "staff")

    with pytest.raises(ValidationError):
        staff_service.set_active(manager, sole_admin.id, False)
    with pytest.raises(ValidationError):
        staff_service.update_staff(manager, sole_admin.id, {"role_id": _role_id("staff")})

    second_admin = make_user("admin2@example.com", "admin")
    staff_service.set_active(manager, second_admin.id, False)  # allowed: sole_admin stays active
    assert second_admin.is_active is False
