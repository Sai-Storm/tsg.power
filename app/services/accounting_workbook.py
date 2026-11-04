"""Excel workbook export and guarded row-by-row accounting imports."""
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.utils.exceptions import InvalidFileException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import (AccountingImportReference, CashEntry, Customer, CustomerAdvance, EmployeeAdvance,
                      EmployeeAdvanceRequest, ExpenseClaim, FinancialTransaction, InventoryCategory,
                      InventoryItem, InventoryTransaction, Invoice, Payment, Supplier, User)
from ..models.billing import PAYMENT_METHODS
from ..models.finance import CASH_CATEGORIES, CASH_DIRECTIONS
from ..utils.time import local_to_utc, utc_to_local, utcnow
from . import customer_service, finance_service, inventory_service, invoice_service
from .errors import ServiceError, ValidationError

MAX_ROWS_PER_SHEET = 500
SHEETS = {
    "Customers": ("Mode", "Customer Code", "Name", "Type", "Contact Person", "Phone",
                  "Alternate Phone", "Email", "Address", "City", "State", "Notes"),
    "Inventory Items": ("Mode", "Part Code", "Name", "SKU", "Category", "Supplier", "Description",
                        "Unit", "Minimum Stock", "Purchase Price", "Selling Price", "Storage Location",
                        "Opening Stock"),
    "Stock Adjustments": ("Transaction ID", "Part Code", "Delta", "Reason", "Reference"),
    "Employee Advances": ("Advance Number", "Employee Staff Code", "Amount", "Reason", "External Reference",
                          "Approved Request ID"),
    "Employee Advance Requests": ("Request ID", "Employee Staff Code", "Requested Amount", "Reason", "Status",
                                  "Requested At", "Approved Amount", "Approved By", "Issued Advance Number"),
    "Customer Advances": ("Advance Number", "Customer Code", "Amount", "Method", "Reference", "Received At",
                          "Notes"),
    "Financial Ledger": ("Journal ID", "Type", "Source Type", "Source ID", "Event", "Occurred At", "Debit Account",
                         "Credit Account", "Amount", "Reference", "Description", "Recorded By", "Reverses Journal ID"),
    "Expense Claims": ("Claim Number", "Employee Staff Code", "Category", "Description", "Amount", "Incurred On",
                       "Advance Number", "Receipt Reference"),
    "Cash Entries": ("Cash Entry Number", "Direction", "Category", "Amount", "Description", "Reference",
                     "Occurred At"),
    "Invoices": ("Invoice Number", "Draft ID", "Service ID", "Customer", "Status", "Issued At",
                 "Due Date", "Total", "Paid", "Balance"),
    "Payments": ("Payment Number", "Invoice Number", "Type", "Amount", "Method", "Reference", "Paid At", "Reason"),
}
PERMISSIONS = (
    "finance.manage", "customer.view", "customer.create", "customer.edit",
    "inventory.view", "inventory.manage", "inventory.adjust", "invoice.view", "payment.record",
)


def _safe(value):
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def _sheet(workbook, name, rows=()):
    ws = workbook.create_sheet(name)
    ws.append(SHEETS[name])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{chr(64 + len(SHEETS[name]))}1"
    for row in rows:
        ws.append([_safe(value) for value in row])
    ws.auto_filter.ref = f"A1:{chr(64 + len(SHEETS[name]))}{ws.max_row}"
    return ws


def _set_widths(ws):
    for column in ws.columns:
        letter = column[0].column_letter
        width = min(max(max((len(str(cell.value or "")) for cell in column), default=10) + 2, 12), 42)
        ws.column_dimensions[letter].width = width


