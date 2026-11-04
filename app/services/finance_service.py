"""Cash handling, employee advances, and expense claims."""
from datetime import datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import joinedload

from ..extensions import db
from ..models import (AdvanceReturn, CashEntry, Customer, CustomerAdvance, EmployeeAdvance,
                      EmployeeAdvanceRequest, ExpenseClaim, FinancialTransaction, Invoice, Payment, ServiceRequest,
                      User)
from ..models.billing import PAYMENT_METHODS
from ..models.finance import CASH_CATEGORIES, CLAIM_CATEGORIES
from ..utils.time import local_to_utc, local_today, utcnow
from . import audit
from .common import parse_money, require
from .errors import ValidationError
from . import financial_ledger
from . import service_request_service as service_svc
from .id_generator import next_value

ZERO = Decimal("0.00")


def available_jobs(actor):
    stmt = select(ServiceRequest).order_by(ServiceRequest.created_at.desc())
    if not actor.has_permission("finance.manage"):
        stmt = stmt.where(service_svc.visible_clause(actor))
    return db.session.scalars(stmt.limit(500)).all()


def _linked_job(actor, service_request_id):
    if not service_request_id:
        return None
    service = db.session.get(ServiceRequest, service_request_id)
    if service is None:
        raise ValidationError("Choose a valid Job Order.")
    if not actor.has_permission("finance.manage") and not service_svc.can_view(actor, service):
        raise ValidationError("You cannot link a finance record to that Job Order.")
    return service


def _number(prefix, sequence):
    year = local_today().year
    return f"{prefix}-{year}-{next_value(sequence, year):04d}"


def _bounds(start=None, end=None, column=None):
    clauses = []
    if start:
        clauses.append(column >= local_to_utc(datetime.combine(start, time.min)))
    if end:
        clauses.append(column < local_to_utc(datetime.combine(end + timedelta(days=1), time.min)))
    return clauses


def advance_outstanding(advance, *, lock=False):
    stmt = select(EmployeeAdvance).where(EmployeeAdvance.id == advance.id)
    if lock:
        db.session.execute(stmt.with_for_update()).scalar_one()
    used = db.session.scalar(
        select(func.coalesce(func.sum(ExpenseClaim.advance_offset), 0)).where(
            ExpenseClaim.advance_id == advance.id,
            ExpenseClaim.status.in_(("approved", "paid")),
        )
    )
    returned = db.session.scalar(select(func.coalesce(func.sum(AdvanceReturn.amount), 0)).where(
        AdvanceReturn.advance_id == advance.id
    ))
    return Decimal(advance.amount) - Decimal(used) - Decimal(returned)


def list_advances(actor):
    stmt = select(EmployeeAdvance).order_by(EmployeeAdvance.issued_at.desc(), EmployeeAdvance.id.desc())
    if not actor.has_permission("finance.manage"):
        stmt = stmt.where(EmployeeAdvance.employee_id == actor.id)
    return db.session.scalars(stmt).all()


def list_claims(actor):
    stmt = select(ExpenseClaim).order_by(ExpenseClaim.submitted_at.desc(), ExpenseClaim.id.desc())
    stmt = stmt.options(joinedload(ExpenseClaim.advance))
    if not actor.has_permission("finance.manage"):
        stmt = stmt.where(ExpenseClaim.employee_id == actor.id)
    return db.session.scalars(stmt).all()


def get_claim(actor, claim_id):
    claim = db.session.get(ExpenseClaim, claim_id)
    if claim is None:
        raise ValidationError("Expense claim not found.")
    if claim.employee_id != actor.id and not actor.has_permission("finance.manage"):
        raise ValidationError("Expense claim not found.")
    return claim


