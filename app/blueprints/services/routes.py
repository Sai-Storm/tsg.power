import re

import io

from flask import Blueprint, abort, flash, redirect, render_template, request, send_file, url_for
from flask_login import current_user
from sqlalchemy import select

from ...extensions import db, limiter
from ...models import (Customer, FaultCategory, Generator, InventoryItem, Priority, ServiceRequest,
                       ServiceType)
from ...models.inventory import NON_INV_CATEGORIES, REQ_BADGE, REQ_STATUSES, UNITS
from ...models.service import STATUSES
from ...security.decorators import any_permission_required, permission_required
from ...services import (customer_service, estimate_service, invoice_service, pdf_service,
                         requirement_service as reqs, service_request_service as svc,
                         service_workflow as wf, upload_service)
from ...services.errors import ServiceError
from ...services.common import fmt_qty
from ...utils.time import local_today, utc_to_local
from .forms import (AckForm, AssignForm, CompleteForm, DetailsForm, NoteForm, OverrideForm, ScheduleForm,
                    CancelServiceForm, RequirementForm, ServiceRequestForm, StatusForm)

bp = Blueprint("services", __name__, url_prefix="/services")
VIEW_PERMS = ("service.view_all", "service.view_assigned")
SERVICE_ID_RE = re.compile(r"^GEN-SRV-\d{4}-\d{4,}$", re.I)


def _load(service_pk):
    service = svc.get_visible(current_user, service_pk)
    if service is None:
        abort(404)  # same answer for "missing" and "not yours"
    return service


def _flash_errors(form):
    for field, errors in form.errors.items():
        label = getattr(getattr(form, field, None), "label", None)
        flash(f"{label.text if label else field}: {errors[0]}", "danger")


def _back(service, anchor=""):
    return redirect(url_for("services.detail", service_pk=service.id) + anchor)


def _lookup_choices(form):
    """Fill the dropdowns that exist on this form (create/edit form has all three, work-details form only one)."""
    if "service_type_id" in form:
        form.service_type_id.choices = [(t.id, t.name) for t in db.session.scalars(
            select(ServiceType).where(ServiceType.is_active.is_(True)).order_by(ServiceType.id))]
    if "priority_id" in form:
        form.priority_id.choices = [(p.id, p.name) for p in db.session.scalars(
            select(Priority).where(Priority.is_active.is_(True)).order_by(Priority.rank))]
    if "fault_category_id" in form:
        form.fault_category_id.choices = [(0, "Not specified")] + [(f.id, f.name) for f in db.session.scalars(
            select(FaultCategory).where(FaultCategory.is_active.is_(True)).order_by(FaultCategory.name))]


def _requirement_choices(form):
    items = db.session.scalars(select(InventoryItem).where(InventoryItem.is_active.is_(True)).order_by(InventoryItem.name))
    form.item_id.choices = [(0, "Not a stock item")] + [
        (i.id, f"{i.part_code} {i.name} ({i.unit}) - stock {fmt_qty(i.current_stock)}") for i in items]
    form.category.choices = list(NON_INV_CATEGORIES.items())
    form.unit.choices = [(u, u) for u in UNITS]


# ------------------------------------------------------------------ list / search
@bp.route("/")
@any_permission_required(*VIEW_PERMS)
def list_services():
    a = request.args
    q = a.get("q", "").strip()
    if q and SERVICE_ID_RE.match(q):  # exact Service ID: jump straight to the job
        hit = db.session.scalar(select(ServiceRequest).where(ServiceRequest.service_id == q.upper()))
        if hit is not None and svc.can_view(current_user, hit):
            return _back(hit)

    def _date(name):
        try:
            return local_today().fromisoformat(a.get(name)) if a.get(name) else None
        except ValueError:
            return None

    sort = a.get("sort", "created")
    direction = "asc" if a.get("dir") == "asc" else "desc"
    filters = dict(q=q, status=a.get("status", ""), priority_id=a.get("priority", type=int),
                   type_id=a.get("type", type=int), technician_id=a.get("technician", type=int),
                   created_from=_date("from"), created_to=_date("to"), overdue=a.get("overdue") == "1",
                   unassigned=a.get("unassigned") == "1", mine=a.get("mine") == "1", payment=a.get("payment") or None)
    stmt = svc.search_services(current_user, sort=sort, direction=direction, **filters)
    pagination = db.paginate(stmt, page=a.get("page", 1, type=int), per_page=15, error_out=False)
    deletable_ids = {
        service.id for service in pagination.items
        if service.status == "new_request" and svc.can_delete_unstarted(current_user, service)
    }
    return render_template(
        "services/list.html", pagination=pagination, sort=sort, direction=direction, f=a,
        deletable_ids=deletable_ids,
        priorities=db.session.scalars(select(Priority).order_by(Priority.rank)).all(),
        types=db.session.scalars(select(ServiceType).order_by(ServiceType.id)).all(),
        technicians=svc.technician_options() if current_user.has_permission("service.view_all") else [])


