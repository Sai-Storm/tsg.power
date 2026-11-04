from datetime import datetime
from io import BytesIO

from openpyxl import load_workbook
from sqlalchemy import select

from app.extensions import db
from app.models import (AccountingImportReference, CashEntry, Customer, EmployeeAdvance, ExpenseClaim,
                        CustomerAdvance, InventoryItem, Payment, Priority, ServiceType)
from app.services import (customer_service, finance_service, generator_service, inventory_service,
                          invoice_service)
from app.services import service_request_service
from app.services.accounting_workbook import template_workbook
from app.utils.time import local_today
from tests.conftest import login


def _upload(client, content):
    return client.post(
        "/finance/excel/import",
        data={"workbook": (BytesIO(content), "accounting.xlsx")},
        content_type="multipart/form-data",
    )


def test_accounting_workbook_imports_valid_rows_and_rejects_reimports(client, make_user):
    admin = make_user("workbook-admin@example.com", "admin")
    employee = make_user("workbook-employee@example.com", "staff", name="Workbook Employee")
    advance_request = finance_service.request_advance(employee, "100", "Travel advance")
    finance_service.approve_advance_request(admin, advance_request.id)
    deposit_customer = customer_service.create_customer(admin, {
        "name": "Workbook Deposit Customer", "phone_primary": "9811111111",
    })
    item = inventory_service.create_item(admin, {
        "name": "Existing stock item", "sku": "WORKBOOK-OLD", "unit": "unit",
        "opening_stock": "4",
    })
    login(client, admin.email)

    template = client.get("/finance/excel/template")
    assert template.status_code == 200
    workbook = load_workbook(BytesIO(template.data))
    workbook["Customers"].append([
        "CREATE", None, "Workbook Customer", "business", "Account Contact", "9876543210",
        None, "workbook@example.com", "1 Sample Road", "Dehradun", "Uttarakhand", None,
    ])
    workbook["Inventory Items"].append([
        "CREATE", None, "Imported Part", "WORKBOOK-NEW", None, None, None, "unit",
        1, 10, 15, "Main store", 3,
    ])
    workbook["Inventory Items"].append([
        "UPDATE", item.part_code, "Updated Stock Item", "WORKBOOK-OLD", None, None, None, "unit",
        0, 0, None, None, None,
    ])
    workbook["Stock Adjustments"].append([None, item.part_code, 2, "Excel stocktake count", "COUNT-2026-001"])
    workbook["Employee Advances"].append([
        None, employee.staff_code, 100, "Travel advance", "ADV-IMPORT-001", advance_request.id,
    ])
    workbook["Customer Advances"].append([
        None, deposit_customer.customer_code, 75, "bank_transfer", "DEPOSIT-IMPORT-001", datetime.now(),
        "Quotation deposit",
    ])
    workbook["Expense Claims"].append([
        None, employee.staff_code, "travel", "Taxi to customer site", 20, local_today(),
        None, "RECEIPT-IMPORT-001",
    ])
    workbook["Cash Entries"].append([
        None, "in", "income", 50, "Workshop service income", "CASH-IMPORT-001", datetime.now(),
    ])
    output = BytesIO()
    workbook.save(output)
    workbook.close()

    response = _upload(client, output.getvalue())
    assert response.status_code == 200
    results = load_workbook(BytesIO(response.data), read_only=True, data_only=True)["Import Results"]
    statuses = [row[2] for row in list(results.iter_rows(values_only=True))[2:]]
    assert statuses == ["IMPORTED"] * 8
    assert db.session.scalar(select(Customer).where(Customer.name == "Workbook Customer")) is not None
    assert db.session.scalar(select(InventoryItem).where(InventoryItem.sku == "WORKBOOK-NEW")).current_stock == 3
    db.session.refresh(item)
    assert item.name == "Updated Stock Item" and item.current_stock == 6
    assert db.session.scalar(select(EmployeeAdvance).where(
        EmployeeAdvance.external_reference == "ADV-IMPORT-001"
    )) is not None
    assert db.session.scalar(select(CustomerAdvance).where(
        CustomerAdvance.reference == "DEPOSIT-IMPORT-001"
    )) is not None
    assert db.session.scalar(select(ExpenseClaim).where(
        ExpenseClaim.receipt_reference == "RECEIPT-IMPORT-001"
    )).status == "submitted"
    assert db.session.scalar(select(CashEntry).where(CashEntry.reference == "CASH-IMPORT-001")) is not None
    assert db.session.query(AccountingImportReference).count() == 5

    repeated = _upload(client, output.getvalue())
    assert repeated.status_code == 200
    repeated_results = load_workbook(BytesIO(repeated.data), read_only=True, data_only=True)["Import Results"]
    repeated_statuses = [row[2] for row in list(repeated_results.iter_rows(values_only=True))[2:]]
    assert repeated_statuses.count("ERROR") == 7
    assert db.session.query(Customer).filter_by(name="Workbook Customer").count() == 1
    assert db.session.query(EmployeeAdvance).filter_by(external_reference="ADV-IMPORT-001").count() == 1
    assert db.session.query(CustomerAdvance).filter_by(reference="DEPOSIT-IMPORT-001").count() == 1
    assert db.session.query(ExpenseClaim).filter_by(receipt_reference="RECEIPT-IMPORT-001").count() == 1


