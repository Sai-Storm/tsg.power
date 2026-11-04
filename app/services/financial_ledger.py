"""Single immutable double-entry ledger for cash, liabilities, income, and expenses."""
from decimal import Decimal

from sqlalchemy import func, select

from ..extensions import db
from ..models import FinancialTransaction
from ..utils.time import utcnow
from .errors import ValidationError


def post(actor, transaction_type, source_type, source_id, event_key, occurred_at,
         debit_account, credit_account, amount, description, reference=None, reverses_id=None):
    amount = Decimal(amount)
    if amount <= 0:
        return None
    if not debit_account or not credit_account or debit_account == credit_account:
        raise ValidationError("A financial journal entry must have distinct debit and credit accounts.")
    if db.session.scalar(select(FinancialTransaction.id).where(
        FinancialTransaction.source_type == source_type,
        FinancialTransaction.source_id == str(source_id),
        FinancialTransaction.event_key == event_key,
    ).limit(1)):
        raise ValidationError(f"The {transaction_type.replace('_', ' ')} is already posted to the financial ledger.")
    entry = FinancialTransaction(
        transaction_type=transaction_type,
        source_type=source_type,
        source_id=str(source_id),
        event_key=event_key,
        occurred_at=occurred_at or utcnow(),
        debit_account=debit_account,
        credit_account=credit_account,
        amount=amount,
        reference=(reference or "")[:120] or None,
        description=(description or transaction_type.replace("_", " ").title())[:500],
        actor_id=actor.id if actor is not None else None,
        reverses_id=reverses_id,
    )
    db.session.add(entry)
    db.session.flush()
    return entry


def reverse(actor, entry, reason, occurred_at=None):
    if entry.reverses_id is not None:
        raise ValidationError("A reversal cannot itself be reversed.")
    if db.session.scalar(select(FinancialTransaction.id).where(
        FinancialTransaction.reverses_id == entry.id
    ).limit(1)):
        raise ValidationError("This financial transaction has already been reversed.")
    return post(
        actor, "reversal", "financial_transaction", entry.id, "reversal",
        occurred_at or utcnow(), entry.credit_account, entry.debit_account, entry.amount,
        reason, reference=entry.reference, reverses_id=entry.id,
    )


def balance(account, start=None, end=None):
    debit_query = select(func.coalesce(func.sum(FinancialTransaction.amount), 0)).where(
        FinancialTransaction.debit_account == account
    )
    credit_query = select(func.coalesce(func.sum(FinancialTransaction.amount), 0)).where(
        FinancialTransaction.credit_account == account
    )
    if start is not None:
        from ..utils.time import local_to_utc
        from datetime import datetime, time
        lower = local_to_utc(datetime.combine(start, time.min))
        debit_query = debit_query.where(FinancialTransaction.occurred_at >= lower)
        credit_query = credit_query.where(FinancialTransaction.occurred_at >= lower)
    if end is not None:
        from ..utils.time import local_to_utc
        from datetime import datetime, time, timedelta
        upper = local_to_utc(datetime.combine(end + timedelta(days=1), time.min))
        debit_query = debit_query.where(FinancialTransaction.occurred_at < upper)
        credit_query = credit_query.where(FinancialTransaction.occurred_at < upper)
    debit = Decimal(db.session.scalar(debit_query))
    credit = Decimal(db.session.scalar(credit_query))
    return debit - credit