def request_advance(actor, amount, reason, service_request_id=None):
    require(actor, "finance.claim")
    service = _linked_job(actor, service_request_id)
    amount = parse_money(amount, "Requested amount", required=True)
    if amount <= 0:
        raise ValidationError("Requested amount must be greater than zero.")
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise ValidationError("Explain why the advance is needed.")
    pending = db.session.scalar(select(EmployeeAdvanceRequest.id).where(
        EmployeeAdvanceRequest.employee_id == actor.id,
        EmployeeAdvanceRequest.status.in_(("requested", "approved")),
    ).limit(1))
    if pending:
        raise ValidationError("You already have an advance request awaiting approval or issuance.")
    request = EmployeeAdvanceRequest(employee_id=actor.id, service_request_id=service.id if service else None,
                                     requested_amount=amount, reason=reason[:500])
    db.session.add(request)
    db.session.flush()
    audit.log("finance.advance_request", "employee_advance_request", request.id,
              new={"amount": amount, "reason": reason, "service_id": service.service_id if service else None},
              user=actor)
    db.session.commit()
    return request


def list_advance_requests(actor):
    stmt = select(EmployeeAdvanceRequest).order_by(
        EmployeeAdvanceRequest.requested_at.desc(), EmployeeAdvanceRequest.id.desc()
    )
    if not actor.has_permission("finance.manage"):
        stmt = stmt.where(EmployeeAdvanceRequest.employee_id == actor.id)
    return db.session.scalars(stmt).all()


def issue_approved_advance(actor, request_id, payment_method="cash", external_reference=None):
    require(actor, "finance.manage")
    advance_request = db.session.execute(
        select(EmployeeAdvanceRequest).where(
            EmployeeAdvanceRequest.id == request_id
        ).with_for_update()
    ).scalar_one_or_none()
    if advance_request is None or advance_request.status != "approved":
        raise ValidationError("Only an approved advance request can be issued.")
    if advance_request.employee_id == actor.id:
        raise ValidationError("You cannot issue your own employee advance.")
    return issue_advance(
        actor, advance_request.employee_id, advance_request.approved_amount,
        advance_request.reason, external_reference, payment_method, advance_request.id,
    )


def approve_advance_request(actor, request_id, approved_amount=None):
    require(actor, "finance.manage")
    request = db.session.execute(
        select(EmployeeAdvanceRequest).where(EmployeeAdvanceRequest.id == request_id).with_for_update()
    ).scalar_one_or_none()
    if request is None or request.status != "requested":
        raise ValidationError("Only a pending advance request can be approved.")
    if request.employee_id == actor.id:
        raise ValidationError("You cannot approve your own advance request.")
    amount = parse_money(approved_amount or request.requested_amount, "Approved amount", required=True)
    if amount <= 0 or amount > request.requested_amount:
        raise ValidationError("Approved amount must be greater than zero and no more than requested.")
    request.status = "approved"
    request.approved_amount = amount
    request.approved_by_id = actor.id
    request.approved_at = utcnow()
    audit.log("finance.advance_request_approve", "employee_advance_request", request.id,
              new={"approved_amount": amount}, user=actor)
    db.session.commit()
    return request


def reject_advance_request(actor, request_id, reason):
    require(actor, "finance.manage")
    request = db.session.execute(
        select(EmployeeAdvanceRequest).where(EmployeeAdvanceRequest.id == request_id).with_for_update()
    ).scalar_one_or_none()
    reason = (reason or "").strip()
    if request is None or request.status != "requested":
        raise ValidationError("Only a pending advance request can be rejected.")
    if request.employee_id == actor.id:
        raise ValidationError("You cannot reject your own advance request.")
    if len(reason) < 3:
        raise ValidationError("Give a reason for rejecting the request.")
    request.status = "rejected"
    request.rejection_reason = reason[:500]
    request.approved_by_id = actor.id
    request.approved_at = utcnow()
    audit.log("finance.advance_request_reject", "employee_advance_request", request.id,
              new={"reason": request.rejection_reason}, user=actor)
    db.session.commit()
    return request


