from flask_wtf import FlaskForm
from wtforms import DecimalField, SelectField, StringField, TextAreaField
from wtforms.validators import DataRequired, Length, NumberRange, Optional


class ItemForm(FlaskForm):
    name = StringField("Item name", validators=[DataRequired(), Length(min=2, max=150)])
    category_id = SelectField("Category", coerce=int)
    sku = StringField("Part number / SKU", validators=[Optional(), Length(max=60)])
    unit = SelectField("Unit of measurement")
    description = TextAreaField("Description", validators=[Optional(), Length(max=1000)], render_kw={"rows": 2})
    opening_stock = DecimalField("Opening stock", places=3, validators=[Optional(), NumberRange(min=0, max=1000000)])
    min_stock = DecimalField("Minimum stock level", places=3, validators=[Optional(), NumberRange(min=0, max=1000000)])
    purchase_price = DecimalField("Purchase price", places=2, validators=[Optional(), NumberRange(min=0, max=99999999)])
    selling_price = DecimalField("Selling price", places=2, validators=[Optional(), NumberRange(min=0, max=99999999)])
    supplier_id = SelectField("Supplier", coerce=int)
    storage_location = StringField("Storage location", validators=[Optional(), Length(max=100)])
