from flask_wtf import FlaskForm
from wtforms import BooleanField, DecimalField, SelectField, StringField, TextAreaField
from wtforms.validators import DataRequired, Length, NumberRange, Optional

MONEY = [Optional(), NumberRange(min=0, max=99999999)]


class EstimateForm(FlaskForm):
    labor_hours = DecimalField("Estimated labor hours", places=2, validators=[Optional(), NumberRange(min=0, max=9999.99)])
    labor_rate = DecimalField("Labor rate per hour", places=2, validators=MONEY)
    parts_amount = DecimalField("Estimated parts cost", places=2, validators=MONEY)
    other_amount = DecimalField("Other expenses (transport, external work...)", places=2, validators=MONEY)
    other_description = StringField("What are the other expenses?", validators=[Optional(), Length(max=200)])
    discount = DecimalField("Discount", places=2, validators=MONEY)
    discount_reason = StringField("Reason for discount", validators=[Optional(), Length(max=200)])
    apply_tax = BooleanField("Add tax", default=True)
    notes = TextAreaField("Notes for the customer", validators=[Optional(), Length(max=2000)], render_kw={"rows": 3})


class StandaloneEstimateForm(EstimateForm):
    customer_id = SelectField("Customer", coerce=int, validators=[DataRequired()])
    generator_id = SelectField("Generator", coerce=int, validators=[DataRequired()])
    service_type_id = SelectField("Requested service", coerce=int, validators=[DataRequired()])
    priority_id = SelectField("Priority", coerce=int, validators=[DataRequired()])
    complaint = TextAreaField("Requested work", validators=[DataRequired(), Length(min=5, max=2000)],
                              render_kw={"rows": 3})
    location = StringField("Service location", validators=[Optional(), Length(max=255)])
