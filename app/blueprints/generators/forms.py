from flask_wtf import FlaskForm
from wtforms import DateField, DecimalField, SelectField, StringField, TextAreaField
from wtforms.validators import DataRequired, Length, NumberRange, Optional

from ...models.generator import CONDITIONS, FUEL_TYPES


class GeneratorForm(FlaskForm):
    brand = StringField("Brand", validators=[DataRequired(), Length(max=60)])
    model = StringField("Model", validators=[DataRequired(), Length(max=80)])
    serial_number = StringField("Serial number", validators=[DataRequired(), Length(max=40)])
    capacity_kva = DecimalField("Capacity (kVA)", places=2, validators=[DataRequired(), NumberRange(min=0.5, max=20000)])
    fuel_type = SelectField("Fuel type", choices=list(FUEL_TYPES.items()), default="diesel")
    condition = SelectField("Condition", choices=list(CONDITIONS.items()), default="good")
    installation_date = DateField("Installation date", validators=[Optional()])
    location = StringField("Installation location", validators=[Optional(), Length(max=255)])
    warranty_start = DateField("Warranty start", validators=[Optional()])
    warranty_end = DateField("Warranty end", validators=[Optional()])
    last_service_date = DateField("Last service date", validators=[Optional()])
    next_maintenance_date = DateField("Next scheduled maintenance", validators=[Optional()])
    notes = TextAreaField("Notes", validators=[Optional(), Length(max=2000)], render_kw={"rows": 3})
