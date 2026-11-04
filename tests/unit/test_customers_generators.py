from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.extensions import db
from app.models import AuditLog, Customer
from app.services import customer_service, generator_service
from app.services.errors import DuplicateWarning, PermissionDenied, ValidationError
from app.utils.validators import normalize_phone

CUSTOMER = {"name": "Sharma Textiles", "customer_type": "business", "phone_primary": "+91 98765 43210",
            "city": "Saharanpur", "email": "Accounts@Sharma.example"}
GEN = {"brand": "Cummins", "model": "C250D5", "serial_number": "cm 2024 001", "capacity_kva": "250",
       "fuel_type": "diesel", "condition": "good"}


def test_phone_normalisation():
    assert normalize_phone("+91 98765-43210") == "9876543210"
    assert normalize_phone("098765 43210") == "9876543210"
    assert normalize_phone("9876543210") == "9876543210"


def test_create_customer_assigns_code_and_normalises(app, make_user):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, CUSTOMER)
    assert c.customer_code == "CUS-000001"
    assert c.normalized_phone == "9876543210" and c.email == "accounts@sharma.example"
    c2 = customer_service.create_customer(staff, {**CUSTOMER, "name": "Other", "phone_primary": "9000000001", "email": ""})
    assert c2.customer_code == "CUS-000002"


@pytest.mark.parametrize("override,msg", [
    ({"name": ""}, "name"), ({"phone_primary": "12"}, "phone"), ({"email": "not-an-email"}, "email"),
    ({"customer_type": "alien"}, "type"), ({"phone_alt": "abc"}, "alternate"),
])
def test_customer_validation(app, make_user, override, msg):
    staff = make_user("tech@example.com", "staff")
    with pytest.raises(ValidationError) as exc:
        customer_service.create_customer(staff, {**CUSTOMER, **override})
    assert msg in str(exc.value).lower()


def test_duplicate_phone_variants_and_confirmation(app, make_user):
    staff = make_user("tech@example.com", "staff")
    first = customer_service.create_customer(staff, CUSTOMER)
    other = {"name": "Different Name", "phone_primary": "098765 43210", "customer_type": "individual"}
    with pytest.raises(DuplicateWarning) as exc:
        customer_service.create_customer(staff, other)
    assert exc.value.matches[0]["customer"].id == first.id
    assert "Same primary phone" in exc.value.matches[0]["reasons"]
    second = customer_service.create_customer(staff, other, confirm_duplicate=True)
    audit = db.session.scalar(select(AuditLog).where(AuditLog.entity_id == str(second.id), AuditLog.action == "customer.create"))
    assert audit.new_values["duplicate_override_of"] == ["CUS-000001"]


def test_duplicate_by_email_and_by_name_city(app, make_user):
    staff = make_user("tech@example.com", "staff")
    customer_service.create_customer(staff, CUSTOMER)
    with pytest.raises(DuplicateWarning):
        customer_service.create_customer(staff, {"name": "X Co", "phone_primary": "9111111111", "email": "ACCOUNTS@sharma.example"})
    with pytest.raises(DuplicateWarning):
        customer_service.create_customer(staff, {"name": "sharma textiles", "phone_primary": "9222222222", "city": "saharanpur"})


def test_alt_phone_matches_other_customers_primary(app, make_user):
    staff = make_user("tech@example.com", "staff")
    customer_service.create_customer(staff, CUSTOMER)
    with pytest.raises(DuplicateWarning):
        customer_service.create_customer(staff, {"name": "Zed Traders", "phone_primary": "9333333333", "phone_alt": "9876543210"})


def test_edit_requires_permission_and_excludes_self_from_duplicates(app, make_user):
    staff = make_user("tech@example.com", "staff")
    admin = make_user("admin@example.com", "admin")
    c = customer_service.create_customer(staff, CUSTOMER)
    with pytest.raises(PermissionDenied):
        customer_service.update_customer(staff, c.id, {**CUSTOMER, "city": "Delhi"})
    updated = customer_service.update_customer(admin, c.id, {**CUSTOMER, "city": "Delhi"})  # no self-duplicate warning
    assert updated.city == "Delhi"
    with pytest.raises(PermissionDenied):
        customer_service.set_active(staff, c.id, False)