def issue_advance(actor, employee_id, amount, reason, external_reference=None,
                  payment_method="cash", request_id=None):
    require(actor, "finance.manage")
    if request_id is None:
        raise ValidationError("Employee advances can only be issued from an approved request.")
    employee = db.session.get(User, employee_id)
    if employee is None or not employee.is_active:
        raise ValidationError("Choose an active employee.")
    amount = parse_money(amount, "Advance amount", required=True)
    if amount <= 0:
        raise ValidationError("Advance amount must be greater than zero.")
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise ValidationError("Enter a reason for the advance.")
    external_reference = (external_reference or "").strip() or None
    if external_reference and len(external_reference) > 100:
        raise ValidationError("Advance reference must be 100 characters or fewer.")
    if payment_method not in ("cash", "bank_transfer", "upi", "cheque", "other"):
        raise ValidationError("Choose a valid advance payment method.")
    advance_request = None
    if request_id is not None:
        advance_request = db.session.execute(
            select(EmployeeAdvanceRequest).where(
                EmployeeAdvanceRequest.id == request_id
            ).with_for_update()
        ).scalar_one_or_none()
        if (advance_request is None or advance_request.status != "approved"
                or advance_request.employee_id != employee.id):
            raise ValidationError("Only an approved request for this employee can be issued.")
        if amount > advance_request.approved_amount:
            raise ValidationError("Issued amount cannot exceed the approved amount.")
    advance = EmployeeAdvance(
        advance_number=_number("ADV", "advance"),
        employee_id=employee.id,
        service_request_id=advance_request.service_request_id if advance_request is not None else None,
        amount=amount,
        reason=reason[:500],
        external_reference=external_reference,
        issued_by_id=actor.id,
    )
    db.session.add(advance)
    db.session.flush()
    if advance_request is not None:
        advance_request.status = "issued"
        advance_request.issued_advance_id = advance.id
    financial_ledger.post(
        actor, "employee_advance_issued", "employee_advance", advance.id, "issued",
        advance.issued_at, "asset:employee_advances",
        "asset:cash" if payment_method == "cash" else "asset:bank",
        amount, f"Employee advance {advance.advance_number} to {employee.full_name}: {reason}",
        reference=external_reference or advance.advance_number,
    )
    audit.log("finance.advance_issue", "employee_advance", advance.id,
              new={"employee": employee.staff_code, "amount": amount, "reason": reason,
                   "external_reference": external_reference, "method": payment_method,
                   "request_id": request_id}, user=actor)
    db.session.commit()
    return advance


def customer_advance_balance(advance, *, lock=False):
    if lock:
        db.session.execute(
            select(CustomerAdvance).where(CustomerAdvance.id == advance.id).with_for_update()
        ).scalar_one()
    applied = db.session.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
        Payment.customer_advance_id == advance.id,
        Payment.payment_type == "payment",
    ))
    return Decimal(advance.amount) - Decimal(applied)


def list_customer_advances(customer_id=None):
    stmt = select(CustomerAdvance).order_by(CustomerAdvance.received_at.desc(), CustomerAdvance.id.desc())
    if customer_id is not None:
        stmt = stmt.where(CustomerAdvance.customer_id == customer_id)
    return db.session.scalars(stmt).all()


