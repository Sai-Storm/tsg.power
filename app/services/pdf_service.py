"""PDF documents (ReportLab): service report, invoice, receipt / refund / adjustment voucher.
Standard PDF fonts only cover Latin text, so other scripts are replaced with '?'."""
import io
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from ..models.billing import APPROVAL_METHODS, INVOICE_STATUSES, PAYMENT_METHODS, PAYMENT_TYPES
from ..models.service import STATUSES
from ..utils.time import utc_to_local
from . import settings_service
from .common import fmt_qty

INK = colors.HexColor("#1b1f24")
AMBER = colors.HexColor("#e0a21b")
GREY = colors.HexColor("#5b646e")
LINE = colors.HexColor("#cfd4d0")
SOFT = colors.HexColor("#f3f4f2")

_styles = getSampleStyleSheet()
BODY = ParagraphStyle("body", parent=_styles["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13, textColor=INK)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8.5, leading=11, textColor=GREY)
H1 = ParagraphStyle("h1", parent=BODY, fontName="Helvetica-Bold", fontSize=15, leading=19)
H2 = ParagraphStyle("h2", parent=BODY, fontName="Helvetica-Bold", fontSize=11.5, leading=15, spaceBefore=10, spaceAfter=4)
RIGHT = ParagraphStyle("right", parent=BODY, alignment=2)
BOLD_RIGHT = ParagraphStyle("boldright", parent=RIGHT, fontName="Helvetica-Bold")


def t(value):
    """Escape for ReportLab markup and make Latin-1 safe."""
    text = "" if value is None else str(value)
    text = text.encode("latin-1", "replace").decode("latin-1")
    return escape(text).replace("\n", "<br/>")


def P(value, style=BODY):
    return Paragraph(t(value), style)


def money(value):
    code = settings_service.get("currency_code", "MMK")
    amount = f"{value:,.2f}"
    if code == "MMK":
        return f"{settings_service.get('currency_symbol', 'Ks')} {amount}"
    return f"Rs. {amount}" if code == "INR" else f"{code} {amount}"


def local(dt, fmt="%d %b %Y, %H:%M"):
    return utc_to_local(dt).strftime(fmt) if dt else "-"


def _header(story, title, subtitle=None):
    lines = []
    for key, prefix in (("company_address", ""), ("company_phone", "Tel: "), ("company_email", ""),
                        ("company_tax_id", "Tax ID: ")):
        value = settings_service.get(key)
        if value:
            lines.append(P(prefix + value, SMALL))
    logo = settings_service.logo_path()
    left = ""
    if logo:
        try:
            img = Image(logo)
            ratio = min(50 * mm / img.imageWidth, 22 * mm / img.imageHeight)
            left = Image(logo, width=img.imageWidth * ratio, height=img.imageHeight * ratio)
        except Exception:  # noqa: BLE001 - a bad logo must never break a document
            left = ""
    head = Table([[left, lines, [Paragraph(t(title), ParagraphStyle("t", parent=H1, alignment=2))]
                   + ([P(subtitle, ParagraphStyle("s", parent=SMALL, alignment=2))] if subtitle else [])]],
                 colWidths=[52 * mm, 52 * mm, 76 * mm])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("LINEBELOW", (0, 0), (-1, 0), 1.5, AMBER), ("BOTTOMPADDING", (0, 0), (-1, 0), 8)]))
    story += [head, Spacer(1, 8)]


def _kv(rows, widths=(30 * mm, 60 * mm)):
    data = [[P(k, SMALL), P(v)] for k, v in rows]
    table = Table(data, colWidths=list(widths))
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("TOPPADDING", (0, 0), (-1, -1), 2)]))
    return table


def _two_col(left, right):
    table = Table([[left, right]], colWidths=[90 * mm, 90 * mm])
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    return table


def _grid(header, rows, widths, right_cols=()):
    th = ParagraphStyle("th", parent=SMALL, fontName="Helvetica-Bold", textColor=INK)
    th_right = ParagraphStyle("thr", parent=th, alignment=2)
    data = [[P(h, th_right if i in right_cols else th) for i, h in enumerate(header)]]
    for row in rows:
        data.append([P(c, RIGHT if i in right_cols else BODY) for i, c in enumerate(row)])
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), SOFT), ("LINEBELOW", (0, 0), (-1, 0), 0.8, LINE),
                               ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return table


