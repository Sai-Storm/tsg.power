import csv
import io
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from flask import Blueprint, abort, flash, make_response, redirect, render_template, request, send_file, url_for
from flask_login import current_user, login_required
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from sqlalchemy import func, or_, select

from ...extensions import db
from ...models import (AuditLog, Customer, Generator, InventoryItem, InventoryTransaction,
                       Invoice, ServiceRequest, User)
from ...models.service import STATUSES
from ...security.decorators import permission_required
from ...services import service_request_service as svc
from ...services.errors import ServiceError
from ...services import finance_service
from ...utils.time import local_to_utc, local_today, utc_to_local

bp = Blueprint("reports", __name__, url_prefix="/reports")

REPORTS = {
    "services": "Service jobs",
    "revenue": "Revenue",
    "outstanding": "Outstanding invoices",
    "inventory": "Inventory stock",
    "movements": "Stock movements",
    "performance": "Staff performance",
    "financial": "Income and expense",
}


def _dates():
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


def _bounds(start, end, column):
    clauses = []
    if start:
        clauses.append(column >= local_to_utc(datetime.combine(start, time.min)))
    if end:
        clauses.append(column < local_to_utc(datetime.combine(end + timedelta(days=1), time.min)))
    return clauses


def report_rows(kind, start=None, end=None):
    if kind == "financial":
        if not current_user.has_permission("finance.manage"):
            abort(403)
        rows = finance_service.financial_report(start, end)
        headers = ["Date", "Category", "Reference", "Description", "Income", "Expense"]
        return headers, [
            [utc_to_local(row["at"]).strftime("%Y-%m-%d"), row["category"], row["reference"],
             row["description"], row["income"], row["expense"]]
            for row in rows
        ]

    if kind == "services":
        stmt = (select(ServiceRequest).where(svc.visible_clause(current_user))
                .order_by(ServiceRequest.created_at.desc()))
        if start:
            stmt = stmt.where(ServiceRequest.created_at >= local_to_utc(datetime.combine(start, time.min)))
        if end:
            stmt = stmt.where(ServiceRequest.created_at < local_to_utc(datetime.combine(end + timedelta(days=1), time.min)))
        jobs = db.session.scalars(stmt.limit(5000)).all()
        return ["Service ID", "Customer", "Generator", "Status", "Technicians", "Created", "Completed"], [
            [job.service_id, job.customer.name, f"{job.generator.brand} {job.generator.model}",
             STATUSES[job.status], ", ".join(a.user.full_name for a in job.active_assignments),
             utc_to_local(job.created_at).strftime("%Y-%m-%d %H:%M"),
             job.actual_completion.isoformat() if job.actual_completion else ""]
            for job in jobs]

    if kind in ("revenue", "outstanding"):
        if not current_user.has_permission("invoice.view"):
            abort(403)
        stmt = select(Invoice).order_by(Invoice.issued_at.desc(), Invoice.id.desc())
        if kind == "outstanding":
            stmt = stmt.where(Invoice.status.in_(("issued", "partial")),
                              Invoice.total > Invoice.amount_paid + Invoice.adjustment_total)
        if start:
            stmt = stmt.where(Invoice.issued_at >= local_to_utc(datetime.combine(start, time.min)))
        if end:
            stmt = stmt.where(Invoice.issued_at < local_to_utc(datetime.combine(end + timedelta(days=1), time.min)))
        invoices = db.session.scalars(stmt.limit(5000)).all()
        headers = ["Invoice", "Service ID", "Customer", "Status", "Issued", "Total", "Paid", "Balance"]
        rows = [[invoice.display_number, invoice.service.service_id, invoice.service.customer.name,
                 invoice.status, utc_to_local(invoice.issued_at).strftime("%Y-%m-%d") if invoice.issued_at else "",
                 invoice.total, invoice.amount_paid, invoice.balance] for invoice in invoices]
        return headers, rows

    if kind == "inventory":
        if not current_user.has_permission("inventory.view"):
            abort(403)
        items = db.session.scalars(select(InventoryItem).order_by(InventoryItem.part_code).limit(5000)).all()
        return ["Part ID", "Name", "Category", "Stock", "Unit", "Minimum", "Low stock"], [
            [item.part_code, item.name, item.category.name if item.category else "", item.current_stock, item.unit,
             item.min_stock, "Yes" if item.is_low else "No"] for item in items]

    if kind == "movements":
        if not current_user.has_permission("inventory.view"):
            abort(403)
        stmt = select(InventoryTransaction).order_by(InventoryTransaction.created_at.desc())
        stmt = stmt.where(*_bounds(start, end, InventoryTransaction.created_at))
        movements = db.session.scalars(stmt.limit(5000)).all()
        return ["Date", "Part ID", "Part", "Type", "Change", "Balance", "Service ID", "Reference"], [
            [utc_to_local(row.created_at).strftime("%Y-%m-%d %H:%M"), row.item.part_code, row.item.name,
             row.txn_type, row.quantity_delta, row.balance_after,
             row.service.service_id if row.service else "", row.reference or ""] for row in movements]

    if kind == "performance":
        staff_rows = svc.technician_options()
        job_stmt = select(ServiceRequest).where(
            ServiceRequest.status.in_(("completed", "closed")),
            ServiceRequest.actual_completion.is_not(None),
            svc.visible_clause(current_user),
        )
        if start:
            job_stmt = job_stmt.where(ServiceRequest.actual_completion >= start)
        if end:
            job_stmt = job_stmt.where(ServiceRequest.actual_completion <= end)
        jobs = db.session.scalars(job_stmt.limit(10000)).all()
        stats = {staff.id: {"completed": 0, "durations": [], "overdue": 0} for staff in staff_rows}
        for job in jobs:
            created_local = utc_to_local(job.created_at).date()
            duration = (job.actual_completion - created_local).days
            for assignment in job.assignments:
                row = stats.get(assignment.user_id)
                if row is not None:
                    row["completed"] += 1
                    row["durations"].append(duration)
        open_jobs = db.session.scalars(select(ServiceRequest).where(
            ServiceRequest.status.not_in(("completed", "closed", "cancelled")),
            svc.visible_clause(current_user),
        )).all()
        for job in open_jobs:
            if job.is_overdue:
                for assignment in job.active_assignments:
                    if assignment.user_id in stats:
                        stats[assignment.user_id]["overdue"] += 1
        headers = ["Staff", "Completed jobs", "Average days to complete", "Overdue open jobs"]
        rows = [[staff.full_name, stats[staff.id]["completed"],
                 round(sum(stats[staff.id]["durations"]) / len(stats[staff.id]["durations"]), 2)
                 if stats[staff.id]["durations"] else "",
                 stats[staff.id]["overdue"]] for staff in staff_rows]
        return headers, rows
    abort(404)