def _populate(workbook):
    customers = db.session.scalars(select(Customer).order_by(Customer.customer_code)).all()
    _sheet(workbook, "Customers", [
        ("", c.customer_code, c.name, c.customer_type, c.contact_person, c.phone_primary, c.phone_alt,
         c.email, c.address, c.city, c.state, c.notes) for c in customers
    ])

    items = db.session.scalars(select(InventoryItem).order_by(InventoryItem.part_code)).all()
    _sheet(workbook, "Inventory Items", [
        ("", i.part_code, i.name, i.sku, i.category.name if i.category else None,
         i.supplier.name if i.supplier else None, i.description, i.unit, i.min_stock,
         i.purchase_price, i.selling_price, i.storage_location, None) for i in items
    ])
    transactions = db.session.scalars(
        select(InventoryTransaction).order_by(InventoryTransaction.id.desc()).limit(5000)
    ).all()
    _sheet(workbook, "Stock Adjustments", [
        (t.id, t.item.part_code, t.quantity_delta, t.reason, t.reference)
        for t in transactions if t.txn_type in ("adjustment", "correction")
    ])

    advances = db.session.scalars(select(EmployeeAdvance).order_by(EmployeeAdvance.issued_at.desc())).all()
    request_ids = {
        advance_request.issued_advance_id: advance_request.id
        for advance_request in db.session.scalars(
            select(EmployeeAdvanceRequest).where(EmployeeAdvanceRequest.issued_advance_id.is_not(None))
        )
    }
    _sheet(workbook, "Employee Advances", [
        (a.advance_number, a.employee.staff_code, a.amount, a.reason, a.external_reference,
         request_ids.get(a.id)) for a in advances
    ])
    requests = db.session.scalars(
        select(EmployeeAdvanceRequest).order_by(EmployeeAdvanceRequest.requested_at.desc())
    ).all()
    _sheet(workbook, "Employee Advance Requests", [
        (r.id, r.employee.staff_code, r.requested_amount, r.reason, r.status, r.requested_at,
         r.approved_amount, r.approved_by.staff_code if r.approved_by else None,
         r.advance.advance_number if r.advance else None) for r in requests
    ])
    customer_advances = db.session.scalars(
        select(CustomerAdvance).order_by(CustomerAdvance.received_at.desc())
    ).all()
    _sheet(workbook, "Customer Advances", [
        (a.advance_number, a.customer.customer_code, a.amount, a.method, a.reference, a.received_at, a.notes)
        for a in customer_advances
    ])
    financial_transactions = db.session.scalars(
        select(FinancialTransaction).order_by(FinancialTransaction.occurred_at.desc())
    ).all()
    _sheet(workbook, "Financial Ledger", [
        (entry.id, entry.transaction_type, entry.source_type, entry.source_id, entry.event_key,
         entry.occurred_at, entry.debit_account, entry.credit_account, entry.amount, entry.reference,
         entry.description, entry.actor.full_name if entry.actor else None, entry.reverses_id)
        for entry in financial_transactions
    ])
    claims = db.session.scalars(select(ExpenseClaim).order_by(ExpenseClaim.submitted_at.desc())).all()
    _sheet(workbook, "Expense Claims", [
        (c.claim_number, c.employee.staff_code, c.category, c.description, c.amount, c.incurred_on,
         c.advance.advance_number if c.advance else None, c.receipt_reference) for c in claims
    ])
    cash_entries = db.session.scalars(select(CashEntry).order_by(CashEntry.occurred_at.desc())).all()
    _sheet(workbook, "Cash Entries", [
        (e.entry_number, e.direction, e.category, e.amount, e.description, e.reference, utc_to_local(e.occurred_at))
        for e in cash_entries
    ])

    invoices = db.session.scalars(select(Invoice).order_by(Invoice.id.desc())).all()
    _sheet(workbook, "Invoices", [
        (i.invoice_number, i.id if i.status == "draft" else None, i.service.service_id,
         i.service.customer.name, i.status, utc_to_local(i.issued_at) if i.issued_at else None,
         i.due_date, i.total, i.amount_paid, i.balance) for i in invoices
    ])
    payments = db.session.scalars(select(Payment).order_by(Payment.paid_at.desc())).all()
    _sheet(workbook, "Payments", [
        (p.number, p.invoice.invoice_number, p.payment_type, p.amount, p.method, p.reference,
         utc_to_local(p.paid_at), p.reason) for p in payments
    ])


def export_workbook():
    workbook = Workbook()
    instructions = workbook.active
    instructions.title = "Instructions"
    instructions.append(("GCSMS accounting workbook",))
    instructions.append(("Only rows with an explicit CREATE, UPDATE, or adjustment entry are imported.",))
    instructions.append(("Imports create new transactions; posted history is never overwritten or deleted.",))
    instructions.append(("Cash, advances, claims, stock adjustments, and payments require references to prevent duplicates.",))
    instructions.append(("Invoices are export-only. Create and issue invoices from the related service request.",))
    instructions.append(("Import processes valid rows individually; review Import Results for rejected rows.",))
    instructions.column_dimensions["A"].width = 110
    _populate(workbook)
    for ws in workbook.worksheets[1:]:
        _set_widths(ws)
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    return output


