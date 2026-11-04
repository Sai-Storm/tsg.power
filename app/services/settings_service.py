import os
import uuid
from decimal import Decimal, InvalidOperation

from flask import current_app

from ..extensions import db
from ..models import CompanySetting
from ..security.permissions import DEFAULT_SETTINGS
from . import audit
from .common import parse_money, require
from .errors import ValidationError

TEXT_KEYS = ("company_name", "company_address", "company_phone", "company_email", "company_tax_id", "currency_code",
             "currency_symbol", "tax_name", "invoice_footer")


def get(key, default=None):
    value = CompanySetting.get(key)
    return value if value is not None else DEFAULT_SETTINGS.get(key, default)


def get_decimal(key, default="0"):
    try:
        return Decimal(str(get(key, default)))
    except InvalidOperation:
        return Decimal(default)


def get_all():
    return {key: get(key) for key in DEFAULT_SETTINGS}


def save(actor, data):
    require(actor, "settings.manage")
    clean = {}
    name = (data.get("company_name") or "").strip()
    if len(name) < 2:
        raise ValidationError("Company name is required.")
    for key in TEXT_KEYS:
        clean[key] = (data.get(key) or "").strip()[:300]
    clean["company_name"] = name
    if not clean["currency_code"] or len(clean["currency_code"]) > 5:
        raise ValidationError("Enter a currency code such as INR.")
    clean["currency_code"] = clean["currency_code"].upper()
    clean["tax_name"] = clean["tax_name"] or "Tax"
    try:
        rate = Decimal(str(data.get("tax_rate")))
    except InvalidOperation:
        raise ValidationError("Tax rate must be a number.")
    if rate < 0 or rate > 100:
        raise ValidationError("Tax rate must be between 0 and 100.")
    clean["tax_rate"] = f"{rate:.2f}"
    clean["labor_rate_per_hour"] = str(parse_money(data.get("labor_rate_per_hour"), "Labor rate", required=True))
    try:
        terms = int(data.get("payment_terms_days"))
    except (TypeError, ValueError):
        raise ValidationError("Payment terms must be a whole number of days.")
    if not 0 <= terms <= 365:
        raise ValidationError("Payment terms must be between 0 and 365 days.")
    clean["payment_terms_days"] = str(terms)
    before = get_all()
    for key, value in clean.items():
        row = db.session.get(CompanySetting, key)
        if row is None:
            db.session.add(CompanySetting(key=key, value=value))
        else:
            row.value = value
    audit.log("settings.update", "company_settings", "company", old=before, new=clean, user=actor)
    db.session.commit()


def save_logo(actor, file_storage):
    """Company logo for PDFs. Re-encoded through the same image checks as other uploads."""
    from .upload_service import _inspect, MAX_BYTES
    require(actor, "settings.manage")
    name = (file_storage.filename or "").lower()
    if not name.endswith((".png", ".jpg", ".jpeg")):
        raise ValidationError("The logo must be a PNG or JPG image.")
    data = file_storage.stream.read(MAX_BYTES + 1)
    if not data or len(data) > 2 * 1024 * 1024:
        raise ValidationError("The logo must be an image of 2 MB or smaller.")
    fmt, payload = _inspect(data, "png" if name.endswith(".png") else "jpg")
    folder = os.path.join(os.path.realpath(current_app.config["UPLOAD_FOLDER"]), "company")
    os.makedirs(folder, exist_ok=True)
    stored = f"{uuid.uuid4().hex}.{'png' if fmt == 'PNG' else 'jpg'}"
    with open(os.path.join(folder, stored), "wb") as fh:
        fh.write(payload)
    row = db.session.get(CompanySetting, "company_logo")
    old = row.value if row else ""
    if row is None:
        db.session.add(CompanySetting(key="company_logo", value=stored))
    else:
        row.value = stored
    audit.log("settings.logo", "company_settings", "company_logo", old={"file": old}, new={"file": stored}, user=actor)
    db.session.commit()
    return stored


def logo_path():
    name = get("company_logo")
    if not name:
        return os.path.join(current_app.root_path, "static", "img", "tsg-logo.png")
    if "/" in name or "\\" in name:
        return None
    path = os.path.join(os.path.realpath(current_app.config["UPLOAD_FOLDER"]), "company", name)
    return path if os.path.isfile(path) else None
