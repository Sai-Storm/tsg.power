import re

PHONE_PATTERN = r"^[0-9+\-\s()]{7,25}$"


def phone_digits(raw):
    return re.sub(r"\D", "", raw or "")


def is_valid_phone(raw):
    return 7 <= len(phone_digits(raw)) <= 15


def normalize_phone(raw):
    """Digits only; keeps the last 10 digits so +91 98765 43210, 098765 43210 and 9876543210 all match."""
    digits = phone_digits(raw)
    return digits[-10:] if len(digits) > 10 else digits