def receive_customer_advance(actor, customer_id, amount, method, reference, notes=None, received_at=None):
    require(actor, "finance.manage")
    customer = db.session.get(Customer, customer_id)
    if customer is None or not customer.is_active:
        raise ValidationError("Choose an active customer.")
    amount = parse_money(amount, "Customer advance", required=True)
    if amount <= 0:
        raise ValidationError("Customer advance must be greater than zero.")
    if method not in PAYMENT_METHODS or method == "customer_credit":
        raise ValidationError("Choose a valid receipt method.")
    reference = (reference or "").strip() or None
    if reference and db.session.scalar(select(CustomerAdvance.id).where(
        func.lower(CustomerAdvance.reference) == reference.lower()
    ).limit(1)):
        raise ValidationError("That customer advance reference has already been used.")
    advance = CustomerAdvance(
        advance_number=_number("CAD", "customer_advance"),
        customer_id=customer.id,
        amount=amount,
        method=method,
        reference=reference,
        received_at=received_at or utcnow(),
        received_by_id=actor.id,
        notes=(notes or "").strip()[:500] or None,
    )
    db.session.add(advance)
    db.session.flush()
    financial_ledger.post(
        actor, "customer_advance_received", "customer_advance", advance.id, "received",
        advance.received_at, "asset:cash" if method == "cash" else "asset:bank",
        "liability:customer_deposits", amount,
        f"Customer advance {advance.advance_number} received from {customer.name}",
        reference=reference or advance.advance_number,
    )
    audit.log("finance.customer_advance_received", "customer_advance", advance.id,
              new={"customer_id": customer.id, "amount": amount, "method": method,
                   "reference": reference}, user=actor)
    db.session.commit()
    return advance


def apply_customer_advance(actor, advance_id, invoice_id, amount):
    require(actor, "payment.record")
    advance = db.session.execute(
        select(CustomerAdvance).where(CustomerAdvance.id == advance_id).with_for_update()
    ).scalar_one_or_none()
    if advance is None:
        raise ValidationError("Customer advance was not found.")
    invoice = db.session.get(Invoice, invoice_id)
    if invoice is None or invoice.service.customer_id != advance.customer_id:
        raise ValidationError("The advance and invoice must belong to the same customer.")
    amount = parse_money(amount, "Applied amount", required=True)
    available = customer_advance_balance(advance)
    if amount <= 0 or amount > available:
        raise ValidationError(f"Applied amount must be greater than zero and no more than {available:.2f}.")
    if amount > invoice.balance:
        raise ValidationError(f"Applied amount cannot exceed the invoice balance of {invoice.balance:.2f}.")
    from . import invoice_service
    return invoice_service.record_payment(
        actor, invoice.id, "payment", amount, "customer_credit",
        reference=advance.advance_number, customer_advance_id=advance.id,
    )


def return_advance(actor, advance_id, amount, note=None):
    require(actor, "finance.manage")
    advance = db.session.execute(
        select(EmployeeAdvance).where(EmployeeAdvance.id == advance_id).with_for_update()
    ).scalar_one_or_none()
    if advance is None:
        raise ValidationError("Advance not found.")
    amount = parse_money(amount, "Return amount", required=True)
    outstanding = advance_outstanding(advance)
    if amount <= 0 or amount > outstanding:
        raise ValidationError(f"Return amount must be greater than zero and no more than {outstanding:.2f}.")
    entry = AdvanceReturn(advance_id=advance.id, amount=amount, note=(note or "").strip()[:500] or None,
                          received_by_id=actor.id)
    db.session.add(entry)
    financial_ledger.post(
        actor, "employee_advance_return", "advance_return", entry.id, "returned",
        entry.returned_at, "asset:cash", "asset:employee_advances", amount,
        f"Return of unused advance {advance.advance_number}", reference=advance.advance_number,
    )
    audit.log("finance.advance_return", "employee_advance", advance.id,
              new={"amount": amount, "note": entry.note}, user=actor)
    db.session.commit()
    return entry


