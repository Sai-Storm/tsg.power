from flask_wtf import FlaskForm
from wtforms import StringField, TextAreaField
from wtforms.validators import DataRequired, Length, Optional, Regexp

from ...utils.validators import PHONE_PATTERN


class SupplierForm(FlaskForm):
    name = StringField("Supplier name", validators=[DataRequired(), Length(min=2, max=120)])
    contact_person = StringField("Contact person", validators=[Optional(), Length(max=120)])
    phone = StringField("Phone", validators=[Optional(), Regexp(PHONE_PATTERN, message="Enter a valid phone number.")])
    email = StringField("Email", validators=[Optional(), Length(max=120)])
    address = TextAreaField("Address", validators=[Optional(), Length(max=1000)], render_kw={"rows": 2})
    notes = TextAreaField("Notes", validators=[Optional(), Length(max=1000)], render_kw={"rows": 2})
