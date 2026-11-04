from flask_wtf import FlaskForm
from wtforms import PasswordField, SelectField, StringField
from wtforms.validators import DataRequired, EqualTo, Length, Optional, Regexp

AVAILABILITY_CHOICES = [("available", "Available"), ("busy", "Busy"), ("on_leave", "On leave")]


class StaffForm(FlaskForm):
    full_name = StringField("Full name", validators=[DataRequired(), Length(min=2, max=120)])
    email = StringField("Email", validators=[DataRequired(), Length(max=120)])
    phone = StringField(
        "Contact number",
        validators=[Optional(), Regexp(r"^[0-9+\-\s()]{7,20}$", message="Enter a valid phone number.")],
    )
    role_id = SelectField("Role", coerce=int)
    specialization = StringField("Specialization", validators=[Optional(), Length(max=100)])
    availability = SelectField("Availability", choices=AVAILABILITY_CHOICES, default="available")
    password = PasswordField("Password", validators=[Optional(), Length(max=128)])
    confirm_password = PasswordField(
        "Confirm password", validators=[EqualTo("password", message="Passwords do not match.")]
    )