@bp.route("/")
@permission_required("report.view")
def index():
    kind = request.args.get("type", "")
    if kind and kind not in REPORTS:
        abort(400, description="Unknown report type.")
    start, end = _dates()
    headers, rows = report_rows(kind, start, end) if kind else ([], [])
    financial_totals = finance_service.report_totals(start, end) if kind == "financial" else None
    return render_template("reports/index.html", reports=REPORTS, kind=kind, headers=headers,
                           rows=rows, start=start, end=end, financial_totals=financial_totals)


@bp.route("/export/<kind>.<fmt>")
@permission_required("report.view")
def export(kind, fmt):
    if kind not in REPORTS or fmt not in ("csv", "pdf"):
        abort(404)
    start, end = _dates()
    headers, rows = report_rows(kind, start, end)
    filename = f"{kind}-report"
    if fmt == "csv":
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(headers)
        writer.writerows([[
            "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r"))
            else value for value in row
        ] for row in rows])
        response = make_response("\ufeff" + stream.getvalue())
        response.headers["Content-Type"] = "text/csv; charset=utf-8"
        response.headers["Content-Disposition"] = f'attachment; filename="{filename}.csv"'
        return response

    output = io.BytesIO()
    document = SimpleDocTemplate(output, pagesize=landscape(A4), title=REPORTS[kind])
    styles = getSampleStyleSheet()
    title = Paragraph(REPORTS[kind], styles["Title"])
    data = [headers] + [[str(value) for value in row] for row in rows]
    table = Table(data, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9ecef")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#202428")),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#ced4da")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    document.build([title, table])
    output.seek(0)
    return send_file(output, mimetype="application/pdf", as_attachment=True,
                     download_name=f"{filename}.pdf", max_age=0)


