"""Invoices and payments. Draft -> Issued -> Partially paid -> Paid (or Void).
Totals are always recomputed here from line items; the balance is re-verified from the payment records."""
from datetime import datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import Customer, CustomerAdvance, FinancialTransaction, Generator, Invoice, InvoiceItem, Payment, ServiceRequest
from ..models.billing import PAYMENT_METHODS
from ..utils.time import local_now, local_to_utc, local_today, utcnow
from ..utils.validators import phone_digits
from . import audit, estimate_service, financial_ledger, service_request_service as svc, settings_service
from .billing_math import ZERO, compute_totals, line_total, r2
from .common import fmt_qty, parse_money, parse_qty, require
from .errors import PermissionDenied, ValidationError
from .id_generator import new_invoice_number, new_payment_number

SORTS = {"issued": Invoice.issued_at, "total": Invoice.total, "created": Invoice.created_at,
         "number": Invoice.invoice_number}


def _lock_invoice(invoice_id):
    inv = db.session.execute(select(Invoice).where(Invoice.id == invoice_id).with_for_update()
                             .execution_options(populate_existing=True)).scalar_one_or_none()
    if inv is None:
        raise ValidationError("Invoice not found.")
    return inv


def _recalc(inv):
    db.session.flush()
    db.session.expire(inv, ["items"])
    subtotal = sum((i.line_total for i in inv.items), start=ZERO)
    try:
        t = compute_totals(subtotal, inv.discount, inv.tax_rate, True)
    except ValidationError:
        db.session.rollback()  # undo the half-applied edit so the invoice is left exactly as it was
        raise ValidationError("The discount is larger than the new subtotal. Lower the discount first.")
    inv.subtotal, inv.tax_amount, inv.total = t["subtotal"], t["tax_amount"], t["total"]


def _snap(inv):
    return {"number": inv.invoice_number, "service": inv.service.service_id, "status": inv.status,
            "subtotal": inv.subtotal, "discount": inv.discount, "tax": inv.tax_amount, "total": inv.total,
            "paid": inv.amount_paid, "adjustments": inv.adjustment_total}


def _refresh_status(inv):
    if inv.status in ("issued", "partial", "paid"):
        if inv.balance <= 0:
            inv.status = "paid"
        elif inv.amount_paid + inv.adjustment_total > 0:
            inv.status = "partial"
        else:
            inv.status = "issued"