def submit_claim(actor, category, description, amount, incurred_on, advance_id=None, receipt_reference=None,
                 employee_id=None, service_request_id=None):
    if actor.has_permission("finance.manage"):
        employee_id = int(employee_id or actor.id)
        employee = db.session.get(User, employee_id)
        if employee is None or not employee.is_active:
            raise ValidationError("Choose an active employee for the claim.")
    else:
        if employee_id is not None and int(employee_id) != actor.id:
            raise ValidationError("You can only submit a claim for yourself.")
        require(actor, "finance.claim")
        employee_id = actor.id
    if category not in CLAIM_CATEGORIES:
        raise ValidationError("Choose a valid expense category.")
    description = (description or "").strip()
    if len(description) < 3:
        raise ValidationError("Describe the expense.")
    amount = parse_money(amount, "Claim amount", required=True)
    if amount <= 0:
        raise ValidationError("Claim amount must be greater than zero.")
    if not incurred_on:
        raise ValidationError("Enter the date the expense was incurred.")
    if incurred_on > local_today():
        raise ValidationError("The expense date cannot be in the future.")
    advance = None
    if advance_id:
        advance = db.session.get(EmployeeAdvance, advance_id)
        if advance is None or advance.employee_id != employee_id:
            raise ValidationError("Choose one of your own advances.")
        if advance_outstanding(advance) <= 0:
            raise ValidationError("That advance has no remaining balance.")
        if service_request_id and advance.service_request_id and int(service_request_id) != advance.service_request_id:
            raise ValidationError("An advance settlement must use the same Job Order as its advance.")
        service_request_id = service_request_id or advance.service_request_id
    service = _linked_job(actor, service_request_id)
    claim = ExpenseClaim(
        claim_number=_number("CLM", "expense_claim"),
        employee_id=employee_id,
        advance_id=advance.id if advance else None,
        service_request_id=service.id if service else None,
        category=category,
        description=description[:500],
        receipt_reference=(receipt_reference or "").strip()[:120] or None,
        incurred_on=incurred_on,
        amount=amount,
    )
    db.session.add(claim)
    db.session.flush()
    audit.log("finance.claim_submit", "expense_claim", claim.id,
              new={"employee_id": employee_id, "amount": amount, "category": category,
                   "advance_id": claim.advance_id, "service_id": service.service_id if service else None,
                   "receipt_reference": claim.receipt_reference}, user=actor)
    db.session.commit()
    return claim


def approve_claim(actor, claim_id):
    require(actor, "finance.manage")
    claim = db.session.execute(
        select(ExpenseClaim).where(ExpenseClaim.id == claim_id).with_for_update()
    ).scalar_one_or_none()
    if claim is None or claim.status != "submitted":
        raise ValidationError("Only a submitted claim can be approved.")
    if claim.employee_id == actor.id:
        raise ValidationError("You cannot approve your own expense claim.")
    offset = ZERO
    if claim.advance_id is not None:
        advance = db.session.execute(
            select(EmployeeAdvance).where(EmployeeAdvance.id == claim.advance_id).with_for_update()
        ).scalar_one_or_none()
        if advance is None:
            raise ValidationError("The linked advance no longer exists.")
        if advance.employee_id != claim.employee_id:
            raise ValidationError("The linked advance belongs to another employee.")
        offset = min(Decimal(claim.amount), advance_outstanding(advance))
    claim.advance_offset = offset
    claim.approved_by_id = actor.id
    claim.approved_at = utcnow()
    claim.status = "paid" if offset == Decimal(claim.amount) else "approved"
    if offset > 0:
        financial_ledger.post(
            actor, "employee_claim_advance_offset", "expense_claim", claim.id, "advance_offset",
            claim.approved_at, "expense:employee_claims", "asset:employee_advances", offset,
            f"Expense claim {claim.claim_number} offset against employee advance",
            reference=claim.claim_number,
        )
    due = Decimal(claim.amount) - offset
    if due > 0:
        financial_ledger.post(
            actor, "employee_claim_approved", "expense_claim", claim.id, "reimbursement_due",
            claim.approved_at, "expense:employee_claims", "liability:employee_reimbursements", due,
            f"Approved employee claim {claim.claim_number}", reference=claim.claim_number,
        )
    audit.log("finance.claim_approve", "expense_claim", claim.id,
              new={"amount": claim.amount, "advance_offset": offset,
                   "reimbursement_due": claim.amount - offset}, user=actor)
    db.session.commit()
    return claim


