from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.extensions import db
from app.models import CashEntry, ExpenseClaim, FinancialTransaction, Payment, Priority, ServiceType
from app.services import (customer_service, finance_service, generator_service, invoice_service,
                          service_request_service)
from app.services.errors import PermissionDenied, ValidationError


def test_advance_claim_offset_and_unused_cash_return(app, make_user):
    admin = make_user("admin@example.com", role="admin")
    staff = make_user("staff@example.com")

    advance_request = finance_service.request_advance(staff, "100.00", "Travel to customer")
    finance_service.approve_advance_request(admin, advance_request.id)
    advance = finance_service.issue_approved_advance(admin, advance_request.id)
    assert finance_service.cash_balance() == Decimal("-100.00")

    claim = finance_service.submit_claim(
        staff, "travel", "Fuel and bus fare", "60", date.today(), advance.id
    )
    approved = finance_service.approve_claim(admin, claim.id)

    assert approved.status == "paid"
    assert approved.advance_offset == Decimal("60.00")
    assert approved.reimbursement_due == Decimal("0.00")
    assert finance_service.advance_outstanding(advance) == Decimal("40.00")

    finance_service.return_advance(admin, advance.id, "40", "Unused balance")
    assert finance_service.advance_outstanding(advance) == Decimal("0.00")
    assert finance_service.cash_balance() == Decimal("-60.00")
    assert finance_service.report_totals()["expense"] == Decimal("60.00")


def test_claim_over_advance_is_approved_then_reimbursed_once(app, make_user):
    admin = make_user("admin@example.com", role="admin")
    staff = make_user("staff@example.com")
    advance_request = finance_service.request_advance(staff, "50", "Field work")
    finance_service.approve_advance_request(admin, advance_request.id)
    advance = finance_service.issue_approved_advance(admin, advance_request.id)
    claim = finance_service.submit_claim(
        staff, "parts", "Emergency part purchase", "80", date.today(), advance.id
    )

    approved = finance_service.approve_claim(admin, claim.id)
    assert approved.status == "approved"
    assert approved.advance_offset == Decimal("50.00")
    assert approved.reimbursement_due == Decimal("30.00")

    paid = finance_service.pay_claim(admin, claim.id, "cash")
    assert paid.status == "paid"
    assert paid.reimbursement_paid == Decimal("30.00")
    assert finance_service.advance_outstanding(advance) == Decimal("0.00")
    assert finance_service.cash_balance() == Decimal("-80.00")
    assert finance_service.report_totals()["expense"] == Decimal("80.00")

    with pytest.raises(ValidationError, match="Only an approved"):
        finance_service.pay_claim(admin, claim.id, "cash")


def test_claim_payout_by_bank_does_not_change_cash_balance(app, make_user):
    admin = make_user("admin@example.com", role="admin")
    staff = make_user("staff@example.com")
    claim = finance_service.submit_claim(staff, "meals", "Customer site meal", "25", date.today())
    finance_service.approve_claim(admin, claim.id)
    finance_service.pay_claim(admin, claim.id, "bank_transfer")

    assert finance_service.cash_balance() == Decimal("0.00")
    assert finance_service.report_totals()["expense"] == Decimal("25.00")


def test_advance_request_requires_approval_before_issuance(app, make_user):
    admin = make_user("request-admin@example.com", role="admin")
    staff = make_user("request-staff@example.com")
    request = finance_service.request_advance(staff, "80", "Travel to customer")

    assert request.status == "requested"
    with pytest.raises(ValidationError, match="Only an approved"):
        finance_service.issue_approved_advance(admin, request.id)
    finance_service.approve_advance_request(admin, request.id, "60")
    advance = finance_service.issue_approved_advance(admin, request.id, "bank_transfer", "BANK-001")

    assert advance.employee_id == staff.id
    assert advance.amount == Decimal("60.00")
    assert db.session.get(type(request), request.id).status == "issued"
    assert finance_service.cash_balance() == Decimal("0.00")
    assert finance_service.report_totals()["expense"] == Decimal("0.00")
    assert db.session.scalar(select(FinancialTransaction).where(
        FinancialTransaction.source_type == "employee_advance"
    )).credit_account == "asset:bank"


def test_employee_cannot_approve_their_own_advance_or_expense_claim(app, make_user):
    employee = make_user("self-approval@example.com", role="admin")
    reviewer = make_user("independent-reviewer@example.com", role="admin")
    advance_request = finance_service.request_advance(employee, "40", "Travel to customer")
    with pytest.raises(ValidationError, match="cannot approve your own"):
        finance_service.approve_advance_request(employee, advance_request.id)
    finance_service.approve_advance_request(reviewer, advance_request.id)

    claim = finance_service.submit_claim(employee, "meals", "Customer site meal", "15", date.today())
    with pytest.raises(ValidationError, match="cannot approve your own"):
        finance_service.approve_claim(employee, claim.id)
    assert finance_service.approve_claim(reviewer, claim.id).status == "approved"


def test_job_link_flows_from_advance_request_to_issued_advance_and_claim(app, make_user):
    admin = make_user("job-finance-admin@example.com", role="admin")
    staff = make_user("job-finance-staff@example.com")
    customer = customer_service.create_customer(admin, {
        "name": "Job Expense Customer", "phone_primary": "9876543210",
    })
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Example", "model": "J1", "serial_number": "JOB-FINANCE-1", "capacity_kva": "10",
    })
    job = service_request_service.create_service_request(staff, {
        "customer_id": customer.id, "generator_id": generator.id, "complaint": "Job-linked finance test",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })

    advance_request = finance_service.request_advance(staff, "80", "Travel to customer", job.id)
    assert advance_request.service_request_id == job.id
    finance_service.approve_advance_request(admin, advance_request.id)
    advance = finance_service.issue_approved_advance(admin, advance_request.id)
    assert advance.service_request_id == job.id

    claim = finance_service.submit_claim(
        staff, "travel", "Travel and meals", "50", date.today(), advance.id
    )
    assert claim.service_request_id == job.id
    assert finance_service.approve_claim(admin, claim.id).advance_offset == Decimal("50.00")
    assert finance_service.advance_outstanding(advance) == Decimal("30.00")


