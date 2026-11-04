import io

from flask import Blueprint, abort, flash, redirect, render_template, request, send_file, url_for
from flask_login import current_user
from sqlalchemy import select

from ...extensions import db
from ...models import Customer, Generator, Priority, ServiceEstimate, ServiceRequest, ServiceType
from ...models.billing import APPROVAL_METHODS, ESTIMATE_BADGE, ESTIMATE_STATUSES
from ...security.decorators import any_permission_required, permission_required
from ...services import estimate_service as est_svc, pdf_service, service_request_service as svc, settings_service
from ...services.errors import ServiceError
from .forms import EstimateForm, StandaloneEstimateForm

bp = Blueprint("estimates", __name__, url_prefix="/estimates")
PERMS = ("estimate.create", "estimate.approve")


def _data(form):
    return {k: v for k, v in form.data.items() if k != "csrf_token"}


def _estimate(est_id):
    est = db.session.get(ServiceEstimate, est_id)
    if est is None or not est_svc.can_view_estimate(current_user, est):
        abort(404)
    return est


def _tune_form(form):
    if not current_user.has_permission("estimate.approve"):  # only Admin sets discount and rate
        del form.discount, form.discount_reason, form.labor_rate


def _standalone_choices(form):
    form.customer_id.choices = [(c.id, f"{c.customer_code} - {c.name}") for c in db.session.scalars(
        select(Customer).where(Customer.is_active.is_(True)).order_by(Customer.name))]
    form.generator_id.choices = [(g.id, f"{g.generator_code} - {g.brand} {g.model} ({g.customer.name})")
                                 for g in db.session.scalars(
                                     select(Generator).where(Generator.is_active.is_(True))
                                     .order_by(Generator.generator_code))]
    form.service_type_id.choices = [(s.id, s.name) for s in db.session.scalars(
        select(ServiceType).where(ServiceType.is_active.is_(True)).order_by(ServiceType.name))]
    form.priority_id.choices = [(p.id, p.name) for p in db.session.scalars(
        select(Priority).where(Priority.is_active.is_(True)).order_by(Priority.rank))]


@bp.route("/")
@any_permission_required(*PERMS, "service.create")
def list_estimates():
    default_status = "customer_approved" if current_user.has_permission("service.create") \
        and not current_user.has_permission("estimate.create") \
        and not current_user.has_permission("estimate.approve") else "draft"
    status = default_status if default_status == "customer_approved" else request.args.get("status", default_status)
    stmt = est_svc.list_estimates(status if status in ESTIMATE_STATUSES else None, current_user)
    pagination = db.paginate(stmt, page=request.args.get("page", 1, type=int), per_page=15, error_out=False)
    return render_template("estimates/list.html", pagination=pagination, status=status,
                           can_create_quote=current_user.has_permission("estimate.create"),
                           can_review_quotes=current_user.has_permission("estimate.approve"))