def template_workbook():
    workbook = Workbook()
    instructions = workbook.active
    instructions.title = "Instructions"
    instructions.append(("GCSMS accounting import template",))
    instructions.append(("Fill only the sheets and rows you need; leave unused rows empty.",))
    instructions.append(("Customers and Inventory Items use Mode=CREATE for a new record or UPDATE with its code.",))
    instructions.append(("Stock Adjustments require an existing Part Code and unique Reference; generated IDs are export-only.",))
    instructions.append(("Advance imports require an approved Request ID and unique External Reference; claims require a unique Receipt Reference.",))
    instructions.append(("Customer Advances can be imported with a unique Reference. Employee Advance Requests and Financial Ledger are export-only.",))
    instructions.append(("Cash Entries require a unique Reference; Payments require an existing issued Invoice Number and unique Reference.",))
    instructions.append(("Invoices are export-only and are ignored during import.",))
    instructions.column_dimensions["A"].width = 110
    for name in SHEETS:
        ws = _sheet(workbook, name)
        _set_widths(ws)
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    return output


def _text(value, label, required=True):
    text = "" if value is None else str(value).strip()
    if required and not text:
        raise ValidationError(f"{label} is required.")
    return text or None


def _reserve_reference(scope, reference, actor):
    if len(reference) > 120:
        raise ValidationError("References must be 120 characters or fewer.")
    normalized = reference.strip().casefold()
    if db.session.scalar(select(AccountingImportReference.id).where(
        AccountingImportReference.scope == scope,
        AccountingImportReference.reference == normalized,
    ).limit(1)):
        raise ValidationError(f"Reference {reference} has already been imported.")
    db.session.add(AccountingImportReference(
        scope=scope, reference=normalized, imported_by_id=actor.id
    ))
    db.session.flush()


def _date(value, label):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(_text(value, label))
    except ValueError:
        raise ValidationError(f"{label} must be an Excel date or YYYY-MM-DD.")


def _local_datetime(value, label):
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, datetime.min.time())
    else:
        text = _text(value, label)
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            raise ValidationError(f"{label} must be an Excel date/time or ISO date/time.")
    return local_to_utc(parsed)


def _employee(staff_code):
    code = _text(staff_code, "Employee Staff Code").upper()
    employee = db.session.scalar(select(User).where(func.upper(User.staff_code) == code))
    if employee is None or not employee.is_active:
        raise ValidationError(f"Active employee {code} was not found.")
    return employee


def _customer(row, actor):
    mode = _text(row["Mode"], "Mode").upper()
    if not mode and _text(row["Customer Code"], "Customer Code", required=False):
        return
    code = _text(row["Customer Code"], "Customer Code", required=mode == "UPDATE")
    data = {
        "name": row["Name"], "customer_type": row["Type"] or "individual",
        "contact_person": row["Contact Person"], "phone_primary": row["Phone"],
        "phone_alt": row["Alternate Phone"], "email": row["Email"], "address": row["Address"],
        "city": row["City"], "state": row["State"], "notes": row["Notes"],
    }
    if mode == "CREATE":
        if code:
            raise ValidationError("Leave Customer Code blank when creating a customer.")
        matches = customer_service.find_potential_duplicates(customer_service._prepare(data))
        if matches:
            raise ValidationError("Possible duplicate customer found; review it in Customers before importing.")
        customer_service.create_customer(actor, data)
    elif mode == "UPDATE":
        customer = db.session.scalar(select(Customer).where(func.upper(Customer.customer_code) == code.upper()))
        if customer is None:
            raise ValidationError(f"Customer {code} was not found.")
        customer_service.update_customer(actor, customer.id, data)
    else:
        raise ValidationError("Mode must be CREATE or UPDATE.")


def _category_id(name):
    name = _text(name, "Category", required=False)
    if not name:
        return None
    category = db.session.scalar(select(InventoryCategory).where(func.lower(InventoryCategory.name) == name.lower()))
    if category is None or not category.is_active:
        raise ValidationError(f"Active inventory category {name} was not found.")
    return category.id


