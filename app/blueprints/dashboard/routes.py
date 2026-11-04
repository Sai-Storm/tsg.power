from datetime import date, datetime, time, timedelta
from decimal import Decimal

from flask import Blueprint, abort, render_template, request, url_for
from flask_login import current_user, login_required
from sqlalchemy import case, func, or_, select

from ...extensions import db
from ...models import (Customer, Generator, InventoryItem, Invoice, Payment, ServiceAssignment,
                       ServiceRequest, Role, User)
from ...models.service import OPEN_STATUSES, STATUSES
from ...services import service_request_service as svc
from ...utils.time import local_to_utc, local_today, utc_to_local, utcnow

bp = Blueprint("dashboard", __name__)


def _date_arg(name):
    value = request.args.get(name, "").strip()
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        abort(400, description=f"Invalid {name} date.")


def _service_scope(start, end, status=None):
    stmt = select(ServiceRequest).where(svc.visible_clause(current_user))
    if start:
        stmt = stmt.where(ServiceRequest.created_at >= local_to_utc(datetime.combine(start, time.min)))
    if end:
        stmt = stmt.where(ServiceRequest.created_at < local_to_utc(datetime.combine(end + timedelta(days=1), time.min)))
    if status:
        stmt = stmt.where(ServiceRequest.status == status)
    return stmt


def _periods(start, end):
    if start and end:
        return start, end
    today = local_today()
    return start or today.replace(day=1) - timedelta(days=335), end or today