@bp.route("/audit")
@permission_required("audit.view")
def audit_log():
    if not current_user.is_admin:
        abort(403)
    start, end = _dates()
    q = request.args.get("q", "").strip()
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    stmt = stmt.where(*_bounds(start, end, AuditLog.created_at))
    user_id = request.args.get("user", type=int)
    if user_id:
        stmt = stmt.where(AuditLog.user_id == user_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(AuditLog.action.ilike(like), AuditLog.entity_type.ilike(like),
                              AuditLog.entity_id.ilike(like), AuditLog.ip_address.ilike(like)))
    pagination = db.paginate(stmt, page=request.args.get("page", 1, type=int), per_page=50, error_out=False)
    users = db.session.scalars(select(User).order_by(User.full_name)).all()
    return render_template("reports/audit.html", pagination=pagination, users=users, start=start, end=end,
                           q=q, selected_user=user_id,
                           filters={key: value for key, value in request.args.items() if key != "page"})


@bp.route("/search")
@login_required
def search():
    q = request.args.get("q", "").strip()
    results = {"services": [], "customers": [], "generators": [], "staff": [], "parts": []}
    search_query = q if len(q) >= 2 else None
    if not q or search_query:
        if current_user.has_permission("service.view_all") or current_user.has_permission("service.view_assigned"):
            jobs = db.session.scalars(svc.search_services(current_user, q=search_query).limit(10)).all()
            results["services"] = [{
                "type": "service", "id": job.id, "title": job.service_id,
                "detail": f"{job.customer.name} · {job.generator.brand} {job.generator.model} · {STATUSES[job.status]}",
                "url": f"/services/{job.id}",
            } for job in jobs]
        like = f"%{q}%"
        if current_user.has_permission("customer.view"):
            customer_stmt = select(Customer)
            if search_query:
                customer_stmt = customer_stmt.where(or_(
                    Customer.customer_code.ilike(like), Customer.name.ilike(like),
                    Customer.phone_primary.ilike(like), Customer.phone_alt.ilike(like),
                ))
            customers = db.session.scalars(customer_stmt.order_by(Customer.created_at.desc()).limit(10)).all()
            results["customers"] = [{"type": "customer", "id": c.id, "title": c.customer_code,
                                     "detail": f"{c.name} · {c.phone_primary}",
                                     "url": f"/customers/{c.id}"} for c in customers]
        if current_user.has_permission("generator.view"):
            generator_stmt = select(Generator)
            if search_query:
                generator_stmt = generator_stmt.where(or_(
                    Generator.generator_code.ilike(like), Generator.serial_number.ilike(like),
                    Generator.model.ilike(like), Generator.brand.ilike(like),
                ))
            generators = db.session.scalars(
                generator_stmt.order_by(Generator.created_at.desc()).limit(10)
            ).all()
            results["generators"] = [{"type": "generator", "id": g.id, "title": g.generator_code,
                                      "detail": f"{g.brand} {g.model} · {g.serial_number} · {g.customer.name}",
                                      "url": f"/generators/{g.id}"} for g in generators]
        if current_user.has_permission("service.view_all") or current_user.has_permission("service.view_assigned"):
            staff_stmt = select(User).where(User.is_active.is_(True))
            if search_query:
                staff_stmt = staff_stmt.where(or_(User.full_name.ilike(like), User.staff_code.ilike(like)))
            staff = db.session.scalars(staff_stmt.order_by(User.full_name).limit(10)).all()
            results["staff"] = [{"type": "staff", "id": person.id, "title": person.full_name,
                                 "detail": person.staff_code,
                                 "url": f"/staff/{person.id}"} for person in staff
                                if current_user.has_permission("staff.manage")]
        if current_user.has_permission("inventory.view"):
            parts_stmt = select(InventoryItem)
            if search_query:
                parts_stmt = parts_stmt.where(or_(
                    InventoryItem.part_code.ilike(like), InventoryItem.name.ilike(like),
                    InventoryItem.sku.ilike(like),
                ))
            parts = db.session.scalars(parts_stmt.order_by(InventoryItem.created_at.desc()).limit(10)).all()
            results["parts"] = [{"type": "part", "id": p.id, "title": p.part_code,
                                 "detail": f"{p.name} · stock {p.current_stock} {p.unit}",
                                 "url": f"/inventory/{p.id}"} for p in parts]
    technicians = svc.technician_options() if current_user.has_permission("service.assign") else []
    return render_template("reports/search.html", q=q, results=results, technicians=technicians,
                           statuses={key: label for key, label in STATUSES.items() if key != "completed"})