@bp.route("/workload")
@permission_required("service.assign")
def workload():
    return render_template("services/workload.html", rows=svc.workload())


# ------------------------------------------------------------------ create (customer -> generator -> form)
@bp.route("/new", methods=["GET", "POST"])
@permission_required("service.create")
def create():
    generator_id = request.values.get("generator_id", type=int)
    customer_id = request.values.get("customer_id", type=int)
    generator = db.session.get(Generator, generator_id) if generator_id else None
    if generator is not None:
        customer = generator.customer
    else:
        customer = db.session.get(Customer, customer_id) if customer_id else None

    if customer is None:  # step 1: find the customer
        q = request.args.get("q", "").strip()
        results = db.session.scalars(customer_service.search_customers(q, status="active").limit(10)).all() if q else []
        return render_template("services/select.html", step="customer", q=q, results=results)
    if generator is None:  # step 2: pick the generator
        gens = [g for g in customer.generators if g.is_active]
        return render_template("services/select.html", step="generator", customer=customer, generators=gens)

    form = ServiceRequestForm()
    _lookup_choices(form)
    if request.method == "GET":
        form.location.data = generator.location
        form.priority_id.data = db.session.scalar(select(Priority.id).where(Priority.code == "normal"))
    if form.validate_on_submit():
        data = {k: v for k, v in form.data.items() if k != "csrf_token"}
        data.update(customer_id=customer.id, generator_id=generator.id)
        try:
            service = svc.create_service_request(current_user, data)
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash(f"Service request {service.service_id} created.", "success")
            return _back(service)
    return render_template("services/form.html", form=form, editing=False, customer=customer,
                           generator=generator, service=None)


# ------------------------------------------------------------------ detail
@bp.route("/<int:service_pk>")
@any_permission_required(*VIEW_PERMS)
def detail(service_pk):
    s = _load(service_pk)
    u = current_user
    manage = svc.can_manage(u, s)
    can_assign = u.has_permission("service.assign") and s.is_open
    ctx = dict(
        s=s, timeline=svc.timeline(s), statuses=STATUSES, manage=manage, can_assign=can_assign,
        can_override=u.has_permission("service.override_status"),
        can_edit_core=svc.can_edit_core(u, s), can_work=svc.can_edit_work(u, s),
        can_complete=svc.can_complete(u, s), can_note=svc.can_add_note(u, s), can_upload=svc.can_upload(u, s),
        can_delete_unstarted=svc.can_delete_unstarted(u, s),
        can_cancel=wf.can_cancel(u, s),
        can_ack=manage and s.status == "completed" and u.has_permission("service.update_status"),
        targets=wf.selectable_targets(u, s) if manage else [],
        attachments=upload_service.list_attachments("service", s.id), note_form=NoteForm(), ack_form=AckForm(),
    )
    status_form = StatusForm()
    status_form.to_status.choices = ctx["targets"]
    override_form = OverrideForm()
    override_form.to_status.choices = [(k, v) for k, v in STATUSES.items() if k != s.status]
    details = DetailsForm(obj=s)
    _lookup_choices(details)
    details.fault_category_id.data = s.fault_category_id or 0
    complete = CompleteForm(obj=s)
    if not complete.actual_completion.data:
        complete.actual_completion.data = local_today()
    assign = AssignForm()
    techs = svc.technician_options()
    assign.technicians.choices = [(t.id, t.full_name) for t in techs]
    assign.lead_id.choices = [(0, "No lead")] + [(t.id, t.full_name) for t in techs]
    assign.technicians.data = [a.user_id for a in s.active_assignments]
    assign.lead_id.data = next((a.user_id for a in s.active_assignments if a.is_lead), 0)
    req_form = RequirementForm()
    _requirement_choices(req_form)
    schedule = ScheduleForm()
    schedule.scheduled_at.data = utc_to_local(s.scheduled_at)
    schedule.estimated_completion.data = s.estimated_completion
    return render_template("services/detail.html", status_form=status_form, override_form=override_form,
                           details_form=details, complete_form=complete, assign_form=assign,
                           schedule_form=schedule, req_form=req_form, req_badge=REQ_BADGE, req_statuses=REQ_STATUSES,
                           can_request=reqs.can_request(u, s), can_usage=reqs.can_record_usage(u, s),
                           can_approve=u.has_permission("requirement.approve"),
                           can_issue=u.has_permission("inventory.issue"),
                           show_billing=estimate_service.can_view(u, s) or u.has_permission("invoice.view"),
                           can_see_invoice=u.has_permission("invoice.view"),
                           can_new_estimate=estimate_service.can_create(u, s),
                           can_approve_report=u.has_permission("service.report_approve")
                           and s.status in ("completed", "closed") and s.report_approved_at is None,
                           can_make_invoice=u.has_permission("invoice.manage")
                           and s.status in ("completed", "closed") and s.report_approved_at is not None,
                           cancel_form=CancelServiceForm(),
                           fin=invoice_service.service_financials(s) if u.has_permission("invoice.view") else None,
                           **ctx)


