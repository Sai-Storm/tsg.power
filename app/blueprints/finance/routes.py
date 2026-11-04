import csv
import io
from datetime import date, timedelta

from flask import Blueprint, abort, flash, make_response, redirect, render_template, request, send_file, url_for
from flask_login import current_user
from sqlalchemy import select

from ...extensions import db
from ...models import Customer, User
from ...models.billing import PAYMENT_METHODS
from ...models.finance import CASH_CATEGORIES, CASH_DIRECTIONS, CLAIM_CATEGORIES, CLAIM_STATUSES
from ...security.decorators import any_permission_required, permission_required
from ...services import finance_service as finance
from ...services import accounting_workbook as workbook_service
from ...services.errors import ServiceError
from ...utils.time import local_today, utc_to_local

bp = Blueprint("finance", __name__, url_prefix="/finance")
FINANCE_ACCESS = ("finance.claim", "finance.manage")
def _require_accounting_workbook_access():
    if not all(current_user.has_permission(code) for code in workbook_service.PERMISSIONS):
        abort(403)


@bp.route("/excel")
@permission_required("finance.manage")
def export_excel():
    _require_accounting_workbook_access()
    return send_file(
        workbook_service.export_workbook(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="gcsms-accounting.xlsx",
        max_age=0,
    )


@bp.route("/excel/template")
@permission_required("finance.manage")
def excel_template():
    _require_accounting_workbook_access()
    return send_file(
        workbook_service.template_workbook(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="gcsms-accounting-template.xlsx",
        max_age=0,
    )


@bp.post("/excel/import")
@permission_required("finance.manage")
def import_excel():
    _require_accounting_workbook_access()
    uploaded = request.files.get("workbook")
    if uploaded is None or not uploaded.filename:
        flash("Choose an Excel .xlsx workbook to import.", "danger")
        return redirect(url_for("finance.index"))
    if not uploaded.filename.lower().endswith(".xlsx"):
        flash("Only .xlsx workbooks are supported.", "danger")
        return redirect(url_for("finance.index"))
    try:
        results = workbook_service.import_workbook(io.BytesIO(uploaded.read()), current_user)
    except ServiceError as exc:
        db.session.rollback()
        flash(str(exc), "danger")
        return redirect(url_for("finance.index"))
    return send_file(
        workbook_service.results_workbook(results),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="gcsms-import-results.xlsx",
        max_age=0,
    )


def _flash_action(call, success):
    try:
        result = call()
    except ServiceError as exc:
        db.session.rollback()
        flash(str(exc), "danger")
        return None
    flash(success, "success")
    return result


@bp.route("/")
@any_permission_required(*FINANCE_ACCESS)
def index():
    advances = finance.list_advances(current_user)
    claims = finance.list_claims(current_user)
    advance_requests = finance.list_advance_requests(current_user)
    balances = {advance.id: finance.advance_outstanding(advance) for advance in advances}
    manager = current_user.has_permission("finance.manage")
    movements = finance.cash_movements(limit=50) if manager else []
    customer_advances = finance.list_customer_advances() if manager else []
    return render_template(
        "finance/index.html",
        advances=advances,
        claims=claims,
        advance_requests=advance_requests,
        balances=balances,
        manager=manager,
        movements=movements,
        customer_advances=customer_advances,
        customer_advance_balances={
            advance.id: finance.customer_advance_balance(advance) for advance in customer_advances
        },
        customers=db.session.scalars(
            select(Customer).where(Customer.is_active.is_(True)).order_by(Customer.name)
        ).all() if manager else [],
        jobs=finance.available_jobs(current_user),
        customers_for_deposits=manager,
        payment_methods={key: value for key, value in PAYMENT_METHODS.items() if key != "customer_credit"},
        receipts=finance.payment_receipts(limit=50) if manager else [],
        cash_balance=finance.cash_balance() if manager else None,
        advance_total=sum(balances.values(), start=0),
        categories=CLAIM_CATEGORIES,
        statuses=CLAIM_STATUSES,
    )


def _cash_dates():
    def parse(name):
        value = request.args.get(name, "").strip()
        if not value:
            return None
        try:
            return date.fromisoformat(value)
        except ValueError:
            abort(400, description=f"Invalid {name} date.")

    start, end = parse("from"), parse("to")
    if start and end and start > end:
        abort(400, description="The start date must not be after the end date.")
    return start, end


def _ledger_rows(start, end):
    rows = list(reversed(finance.cash_movements(start, end, limit=None)))
    balance = finance.cash_balance(start - timedelta(days=1)) if start else 0
    for row in rows:
        amount = row["amount"] if row["direction"] == "in" else -row["amount"]
        balance += amount
        row["balance"] = balance
        row["signed_amount"] = amount
        row["local_at"] = utc_to_local(row["at"])
    return rows, balance


@bp.route("/cash")
@permission_required("finance.manage")
def cash_ledger():
    start, end = _cash_dates()
    rows, closing_balance = _ledger_rows(start, end)
    opening_balance = finance.cash_balance(start - timedelta(days=1)) if start else 0
    return render_template(
        "finance/cash.html",
        rows=rows,
        start=start,
        end=end,
        opening_balance=opening_balance,
        closing_balance=closing_balance,
    )


@bp.route("/cash.csv")
@permission_required("finance.manage")
def export_cash_ledger():
    start, end = _cash_dates()
    rows, _ = _ledger_rows(start, end)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["Date", "Direction", "Source", "Reference", "Description", "Amount", "Balance"])
    for row in rows:
        values = [
            row["local_at"].strftime("%Y-%m-%d %H:%M"),
            CASH_DIRECTIONS[row["direction"]],
            row["source"],
            row["reference"],
            row["description"],
            row["signed_amount"],
            row["balance"],
        ]
        for index in (2, 3, 4):
            value = values[index]
            if value.startswith(("=", "+", "-", "@", "\t", "\r")):
                values[index] = "'" + value
        writer.writerow(values)
    response = make_response("\ufeff" + stream.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = 'attachment; filename="cash-ledger.csv"'
    return response


@bp.route("/receipts")
@permission_required("finance.manage")
def receipts():
    start, end = _cash_dates()
    rows = finance.payment_receipts(start, end, limit=None)
    return render_template("finance/receipts.html", receipts=rows, start=start, end=end)


@bp.route("/receipts.csv")
@permission_required("finance.manage")
def export_receipts():
    start, end = _cash_dates()
    rows = finance.payment_receipts(start, end, limit=None)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["Date", "Receipt", "Invoice", "Service", "Customer", "Method", "Reference", "Amount"])
    for payment in rows:
        values = [
            utc_to_local(payment.paid_at).strftime("%Y-%m-%d %H:%M"),
            payment.number,
            payment.invoice.display_number,
            payment.invoice.service.service_id,
            payment.invoice.service.customer.name,
            payment.method or "",
            payment.reference or "",
            payment.amount,
        ]
        for index in (1, 2, 3, 4, 5, 6):
            value = values[index]
            if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
                values[index] = "'" + value
        writer.writerow(values)
    response = make_response("\ufeff" + stream.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = 'attachment; filename="cash-receipts.csv"'
    return response


@bp.route("/claims/new", methods=["GET", "POST"])
@any_permission_required(*FINANCE_ACCESS)
def new_claim():
    advances = finance.list_advances(current_user)
    if request.method == "POST":
        try:
            incurred_on = date.fromisoformat(request.form.get("incurred_on", ""))
        except ValueError:
            flash("Enter a valid expense date.", "danger")
        else:
            claim = _flash_action(
                lambda: finance.submit_claim(
                    current_user,
                    request.form.get("category"),
                    request.form.get("description"),
                    request.form.get("amount"),
                    incurred_on,
                    request.form.get("advance_id", type=int),
                    request.form.get("receipt_reference"),
                    service_request_id=request.form.get("service_request_id", type=int),
                ),
                "Expense claim submitted for approval.",
            )
            if claim is not None:
                return redirect(url_for("finance.index"))
    return render_template(
        "finance/claim_form.html",
        advances=advances,
        jobs=finance.available_jobs(current_user),
        balances={advance.id: finance.advance_outstanding(advance) for advance in advances},
        categories=CLAIM_CATEGORIES,
        today=local_today(),
    )


@bp.post("/advance-requests")
@permission_required("finance.claim")
def request_advance():
    _flash_action(
        lambda: finance.request_advance(
            current_user, request.form.get("amount"), request.form.get("reason"),
            request.form.get("service_request_id", type=int),
        ),
        "Advance request submitted for manager approval.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/advance-requests/<int:request_id>/approve")
@permission_required("finance.manage")
def approve_advance_request(request_id):
    _flash_action(
        lambda: finance.approve_advance_request(
            current_user, request_id, request.form.get("approved_amount")
        ),
        "Employee advance request approved.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/advance-requests/<int:request_id>/reject")
@permission_required("finance.manage")
def reject_advance_request(request_id):
    _flash_action(
        lambda: finance.reject_advance_request(
            current_user, request_id, request.form.get("reason")
        ),
        "Employee advance request rejected.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/advance-requests/<int:request_id>/issue")
@permission_required("finance.manage")
def issue_approved_advance(request_id):
    _flash_action(
        lambda: finance.issue_approved_advance(
            current_user, request_id, request.form.get("method"),
            request.form.get("reference"),
        ),
        "Approved employee advance issued and recorded.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/customer-advances")
@permission_required("finance.manage")
def receive_customer_advance():
    _flash_action(
        lambda: finance.receive_customer_advance(
            current_user, request.form.get("customer_id", type=int), request.form.get("amount"),
            request.form.get("method"), request.form.get("reference"), request.form.get("notes"),
        ),
        "Customer deposit received and recorded as a liability.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/advances/<int:advance_id>/returns")
@permission_required("finance.manage")
def return_advance(advance_id):
    _flash_action(
        lambda: finance.return_advance(
            current_user, advance_id, request.form.get("amount"), request.form.get("note")
        ),
        "Unused advance returned and recorded as cash in.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/claims/<int:claim_id>/approve")
@permission_required("finance.manage")
def approve_claim(claim_id):
    _flash_action(lambda: finance.approve_claim(current_user, claim_id), "Expense claim approved.")
    return redirect(url_for("finance.index"))


@bp.post("/claims/<int:claim_id>/reject")
@permission_required("finance.manage")
def reject_claim(claim_id):
    _flash_action(
        lambda: finance.reject_claim(current_user, claim_id, request.form.get("reason")),
        "Expense claim rejected.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/claims/<int:claim_id>/pay")
@permission_required("finance.manage")
def pay_claim(claim_id):
    _flash_action(
        lambda: finance.pay_claim(current_user, claim_id, request.form.get("method")),
        "Expense reimbursement paid.",
    )
    return redirect(url_for("finance.index"))


@bp.post("/cash-entries")
@permission_required("finance.manage")
def record_cash_entry():
    direction = request.form.get("direction")
    _flash_action(
        lambda: finance.record_cash_entry(
            current_user,
            direction,
            request.form.get("category"),
            request.form.get("amount"),
            request.form.get("description"),
            request.form.get("reference"),
        ),
        f"Cash {CASH_DIRECTIONS.get(direction, 'movement').lower()} recorded.",
    )
    return redirect(url_for("finance.index"))


@bp.before_request
def ensure_staff_access():
    if current_user.is_authenticated and not any(current_user.has_permission(code) for code in FINANCE_ACCESS):
        abort(403)


@bp.context_processor
def finance_form_choices():
    if current_user.is_authenticated and current_user.has_permission("finance.manage"):
        return {
            "finance_employees": db.session.scalars(
                select(User).where(User.is_active.is_(True)).order_by(User.full_name)
            ).all(),
            "cash_categories": CASH_CATEGORIES,
            "cash_directions": CASH_DIRECTIONS,
        }
    return {"finance_employees": [], "cash_categories": CASH_CATEGORIES, "cash_directions": CASH_DIRECTIONS}