def test_accounting_workbook_exports_and_imports_payment_against_issued_invoice(client, make_user):
    admin = make_user("workbook-payment-admin@example.com", "admin")
    customer = customer_service.create_customer(admin, {
        "name": "Payment Workbook Customer", "phone_primary": "9876543211",
    })
    generator = generator_service.create_generator(admin, customer.id, {
        "brand": "Example", "model": "X1", "serial_number": "WORKBOOK-PAY-1", "capacity_kva": "10",
    })
    service = service_request_service.create_service_request(admin, {
        "customer_id": customer.id, "generator_id": generator.id, "complaint": "Workbook invoice",
        "service_type_id": db.session.scalar(select(ServiceType.id)),
        "priority_id": db.session.scalar(select(Priority.id)),
    })
    service.status = "completed"
    db.session.commit()
    service_request_service.approve_completion_report(admin, service.id)
    invoice = invoice_service.create_draft(admin, service.id)
    invoice_service.add_item(admin, invoice.id, "Labor", 1, 100)
    invoice_service.issue_invoice(admin, invoice.id)
    login(client, admin.email)

    exported = client.get("/finance/excel")
    assert exported.status_code == 200
    workbook = load_workbook(BytesIO(exported.data), read_only=True, data_only=True)
    assert {"Customers", "Inventory Items", "Employee Advances", "Employee Advance Requests",
            "Customer Advances", "Financial Ledger", "Expense Claims", "Cash Entries", "Invoices",
            "Payments"}.issubset(workbook.sheetnames)
    assert workbook["Invoices"]["A2"].value == invoice.invoice_number

    workbook = load_workbook(template_workbook())
    workbook["Payments"].append([
        None, invoice.invoice_number, "payment", 25, "cash", "PAY-IMPORT-001", datetime.now(), None,
    ])
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    response = _upload(client, output.getvalue())
    assert response.status_code == 200
    payment = db.session.scalar(select(Payment).where(Payment.reference == "PAY-IMPORT-001"))
    assert payment is not None and payment.invoice_id == invoice.id
    db.session.refresh(invoice)
    assert invoice.amount_paid == 25


def test_accounting_workbook_rejects_bad_headers_before_importing_any_rows(client, make_user):
    admin = make_user("workbook-header-admin@example.com", "admin")
    login(client, admin.email)
    workbook = load_workbook(template_workbook())
    workbook["Customers"].append([
        "CREATE", None, "Must Not Import", "business", None, "9876543212",
        None, None, None, None, None, None,
    ])
    workbook["Inventory Items"]["A1"] = "Incorrect header"
    output = BytesIO()
    workbook.save(output)
    workbook.close()

    response = _upload(client, output.getvalue())

    assert response.status_code == 302
    assert db.session.scalar(select(Customer).where(Customer.name == "Must Not Import")) is None


def test_accounting_workbook_requires_manager_access(client, make_user):
    employee = make_user("workbook-no-access@example.com", "staff")
    login(client, employee.email)

    assert client.get("/finance/excel").status_code == 403
    assert client.get("/finance/excel/template").status_code == 403