@bp.post("/<int:service_pk>/report/approve")
@permission_required("service.report_approve")
def approve_report(service_pk):
    service = _load(service_pk)
    try:
        svc.approve_completion_report(current_user, service.id, request.form.get("note"))
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash("Service delivery report approved for invoicing.", "success")
    return redirect(url_for("services.detail", service_pk=service_pk) + "#billing")


@bp.post("/<int:service_pk>/delete")
@any_permission_required(*VIEW_PERMS)
def delete_unstarted(service_pk):
    service = _load(service_pk)
    try:
        svc.delete_unstarted(current_user, service.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return _back(service)
    flash(f"Unstarted request {service.service_id} permanently deleted.", "success")
    return redirect(url_for("services.list_services"))


@bp.post("/<int:service_pk>/urgent-delete")
@permission_required("role.manage")
def urgent_delete(service_pk):
    service = db.get_or_404(ServiceRequest, service_pk)
    service_id = service.service_id
    try:
        svc.force_delete_service(current_user, service.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("services.detail", service_pk=service_pk))
    flash(f"{service_id} and its operational history were deleted. Audit records were retained.", "warning")
    return redirect(url_for("services.list_services"))


# ------------------------------------------------------------------ edit core fields
@bp.route("/<int:service_pk>/edit", methods=["GET", "POST"])
@any_permission_required(*VIEW_PERMS)
def edit(service_pk):
    s = _load(service_pk)
    if not svc.can_edit_core(current_user, s):
        abort(403)
    form = ServiceRequestForm(obj=s)
    _lookup_choices(form)
    if request.method == "GET":
        form.fault_category_id.data = s.fault_category_id or 0
    if form.validate_on_submit():
        try:
            svc.update_request(current_user, s.id, {k: v for k, v in form.data.items() if k != "csrf_token"})
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Service request updated.", "success")
            return _back(s)
    return render_template("services/form.html", form=form, editing=True, customer=s.customer,
                           generator=s.generator, service=s)


# ------------------------------------------------------------------ actions (all POST, all redirect back)
def _action(service_pk, form, call, ok_message, anchor=""):
    s = _load(service_pk)
    if form.validate_on_submit():
        try:
            call(s)
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash(ok_message, "success")
    else:
        _flash_errors(form)
    return _back(s, anchor)


@bp.post("/<int:service_pk>/status")
@any_permission_required(*VIEW_PERMS)
def change_status(service_pk):
    s = _load(service_pk)
    form = StatusForm()
    form.to_status.choices = wf.selectable_targets(current_user, s)
    return _action(service_pk, form, lambda sv: svc.change_status(current_user, sv.id, form.to_status.data,
                                                                  form.remarks.data), "Status updated.", "#timeline")


@bp.post("/<int:service_pk>/cancel")
@any_permission_required(*VIEW_PERMS)
def cancel(service_pk):
    form = CancelServiceForm()
    return _action(service_pk, form, lambda sv: svc.change_status(
        current_user, sv.id, "cancelled", form.reason.data), "Service request cancelled.", "#timeline")


@bp.post("/<int:service_pk>/override")
@permission_required("service.override_status")
def override(service_pk):
    form = OverrideForm()
    form.to_status.choices = list(STATUSES.items())
    return _action(service_pk, form, lambda sv: svc.override_status(current_user, sv.id, form.to_status.data,
                                                                     form.reason.data), "Status overridden and recorded.", "#timeline")


@bp.post("/<int:service_pk>/assign")
@permission_required("service.assign")
def assign(service_pk):
    form = AssignForm()
    techs = svc.technician_options()
    form.technicians.choices = [(t.id, t.full_name) for t in techs]
    form.lead_id.choices = [(0, "No lead")] + [(t.id, t.full_name) for t in techs]
    return _action(service_pk, form, lambda sv: svc.assign_technicians(
        current_user, sv.id, form.technicians.data, form.lead_id.data, form.remarks.data), "Technicians updated.", "#timeline")


@bp.post("/<int:service_pk>/schedule")
@permission_required("service.assign")
def schedule(service_pk):
    form = ScheduleForm()
    return _action(service_pk, form, lambda sv: svc.schedule_visit(
        current_user, sv.id, form.scheduled_at.data, form.estimated_completion.data), "Visit scheduled.", "#timeline")


@bp.post("/<int:service_pk>/details")
@any_permission_required(*VIEW_PERMS)
def details(service_pk):
    form = DetailsForm()
    _lookup_choices(form)
    return _action(service_pk, form, lambda sv: svc.save_work_details(
        current_user, sv.id, {k: v for k, v in form.data.items() if k != "csrf_token"}), "Work details saved.", "#work")


@bp.post("/<int:service_pk>/complete")
@any_permission_required(*VIEW_PERMS)
def complete(service_pk):
    form = CompleteForm()
    return _action(service_pk, form, lambda sv: svc.complete_service(
        current_user, sv.id, {k: v for k, v in form.data.items() if k != "csrf_token"}),
        "Completion report submitted. The job is now Completed.", "#timeline")


@bp.post("/<int:service_pk>/acknowledge")
@any_permission_required(*VIEW_PERMS)
def acknowledge(service_pk):
    form = AckForm()
    return _action(service_pk, form, lambda sv: svc.record_acknowledgment(current_user, sv.id, form.name.data),
                   "Customer acknowledgment recorded.", "#work")


@bp.post("/<int:service_pk>/note")
@any_permission_required(*VIEW_PERMS)
def note(service_pk):
    form = NoteForm()
    return _action(service_pk, form, lambda sv: svc.add_note(current_user, sv.id, form.note.data), "Note added.", "#timeline")


@bp.post("/<int:service_pk>/attachments")
@limiter.limit("60 per hour")
@any_permission_required(*VIEW_PERMS)
def upload(service_pk):
    s = _load(service_pk)
    files = [f for f in request.files.getlist("files") if f and f.filename]
    if not files:
        flash("Choose at least one file to upload.", "warning")
    saved = 0
    for f in files:
        try:
            upload_service.save_upload(current_user, "service", s.id, f, request.form.get("description"))
            saved += 1
        except ServiceError as exc:
            flash(f"{f.filename}: {exc}", "danger")
    if saved:
        flash(f"{saved} file{'s' if saved != 1 else ''} uploaded.", "success")
    return _back(s, "#files")


@bp.post("/attachments/<int:attachment_id>/delete")
@any_permission_required(*VIEW_PERMS)
def delete_attachment(attachment_id):
    from ...models import Attachment
    att = db.session.get(Attachment, attachment_id)
    if att is None or att.owner_type != "service" or not upload_service.can_view(current_user, att):
        abort(404)
    try:
        upload_service.delete_attachment(current_user, attachment_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash("File removed.", "success")
    return redirect(url_for("services.detail", service_pk=att.owner_id) + "#files")


# ------------------------------------------------------------------ materials / requirements
@bp.post("/<int:service_pk>/requirements")
@any_permission_required(*VIEW_PERMS)
def add_requirement(service_pk):
    form = RequirementForm()
    _requirement_choices(form)
    return _action(service_pk, form, lambda sv: reqs.add_requirement(
        current_user, sv.id, {k: v for k, v in form.data.items() if k != "csrf_token"}),
        "Added to the request list. Submit it for approval when the list is complete.", "#materials")


@bp.post("/<int:service_pk>/requirements/submit")
@any_permission_required(*VIEW_PERMS)
def submit_requirements(service_pk):
    s = _load(service_pk)
    try:
        lines = reqs.submit_requirements(current_user, s.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash(f"{len(lines)} line(s) sent for approval.", "success")
    return _back(s, "#materials")


@bp.post("/requirements/<int:req_id>/delete")
@any_permission_required(*VIEW_PERMS)
def delete_requirement(req_id):
    from ...models import ServiceRequirement
    line = db.session.get(ServiceRequirement, req_id)
    if line is None or svc.get_visible(current_user, line.service_request_id) is None:
        abort(404)
    try:
        reqs.delete_draft(current_user, req_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash("Line removed.", "success")
    return redirect(url_for("services.detail", service_pk=line.service_request_id) + "#materials")


@bp.post("/requirements/<int:req_id>/usage")
@any_permission_required(*VIEW_PERMS)
def record_usage(req_id):
    from ...models import ServiceRequirement
    line = db.session.get(ServiceRequirement, req_id)
    if line is None or svc.get_visible(current_user, line.service_request_id) is None:
        abort(404)
    try:
        reqs.record_usage(current_user, req_id, request.form.get("used_qty"))
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash("Usage recorded.", "success")
    return redirect(url_for("services.detail", service_pk=line.service_request_id) + "#materials")


@bp.route("/<int:service_pk>/report.pdf")
@any_permission_required(*VIEW_PERMS)
def report_pdf(service_pk):
    s = _load(service_pk)
    data = pdf_service.build_service_report(s, include_financials=current_user.has_permission("invoice.view"))
    return send_file(io.BytesIO(data), mimetype="application/pdf", download_name=f"{s.service_id}-report.pdf", max_age=0)