def reject_claim(actor, claim_id, reason):
    require(actor, "finance.manage")
    claim = db.session.execute(
        select(ExpenseClaim).where(ExpenseClaim.id == claim_id).with_for_update()
    ).scalar_one_or_none()
    reason = (reason or "").strip()
    if claim is None or claim.status != "submitted":
        raise ValidationError("Only a submitted claim can be rejected.")
    if claim.employee_id == actor.id:
        raise ValidationError("You cannot reject your own expense claim.")
    if len(reason) < 3:
        raise ValidationError("Give a reason for rejecting the claim.")
    claim.status, claim.rejection_reason = "rejected", reason[:500]
    audit.log("finance.claim_reject", "expense_claim", claim.id, new={"reason": claim.rejection_reason}, user=actor)
    db.session.commit()
    return claim


def pay_claim(actor, claim_id, method):
    require(actor, "finance.manage")
    if method not in ("cash", "bank_transfer", "upi", "cheque", "other"):
        raise ValidationError("Choose a valid payout method.")
    claim = db.session.execute(
        select(ExpenseClaim).where(ExpenseClaim.id == claim_id).with_for_update()
    ).scalar_one_or_none()
    if claim is None or claim.status != "approved":
        raise ValidationError("Only an approved claim with a payout due can be paid.")
    due = Decimal(claim.amount) - Decimal(claim.advance_offset)
    if due <= 0:
        raise ValidationError("This claim has no reimbursement due.")
    claim.reimbursement_paid = due
    claim.reimbursement_method = method
    claim.paid_at = utcnow()
    claim.status = "paid"
    financial_ledger.post(
        actor, "employee_claim_reimbursement", "expense_claim", claim.id, "reimbursement_paid",
        claim.paid_at, "liability:employee_reimbursements",
        "asset:cash" if method == "cash" else "asset:bank", due,
        f"Expense reimbursement {claim.claim_number}: {claim.description}", reference=claim.claim_number,
    )
    audit.log("finance.claim_pay", "expense_claim", claim.id,
              new={"amount": due, "method": method}, user=actor)
    db.session.commit()
    return claim


def record_cash_entry(actor, direction, category, amount, description, reference=None, occurred_at=None):
    require(actor, "finance.manage")
    if direction not in ("in", "out") or category not in CASH_CATEGORIES:
        raise ValidationError("Choose a valid cash direction and category.")
    if (direction == "out" and category != "expense") or (
        direction == "in" and category not in ("income", "opening")
    ):
        raise ValidationError("Cash in must be other income or an opening balance; cash out must be other expense.")
    amount = parse_money(amount, "Amount", required=True)
    if amount <= 0:
        raise ValidationError("Amount must be greater than zero.")
    description = (description or "").strip()
    if len(description) < 3:
        raise ValidationError("Describe the cash movement.")
    entry = CashEntry(
        entry_number=_number("CASH", "cash_entry"),
        direction=direction,
        category=category,
        amount=amount,
        description=description[:500],
        reference=(reference or "").strip()[:120] or None,
        occurred_at=occurred_at or utcnow(),
        recorded_by_id=actor.id,
    )
    db.session.add(entry)
    db.session.flush()
    debit_account, credit_account = (
        ("asset:cash", "income:other") if category == "income" else
        ("expense:other", "asset:cash") if category == "expense" else
        ("asset:cash", "equity:opening")
    )
    financial_ledger.post(
        actor, "cash_entry", "cash_entry", entry.id, "recorded", entry.occurred_at,
        debit_account, credit_account, amount, description, reference=reference or entry.entry_number,
    )
    audit.log("finance.cash_entry", "cash_entry", entry.id,
              new={"direction": direction, "category": category, "amount": amount,
                   "description": description}, user=actor)
    db.session.commit()
    return entry