def test_search_by_phone_fragment_and_filters(app, make_user):
    staff = make_user("tech@example.com", "staff")
    customer_service.create_customer(staff, CUSTOMER)
    customer_service.create_customer(staff, {"name": "Ravi", "phone_primary": "9000000009", "customer_type": "individual"})
    names = lambda **kw: [c.name for c in db.session.scalars(customer_service.search_customers(**kw))]
    assert names(q="43210") == ["Sharma Textiles"]
    assert names(q="CUS-000002") == ["Ravi"]
    assert names(ctype="individual") == ["Ravi"]
    assert names(sort="name", direction="desc") == ["Sharma Textiles", "Ravi"]


def test_generator_serial_rules(app, make_user):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, CUSTOMER)
    g = generator_service.create_generator(staff, c.id, GEN)
    assert g.generator_code == "GEN-000001" and g.serial_number == "CM2024001"
    # same brand + serial (case/space insensitive) is rejected, even for another customer
    c2 = customer_service.create_customer(staff, {"name": "Other", "phone_primary": "9000000002"})
    with pytest.raises(ValidationError) as exc:
        generator_service.create_generator(staff, c2.id, {**GEN, "brand": "CUMMINS", "serial_number": "cm2024001"})
    assert "GEN-000001" in str(exc.value)
    # same serial under a different brand is allowed
    assert generator_service.create_generator(staff, c2.id, {**GEN, "brand": "Kirloskar"}).id != g.id


@pytest.mark.parametrize("serial", ["", "AB", "N/A", "TBD123"[:3], "1111111", "has space!", "x" * 41])
def test_bad_serials_rejected(app, make_user, serial):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, CUSTOMER)
    with pytest.raises(ValidationError):
        generator_service.create_generator(staff, c.id, {**GEN, "serial_number": serial})


def test_customer_can_own_multiple_generators(app, make_user):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, CUSTOMER)
    for i in range(3):
        generator_service.create_generator(staff, c.id, {**GEN, "serial_number": f"SN-{i}00{i}"})
    db.session.refresh(c)
    assert len(c.generators) == 3


def test_generator_field_validation(app, make_user):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, CUSTOMER)
    today = date.today()
    bad = [
        {"capacity_kva": "0"}, {"capacity_kva": "abc"}, {"capacity_kva": "99999"}, {"fuel_type": "coal"},
        {"warranty_start": today, "warranty_end": today - timedelta(days=1)},
        {"last_service_date": today + timedelta(days=3)},
        {"last_service_date": today, "next_maintenance_date": today - timedelta(days=1)},
    ]
    for i, override in enumerate(bad):
        with pytest.raises(ValidationError):
            generator_service.create_generator(staff, c.id, {**GEN, "serial_number": f"OK-{i}{i}{i}x", **override})


def test_cannot_register_generator_for_inactive_customer_and_staff_cannot_edit(app, make_user):
    staff = make_user("tech@example.com", "staff")
    admin = make_user("admin@example.com", "admin")
    c = customer_service.create_customer(staff, CUSTOMER)
    g = generator_service.create_generator(staff, c.id, GEN)
    with pytest.raises(PermissionDenied):
        generator_service.update_generator(staff, g.id, {**GEN, "model": "Changed"})
    customer_service.set_active(admin, c.id, False)
    with pytest.raises(ValidationError):
        generator_service.create_generator(staff, c.id, {**GEN, "serial_number": "NEW-0001"})


def test_maintenance_overdue_search(app, make_user):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, CUSTOMER)
    generator_service.create_generator(staff, c.id, {**GEN, "serial_number": "OLD-0001", "next_maintenance_date": date.today() - timedelta(days=5)})
    generator_service.create_generator(staff, c.id, {**GEN, "serial_number": "NEW-0001", "next_maintenance_date": date.today() + timedelta(days=30)})
    rows = db.session.scalars(generator_service.search_generators(maintenance="overdue")).all()
    assert [r.serial_number for r in rows] == ["OLD-0001"] and rows[0].maintenance_overdue
