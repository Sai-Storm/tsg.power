from flask_wtf import FlaskForm
from wtforms import SelectField, StringField, TextAreaField
from wtforms.validators import DataRequired, Length, Optional, Regexp

from ...utils.validators import PHONE_PATTERN

PHONE_MSG = "Enter a valid phone number."


class CustomerForm(FlaskForm):
    name = StringField("Customer or company name", validators=[DataRequired(), Length(min=2, max=150)])
    customer_type = SelectField("Customer type", choices=[("individual", "Individual"), ("business", "Business")])
    contact_person = StringField("Contact person", validators=[Optional(), Length(max=120)])
    phone_primary = StringField("Primary phone", validators=[DataRequired(), Regexp(PHONE_PATTERN, message=PHONE_MSG)])
    phone_alt = StringField("Alternate phone", validators=[Optional(), Regexp(PHONE_PATTERN, message=PHONE_MSG)])
    email = StringField("Email", validators=[Optional(), Length(max=120)])
    address = TextAreaField("Full address", validators=[Optional(), Length(max=1000)], render_kw={"rows": 2})
    city = StringField("City", validators=[Optional(), Length(max=80)])
    state = StringField("State", validators=[Optional(), Length(max=80)])
    notes = TextAreaField("Notes", validators=[Optional(), Length(max=2000)], render_kw={"rows": 3})