def test_customer_advance_is_deposit_not_revenue_and_application_is_not_cash(app, make_user):
    admin = make_user("deposit-admin@example.com", role="admin")
    customer = customer_service.create_customer(admin, {
        "name": "Deposit Customer", "phone_primary": "9876543210",
    })
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Example", "model": "D1", "serial_number": "DEPOSIT-1", "capacity_kva": "10",
    })
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id, "generator_id": generator.id, "complaint": "Deposit workflow test",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service.status = "completed"
    db.session.commit()
    service_request_service.approve_completion_report(admin, service.id)
    invoice = invoice_service.create_draft(admin, service.id)
    invoice_service.add_item(admin, invoice.id, "Service", 1, 100)
    invoice_service.issue_invoice(admin, invoice.id)
    deposit = finance_service.receive_customer_advance(
        admin, customer.id, "150", "cash", "DEP-001"
    )

    assert finance_service.report_totals()["income"] == invoice.total
    assert finance_service.cash_balance() == Decimal("150.00")
    payment = finance_service.apply_customer_advance(admin, deposit.id, invoice.id, "50")

    assert payment.method == "customer_credit"
    assert finance_service.customer_advance_balance(deposit) == Decimal("100.00")
    assert finance_service.cash_balance() == Decimal("150.00")
    assert finance_service.report_totals()["income"] == invoice.total
    invoice_service.record_payment(admin, invoice.id, "payment", "68", "cash")
    invoice_service.record_payment(admin, invoice.id, "refund", "20", "cash", reason="Customer overpayment")
    assert finance_service.cash_balance() == Decimal("198.00")
    assert finance_service.report_totals()["income"] == invoice.total
    assert finance_service.report_totals()["expense"] == Decimal("0.00")
    assert invoice.balance == Decimal("20.00")
    assert db.session.scalar(select(FinancialTransaction).where(
        FinancialTransaction.source_type == "invoice",
        FinancialTransaction.event_key == "issued",
    )).credit_account == "income:service_revenue"


def test_manual_cash_entries_are_classified_and_reported(app, make_user):
    admin = make_user("admin@example.com", role="admin")
    finance_service.record_cash_entry(admin, "in", "opening", "200", "Starting cash")
    finance_service.record_cash_entry(admin, "in", "income", "20", "Other receipt")
    finance_service.record_cash_entry(admin, "out", "expense", "45", "Office supplies")

    assert finance_service.cash_balance() == Decimal("175.00")
    assert finance_service.report_totals() == {
        "income": Decimal("20.00"),
        "expense": Decimal("45.00"),
        "net": Decimal("-25.00"),
    }

    with pytest.raises(ValidationError, match="Cash in must"):
        finance_service.record_cash_entry(admin, "in", "expense", "10", "Wrong classification")

    opening = db.session.scalar(select(CashEntry).where(CashEntry.category == "opening"))
    opening.amount = Decimal("201.00")
    with pytest.raises(RuntimeError, match="append-only"):
        db.session.flush()
    db.session.rollback()


def test_staff_cannot_issue_advances_or_see_other_claims(app, make_user):
    admin = make_user("admin@example.com", role="admin")
    staff = make_user("staff@example.com")
    other_staff = make_user("other@example.com")
    claim = finance_service.submit_claim(other_staff, "other", "Small office item", "10", date.today())

    with pytest.raises(PermissionDenied):
        finance_service.issue_advance(staff, other_staff.id, "10", "Not allowed")
    with pytest.raises(ValidationError, match="not found"):
        finance_service.get_claim(staff, claim.id)

    assert finance_service.list_claims(staff) == []
    assert finance_service.list_claims(admin) == [claim]


def test_web_claim_submission_and_master_export(app, client, make_user):
    staff = make_user("staff@example.com")
    response = client.post(
        "/auth/login",
        data={"email": staff.email, "password": "Str0ngPassw0rd"},
        follow_redirects=True,
    )
    assert response.status_code == 200

    response = client.post(
        "/finance/claims/new",
        data={
            "category": "travel",
            "description": "Travel to customer site",
            "amount": "35.50",
            "incurred_on": date.today().isoformat(),
            "advance_id": "",
            "receipt_reference": "R-100",
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    claim = db.session.scalar(select(ExpenseClaim).where(ExpenseClaim.employee_id == staff.id))
    assert claim is not None
    assert claim.status == "submitted"
    assert b"Expense claim submitted for approval." in response.data

    customer_export = client.get("/customers/master.csv")
    assert customer_export.status_code == 200
    assert b"Customer ID,Name,Type" in customer_export.data


def test_admin_finance_and_income_report_pages_render(app, client, make_user):
    admin = make_user("admin@example.com", role="admin")
    login = client.post(
        "/auth/login",
        data={"email": admin.email, "password": "Str0ngPassw0rd"},
        follow_redirects=True,
    )
    assert login.status_code == 200

    finance_page = client.get("/finance/")
    assert finance_page.status_code == 200
    assert b"Net cash on hand" in finance_page.data
    cash_page = client.get("/finance/cash")
    assert cash_page.status_code == 200
    assert b"Cash in/out ledger" in cash_page.data
    assert client.get("/finance/cash.csv").status_code == 200
    report_page = client.get("/reports/?type=financial")
    assert report_page.status_code == 200
    assert b"Income received" in report_page.data