def _totals(rows):
    data = [[P(k, RIGHT), P(v, BOLD_RIGHT if strong else RIGHT)] for k, v, strong in rows]
    table = Table(data, colWidths=[132 * mm, 48 * mm])
    table.setStyle(TableStyle([("LINEABOVE", (0, -1), (-1, -1), 0.8, INK), ("TOPPADDING", (0, 0), (-1, -1), 2),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
    return table


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(GREY)
    canvas.drawString(15 * mm, 10 * mm, t(settings_service.get("company_name")))
    canvas.drawRightString(195 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def _render(story, title):
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm,
                            bottomMargin=18 * mm, title=title, author=settings_service.get("company_name"))
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()


# ---------------------------------------------------------------- service report
def build_service_report(service, include_financials=False):
    from . import invoice_service
    s, c, g = service, service.customer, service.generator
    story = []
    _header(story, "SERVICE REPORT", s.service_id)
    story.append(_two_col(
        _kv([("Customer", f"{c.name} ({c.customer_code})"), ("Contact", c.contact_person or "-"),
             ("Phone", c.phone_primary), ("Address", ", ".join(x for x in (c.address, c.city, c.state) if x) or "-")]),
        _kv([("Service type", s.service_type.name), ("Priority", s.priority.name), ("Status", STATUSES[s.status]),
             ("Created", local(s.created_at)), ("Visit", local(s.scheduled_at)),
             ("Completed", s.actual_completion.strftime("%d %b %Y") if s.actual_completion else "-")])))
    story += [P("Generator", H2), _kv([
        ("Generator", f"{g.generator_code}: {g.brand} {g.model}"), ("Serial number", g.serial_number),
        ("Capacity / fuel", f"{fmt_qty(g.capacity_kva)} kVA, {g.fuel_type.replace('_', ' ')}"),
        ("Service location", s.location or g.location or "-")], widths=(38 * mm, 142 * mm))]
    story += [P("Complaint", H2), P(s.complaint)]
    story += [P("Diagnosis and work performed", H2), _kv([
        ("Fault category", s.fault_category.name if s.fault_category else "-"), ("Diagnosis", s.diagnosis or "-"),
        ("Work performed", s.work_performed or "-"),
        ("Labor hours", fmt_qty(s.labor_hours) if s.labor_hours is not None else "-"),
        ("Technicians", ", ".join(f"{a.user.full_name}{' (lead)' if a.is_lead else ''}" for a in s.active_assignments) or "-"),
        ("Remarks", s.completion_remarks or "-")], widths=(38 * mm, 142 * mm))]
    used = [r for r in s.requirements if r.status not in ("rejected", "requested", "pending_approval")]
    if used:
        story += [P("Parts and materials", H2), _grid(
            ["Item", "Approved", "Issued", "Used", "Returned"],
            [[r.description, f"{fmt_qty(r.approved_qty)} {r.unit}", fmt_qty(r.issued_qty) if r.is_inventory else "-",
              fmt_qty(r.used_qty), fmt_qty(r.returned_qty) if r.is_inventory else "-"] for r in used],
            [80 * mm, 25 * mm, 25 * mm, 25 * mm, 25 * mm], right_cols=(1, 2, 3, 4))]
    if s.customer_acknowledged_at:
        story += [P("Customer acknowledgment", H2),
                  P(f"{s.customer_acknowledged_by}, {local(s.customer_acknowledged_at)}")]
    if include_financials:
        fin = invoice_service.service_financials(s)
        inv = fin["invoice"]
        story.append(P("Costs and payment", H2))
        rows = []
        if fin["estimate"] is not None:
            rows.append(("Latest estimate", f"v{fin['estimate'].version}, {money(fin['estimate'].total)} "
                                            f"({fin['estimate'].status.replace('_', ' ')})"))
        if inv is not None:
            rows += [("Invoice", inv.display_number), ("Labor", money(inv.subtotal_of("labor"))),
                     ("Parts", money(inv.subtotal_of("part"))), ("Other", money(inv.subtotal_of("other"))),
                     ("Discount", money(inv.discount)), (inv.tax_name, money(inv.tax_amount)),
                     ("Final total", money(inv.total)), ("Amount paid", money(inv.amount_paid)),
                     ("Outstanding", money(inv.balance))]
        rows.append(("Payment status", fin["payment_status"]))
        story.append(_kv(rows, widths=(38 * mm, 142 * mm)))
    story += [Spacer(1, 22), _two_col(P("Technician signature: ____________________", SMALL),
                                      P("Customer signature: ____________________", SMALL))]
    return _render(story, f"Service report {s.service_id}")


# ---------------------------------------------------------------- quotation
def build_quotation(estimate):
    service = estimate.service
    customer = estimate.customer or service.customer
    generator = estimate.generator or service.generator
    service_type = estimate.service_type or service.service_type
    complaint = estimate.complaint or service.complaint
    location = estimate.location or service.location or generator.location
    quotation_number = estimate.quotation_number or service.service_id
    story = []
    _header(story, "QUOTATION", f"{quotation_number} - version {estimate.version}")
    story.append(_two_col(
        _kv([
            ("Customer", f"{customer.name} ({customer.customer_code})"),
            ("Contact", customer.contact_person or "-"),
            ("Phone", customer.phone_primary),
            ("Address", ", ".join(part for part in (customer.address, customer.city, customer.state) if part) or "-"),
        ]),
        _kv([
            ("Quotation date", local(estimate.created_at, "%d %b %Y")),
            ("Status", estimate.status.replace("_", " ").title()),
            ("Prepared by", estimate.created_by.full_name),
            ("Customer reference", service.service_id if service else quotation_number),
        ]),
    ))
    story += [
        P("Equipment and requested work", H2),
        _kv([
            ("Generator", f"{generator.generator_code}: {generator.brand} {generator.model}"),
            ("Serial number", generator.serial_number),
            ("Service type", service_type.name),
            ("Service location", location or "-"),
            ("Customer complaint", complaint),
        ], widths=(38 * mm, 142 * mm)),
        P("Quotation breakdown", H2),
    ]
    lines = [
        ["Labor", f"{fmt_qty(estimate.labor_hours)} hour(s)", money(estimate.labor_rate), money(estimate.labor_amount)],
        ["Parts and materials", "-", "-", money(estimate.parts_amount)],
        [estimate.other_description or "Other", "-", "-", money(estimate.other_amount)],
    ]
    story.append(_grid(
        ["Description", "Quantity", "Rate", "Amount"],
        lines,
        [72 * mm, 30 * mm, 35 * mm, 43 * mm],
        right_cols=(1, 2, 3),
    ))
    totals = [("Subtotal", money(estimate.subtotal), False)]
    if estimate.discount > 0:
        totals.append(("Discount", f"- {money(estimate.discount)}", False))
    totals.append((f"{settings_service.get('tax_name', 'Tax')} @ {estimate.tax_rate}%" if estimate.apply_tax else "Tax not applied",
                   money(estimate.tax_amount), False))
    totals.append(("Quotation total", money(estimate.total), True))
    story += [Spacer(1, 8), _totals(totals)]
    if estimate.notes:
        story += [P("Notes", H2), P(estimate.notes)]
    story += [
        Spacer(1, 18),
        P("Customer approval: ____________________________    Date: ________________", SMALL),
        Spacer(1, 10),
        P("This quotation is subject to the scope, parts, and work described above.", SMALL),
    ]
    return _render(story, f"Quotation {quotation_number} v{estimate.version}")


# ---------------------------------------------------------------- invoice
def build_invoice(invoice):
    inv, s = invoice, invoice.service
    c, g = s.customer, s.generator
    story = []
    _header(story, "TAX INVOICE" if inv.tax_rate > 0 else "INVOICE", inv.display_number)
    if inv.status == "draft":
        story.append(P("<b>DRAFT: not a valid invoice until issued</b>", ParagraphStyle("d", parent=BODY, textColor=colors.HexColor("#b03a2e"))))
    if inv.status == "void":
        story.append(P(f"<b>VOID</b>: {inv.void_reason or ''}", ParagraphStyle("v", parent=BODY, textColor=colors.HexColor("#b03a2e"))))
    story.append(_two_col(
        _kv([("Bill to", c.name), ("Customer ID", c.customer_code), ("Phone", c.phone_primary),
             ("Address", ", ".join(x for x in (c.address, c.city, c.state) if x) or "-")]),
        _kv([("Invoice date", local(inv.issued_at, "%d %b %Y") if inv.issued_at else "-"),
             ("Due date", inv.due_date.strftime("%d %b %Y") if inv.due_date else "-"), ("Service ID", s.service_id),
             ("Generator", f"{g.brand} {g.model}, S/N {g.serial_number}"),
             ("Completed", s.actual_completion.strftime("%d %b %Y") if s.actual_completion else "-"),
             ("Payment status", INVOICE_STATUSES[inv.status])])))
    story.append(Spacer(1, 6))
    story.append(_grid(["Description", "Type", "Qty", "Unit price", "Amount"],
                       [[i.description, {"labor": "Labor", "part": "Parts", "other": "Other"}[i.item_type],
                         f"{fmt_qty(i.quantity)} {i.unit}", money(i.unit_price), money(i.line_total)] for i in inv.items],
                       [66 * mm, 20 * mm, 26 * mm, 33 * mm, 35 * mm], right_cols=(2, 3, 4)))
    rows = [("Labor", money(inv.subtotal_of("labor")), False), ("Parts", money(inv.subtotal_of("part")), False),
            ("Other charges", money(inv.subtotal_of("other")), False), ("Subtotal", money(inv.subtotal), False)]
    if inv.discount > 0:
        rows.append((f"Discount ({inv.discount_reason})" if inv.discount_reason else "Discount", "- " + money(inv.discount), False))
    rows += [(f"{inv.tax_name} @ {fmt_qty(inv.tax_rate)}%", money(inv.tax_amount), False), ("TOTAL", money(inv.total), True)]
    story += [Spacer(1, 6), _totals(rows)]
    if inv.status != "draft":
        pay = [("Amount received", money(inv.amount_paid), False)]
        if inv.adjustment_total > 0:
            pay.append(("Adjustments / credits", money(inv.adjustment_total), False))
        pay.append(("BALANCE DUE", money(inv.balance), True))
        story += [Spacer(1, 6), _totals(pay)]
    if inv.payments:
        story += [P("Payment history", H2), _grid(
            ["Date", "Number", "Type", "Method", "Amount"],
            [[local(p.paid_at, "%d %b %Y"), p.number, PAYMENT_TYPES[p.payment_type],
              PAYMENT_METHODS.get(p.method, "-"), ("- " if p.payment_type == "refund" else "") + money(p.amount)]
             for p in inv.payments], [28 * mm, 36 * mm, 40 * mm, 34 * mm, 42 * mm], right_cols=(4,))]
    if inv.notes:
        story += [P("Notes", H2), P(inv.notes)]
    story += [Spacer(1, 14), P(settings_service.get("invoice_footer"), SMALL)]
    return _render(story, f"Invoice {inv.display_number}")


# ---------------------------------------------------------------- receipt
def build_receipt(payment):
    p, inv = payment, payment.invoice
    s = inv.service
    titles = {"payment": "PAYMENT RECEIPT", "refund": "REFUND VOUCHER", "adjustment": "ADJUSTMENT NOTE"}
    story = []
    _header(story, titles[p.payment_type], p.number)
    story.append(_kv([
        ("Received from" if p.payment_type == "payment" else "Customer", f"{s.customer.name} ({s.customer.customer_code})"),
        ("Date", local(p.paid_at)), ("Invoice", inv.display_number), ("Service ID", s.service_id),
        ("Amount", money(p.amount)), ("Method", PAYMENT_METHODS.get(p.method, "-")),
        ("Reference", p.reference or "-"), ("Reason", p.reason or "-"), ("Recorded by", p.received_by.full_name)],
        widths=(38 * mm, 142 * mm)))
    story += [Spacer(1, 8), _totals([("Invoice total", money(inv.total), False), ("Received to date", money(inv.amount_paid), False),
                                      ("Adjustments", money(inv.adjustment_total), False), ("Balance due", money(inv.balance), True)])]
    story += [Spacer(1, 20), P("This is a computer-generated document.", SMALL)]
    return _render(story, f"{titles[p.payment_type].title()} {p.number}")
