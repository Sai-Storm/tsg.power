from datetime import date

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user
from sqlalchemy import select

from ...extensions import db
from ...models import InventoryCategory, InventoryItem, Supplier
from ...models.inventory import REQ_BADGE, REQ_STATUSES, TXN_LABELS, UNITS
from ...security.decorators import any_permission_required, permission_required
from ...services import inventory_service as inv, requirement_service as reqs
from ...services.errors import ServiceError
from ...services.common import fmt_qty
from ...utils.web import is_safe_url
from .forms import ItemForm

bp = Blueprint("inventory", __name__, url_prefix="/inventory")


def _choices(form):
    form.category_id.choices = [(0, "No category")] + [(c.id, c.name) for c in db.session.scalars(
        select(InventoryCategory).where(InventoryCategory.is_active.is_(True)).order_by(InventoryCategory.name))]
    form.supplier_id.choices = [(0, "No supplier")] + [(s.id, s.name) for s in db.session.scalars(
        select(Supplier).where(Supplier.is_active.is_(True)).order_by(Supplier.name))]
    form.unit.choices = [(u, u) for u in UNITS]


def _data(form):
    data = {k: v for k, v in form.data.items() if k != "csrf_token"}
    return data


def _go(call, ok=None):
    try:
        result = call()
    except ServiceError as exc:
        flash(str(exc), "danger")
        return None
    if ok:
        flash(ok, "success")
    return result


def _next(default):
    nxt = request.form.get("next")
    return nxt if nxt and is_safe_url(nxt) else default


def _date(name):
    try:
        return date.fromisoformat(request.args[name]) if request.args.get(name) else None
    except ValueError:
        return None


# ------------------------------------------------------------------ items
@bp.route("/")
@permission_required("inventory.view")
def list_items():
    a = request.args
    sort = a.get("sort", "name")
    direction = "desc" if a.get("dir") == "desc" else "asc"
    stmt = inv.search_items(a.get("q", "").strip(), a.get("category", type=int), a.get("supplier", type=int),
                            a.get("low") == "1", a.get("status", ""), sort, direction)
    pagination = db.paginate(stmt, page=a.get("page", 1, type=int), per_page=15, error_out=False)
    return render_template(
        "inventory/list.html", pagination=pagination, sort=sort, direction=direction, f=a,
        categories=db.session.scalars(select(InventoryCategory).order_by(InventoryCategory.name)).all(),
        suppliers=db.session.scalars(select(Supplier).order_by(Supplier.name)).all(),
        low_count=inv.low_stock_count())