def _supplier_id(name):
    name = _text(name, "Supplier", required=False)
    if not name:
        return None
    supplier = db.session.scalar(select(Supplier).where(func.lower(Supplier.name) == name.lower()))
    if supplier is None or not supplier.is_active:
        raise ValidationError(f"Active supplier {name} was not found.")
    return supplier.id


def _inventory_item(row, actor):
    mode = _text(row["Mode"], "Mode").upper()
    if not mode and _text(row["Part Code"], "Part Code", required=False):
        return
    code = _text(row["Part Code"], "Part Code", required=mode == "UPDATE")
    data = {
        "name": row["Name"], "sku": row["SKU"], "category_id": _category_id(row["Category"]),
        "supplier_id": _supplier_id(row["Supplier"]), "description": row["Description"],
        "unit": row["Unit"] or "unit", "min_stock": row["Minimum Stock"] or 0,
        "purchase_price": row["Purchase Price"] or 0, "selling_price": row["Selling Price"],
        "storage_location": row["Storage Location"],
    }
    if mode == "CREATE":
        if code:
            raise ValidationError("Leave Part Code blank when creating an inventory item.")
        data["opening_stock"] = row["Opening Stock"] or 0
        inventory_service.create_item(actor, data)
    elif mode == "UPDATE":
        item = db.session.scalar(select(InventoryItem).where(func.upper(InventoryItem.part_code) == code.upper()))
        if item is None:
            raise ValidationError(f"Inventory item {code} was not found.")
        if row["Opening Stock"] not in (None, ""):
            raise ValidationError("Opening Stock is allowed only when creating an item; use Stock Adjustments otherwise.")
        inventory_service.update_item(actor, item.id, data)
    else:
        raise ValidationError("Mode must be CREATE or UPDATE.")


def _stock_adjustment(row, actor):
    code = _text(row["Part Code"], "Part Code").upper()
    item = db.session.scalar(select(InventoryItem).where(func.upper(InventoryItem.part_code) == code))
    if item is None:
        raise ValidationError(f"Inventory item {code} was not found.")
    reference = _text(row["Reference"], "Reference")
    if len(reference) > 100:
        raise ValidationError("Stock adjustment references must be 100 characters or fewer.")
    scope = f"stock:{item.part_code.casefold()}"
    if db.session.scalar(select(InventoryTransaction.id).where(
        InventoryTransaction.item_id == item.id,
        func.lower(InventoryTransaction.reference) == reference.lower(),
    ).limit(1)):
        raise ValidationError(f"Reference {reference} has already been used for this item.")
    _reserve_reference(scope, reference, actor)
    inventory_service.adjust_stock(actor, item.id, row["Delta"], row["Reason"],
                                   kind="adjustment", reference=reference)


def _advance(row, actor):
    employee = _employee(row["Employee Staff Code"])
    reference = _text(row["External Reference"], "External Reference")
    if len(reference) > 100:
        raise ValidationError("External Reference must be 100 characters or fewer.")
    if db.session.scalar(select(EmployeeAdvance.id).where(
        func.lower(EmployeeAdvance.external_reference) == reference.lower()
    ).limit(1)):
        raise ValidationError(f"Advance reference {reference} has already been imported.")
    request_id_value = _text(row["Approved Request ID"], "Approved Request ID")
    try:
        request_id = int(request_id_value)
    except (TypeError, ValueError):
        raise ValidationError("Approved Request ID must be an integer.") from None
    advance_request = db.session.get(EmployeeAdvanceRequest, request_id)
    if (advance_request is None or advance_request.status != "approved"
            or advance_request.employee_id != employee.id):
        raise ValidationError("Approved Request ID must identify an approved request for this employee.")
    try:
        imported_amount = Decimal(str(row["Amount"]))
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError("Amount must match the approved request amount.") from None
    if imported_amount != Decimal(advance_request.approved_amount):
        raise ValidationError("Amount must match the approved request amount.")
    if _text(row["Reason"], "Reason") != advance_request.reason:
        raise ValidationError("Reason must match the approved request.")
    _reserve_reference("employee_advances", reference, actor)
    finance_service.issue_approved_advance(actor, advance_request.id, "cash", reference)


