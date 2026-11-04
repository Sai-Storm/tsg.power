from flask_wtf import FlaskForm
from wtforms import (DateField, DateTimeLocalField, DecimalField, SelectField, SelectMultipleField, StringField,
                     TextAreaField)
from wtforms.validators import DataRequired, Length, NumberRange, Optional

TA = {"rows": 3}


class ServiceRequestForm(FlaskForm):
    service_type_id = SelectField("Service type", coerce=int)
    priority_id = SelectField("Priority", coerce=int)
    fault_category_id = SelectField("Fault category", coerce=int)
    complaint = TextAreaField("Customer complaint / requested service",
                              validators=[DataRequired(), Length(min=5, max=2000)], render_kw=TA)
    location = StringField("Service location", validators=[Optional(), Length(max=255)])


class StatusForm(FlaskForm):
    to_status = SelectField("New status")
    remarks = TextAreaField("Remarks", validators=[Optional(), Length(max=1000)], render_kw={"rows": 2})


class CancelServiceForm(FlaskForm):
    reason = TextAreaField("Reason for cancellation", validators=[DataRequired(), Length(min=5, max=1000)],
                           render_kw={"rows": 2})


class OverrideForm(FlaskForm):
    to_status = SelectField("Set status to")
    reason = TextAreaField("Reason for override", validators=[DataRequired(), Length(min=5, max=1000)],
                           render_kw={"rows": 2})


class DetailsForm(FlaskForm):
    fault_category_id = SelectField("Fault category", coerce=int)
    diagnosis = TextAreaField("Fault diagnosis", validators=[Optional(), Length(max=4000)], render_kw=TA)
    work_performed = TextAreaField("Work performed", validators=[Optional(), Length(max=4000)], render_kw=TA)
    labor_hours = DecimalField("Labor hours", places=2, validators=[Optional(), NumberRange(min=0, max=999.99)])
    estimated_completion = DateField("Estimated completion", validators=[Optional()])


class CompleteForm(FlaskForm):
    diagnosis = TextAreaField("Fault diagnosis", validators=[DataRequired(), Length(max=4000)], render_kw=TA)
    work_performed = TextAreaField("Work performed", validators=[DataRequired(), Length(max=4000)], render_kw=TA)
    labor_hours = DecimalField("Labor hours", places=2, validators=[DataRequired(), NumberRange(min=0, max=999.99)])
    actual_completion = DateField("Actual completion date", validators=[DataRequired()])
    completion_remarks = TextAreaField("Completion remarks", validators=[Optional(), Length(max=2000)],
                                       render_kw={"rows": 2})


class AssignForm(FlaskForm):
    technicians = SelectMultipleField("Technicians", coerce=int, validators=[DataRequired()])
    lead_id = SelectField("Lead technician", coerce=int)
    remarks = StringField("Note", validators=[Optional(), Length(max=300)])


class ScheduleForm(FlaskForm):
    scheduled_at = DateTimeLocalField("Visit date and time", format="%Y-%m-%dT%H:%M", validators=[DataRequired()])
    estimated_completion = DateField("Estimated completion", validators=[Optional()])


class AckForm(FlaskForm):
    name = StringField("Customer representative", validators=[DataRequired(), Length(min=2, max=120)])


class NoteForm(FlaskForm):
    note = TextAreaField("Add a note", validators=[DataRequired(), Length(min=3, max=1000)], render_kw={"rows": 2})


class RequirementForm(FlaskForm):
    item_id = SelectField("Stock item", coerce=int)
    description = StringField("Or describe another requirement", validators=[Optional(), Length(max=200)])
    category = SelectField("Requirement type", choices=[])
    quantity = DecimalField("Quantity", places=3, validators=[DataRequired(), NumberRange(min=0.001, max=1000000)])
    unit = SelectField("Unit (non-stock only)", choices=[])
    unit_price = DecimalField("Estimated unit cost (non-stock only)", places=2,
                              validators=[Optional(), NumberRange(min=0, max=99999999)])
    purpose = StringField("Reason / purpose", validators=[Optional(), Length(max=255)])