def cash_movements(start=None, end=None, limit=1000):
    stmt = select(FinancialTransaction).where(
        (FinancialTransaction.debit_account == "asset:cash")
        | (FinancialTransaction.credit_account == "asset:cash"),
        *_bounds(start, end, FinancialTransaction.occurred_at),
    ).order_by(FinancialTransaction.occurred_at.desc(), FinancialTransaction.id.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    return [{
        "at": entry.occurred_at,
        "direction": "in" if entry.debit_account == "asset:cash" else "out",
        "amount": entry.amount,
        "reference": entry.reference or f"FTX-{entry.id}",
        "description": entry.description,
        "source": entry.transaction_type.replace("_", " "),
    } for entry in db.session.scalars(stmt)]


def payment_receipts(start=None, end=None, limit=1000):
    stmt = select(Payment).where(
        Payment.payment_type == "payment",
        Payment.method != "customer_credit",
        *_bounds(start, end, Payment.paid_at),
    ).options(
        joinedload(Payment.invoice).joinedload(Invoice.service)
    ).order_by(Payment.paid_at.desc(), Payment.id.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    return db.session.scalars(stmt).all()


def cash_balance(as_of=None):
    end = as_of or local_today()
    return financial_ledger.balance("asset:cash", end=end)


def financial_report(start=None, end=None):
    entries = db.session.scalars(
        select(FinancialTransaction).where(
            (FinancialTransaction.debit_account.like("expense:%"))
            | (FinancialTransaction.credit_account.like("expense:%"))
            | (FinancialTransaction.debit_account.like("income:%"))
            | (FinancialTransaction.credit_account.like("income:%")),
            *_bounds(start, end, FinancialTransaction.occurred_at),
        ).order_by(FinancialTransaction.occurred_at.desc(), FinancialTransaction.id.desc())
    ).all()
    rows = []
    for entry in entries:
        income = Decimal(entry.amount) if entry.credit_account.startswith("income:") else ZERO
        expense = Decimal(entry.amount) if entry.debit_account.startswith("expense:") else ZERO
        if entry.debit_account.startswith("income:"):
            income -= Decimal(entry.amount)
        if entry.credit_account.startswith("expense:"):
            expense -= Decimal(entry.amount)
        category = {
            "service_revenue": "Service revenue",
            "service_returns": "Customer refunds",
            "employee_claims": "Employee claims",
            "other": "Other income/expense",
            "invoice_writeoff": "Invoice write-off",
        }
        account = entry.credit_account if income > 0 else entry.debit_account if income < 0 else (
            entry.debit_account if expense > 0 else entry.credit_account
        )
        rows.append({
            "at": entry.occurred_at,
            "category": category.get(account.split(":", 1)[-1], entry.transaction_type.replace("_", " ").title()),
            "reference": entry.reference or f"FTX-{entry.id}",
            "description": entry.description,
            "income": income,
            "expense": expense,
        })
    return rows


def report_totals(start=None, end=None):
    entries = db.session.scalars(select(FinancialTransaction).where(
        (FinancialTransaction.debit_account.like("expense:%"))
        | (FinancialTransaction.credit_account.like("expense:%"))
        | (FinancialTransaction.debit_account.like("income:%"))
        | (FinancialTransaction.credit_account.like("income:%")),
        *_bounds(start, end, FinancialTransaction.occurred_at),
    )).all()
    income = sum((
        Decimal(entry.amount) * (
            (1 if entry.credit_account.startswith("income:") else 0)
            - (1 if entry.debit_account.startswith("income:") else 0)
        ) for entry in entries
    ), start=ZERO)
    expense = sum((
        Decimal(entry.amount) * (
            (1 if entry.debit_account.startswith("expense:") else 0)
            - (1 if entry.credit_account.startswith("expense:") else 0)
        ) for entry in entries
    ), start=ZERO)
    return {"income": income, "expense": expense, "net": income - expense}