def _customer_advance(row, actor):
    customer_code = _text(row["Customer Code"], "Customer Code").upper()
    customer = db.session.scalar(select(Customer).where(func.upper(Customer.customer_code) == customer_code))
    if customer is None or not customer.is_active:
        raise ValidationError(f"Active customer {customer_code} was not found.")
    reference = _text(row["Reference"], "Reference")
    if len(reference) > 100:
        raise ValidationError("Customer advance references must be 100 characters or fewer.")
    if db.session.scalar(select(CustomerAdvance.id).where(
        func.lower(CustomerAdvance.reference) == reference.lower()
    ).limit(1)):
        raise ValidationError(f"Customer advance reference {reference} has already been used.")
    method = _text(row["Method"], "Method").lower()
    if method not in PAYMENT_METHODS or method == "customer_credit":
        raise ValidationError("Method is invalid.")
    received_at = _local_datetime(row["Received At"], "Received At") if row["Received At"] else None
    if received_at and received_at > utcnow():
        raise ValidationError("Received At cannot be in the future.")
    _reserve_reference("customer_advances", reference, actor)
    finance_service.receive_customer_advance(
        actor, customer.id, row["Amount"], method, reference, row["Notes"], received_at,
    )


def _claim(row, actor):
    employee = _employee(row["Employee Staff Code"])
    reference = _text(row["Receipt Reference"], "Receipt Reference")
    duplicate = db.session.scalar(select(ExpenseClaim.id).where(
        ExpenseClaim.employee_id == employee.id,
        func.lower(ExpenseClaim.receipt_reference) == reference.lower(),
    ).limit(1))
    if duplicate:
        raise ValidationError(f"Receipt reference {reference} already exists for this employee.")
    advance_number = _text(row["Advance Number"], "Advance Number", required=False)
    advance = None
    if advance_number:
        advance = db.session.scalar(select(EmployeeAdvance).where(
            func.upper(EmployeeAdvance.advance_number) == advance_number.upper()
        ))
        if advance is None or advance.employee_id != employee.id:
            raise ValidationError("Advance Number was not found for this employee.")
    _reserve_reference(f"claims:{employee.staff_code.casefold()}", reference, actor)
    finance_service.submit_claim(
        actor, _text(row["Category"], "Category").lower(), row["Description"], row["Amount"],
        _date(row["Incurred On"], "Incurred On"), advance.id if advance else None, reference,
        employee_id=employee.id,
    )


def _cash_entry(row, actor):
    reference = _text(row["Reference"], "Reference")
    duplicate = db.session.scalar(select(CashEntry.id).where(
        func.lower(CashEntry.reference) == reference.lower()
    ).limit(1))
    if duplicate:
        raise ValidationError(f"Cash entry reference {reference} has already been used.")
    direction = _text(row["Direction"], "Direction").lower()
    category = _text(row["Category"], "Category").lower()
    if direction not in CASH_DIRECTIONS or category not in CASH_CATEGORIES:
        raise ValidationError("Direction or Category is invalid.")
    occurred_at = _local_datetime(row["Occurred At"], "Occurred At")
    if occurred_at > utcnow():
        raise ValidationError("Occurred At cannot be in the future.")
    _reserve_reference("cash_entries", reference, actor)
    finance_service.record_cash_entry(
        actor, direction, category, row["Amount"], row["Description"], reference,
        occurred_at,
    )


def _payment(row, actor):
    invoice_number = _text(row["Invoice Number"], "Invoice Number").upper()
    invoice = db.session.scalar(select(Invoice).where(func.upper(Invoice.invoice_number) == invoice_number))
    if invoice is None or invoice.status in ("draft", "void"):
        raise ValidationError(f"Issued invoice {invoice_number} was not found.")
    reference = _text(row["Reference"], "Reference")
    if len(reference) > 100:
        raise ValidationError("Payment references must be 100 characters or fewer.")
    duplicate = db.session.scalar(select(Payment.id).where(
        Payment.invoice_id == invoice.id, func.lower(Payment.reference) == reference.lower()
    ).limit(1))
    if duplicate:
        raise ValidationError(f"Payment reference {reference} already exists for this invoice.")
    kind = _text(row["Type"], "Type").lower()
    method = _text(row["Method"], "Method", required=kind != "adjustment")
    if method and method.lower() not in PAYMENT_METHODS:
        raise ValidationError("Method is invalid.")
    finance_service.require(actor, "payment.record")
    _reserve_reference(f"payments:{invoice_number.casefold()}", reference, actor)
    invoice_service.record_payment(
        actor, invoice.id, kind, row["Amount"], method.lower() if method else None, reference,
        _local_datetime(row["Paid At"], "Paid At"), row["Reason"],
    )


