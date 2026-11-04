from decimal import Decimal, InvalidOperation

from ..models.inventory import COUNTABLE_UNITS
from .errors import PermissionDenied, ValidationError

Q3 = Decimal("0.001")
Q2 = Decimal("0.01")
MAX_QTY = Decimal("1000000")


def require(actor, code):
    if actor is None or not actor.is_authenticated or not actor.has_permission(code):
        raise PermissionDenied("You do not have permission to do that.")


def fmt_qty(value):
    if value is None:
        return "-"
    text = f"{Decimal(value):f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def parse_qty(value, label="Quantity", unit=None, allow_zero=False, allow_negative=False):
    if value is None or str(value).strip() == "":
        raise ValidationError(f"{label} is required.")
    try:
        qty = Decimal(str(value)).quantize(Q3)
    except (InvalidOperation, ValueError):
        raise ValidationError(f"{label} must be a number.")
    if not allow_negative and (qty < 0 or (qty == 0 and not allow_zero)):
        raise ValidationError(f"{label} must be greater than zero.")
    if abs(qty) > MAX_QTY:
        raise ValidationError(f"{label} is too large.")
    if unit in COUNTABLE_UNITS and qty != qty.to_integral_value():
        raise ValidationError(f"{label} must be a whole number for items counted in {unit}s.")
    return qty


def parse_money(value, label="Amount", required=False):
    if value is None or str(value).strip() == "":
        if required:
            raise ValidationError(f"{label} is required.")
        return None
    try:
        amount = Decimal(str(value)).quantize(Q2)
    except (InvalidOperation, ValueError):
        raise ValidationError(f"{label} must be a number.")
    if amount < 0 or amount > Decimal("99999999.99"):
        raise ValidationError(f"{label} must be between 0 and 99,999,999.99.")
    return amount
