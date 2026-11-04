from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user
from sqlalchemy import select

from ...extensions import db, limiter
from ...models import Customer, Generator
from ...models.generator import CONDITIONS, FUEL_TYPES
from ...security.decorators import permission_required
from ...services import customer_service, generator_service, service_request_service, upload_service
from ...services.errors import ServiceError
from .forms import GeneratorForm

bp = Blueprint("generators", __name__, url_prefix="/generators")


def _data(form):
    data = dict(form.data)
    data.pop("csrf_token", None)
    return data


@bp.route("/")
@permission_required("generator.view")
def list_generators():
    args = request.args
    sort = args.get("sort", "code")
    direction = "asc" if args.get("dir") == "asc" else "desc"
    customer_id = args.get("customer", type=int)
    stmt = generator_service.search_generators(
        args.get("q", "").strip(), customer_id, args.get("fuel", ""), args.get("condition", ""),
        args.get("status", ""), args.get("maintenance", ""), sort, direction)
    pagination = db.paginate(stmt, page=args.get("page", 1, type=int), per_page=15, error_out=False)
    customer = db.session.get(Customer, customer_id) if customer_id else None
    return render_template("generators/list.html", pagination=pagination, sort=sort, direction=direction,
                           q=args.get("q", "").strip(), fuel=args.get("fuel", ""), condition=args.get("condition", ""),
                           status=args.get("status", ""), maintenance=args.get("maintenance", ""),
                           customer=customer, fuel_types=FUEL_TYPES, conditions=CONDITIONS)


@bp.route("/new", methods=["GET", "POST"])
@permission_required("generator.create")
def create():
    customer_id = request.values.get("customer_id", type=int)
    if not customer_id:
        # Step 1: choose the owner. Search by name, phone or customer ID.
        q = request.args.get("q", "").strip()
        results = []
        if q:
            stmt = customer_service.search_customers(q, status="active").limit(10)
            results = db.session.scalars(stmt).all()
        return render_template("generators/select_customer.html", q=q, results=results)

    customer = db.get_or_404(Customer, customer_id)
    form = GeneratorForm()
    if form.validate_on_submit():
        try:
            gen = generator_service.create_generator(current_user, customer.id, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash(f"Generator {gen.generator_code} registered for {customer.name}.", "success")
            return redirect(url_for("generators.detail", generator_id=gen.id))
    return render_template("generators/form.html", form=form, editing=False, customer=customer, generator=None)


@bp.route("/<int:generator_id>")
@permission_required("generator.view")
def detail(generator_id):
    gen = db.get_or_404(Generator, generator_id)
    return render_template("generators/detail.html", generator=gen, fuel_types=FUEL_TYPES, conditions=CONDITIONS,
                           attachments=upload_service.list_attachments("generator", gen.id),
                           services=service_request_service.history_for(current_user, generator_id=gen.id))


@bp.route("/<int:generator_id>/edit", methods=["GET", "POST"])
@permission_required("generator.edit")
def edit(generator_id):
    gen = db.get_or_404(Generator, generator_id)
    form = GeneratorForm(obj=gen)
    if form.validate_on_submit():
        try:
            generator_service.update_generator(current_user, gen.id, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Generator updated.", "success")
            return redirect(url_for("generators.detail", generator_id=gen.id))
    return render_template("generators/form.html", form=form, editing=True, customer=gen.customer, generator=gen)


@bp.post("/<int:generator_id>/deactivate")
@permission_required("generator.edit")
def deactivate(generator_id):
    return _toggle(generator_id, False, "deactivated")


@bp.post("/<int:generator_id>/delete")
@permission_required("generator.edit")
def delete(generator_id):
    try:
        deleted_services = generator_service.delete_generator(current_user, generator_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("generators.detail", generator_id=generator_id))
    flash(f"Generator permanently deleted with {deleted_services} untouched service request(s).", "success")
    return redirect(url_for("generators.list_generators"))


@bp.post("/<int:generator_id>/urgent-delete")
@permission_required("role.manage")
def urgent_delete(generator_id):
    gen = db.get_or_404(Generator, generator_id)
    generator_code = gen.generator_code
    try:
        deleted_services = generator_service.force_delete_generator(current_user, gen.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("generators.detail", generator_id=generator_id))
    flash(f"{generator_code} and {deleted_services} linked job(s) were deleted. Audit records were retained.", "warning")
    return redirect(url_for("generators.list_generators"))


@bp.post("/<int:generator_id>/activate")
@permission_required("generator.edit")
def activate(generator_id):
    return _toggle(generator_id, True, "reactivated")


def _toggle(generator_id, active, verb):
    try:
        gen = generator_service.set_active(current_user, generator_id, active)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("generators.list_generators"))
    flash(f"{gen.generator_code} has been {verb}.", "success")
    return redirect(url_for("generators.detail", generator_id=gen.id))


@bp.post("/<int:generator_id>/attachments")
@limiter.limit("40 per hour")
@permission_required("generator.view")
def upload(generator_id):
    gen = db.get_or_404(Generator, generator_id)
    files = [f for f in request.files.getlist("files") if f and f.filename]
    if not files:
        flash("Choose at least one file to upload.", "warning")
    saved = 0
    for f in files:
        try:
            upload_service.save_upload(current_user, "generator", gen.id, f, request.form.get("description"))
            saved += 1
        except ServiceError as exc:
            flash(f"{f.filename}: {exc}", "danger")
    if saved:
        flash(f"{saved} file{'s' if saved != 1 else ''} uploaded.", "success")
    return redirect(url_for("generators.detail", generator_id=gen.id) + "#files")


@bp.post("/attachments/<int:attachment_id>/delete")
@permission_required("generator.view")
def delete_attachment(attachment_id):
    from ...models import Attachment
    existing = db.session.get(Attachment, attachment_id)
    if existing is None or existing.owner_type != "generator":
        abort(404)
    try:
        att = upload_service.delete_attachment(current_user, attachment_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("generators.list_generators"))
    flash("File removed.", "success")
    return redirect(url_for("generators.detail", generator_id=att.owner_id) + "#files")
