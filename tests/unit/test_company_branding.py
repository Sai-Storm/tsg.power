from sqlalchemy import select

from app.extensions import db
from app.models import CompanySetting
from app.security.seed import seed_rbac
from app.services.settings_service import logo_path
from tests.conftest import login


def test_seed_replaces_only_the_previous_placeholder_company_name(app):
    setting = db.session.get(CompanySetting, "company_name")
    setting.value = "Generator Service Company"
    db.session.commit()

    seed_rbac()

    assert db.session.scalar(
        select(CompanySetting.value).where(CompanySetting.key == "company_name")
    ) == "TSG Power Engineering Service Group"

    setting = db.session.get(CompanySetting, "company_name")
    setting.value = "My Custom Company"
    db.session.commit()
    seed_rbac()
    assert setting.value == "My Custom Company"


def test_tsg_branding_and_default_logo_are_available(client, make_user, app):
    response = client.get("/auth/login")
    assert response.status_code == 200
    assert b"TSG Power Engineering Service Group" in response.data
    assert b"img/tsg-logo.png" in response.data

    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    logo_response = client.get("/settings/logo")
    assert logo_response.status_code == 200
    assert logo_response.mimetype == "image/png"
    with app.app_context():
        assert logo_path().endswith("tsg-logo.png")