IMPORTERS = {
    "Customers": _customer,
    "Inventory Items": _inventory_item,
    "Stock Adjustments": _stock_adjustment,
    "Employee Advances": _advance,
    "Customer Advances": _customer_advance,
    "Expense Claims": _claim,
    "Cash Entries": _cash_entry,
    "Payments": _payment,
}


def import_workbook(stream, actor):
    try:
        workbook = load_workbook(stream, read_only=True, data_only=False)
    except (InvalidFileException, BadZipFile, OSError, ValueError, KeyError, IndexError, ParseError) as exc:
        raise ValidationError("The uploaded file is not a readable .xlsx workbook.") from exc

    unknown_sheets = set(workbook.sheetnames) - {"Instructions", *SHEETS.keys()}
    if unknown_sheets:
        raise ValidationError(f"Unknown sheet(s): {', '.join(sorted(unknown_sheets))}. Use the provided template.")

    prepared_sheets = {}
    try:
        for name in IMPORTERS:
            if name not in workbook.sheetnames:
                continue
            ws = workbook[name]
            rows = ws.iter_rows(values_only=False)
            header_cells = next(rows, None)
            expected = SHEETS[name]
            actual = tuple(cell.value for cell in header_cells) if header_cells else ()
            if actual != expected:
                workbook.close()
                raise ValidationError(
                    f"Sheet '{name}' must have the template headers in row 1 and in the original order."
                )
            staged_rows = []
            for row_number, cells in enumerate(rows, start=2):
                values = [cell.value for cell in cells[:len(expected)]]
                if not any(value is not None and str(value).strip() for value in values):
                    continue
                if len(staged_rows) >= MAX_ROWS_PER_SHEET:
                    workbook.close()
                    raise ValidationError(f"Sheet '{name}' exceeds the {MAX_ROWS_PER_SHEET}-row import limit.")
                has_formula = any(getattr(cell, "data_type", None) == "f" for cell in cells)
                staged_rows.append((row_number, values, has_formula))
            prepared_sheets[name] = (staged_rows, expected)
    except (InvalidFileException, BadZipFile, OSError, ValueError, KeyError, IndexError, ParseError) as exc:
        workbook.close()
        raise ValidationError("The uploaded file is not a readable .xlsx workbook.") from exc

    results = []
    for name, importer in IMPORTERS.items():
        if name not in prepared_sheets:
            continue
        staged_rows, expected = prepared_sheets[name]
        for row_number, values, has_formula in staged_rows:
            try:
                if has_formula:
                    raise ValidationError("Formula cells are not allowed in imported data.")
                data = dict(zip(expected, values))
                importer(data, actor)
                results.append((name, row_number, "IMPORTED", "Saved successfully."))
            except ServiceError as exc:
                db.session.rollback()
                results.append((name, row_number, "ERROR", str(exc)))
            except (ValueError, TypeError, KeyError) as exc:
                db.session.rollback()
                results.append((name, row_number, "ERROR", f"Invalid row data: {exc}"))
            except IntegrityError:
                db.session.rollback()
                results.append((name, row_number, "ERROR", "A duplicate or conflicting record prevented saving."))

    if "Invoices" in workbook.sheetnames:
        ws = workbook["Invoices"]
        if ws.max_row > 1:
            results.append(("Invoices", 2, "SKIPPED", "Invoices are read-only; no invoice data was changed."))
    workbook.close()
    return results


def results_workbook(results):
    workbook = Workbook()
    ws = workbook.active
    ws.title = "Import Results"
    ws.append(("Sheet", "Excel Row", "Result", "Details"))
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:D{max(1, len(results) + 1)}"
    imported = sum(result == "IMPORTED" for _, _, result, _ in results)
    errors = sum(result == "ERROR" for _, _, result, _ in results)
    ws.append(("Summary", None, None, f"{imported} imported; {errors} errors. Review each row below."))
    for result in results:
        ws.append([_safe(value) for value in result])
    _set_widths(ws)
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    return output
