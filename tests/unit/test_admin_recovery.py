from sqlalchemy import select

from app.extensions import db
from app.models import AuditLog, User
from app.utils.time import utcnow


def test_recover_admin_changes_email_and_password_and_clears_lockout(app, make_user):
    admin = make_user("old-admin@example.com", role="admin")
    admin.failed_login_count = 3
    admin.locked_until = utcnow()
    db.session.commit()

    runner = app.test_cli_runner()
    result = runner.invoke(
        args=["recover-admin"],
        input="STF-0001\nadmin.new@example.com\nN3wStrongPassword\nN3wStrongPassword\n",
    )

    assert result.exit_code == 0, result.output
    db.session.refresh(admin)
    assert admin.email == "admin.new@example.com"
    assert admin.check_password("N3wStrongPassword")
    assert admin.failed_login_count == 0
    assert admin.locked_until is None
    log = db.session.scalar(select(AuditLog).where(AuditLog.action == "auth.admin_recovery"))
    assert log is not None
    assert log.user_id == admin.id
    assert log.old_values == {"email": "old-admin@example.com"}
    assert log.new_values == {"email": "admin.new@example.com"}
    assert "N3wStrongPassword" not in result.output


def test_recover_admin_rejects_duplicate_email_and_keeps_account(app, make_user):
    make_user("first-admin@example.com", role="admin")
    make_user("other-admin@example.com", role="admin")
    runner = app.test_cli_runner()
    result = runner.invoke(
        args=["recover-admin"],
        input="STF-0001\nother-admin@example.com\nN3wStrongPassword\nN3wStrongPassword\n",
    )

    assert result.exit_code != 0
    assert "already in use" in result.output
    admin = db.session.scalar(select(User).where(User.staff_code == "STF-0001"))
    assert admin.email == "first-admin@example.com"


def test_recover_admin_rejects_weak_password(app, make_user):
    admin = make_user("admin@example.com", role="admin")
    runner = app.test_cli_runner()
    result = runner.invoke(
        args=["recover-admin"],
        input="STF-0001\nnew-admin@example.com\nweak\nweak\n",
    )

    assert result.exit_code != 0
    assert "Password needs" in result.output
    db.session.refresh(admin)
    assert admin.email == "admin@example.com"