# ---------------------------------------------------------------- draft
def create_draft(actor, service_pk):
    """Build from an accepted quotation when present, otherwise use completed-job actuals."""
    require(actor, "invoice.manage")
    service = svc.lock_service(service_pk)
    if service.status not in ("completed", "closed"):
        raise ValidationError("An invoice can be created once the job is completed.")
    if service.report_approved_at is None:
        raise ValidationError("A manager must approve the service delivery report before invoicing.")
    live = next((i for i in service.invoices if i.status != "void"), None)
    if live is not None:
        raise ValidationError(f"This job already has {live.display_number}.")
    latest = estimate_service.latest_estimate(service)
    accepted_quote = latest if latest is not None and latest.status == "customer_approved" else None
    rate = accepted_quote.labor_rate if accepted_quote is not None \
        else settings_service.get_decimal("labor_rate_per_hour", "0")
    inv = Invoice(service_request_id=service.id, active_service_id=service.id, status="draft",
                  discount=accepted_quote.discount if accepted_quote is not None else ZERO,
                  discount_reason=accepted_quote.discount_reason if accepted_quote is not None else None,
                  tax_name=settings_service.get("tax_name") or "Tax",
                  tax_rate=(accepted_quote.tax_rate if accepted_quote.apply_tax else ZERO)
                  if accepted_quote is not None else settings_service.get_decimal("tax_rate", "0"),
                  created_by_id=actor.id)
    db.session.add(inv)
    unpriced = 0
    if accepted_quote is not None:
        if accepted_quote.labor_amount > 0:
            inv.items.append(InvoiceItem(item_type="labor", description="Labor", quantity=accepted_quote.labor_hours,
                                         unit="hour", unit_price=rate, line_total=accepted_quote.labor_amount))
        if accepted_quote.parts_amount > 0:
            inv.items.append(InvoiceItem(item_type="part", description="Parts and materials", quantity=1, unit="lot",
                                         unit_price=accepted_quote.parts_amount, line_total=accepted_quote.parts_amount))
        if accepted_quote.other_amount > 0:
            inv.items.append(InvoiceItem(item_type="other", description=accepted_quote.other_description or "Other",
                                         quantity=1, unit="lot", unit_price=accepted_quote.other_amount,
                                         line_total=accepted_quote.other_amount))
    else:
        if service.labor_hours and service.labor_hours > 0:
            inv.items.append(InvoiceItem(item_type="labor", description="Labor", quantity=service.labor_hours,
                                         unit="hour", unit_price=rate, line_total=line_total(service.labor_hours, rate)))
        for r in service.requirements:
            if r.used_qty <= 0:
                continue
            price = r.unit_price
            if price is None and r.item is not None:
                price = r.item.selling_price
            if price is None:
                price, unpriced = Decimal("0.00"), unpriced + 1
            inv.items.append(InvoiceItem(item_type="part" if r.is_inventory else "other", description=r.description,
                                         quantity=r.used_qty, unit=r.unit, unit_price=price,
                                         line_total=line_total(r.used_qty, price), requirement_id=r.id))
    try:
        _recalc(inv)
        audit.log("invoice.create_draft", "invoice", "new", new={"service": service.service_id, "unpriced": unpriced}, user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("This job already has an invoice.")
    inv.unpriced_lines = unpriced
    return inv


def _draft(actor, invoice_id):
    require(actor, "invoice.manage")
    inv = _lock_invoice(invoice_id)
    if inv.status != "draft":
        raise ValidationError("Issued invoices cannot be edited. Void it and create a new one, or record an adjustment.")
    return inv


def add_item(actor, invoice_id, description, quantity, unit_price, item_type="other"):
    inv = _draft(actor, invoice_id)
    description = (description or "").strip()
    if len(description) < 2:
        raise ValidationError("Describe the charge.")
    qty = parse_qty(quantity, "Quantity")
    price = parse_money(unit_price, "Unit price", required=True)
    inv.items.append(InvoiceItem(item_type=item_type if item_type in ("labor", "part", "other") else "other",
                                 description=description[:200], quantity=qty, unit_price=price,
                                 line_total=line_total(qty, price)))
    _recalc(inv)
    audit.log("invoice.add_item", "invoice", inv.id, new={"description": description, "qty": qty, "price": price}, user=actor)
    db.session.commit()
    return inv


def update_item(actor, invoice_id, item_id, quantity, unit_price, description=None):
    inv = _draft(actor, invoice_id)
    item = next((i for i in inv.items if i.id == item_id), None)
    if item is None:
        raise ValidationError("Line not found.")
    before = {"qty": item.quantity, "price": item.unit_price}
    item.quantity = parse_qty(quantity, "Quantity")
    item.unit_price = parse_money(unit_price, "Unit price", required=True)
    if description and len(description.strip()) >= 2:
        item.description = description.strip()[:200]
    item.line_total = line_total(item.quantity, item.unit_price)
    _recalc(inv)
    audit.log("invoice.update_item", "invoice", inv.id, old=before, new={"qty": item.quantity, "price": item.unit_price}, user=actor)
    db.session.commit()
    return inv


def delete_item(actor, invoice_id, item_id):
    inv = _draft(actor, invoice_id)
    item = next((i for i in inv.items if i.id == item_id), None)
    if item is None:
        raise ValidationError("Line not found.")
    inv.items.remove(item)
    _recalc(inv)
    audit.log("invoice.delete_item", "invoice", inv.id, old={"description": item.description}, user=actor)
    db.session.commit()
    return inv


def set_terms(actor, invoice_id, discount, discount_reason, tax_rate, notes=None):
    """Discount and tax rate on a draft. Only users with invoice.manage (Admin) can authorise a discount."""
    inv = _draft(actor, invoice_id)
    discount = parse_money(discount or 0, "Discount")
    reason = (discount_reason or "").strip()[:200]
    if discount > 0 and len(reason) < 3:
        raise ValidationError("Give a reason for the discount.")
    try:
        rate = Decimal(str(tax_rate if tax_rate not in (None, "") else inv.tax_rate))
    except Exception:
        raise ValidationError("Tax rate must be a number.")
    if rate < 0 or rate > 100:
        raise ValidationError("Tax rate must be between 0 and 100.")
    current_subtotal = sum((i.line_total for i in inv.items), start=ZERO)
    compute_totals(current_subtotal, discount, rate, True)  # raises before anything is changed
    before = {"discount": inv.discount, "tax_rate": inv.tax_rate}
    inv.discount, inv.discount_reason, inv.tax_rate = discount, (reason or None) if discount > 0 else None, rate
    inv.notes = (notes or "").strip() or None
    _recalc(inv)
    audit.log("invoice.set_terms", "invoice", inv.id, old=before, new={"discount": discount, "tax_rate": rate, "reason": reason}, user=actor)
    db.session.commit()
    return inv


def discard_draft(actor, invoice_id):
    inv = _draft(actor, invoice_id)
    audit.log("invoice.discard_draft", "invoice", inv.id, old=_snap(inv), user=actor)
    db.session.delete(inv)
    db.session.commit()


def issue_invoice(actor, invoice_id):
    inv = _draft(actor, invoice_id)
    if inv.service.report_approved_at is None:
        raise ValidationError("A manager must approve the service delivery report before issuing the invoice.")
    if not inv.items:
        raise ValidationError("Add at least one line before issuing the invoice.")
    _recalc(inv)
    inv.invoice_number = new_invoice_number()
    inv.status, inv.issued_at, inv.issued_by_id = "issued", utcnow(), actor.id
    inv.due_date = local_today() + timedelta(days=int(settings_service.get_decimal("payment_terms_days", "15")))
    _refresh_status(inv)  # a zero-value (e.g. warranty) invoice has nothing to collect
    financial_ledger.post(
        actor, "invoice_issued", "invoice", inv.id, "issued", inv.issued_at,
        "asset:accounts_receivable", "income:service_revenue", inv.total,
        f"Invoice {inv.invoice_number} issued for {inv.service.service_id}",
        reference=inv.invoice_number,
    )
    svc.add_event(inv.service, "billing", f"Invoice {inv.invoice_number} issued (total {inv.total})", actor)
    audit.log("invoice.issue", "invoice", inv.id, new=_snap(inv), user=actor)
    db.session.commit()
    return inv


# ---------------------------------------------------------------- payments, refunds, adjustments
def _reconcile(inv):
    """Recompute paid/adjusted from the payment records (the source of truth) and refuse impossible states."""
    sums = dict(db.session.execute(select(Payment.payment_type, func.coalesce(func.sum(Payment.amount), 0))
                                   .where(Payment.invoice_id == inv.id).group_by(Payment.payment_type)).all())
    paid = r2(Decimal(sums.get("payment", 0)) - Decimal(sums.get("refund", 0)))
    adjusted = r2(Decimal(sums.get("adjustment", 0)))
    if paid < 0 or paid + adjusted > inv.total:
        raise ValidationError("That entry would leave the invoice over-paid or with a negative balance.")
    inv.amount_paid, inv.adjustment_total = paid, adjusted
    _refresh_status(inv)


def record_payment(actor, invoice_id, kind, amount, method=None, reference=None, paid_at_local=None, reason=None,
                   customer_advance_id=None):
    require(actor, "payment.record")
    inv = _lock_invoice(invoice_id)
    if kind not in ("payment", "refund", "adjustment"):
        raise ValidationError("Choose payment, refund or adjustment.")
    if inv.status in ("draft", "void"):
        raise ValidationError("Payments can only be recorded against an issued invoice.")
    _reconcile(inv)  # never trust the cached figures: rebuild them from the payment records first
    amount = parse_money(amount, "Amount", required=True)
    if amount <= 0:
        raise ValidationError("Amount must be greater than zero.")
    reason = (reason or "").strip() or None
    if kind in ("refund", "adjustment") and (reason is None or len(reason) < 5):
        raise ValidationError("A reason (at least 5 characters) is required for refunds and adjustments.")
    if kind in ("payment", "refund") and method not in PAYMENT_METHODS:
        raise ValidationError("Select how the money was paid.")
    if kind != "payment" and customer_advance_id is not None:
        raise ValidationError("A customer advance can only be applied as a payment.")
    if method == "customer_credit":
        if customer_advance_id is None:
            raise ValidationError("Choose the customer advance to apply.")
        from . import finance_service
        advance = db.session.execute(
            select(CustomerAdvance).where(CustomerAdvance.id == customer_advance_id).with_for_update()
        ).scalar_one_or_none()
        if advance is None or advance.customer_id != inv.service.customer_id:
            raise ValidationError("The advance and invoice must belong to the same customer.")
        if amount > finance_service.customer_advance_balance(advance):
            raise ValidationError("The amount exceeds the customer's unapplied advance balance.")
    elif customer_advance_id is not None:
        raise ValidationError("Customer advance details do not match the payment method.")
    if kind == "adjustment":
        method = None
    if kind in ("payment", "adjustment") and amount > inv.balance:
        raise ValidationError(f"The amount exceeds the outstanding balance of {inv.balance}.")
    if kind == "refund" and amount > inv.amount_paid:
        raise ValidationError(f"A refund cannot exceed the amount received so far ({inv.amount_paid}).")
    when = local_to_utc(paid_at_local) if paid_at_local else utcnow()
    if when > utcnow() + timedelta(minutes=5):
        raise ValidationError("The payment date cannot be in the future.")
    payment = Payment(invoice_id=inv.id, customer_advance_id=customer_advance_id,
                      payment_type=kind, amount=amount, method=method,
                      reference=(reference or "").strip()[:100] or None, reason=reason, paid_at=when,
                      number=new_payment_number(kind), received_by_id=actor.id)
    db.session.add(payment)
    db.session.flush()
    db.session.expire(inv, ["payments"])
    _reconcile(inv)
    svc.add_event(inv.service, "billing", f"{payment.number}: {kind} of {amount} on {inv.invoice_number}"
                  f" (balance {inv.balance})", actor)
    if kind == "payment" and method == "customer_credit":
        debit_account, credit_account = "liability:customer_deposits", "asset:accounts_receivable"
        transaction_type = "customer_advance_applied"
    elif kind == "payment":
        debit_account = "asset:cash" if method == "cash" else "asset:bank"
        credit_account, transaction_type = "asset:accounts_receivable", "invoice_payment"
    elif kind == "refund":
        debit_account = "asset:accounts_receivable"
        credit_account = "asset:cash" if method == "cash" else "asset:bank"
        transaction_type = "invoice_refund"
    else:
        debit_account, credit_account = "expense:invoice_writeoff", "asset:accounts_receivable"
        transaction_type = "invoice_adjustment"
    financial_ledger.post(
        actor, transaction_type, "payment", payment.id, "posted", payment.paid_at,
        debit_account, credit_account, amount,
        f"{payment.number}: {kind} for invoice {inv.invoice_number}",
        reference=payment.reference or payment.number,
    )
    audit.log(f"payment.{kind}", "invoice", inv.id, new={"number": payment.number, "amount": amount, "method": method,
                                                          "reason": reason, "status": inv.status}, user=actor)
    db.session.commit()
    return payment


def void_invoice(actor, invoice_id, reason):
    require(actor, "invoice.manage")
    inv = _lock_invoice(invoice_id)
    if inv.status in ("draft", "void"):
        raise ValidationError("Only an issued invoice can be voided (drafts can simply be discarded).")
    if len((reason or "").strip()) < 5:
        raise ValidationError("Give a reason (at least 5 characters) for voiding the invoice.")
    _reconcile(inv)
    if inv.amount_paid != 0 or inv.adjustment_total != 0:
        raise ValidationError("Refund all money received (and avoid adjustments) before voiding this invoice.")
    inv.status, inv.active_service_id = "void", None  # frees the job for a corrected invoice; the number is never reused
    inv.void_reason, inv.voided_at, inv.voided_by_id = reason.strip(), utcnow(), actor.id
    svc.add_event(inv.service, "billing", f"Invoice {inv.invoice_number} voided: {reason.strip()}", actor)
    audit.log("invoice.void", "invoice", inv.id, new={**_snap(inv), "reason": reason}, user=actor)
    posted_invoice = db.session.scalar(select(FinancialTransaction).where(
        FinancialTransaction.source_type == "invoice",
        FinancialTransaction.source_id == str(inv.id),
        FinancialTransaction.event_key == "issued",
    ))
    if posted_invoice is not None:
        financial_ledger.reverse(actor, posted_invoice, f"Void invoice {inv.invoice_number}: {reason}")
    db.session.commit()
    return inv


# ---------------------------------------------------------------- queries
def service_financials(service):
    """Estimate vs final figures and payment status for one job."""
    live = next((i for i in service.invoices if i.status != "void"), None)
    est = estimate_service.latest_estimate(service)
    labels = {None: "No invoice", "draft": "Invoice draft", "issued": "Unpaid", "partial": "Partially paid", "paid": "Paid"}
    return {"estimate": est, "invoice": live, "payment_status": labels[live.status if live else None],
            "paid": live.amount_paid if live else ZERO, "balance": live.balance if live else None}


def search_invoices(q=None, status=None, outstanding=False, overdue=False, date_from=None, date_to=None,
                    sort="issued", direction="desc"):
    stmt = (select(Invoice).join(ServiceRequest, Invoice.service_request_id == ServiceRequest.id)
            .join(Customer, ServiceRequest.customer_id == Customer.id)
            .join(Generator, ServiceRequest.generator_id == Generator.id))
    if q:
        query = q.strip()
        like = f"%{query}%"
        conditions = [
            Invoice.invoice_number.ilike(like),
            ServiceRequest.service_id.ilike(like),
            Customer.name.ilike(like),
            Customer.contact_person.ilike(like),
            Customer.customer_code.ilike(like),
            Generator.brand.ilike(like),
            Generator.serial_number.ilike(like),
            Generator.generator_code.ilike(like),
            Generator.model.ilike(like),
        ]
        digits = phone_digits(query)
        if len(digits) >= 4:
            phone_like = f"%{digits}%"
            conditions.extend((
                Customer.normalized_phone.like(phone_like),
                Customer.normalized_phone_alt.like(phone_like),
            ))
        stmt = stmt.where(or_(*conditions))
    if status in ("draft", "issued", "partial", "paid", "void"):
        stmt = stmt.where(Invoice.status == status)
    if outstanding:
        stmt = stmt.where(Invoice.status.in_(("issued", "partial")))
    if overdue:
        stmt = stmt.where(Invoice.status.in_(("issued", "partial")), Invoice.due_date < local_today())
    if date_from:
        stmt = stmt.where(Invoice.issued_at >= local_to_utc(datetime.combine(date_from, time.min)))
    if date_to:
        stmt = stmt.where(Invoice.issued_at < local_to_utc(datetime.combine(date_to + timedelta(days=1), time.min)))
    col = SORTS.get(sort, Invoice.issued_at)
    return stmt.order_by(col.desc() if direction == "desc" else col.asc(), Invoice.id.desc())


def outstanding_summary():
    total, count = db.session.execute(select(
        func.coalesce(func.sum(Invoice.total - Invoice.amount_paid - Invoice.adjustment_total), 0), func.count(Invoice.id)
    ).where(Invoice.status.in_(("issued", "partial")))).one()
    return {"amount": r2(Decimal(total)), "count": count}


def payment_clause(value):
    """SQL filter on a job's payment status (used by the service list)."""
    live = Invoice.service_request_id == ServiceRequest.id
    if value == "none":
        return ~exists().where(live, Invoice.status != "void")
    if value in ("unpaid", "partial", "paid"):
        return exists().where(live, Invoice.status == {"unpaid": "issued"}.get(value, value))
    return None