@bp.post("/search/actions")
@login_required
def search_actions():
    selected = list(dict.fromkeys(request.form.getlist("selected")))
    search_query = request.form.get("q", "").strip()
    return_url = url_for("reports.search", q=search_query) if search_query else url_for("reports.search")
    if not selected or len(selected) > 50:
        flash("Select between 1 and 50 records.", "warning")
        return redirect(return_url)

    records = []
    for token in selected:
        try:
            kind, raw_id = token.split(":", 1)
            record_id = int(raw_id)
        except (ValueError, TypeError):
            abort(400, description="Invalid selected record.")
        if kind == "service":
            record = svc.get_visible(current_user, record_id)
            if record is None:
                abort(404)
            records.append((kind, record))
        elif kind == "customer" and current_user.has_permission("customer.view"):
            record = db.session.get(Customer, record_id)
            if record is None:
                abort(404)
            records.append((kind, record))
        elif kind == "generator" and current_user.has_permission("generator.view"):
            record = db.session.get(Generator, record_id)
            if record is None:
                abort(404)
            records.append((kind, record))
        elif kind == "part" and current_user.has_permission("inventory.view"):
            record = db.session.get(InventoryItem, record_id)
            if record is None:
                abort(404)
            records.append((kind, record))
        elif kind == "staff" and current_user.has_permission("staff.manage"):
            record = db.session.get(User, record_id)
            if record is None:
                abort(404)
            records.append((kind, record))
        else:
            abort(403)

    action = request.form.get("action")
    if action == "export":
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(("Type", "ID", "Title", "Details", "URL"))
        for kind, record in records:
            if kind == "service":
                title = record.service_id
                detail = f"{record.customer.name} · {record.generator.brand} {record.generator.model} · {STATUSES[record.status]}"
                url = f"/services/{record.id}"
            elif kind == "customer":
                title, detail, url = record.customer_code, f"{record.name} · {record.phone_primary}", f"/customers/{record.id}"
            elif kind == "generator":
                title = record.generator_code
                detail = f"{record.brand} {record.model} · {record.serial_number} · {record.customer.name}"
                url = f"/generators/{record.id}"
            elif kind == "part":
                title, detail, url = record.part_code, f"{record.name} · stock {record.current_stock} {record.unit}", f"/inventory/{record.id}"
            else:
                title, detail, url = record.full_name, record.staff_code, f"/staff/{record.id}"
            row = (kind, record.id, title, detail, url)
            writer.writerow([
                "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r"))
                else value for value in row
            ])
        response = make_response("\ufeff" + output.getvalue())
        response.headers["Content-Type"] = "text/csv; charset=utf-8"
        response.headers["Content-Disposition"] = "attachment; filename=selected-search-records.csv"
        return response

    if action not in ("status", "assign") or any(kind != "service" for kind, _ in records):
        flash("Service status and assignment actions require only service jobs to be selected.", "danger")
        return redirect(return_url)
    if action == "status":
        if not current_user.has_permission("service.view_all") and not current_user.has_permission("service.view_assigned"):
            abort(403)
        target = request.form.get("status", "")
        remarks = request.form.get("remarks", "")
        operate = lambda service: svc.change_status(current_user, service.id, target, remarks)
    else:
        if not current_user.has_permission("service.assign"):
            abort(403)
        technician_id = request.form.get("technician_id", type=int)
        if technician_id is None:
            flash("Choose a technician to assign.", "warning")
            return redirect(return_url)

        def operate(service):
            active_ids = [assignment.user_id for assignment in service.active_assignments]
            lead_id = next((assignment.user_id for assignment in service.active_assignments if assignment.is_lead), None)
            assigned_ids = set(active_ids)
            assigned_ids.add(technician_id)
            return svc.assign_technicians(
                current_user, service.id, assigned_ids, lead_id or technician_id,
                remarks="Bulk assignment from Global Search",
            )

    succeeded, failures = 0, []
    for kind, record in records:
        try:
            operate(record)
            succeeded += 1
        except ServiceError as exc:
            db.session.rollback()
            failures.append(f"{record.service_id}: {exc}")
    if succeeded:
        flash(f"Operation completed for {succeeded} service job(s).", "success")
    if failures:
        flash("Some selected jobs were not changed: " + "; ".join(failures), "warning")
    return redirect(return_url)