def _chart_data(start, end, status):
    first, last = _periods(start, end)
    lower = local_to_utc(datetime.combine(first, time.min))
    upper = local_to_utc(datetime.combine(last + timedelta(days=1), time.min))
    month_expr = func.strftime("%Y-%m", ServiceRequest.created_at) if db.engine.dialect.name == "sqlite" \
        else func.date_format(ServiceRequest.created_at, "%Y-%m")
    monthly_services = select(month_expr, func.count(ServiceRequest.id)).where(
        ServiceRequest.created_at >= lower, ServiceRequest.created_at < upper,
        svc.visible_clause(current_user))
    if status:
        monthly_services = monthly_services.where(ServiceRequest.status == status)
    services_by_month = dict(db.session.execute(monthly_services.group_by(month_expr)).all())

    payment_month = func.strftime("%Y-%m", Payment.paid_at) if db.engine.dialect.name == "sqlite" \
        else func.date_format(Payment.paid_at, "%Y-%m")
    signed_amount = case((Payment.payment_type == "refund", -Payment.amount),
                         (Payment.payment_type == "payment", Payment.amount), else_=Decimal("0"))
    revenue_rows = db.session.execute(
        select(payment_month, func.coalesce(func.sum(signed_amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .where(Payment.paid_at >= lower, Payment.paid_at < upper,
               Invoice.status != "void")
        .group_by(payment_month)
    ).all()
    revenue_by_month = dict(revenue_rows)

    status_rows = db.session.execute(
        select(ServiceRequest.status, func.count(ServiceRequest.id))
        .where(ServiceRequest.created_at >= lower, ServiceRequest.created_at < upper,
               svc.visible_clause(current_user))
        .group_by(ServiceRequest.status)
    ).all()
    if status:
        status_rows = [(key, value if key == status else 0) for key, value in status_rows]

    workload_rows = db.session.execute(
        select(User.full_name, func.count(func.distinct(ServiceAssignment.service_request_id)))
        .join(ServiceAssignment, ServiceAssignment.user_id == User.id)
        .join(ServiceRequest, ServiceRequest.id == ServiceAssignment.service_request_id)
        .where(ServiceAssignment.unassigned_at.is_(None), ServiceRequest.status.in_(OPEN_STATUSES),
               ServiceRequest.created_at >= lower, ServiceRequest.created_at < upper)
        .group_by(User.id, User.full_name)
        .order_by(func.count(func.distinct(ServiceAssignment.service_request_id)).desc(), User.full_name)
        .limit(10)
    ).all()
    months = []
    cursor = first.replace(day=1)
    end_month = last.replace(day=1)
    while cursor <= end_month:
        months.append(cursor.strftime("%Y-%m"))
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
    return {
        "months": months,
        "service_counts": [int(services_by_month.get(m, 0)) for m in months],
        "revenues": [float(revenue_by_month.get(m, 0) or 0) for m in months],
        "status_labels": [STATUSES.get(key, key) for key, _ in status_rows],
        "status_counts": [int(value) for _, value in status_rows],
        "workload_labels": [name for name, _ in workload_rows],
        "workload_counts": [int(value) for _, value in workload_rows],
    }


@bp.route("/")
@login_required
def home():
    start, end = _date_arg("from"), _date_arg("to")
    status = request.args.get("status", "").strip()
    if status and status not in STATUSES:
        abort(400, description="Invalid service status.")
    if start and end and start > end:
        abort(400, description="The start date must not be after the end date.")

    services = db.session.scalars(_service_scope(start, end, status)).all()
    counts = {key: sum(service.status == key for service in services) for key in STATUSES}
    overdue = sum(service.is_overdue for service in services)
    today = local_today()
    lower, upper = _periods(start, end)

    cards = []
    range_args = {"from": start.isoformat() if start else None, "to": end.isoformat() if end else None}
    if current_user.has_permission("customer.view"):
        cards.append({"label": "Customers", "value": db.session.scalar(select(func.count(Customer.id))) or 0,
                      "href": url_for("customers.list_customers")})
    if current_user.has_permission("generator.view"):
        cards.append({"label": "Generators", "value": db.session.scalar(select(func.count(Generator.id))) or 0,
                      "href": url_for("generators.list_generators")})
    if current_user.has_permission("staff.manage"):
        staff_stmt = select(func.count(User.id)).join(Role, Role.id == User.role_id).where(Role.name != "customer")
        cards.append({"label": "Staff accounts", "value": db.session.scalar(staff_stmt) or 0, "href": "/staff/"})

    service_labels = (
        ("New jobs", "new_request"),
        ("Pending jobs", "under_review"),
        ("Assigned jobs", "assigned"),
        ("Scheduled jobs", "scheduled"),
        ("In progress", "in_progress"),
        ("Waiting for parts", "waiting_parts"),
        ("Completed jobs", "completed"),
    )
    for label, key in service_labels:
        cards.append({"label": label, "value": counts.get(key, 0),
                      "href": url_for("services.list_services", status=key, **range_args)})
    cards.append({"label": "Overdue jobs", "value": overdue,
                  "href": url_for("services.list_services", overdue=1, **range_args)})
    if current_user.has_permission("inventory.view"):
        cards.append({"label": "Low-stock parts",
                      "value": db.session.scalar(select(func.count(InventoryItem.id)).where(
                          InventoryItem.is_active.is_(True), InventoryItem.current_stock <= InventoryItem.min_stock)) or 0,
                      "href": url_for("inventory.list_items", low=1)})
    if current_user.has_permission("invoice.view"):
        outstanding = db.session.execute(
            select(func.count(Invoice.id), func.coalesce(func.sum(Invoice.total - Invoice.amount_paid -
                                                                  Invoice.adjustment_total), 0))
            .where(Invoice.status.in_(("issued", "partial")), Invoice.total > Invoice.amount_paid +
                   Invoice.adjustment_total)
        ).one()
        cards.append({"label": "Outstanding payments", "value": outstanding[0] or 0,
                      "amount": outstanding[1] or 0,                       "href": url_for("invoices.list_invoices", outstanding=1)})
        revenue_start = start or today.replace(day=1)
        revenue_end = end or today
        revenue = db.session.scalar(
            select(func.coalesce(func.sum(case((Payment.payment_type == "refund", -Payment.amount),
                                               (Payment.payment_type == "payment", Payment.amount),
                                               else_=Decimal("0"))), 0))
            .join(Invoice, Invoice.id == Payment.invoice_id)
            .where(Invoice.status != "void",
                   Payment.paid_at >= local_to_utc(datetime.combine(revenue_start, time.min)),
                   Payment.paid_at < local_to_utc(datetime.combine(revenue_end + timedelta(days=1), time.min)))
        ) or 0
        cards.append({"label": "Revenue in period", "value": revenue,
                      "href": url_for("reports.index", type="revenue",
                                      **{"from": start.isoformat() if start else revenue_start.isoformat(),
                                         "to": end.isoformat() if end else revenue_end.isoformat()})})
    charts = _chart_data(start, end, status)
    return render_template("dashboard/home.html", cards=cards, charts=charts, start=start, end=end,
                           selected_status=status, statuses=STATUSES, today=today)
