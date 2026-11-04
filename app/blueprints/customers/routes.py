import csv
import io

from flask import Blueprint, flash, make_response, redirect, render_template, request, url_for
from flask_login import current_user
from sqlalchemy import select

from ...extensions import db
from ...models import Customer
from ...security.decorators import permission_required
from ...services import customer_service, service_request_service
from ...services.errors import DuplicateWarning, ServiceError
from .forms import CustomerForm

bp = Blueprint("customers", __name__, url_prefix="/customers")


def _data(form):
    data = dict(form.data)
    data.pop("csrf_token", None)
    return data


@bp.route("/")
@permission_required("customer.view")
def list_customers():
    q = request.args.get("q", "").strip()
    ctype = request.args.get("type", "")
    status = request.args.get("status", "")
    city = request.args.get("city", "").strip()
    sort = request.args.get("sort", "name")
    direction = "desc" if request.args.get("dir") == "desc" else "asc"
    stmt = customer_service.search_customers(q, ctype, status, city, sort, direction)
    pagination = db.paginate(stmt, page=request.args.get("page", 1, type=int), per_page=15, error_out=False)
    counts = customer_service.generator_counts([c.id for c in pagination.items])
    return render_template("customers/list.html", pagination=pagination, counts=counts, q=q, ctype=ctype,
                           status=status, city=city, sort=sort, direction=direction)


@bp.route("/master.csv")
@permission_required("customer.view")
def export_master():
    customers = db.session.scalars(
        select(Customer).order_by(Customer.customer_code)
    ).all()
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["Customer ID", "Name", "Type", "Contact person", "Phone", "Alternate phone",
                     "Email", "Address", "City", "State", "Status"])
    for customer in customers:
        writer.writerow([
            customer.customer_code, customer.name, customer.customer_type, customer.contact_person or "",
            customer.phone_primary, customer.phone_alt or "", customer.email or "", customer.address or "",
            customer.city or "", customer.state or "", "Active" if customer.is_active else "Inactive",
        ])
    safe_rows = []
    for line in csv.reader(io.StringIO(stream.getvalue())):
        safe_rows.append([
            "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value
            for value in line
        ])
    output = io.StringIO(newline="")
    csv.writer(output).writerows(safe_rows)
    response = make_response("\ufeff" + output.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = 'attachment; filename="customer-master.csv"'
    return response


@bp.route("/new", methods=["GET", "POST"])
@permission_required("customer.create")
def create():
    form = CustomerForm()
    duplicates = None
    if form.validate_on_submit():
        try:
            customer = customer_service.create_customer(
                current_user, _data(form), confirm_duplicate=request.form.get("confirm_duplicate") == "1")
        except DuplicateWarning as warning:
            duplicates = warning.matches
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash(f"Customer {customer.customer_code} registered.", "success")
            return redirect(url_for("customers.detail", customer_id=customer.id))
    return render_template("customers/form.html", form=form, editing=False, customer=None, duplicates=duplicates)


@bp.route("/<int:customer_id>")
@permission_required("customer.view")
def detail(customer_id):
    customer = db.get_or_404(Customer, customer_id)
    return render_template("customers/detail.html", customer=customer,
                           services=service_request_service.history_for(current_user, customer_id=customer.id))


@bp.route("/<int:customer_id>/edit", methods=["GET", "POST"])
@permission_required("customer.edit")
def edit(customer_id):
    customer = db.get_or_404(Customer, customer_id)
    form = CustomerForm(obj=customer)
    duplicates = None
    if form.validate_on_submit():
        try:
            customer_service.update_customer(
                current_user, customer.id, _data(form), confirm_duplicate=request.form.get("confirm_duplicate") == "1")
        except DuplicateWarning as warning:
            duplicates = warning.matches
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Customer updated.", "success")
            return redirect(url_for("customers.detail", customer_id=customer.id))
    return render_template("customers/form.html", form=form, editing=True, customer=customer, duplicates=duplicates)


@bp.post("/<int:customer_id>/deactivate")
@permission_required("customer.edit")
def deactivate(customer_id):
    return _toggle(customer_id, False, "deactivated")


@bp.post("/<int:customer_id>/delete")
@permission_required("customer.edit")
def delete(customer_id):
    try:
        customer_service.delete_customer(current_user, customer_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("customers.detail", customer_id=customer_id))
    flash("Customer permanently deleted.", "success")
    return redirect(url_for("customers.list_customers"))


@bp.post("/<int:customer_id>/urgent-delete")
@permission_required("role.manage")
def urgent_delete(customer_id):
    customer = db.get_or_404(Customer, customer_id)
    customer_code = customer.customer_code
    try:
        deleted_services, deleted_generators = customer_service.force_delete_customer(current_user, customer.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("customers.detail", customer_id=customer_id))
    flash(
        f"{customer_code}, {deleted_generators} generator(s), and {deleted_services} job(s) were deleted. "
        "Audit records were retained.",
        "warning",
    )
    return redirect(url_for("customers.list_customers"))


@bp.post("/<int:customer_id>/activate")
@permission_required("customer.edit")
def activate(customer_id):
    return _toggle(customer_id, True, "reactivated")


def _toggle(customer_id, active, verb):
    try:
        customer = customer_service.set_active(current_user, customer_id, active)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("customers.list_customers"))
    flash(f"{customer.name} has been {verb}.", "success")
    return redirect(url_for("customers.detail", customer_id=customer.id))


@bp.route("/duplicates")
@permission_required("customer.edit")
def duplicates():
    return render_template("customers/duplicates.html", groups=customer_service.duplicate_groups())
