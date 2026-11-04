"""All money arithmetic lives here: Decimal only, half-up rounding to 2 places, no client-supplied totals."""
from decimal import ROUND_HALF_UP, Decimal

from .errors import ValidationError

Q2 = Decimal("0.01")
ZERO = Decimal("0.00")


def r2(value):
    return Decimal(value).quantize(Q2, rounding=ROUND_HALF_UP)


def line_total(quantity, unit_price):
    return r2(Decimal(quantity) * Decimal(unit_price))


def compute_totals(subtotal, discount=ZERO, tax_rate=ZERO, apply_tax=True):
    """subtotal - discount = taxable; tax = taxable * rate; total = taxable + tax. Discount may not exceed the subtotal."""
    subtotal, discount, tax_rate = r2(subtotal), r2(discount), Decimal(tax_rate)
    if subtotal < 0:
        raise ValidationError("Subtotal cannot be negative.")
    if discount < 0:
        raise ValidationError("Discount cannot be negative.")
    if discount > subtotal:
        raise ValidationError("The discount cannot be larger than the subtotal.")
    taxable = subtotal - discount
    tax = r2(taxable * tax_rate / Decimal(100)) if apply_tax else ZERO
    return {"subtotal": subtotal, "discount": discount, "taxable": taxable, "tax_amount": tax, "total": taxable + tax}
