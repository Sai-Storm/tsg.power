from flask import Blueprint, flash, redirect, render_template, request, url_for
from flask_login import current_user

from ...extensions import db
from ...models import Supplier
from ...security.decorators import permission_required
from ...services import supplier_service
from ...services.errors import ServiceError
from .forms import SupplierForm

bp = Blueprint("suppliers", __name__, url_prefix="/suppliers")


def _data(form):
    return {k: v for k, v in form.data.items() if k != "csrf_token"}


@bp.route("/")
@permission_required("inventory.manage")
def list_suppliers():
    q, status = request.args.get("q", "").strip(), request.args.get("status", "")
    pagination = db.paginate(supplier_service.search_suppliers(q, status), page=request.args.get("page", 1, type=int),
                             per_page=15, error_out=False)
    return render_template("suppliers/list.html", pagination=pagination, q=q, status=status)


@bp.route("/new", methods=["GET", "POST"])
@permission_required("inventory.manage")
def create():
    form = SupplierForm()
    if form.validate_on_submit():
        try:
            supplier_service.create_supplier(current_user, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Supplier added.", "success")
            return redirect(url_for("suppliers.list_suppliers"))
    return render_template("suppliers/form.html", form=form, editing=False)


@bp.route("/<int:supplier_id>/edit", methods=["GET", "POST"])
@permission_required("inventory.manage")
def edit(supplier_id):
    supplier = db.get_or_404(Supplier, supplier_id)
    form = SupplierForm(obj=supplier)
    if form.validate_on_submit():
        try:
            supplier_service.update_supplier(current_user, supplier.id, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Supplier updated.", "success")
            return redirect(url_for("suppliers.list_suppliers"))
    return render_template("suppliers/form.html", form=form, editing=True)


@bp.post("/<int:supplier_id>/<action>")
@permission_required("inventory.manage")
def toggle(supplier_id, action):
    if action not in ("activate", "deactivate"):
        return redirect(url_for("suppliers.list_suppliers"))
    try:
        supplier_service.set_active(current_user, supplier_id, action == "activate")
        flash(f"Supplier {action}d.", "success")
    except ServiceError as exc:
        flash(str(exc), "danger")
    return redirect(url_for("suppliers.list_suppliers"))


@bp.post("/<int:supplier_id>/delete")
@permission_required("inventory.manage")
def delete(supplier_id):
    try:
        supplier_service.delete_supplier(current_user, supplier_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("suppliers.list_suppliers"))
    flash("Supplier permanently deleted.", "success")
    return redirect(url_for("suppliers.list_suppliers"))