@bp.route("/new", methods=["GET", "POST"])
@any_permission_required(*PERMS)
def create():
    service_pk = request.values.get("service", type=int)
    service = svc.get_visible(current_user, service_pk) if service_pk else None
    if service_pk and service is None:
        abort(404)
    if service is not None and not est_svc.can_create(current_user, service):
        abort(403)
    form = EstimateForm() if service is not None else StandaloneEstimateForm()
    if service is None:
        _standalone_choices(form)
    _tune_form(form)
    if request.method == "GET":
        if service is not None:
            form.parts_amount.data = est_svc.suggest_parts_amount(service)
            form.labor_hours.data = service.labor_hours
        if form.labor_rate:
            form.labor_rate.data = settings_service.get_decimal("labor_rate_per_hour")
    if form.validate_on_submit():
        try:
            est = est_svc.create_estimate(current_user, service.id, _data(form)) if service is not None \
                else est_svc.create_standalone_estimate(current_user, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash(f"Quotation {est.quotation_number or f'for {service.service_id}'} saved as a draft.", "success")
            return redirect(url_for("estimates.detail", est_id=est.id))
    return render_template("estimates/form.html", form=form, service=service, estimate=None,
                           rate=settings_service.get_decimal("labor_rate_per_hour"))


@bp.route("/<int:est_id>")
@any_permission_required("estimate.create", "estimate.approve", "invoice.view", "service.create")
def detail(est_id):
    est = _estimate(est_id)
    return render_template("estimates/detail.html", e=est, statuses=ESTIMATE_STATUSES, badge=ESTIMATE_BADGE,
                           methods=APPROVAL_METHODS, can_approve=current_user.has_permission("estimate.approve"),
                           can_record=current_user.has_permission("estimate.approve") or (
                               current_user.has_permission("estimate.create") and est.created_by_id == current_user.id),
                           can_convert=current_user.has_permission("service.create"),
                           can_revise=est.service is not None and est_svc.can_create(current_user, est.service)
                           and est.status in ("approved", "customer_approved", "rejected")
                           and est.id == est.service.estimates[-1].id,
                           can_edit=est.status == "draft" and (est.created_by_id == current_user.id
                                                              or current_user.has_permission("estimate.approve")))


@bp.route("/<int:est_id>/quotation.pdf")
@any_permission_required("estimate.create", "estimate.approve", "invoice.view", "service.create")
def quotation_pdf(est_id):
    estimate = _estimate(est_id)
    data = pdf_service.build_quotation(estimate)
    filename = f"{estimate.quotation_number or estimate.service.service_id}-quotation-v{estimate.version}.pdf"
    return send_file(io.BytesIO(data), mimetype="application/pdf", download_name=filename, max_age=0)


@bp.post("/<int:est_id>/delete")
@any_permission_required(*PERMS)
def delete_draft(est_id):
    est = _estimate(est_id)
    try:
        service = est_svc.delete_draft(current_user, est.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("estimates.detail", est_id=est.id))
    flash("Draft estimate permanently deleted. The service timeline and audit log retain the deletion record.", "success")
    return redirect(url_for("services.detail", service_pk=service.id) if service
                    else url_for("estimates.list_estimates", status=""))


@bp.route("/<int:est_id>/edit", methods=["GET", "POST"])
@any_permission_required(*PERMS)
def edit(est_id):
    est = _estimate(est_id)
    if est.status != "draft":
        flash("Only a draft estimate can be edited. Create a revised estimate instead.", "warning")
        return redirect(url_for("estimates.detail", est_id=est.id))
    form = EstimateForm(obj=est) if est.service is not None else StandaloneEstimateForm(obj=est)
    if est.service is None:
        _standalone_choices(form)
    _tune_form(form)
    if form.validate_on_submit():
        try:
            est_svc.update_estimate(current_user, est.id, _data(form))
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Estimate updated.", "success")
            return redirect(url_for("estimates.detail", est_id=est.id))
    return render_template("estimates/form.html", form=form, service=est.service, estimate=est,
                           rate=est.labor_rate)


def _act(est_id, call, ok):
    est = _estimate(est_id)
    try:
        call(est)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash(ok, "success")
    return redirect(url_for("estimates.detail", est_id=est.id))


@bp.post("/<int:est_id>/approve")
@permission_required("estimate.approve")
def approve(est_id):
    return _act(est_id, lambda e: est_svc.approve_estimate(current_user, e.id), "Estimate approved.")


@bp.post("/<int:est_id>/reject")
@permission_required("estimate.approve")
def reject(est_id):
    return _act(est_id, lambda e: est_svc.reject_estimate(current_user, e.id, request.form.get("reason")), "Estimate rejected.")


@bp.post("/<int:est_id>/customer")
@any_permission_required(*PERMS)
def customer_decision(est_id):
    f = request.form
    return _act(est_id, lambda e: est_svc.record_customer_decision(
        current_user, e.id, f.get("decision"), f.get("name"), f.get("method"), f.get("note")),
        "Customer decision recorded.")


@bp.post("/<int:est_id>/convert")
@permission_required("service.create")
def convert(est_id):
    estimate = _estimate(est_id)
    try:
        service = est_svc.convert_accepted_quotation(current_user, estimate.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("estimates.detail", est_id=estimate.id))
    flash(f"Job Order {service.service_id} created from the accepted quotation.", "success")
    return redirect(url_for("services.detail", service_pk=service.id))