@bp.route("/new", methods=["GET", "POST"])
@permission_required("inventory.manage")
def create():
    form = ItemForm()
    _choices(form)
    if form.validate_on_submit():
        try:
            item = inv.create_item(current_user, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash(f"{item.part_code} {item.name} added.", "success")
            return redirect(url_for("inventory.detail", item_id=item.id))
    return render_template("inventory/form.html", form=form, editing=False, item=None)


@bp.route("/<int:item_id>")
@permission_required("inventory.view")
def detail(item_id):
    item = db.get_or_404(InventoryItem, item_id)
    txns = db.paginate(inv.search_transactions(item_id=item.id), page=request.args.get("page", 1, type=int),
                       per_page=15, error_out=False)
    return render_template("inventory/detail.html", item=item, txns=txns, txn_labels=TXN_LABELS)


@bp.route("/<int:item_id>/edit", methods=["GET", "POST"])
@permission_required("inventory.manage")
def edit(item_id):
    item = db.get_or_404(InventoryItem, item_id)
    form = ItemForm(obj=item)
    del form.opening_stock
    _choices(form)
    if request.method == "GET":
        form.category_id.data = item.category_id or 0
        form.supplier_id.data = item.supplier_id or 0
    if form.validate_on_submit():
        if _go(lambda: inv.update_item(current_user, item.id, _data(form)), "Item updated."):
            return redirect(url_for("inventory.detail", item_id=item.id))
    return render_template("inventory/form.html", form=form, editing=True, item=item)


@bp.post("/<int:item_id>/activate")
@permission_required("inventory.manage")
def activate(item_id):
    _go(lambda: inv.set_item_active(current_user, item_id, True), "Item reactivated.")
    return redirect(url_for("inventory.detail", item_id=item_id))


@bp.post("/<int:item_id>/deactivate")
@permission_required("inventory.manage")
def deactivate(item_id):
    _go(lambda: inv.set_item_active(current_user, item_id, False), "Item deactivated.")
    return redirect(url_for("inventory.detail", item_id=item_id))


@bp.post("/<int:item_id>/delete")
@permission_required("inventory.manage")
def delete_item(item_id):
    if _go(lambda: inv.delete_item(current_user, item_id), "Inventory item permanently deleted.") is not None:
        return redirect(url_for("inventory.list_items"))
    return redirect(url_for("inventory.detail", item_id=item_id))


@bp.post("/<int:item_id>/stock-in")
@permission_required("inventory.manage")
def stock_in(item_id):
    f = request.form
    _go(lambda: inv.stock_in(current_user, item_id, f.get("quantity"), f.get("reference"), f.get("reason"),
                             f.get("unit_cost")), "Stock received and recorded.")
    return redirect(url_for("inventory.detail", item_id=item_id))


@bp.post("/<int:item_id>/adjust")
@permission_required("inventory.adjust")
def adjust(item_id):
    f = request.form
    _go(lambda: inv.adjust_stock(current_user, item_id, f.get("delta"), f.get("reason"), f.get("kind", "adjustment"),
                                 f.get("reference")), "Stock adjusted and recorded.")
    return redirect(url_for("inventory.detail", item_id=item_id))


@bp.route("/transactions")
@permission_required("inventory.manage")
def transactions():
    a = request.args
    stmt = inv.search_transactions(a.get("item", type=int), a.get("type", ""), _date("from"), _date("to"))
    pagination = db.paginate(stmt, page=a.get("page", 1, type=int), per_page=25, error_out=False)
    return render_template("inventory/transactions.html", pagination=pagination, f=a, txn_labels=TXN_LABELS)


@bp.route("/categories", methods=["GET", "POST"])
@permission_required("inventory.manage")
def categories():
    if request.method == "POST":
        _go(lambda: inv.add_category(current_user, request.form.get("name")), "Category added.")
        return redirect(url_for("inventory.categories"))
    cats = db.session.scalars(select(InventoryCategory).order_by(InventoryCategory.name)).all()
    return render_template("inventory/categories.html", categories=cats)


@bp.post("/categories/<int:category_id>/toggle")
@permission_required("inventory.manage")
def toggle_category(category_id):
    _go(lambda: inv.toggle_category(current_user, category_id), "Category updated.")
    return redirect(url_for("inventory.categories"))


@bp.post("/categories/<int:category_id>/delete")
@permission_required("inventory.manage")
def delete_category(category_id):
    _go(lambda: inv.delete_category(current_user, category_id), "Category permanently deleted.")
    return redirect(url_for("inventory.categories"))


# ------------------------------------------------------------------ material requests: approvals + store
@bp.route("/requests")
@any_permission_required("requirement.approve", "inventory.issue")
def requests():
    can_approve = current_user.has_permission("requirement.approve")
    can_issue = current_user.has_permission("inventory.issue")
    tab = request.args.get("tab") or ("pending" if can_approve else "issue")
    return render_template("inventory/requests.html", tab=tab, can_approve=can_approve, can_issue=can_issue,
                           pending=reqs.pending_approvals() if can_approve else [],
                           queue=reqs.issue_queue() if can_issue else [], req_badge=REQ_BADGE, req_statuses=REQ_STATUSES)


@bp.route("/waiting")
@permission_required("inventory.view")
def waiting():
    return render_template("inventory/waiting.html", services=reqs.waiting_for_parts(current_user))


@bp.post("/requirements/<int:req_id>/approve")
@permission_required("requirement.approve")
def approve(req_id):
    f = request.form
    _go(lambda: reqs.approve(current_user, req_id, f.get("approved_qty"), f.get("note"), f.get("unit_price")),
        "Request approved.")
    return redirect(_next(url_for("inventory.requests")))


@bp.post("/requirements/<int:req_id>/reject")
@permission_required("requirement.approve")
def reject(req_id):
    _go(lambda: reqs.reject(current_user, req_id, request.form.get("note")), "Request rejected.")
    return redirect(_next(url_for("inventory.requests")))


@bp.post("/requirements/<int:req_id>/issue")
@permission_required("inventory.issue")
def issue(req_id):
    result = _go(lambda: reqs.issue(current_user, req_id, request.form.get("quantity")))
    if result:
        req, now = result
        if now == 0:
            flash(f"No stock of {req.description} is available. The line stays open and the job is waiting for parts.", "warning")
        elif req.status == "partially_available":
            flash(f"Issued {fmt_qty(now)} {req.unit}. Only part of the request could be issued; "
                  f"{fmt_qty(req.to_issue)} {req.unit} still waiting for stock.", "warning")
        else:
            flash(f"Issued {fmt_qty(now)} {req.unit} {req.description}.", "success")
    return redirect(_next(url_for("inventory.requests", tab="issue")))


@bp.post("/requirements/<int:req_id>/return")
@permission_required("inventory.issue")
def return_stock(req_id):
    f = request.form
    _go(lambda: reqs.return_unused(current_user, req_id, f.get("quantity"), f.get("reason")), "Returned to stock.")
    return redirect(_next(url_for("inventory.requests", tab="issue")))
