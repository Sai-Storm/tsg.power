from sqlalchemy import select

from app.extensions import db
from app.models import Permission, Role
from app.security.seed import seed_rbac


def test_workflow_roles_have_separated_permissions(app):
    roles = {role.name: role for role in db.session.scalars(select(Role))}
    sales = {permission.code for permission in roles["sales"].permissions}
    operations = {permission.code for permission in roles["operations"].permissions}
    accountant = {permission.code for permission in roles["accountant"].permissions}
    manager = {permission.code for permission in roles["manager"].permissions}

    assert {"estimate.create", "service.create"} <= sales
    assert "service.report_approve" not in accountant and "service.report_approve" in manager
    assert {"invoice.manage", "finance.manage"} <= accountant
    assert {"estimate.approve", "service.report_approve", "finance.manage"} <= manager
    assert "invoice.manage" not in manager
    assert {"service.assign", "requirement.approve"} <= operations


def test_rbac_seeding_adds_defaults_without_removing_custom_permissions(app):
    sales = db.session.scalar(select(Role).where(Role.name == "sales"))
    custom = Permission(code="test.custom", description="Test-only custom permission")
    db.session.add(custom)
    sales.permissions.append(custom)
    db.session.commit()

    seed_rbac()

    db.session.refresh(sales)
    assert "estimate.create" in {permission.code for permission in sales.permissions}
    assert "test.custom" in {permission.code for permission in sales.permissions}
