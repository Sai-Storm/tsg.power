import os

from flask import Blueprint, abort, flash, redirect, render_template, request, send_file, url_for
from flask_login import current_user, login_required
from flask_wtf import FlaskForm
from wtforms import DecimalField, IntegerField, StringField, TextAreaField
from wtforms.validators import DataRequired, Length, NumberRange, Optional

from ...security.decorators import permission_required
from ...services import settings_service
from ...services.errors import ServiceError

bp = Blueprint("settings", __name__, url_prefix="/settings")


class SettingsForm(FlaskForm):
    company_name = StringField("Company name", validators=[DataRequired(), Length(max=150)])
    company_address = TextAreaField("Address", validators=[Optional(), Length(max=300)], render_kw={"rows": 2})
    company_phone = StringField("Phone", validators=[Optional(), Length(max=50)])
    company_email = StringField("Email", validators=[Optional(), Length(max=120)])
    company_tax_id = StringField("Tax / GST number", validators=[Optional(), Length(max=50)])
    currency_code = StringField("Currency code", validators=[DataRequired(), Length(max=5)])
    currency_symbol = StringField("Currency symbol", validators=[Optional(), Length(max=5)])
    tax_name = StringField("Tax name", validators=[Optional(), Length(max=20)])
    tax_rate = DecimalField("Tax rate (%)", places=2, validators=[DataRequired(), NumberRange(min=0, max=100)])
    labor_rate_per_hour = DecimalField("Labor rate per hour", places=2, validators=[DataRequired(), NumberRange(min=0)])
    payment_terms_days = IntegerField("Payment terms (days)", validators=[NumberRange(min=0, max=365)])
    invoice_footer = StringField("Invoice footer text", validators=[Optional(), Length(max=300)])


@bp.route("/", methods=["GET", "POST"])
@permission_required("settings.manage")
def index():
    current = settings_service.get_all()
    for key in ("tax_rate", "labor_rate_per_hour"):  # number fields need numbers, not text
        current[key] = settings_service.get_decimal(key)
    current["payment_terms_days"] = int(settings_service.get_decimal("payment_terms_days", "15"))
    form = SettingsForm(data=current)
    if form.validate_on_submit():
        try:
            settings_service.save(current_user, {k: v for k, v in form.data.items() if k != "csrf_token"})
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Settings saved.", "success")
            return redirect(url_for("settings.index"))
    return render_template("settings/index.html", form=form, has_logo=bool(settings_service.logo_path()))


@bp.post("/logo")
@permission_required("settings.manage")
def upload_logo():
    f = request.files.get("logo")
    if not f or not f.filename:
        flash("Choose a PNG or JPG logo.", "warning")
    else:
        try:
            settings_service.save_logo(current_user, f)
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Logo updated.", "success")
    return redirect(url_for("settings.index"))


@bp.route("/logo")
@login_required
def logo():
    path = settings_service.logo_path()
    if not path or not os.path.isfile(path):
        abort(404)
    return send_file(path, max_age=0)
