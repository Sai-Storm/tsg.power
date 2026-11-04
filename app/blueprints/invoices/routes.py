import io
from datetime import date, datetime

from flask import Blueprint, abort, flash, redirect, render_template, request, send_file, url_for
from flask_login import current_user

from ...extensions import db
from ...models import Invoice, Payment
from ...models.billing import (INVOICE_BADGE, INVOICE_STATUSES, ITEM_TYPES, PAYMENT_METHODS, PAYMENT_TYPES)
from ...security.decorators import permission_required
from ...services import (estimate_service, finance_service, invoice_service as inv_svc, pdf_service,
                        service_request_service as svc)
from ...services.errors import ServiceError

bp = Blueprint("invoices", __name__, url_prefix="/invoices")


def _date(name):
    try:
        return date.fromisoformat(request.args[name]) if request.args.get(name) else None
    except ValueError:
        return None


def _invoice(invoice_id):
    inv = db.session.get(Invoice, invoice_id)
    if inv is None:
        abort(404)
    return inv


def _go(call, ok):
    try:
        result = call()
    except ServiceError as exc:
        flash(str(exc), "danger")
        return None
    flash(ok, "success")
    return result


def _pdf(data, name):
    return send_file(io.BytesIO(data), mimetype="application/pdf", download_name=name, max_age=0)


@bp.route("/")
@permission_required("invoice.view")
def list_invoices():
    a = request.args
    sort = a.get("sort", "issued")
    direction = "asc" if a.get("dir") == "asc" else "desc"
    stmt = inv_svc.search_invoices(a.get("q", "").strip(), a.get("status", ""), a.get("outstanding") == "1",
                                   a.get("overdue") == "1", _date("from"), _date("to"), sort, direction)
    pagination = db.paginate(stmt, page=a.get("page", 1, type=int), per_page=15, error_out=False)
    return render_template("invoices/list.html", pagination=pagination, f=a, sort=sort, direction=direction,
                           summary=inv_svc.outstanding_summary(), statuses=INVOICE_STATUSES, badge=INVOICE_BADGE,
                           can_manage=current_user.has_permission("invoice.manage"))


@bp.post("/from-service/<int:service_pk>")
@permission_required("invoice.manage")
def create_from_service(service_pk):
    if svc.get_visible(current_user, service_pk) is None:
        abort(404)
    inv = _go(lambda: inv_svc.create_draft(current_user, service_pk), "Draft invoice created. Review it, then issue it.")
    if inv is None:
        return redirect(url_for("services.detail", service_pk=service_pk) + "#billing")
    if getattr(inv, "unpriced_lines", 0):
        flash(f"{inv.unpriced_lines} used item(s) have no price. Check the unit prices before issuing.", "warning")
    return redirect(url_for("invoices.detail", invoice_id=inv.id))


@bp.route("/<int:invoice_id>")
@permission_required("invoice.view")
def detail(invoice_id):
    inv = _invoice(invoice_id)
    can_pay = current_user.has_permission("payment.record")
    customer_advances = []
    if can_pay and inv.status not in ("draft", "void"):
        customer_advances = [
            advance for advance in finance_service.list_customer_advances(inv.service.customer_id)
            if finance_service.customer_advance_balance(advance) > 0
        ]
    return render_template("invoices/detail.html", i=inv, statuses=INVOICE_STATUSES, badge=INVOICE_BADGE,
                           item_types=ITEM_TYPES,
                           methods=PAYMENT_METHODS,
                           payment_methods={key: value for key, value in PAYMENT_METHODS.items()
                                            if key != "customer_credit"},
                           ptypes=PAYMENT_TYPES,
                           estimate=estimate_service.latest_estimate(inv.service),
                           can_manage=current_user.has_permission("invoice.manage"),
                           can_pay=can_pay, customer_advances=customer_advances,
                           customer_advance_balances={
                               advance.id: finance_service.customer_advance_balance(advance)
                               for advance in customer_advances
                           })


def _back(invoice_id):
    return redirect(url_for("invoices.detail", invoice_id=invoice_id))


@bp.post("/<int:invoice_id>/items")
@permission_required("invoice.manage")
def add_item(invoice_id):
    f = request.form
    _go(lambda: inv_svc.add_item(current_user, invoice_id, f.get("description"), f.get("quantity"),
                                 f.get("unit_price"), f.get("item_type", "other")), "Line added.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/items/<int:item_id>")
@permission_required("invoice.manage")
def update_item(invoice_id, item_id):
    f = request.form
    _go(lambda: inv_svc.update_item(current_user, invoice_id, item_id, f.get("quantity"), f.get("unit_price"),
                                    f.get("description")), "Line updated.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/items/<int:item_id>/delete")
@permission_required("invoice.manage")
def delete_item(invoice_id, item_id):
    _go(lambda: inv_svc.delete_item(current_user, invoice_id, item_id), "Line removed.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/terms")
@permission_required("invoice.manage")
def terms(invoice_id):
    f = request.form
    _go(lambda: inv_svc.set_terms(current_user, invoice_id, f.get("discount"), f.get("discount_reason"),
                                  f.get("tax_rate"), f.get("notes")), "Discount, tax and notes saved.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/issue")
@permission_required("invoice.manage")
def issue(invoice_id):
    _go(lambda: inv_svc.issue_invoice(current_user, invoice_id), "Invoice issued.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/discard")
@permission_required("invoice.manage")
def discard(invoice_id):
    inv = _invoice(invoice_id)
    service_pk = inv.service_request_id
    if _go(lambda: inv_svc.discard_draft(current_user, invoice_id) or True, "Draft discarded."):
        return redirect(url_for("services.detail", service_pk=service_pk) + "#billing")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/void")
@permission_required("invoice.manage")
def void(invoice_id):
    _go(lambda: inv_svc.void_invoice(current_user, invoice_id, request.form.get("reason")), "Invoice voided.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/payments")
@permission_required("payment.record")
def add_payment(invoice_id):
    f = request.form
    when = None
    if f.get("paid_at"):
        try:
            when = datetime.strptime(f["paid_at"], "%Y-%m-%dT%H:%M")
        except ValueError:
            flash("Enter a valid payment date and time.", "danger")
            return _back(invoice_id)
    payment = _go(lambda: inv_svc.record_payment(current_user, invoice_id, f.get("kind"), f.get("amount"),
                                                 f.get("method"), f.get("reference"), when, f.get("reason")),
                  "Recorded.")
    return _back(invoice_id)


@bp.post("/<int:invoice_id>/customer-advances")
@permission_required("payment.record")
def apply_customer_advance(invoice_id):
    _go(
        lambda: finance_service.apply_customer_advance(
            current_user, request.form.get("customer_advance_id", type=int),
            invoice_id, request.form.get("amount"),
        ),
        "Customer deposit applied to the invoice.",
    )
    return _back(invoice_id)


@bp.route("/<int:invoice_id>/pdf")
@permission_required("invoice.view")
def invoice_pdf(invoice_id):
    inv = _invoice(invoice_id)
    return _pdf(pdf_service.build_invoice(inv), f"{inv.display_number.replace(' ', '_').replace('#', '')}.pdf")


@bp.route("/payments/<int:payment_id>/receipt.pdf")
@permission_required("invoice.view")
def receipt_pdf(payment_id):
    payment = db.session.get(Payment, payment_id)
    if payment is None:
        abort(404)
    return _pdf(pdf_service.build_receipt(payment), f"{payment.number}.pdf")
