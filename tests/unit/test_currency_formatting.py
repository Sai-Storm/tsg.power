from decimal import Decimal

from app.extensions import db
from app.models import CompanySetting
from app.security.seed import seed_rbac
from app.services import pdf_service


def set_currency(code, symbol):
    db.session.get(CompanySetting, "currency_code").value = code
    db.session.get(CompanySetting, "currency_symbol").value = symbol
    db.session.commit()


def test_default_currency_is_myanmar_kyat_in_web_and_pdf(app):
    assert db.session.get(CompanySetting, "currency_code").value == "MMK"
    assert db.session.get(CompanySetting, "currency_symbol").value == "Ks"

    with app.test_request_context("/"):
        assert app.jinja_env.filters["money"](Decimal("1234.5")) == "Ks 1,234.50"
    assert pdf_service.money(Decimal("1234.5")) == "Ks 1,234.50"


def test_seeding_migrates_old_default_but_preserves_custom_currency(app):
    set_currency("INR", "\u20b9")
    seed_rbac()
    assert db.session.get(CompanySetting, "currency_code").value == "MMK"
    assert db.session.get(CompanySetting, "currency_symbol").value == "Ks"

    set_currency("MMK", "\u20b9")
    seed_rbac()
    assert db.session.get(CompanySetting, "currency_symbol").value == "Ks"

    set_currency("USD", "$")
    seed_rbac()
    assert db.session.get(CompanySetting, "currency_code").value == "USD"
    assert db.session.get(CompanySetting, "currency_symbol").value == "$"


def test_custom_currency_formatting_remains_supported(app):
    set_currency("INR", "\u20b9")
    with app.test_request_context("/"):
        assert app.jinja_env.filters["money"](Decimal("1234.5")) == "\u20b91,234.50"
    assert pdf_service.money(Decimal("1234.5")) == "Rs. 1,234.50"
