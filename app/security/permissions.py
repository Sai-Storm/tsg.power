"""Permission catalogue. Later phases enforce these; all are seeded now so roles stay stable."""

PERMISSIONS = {
    "staff.manage": "Create, edit, deactivate staff accounts",
    "role.manage": "Assign roles and permissions",
    "customer.view": "View customers",
    "customer.create": "Register customers",
    "customer.edit": "Edit customers",
    "generator.view": "View generators",
    "generator.create": "Register generators",
    "generator.edit": "Edit generators",
    "service.create": "Create service requests",
    "service.view_all": "View every service request",
    "service.view_assigned": "View own assigned service requests",
    "service.assign": "Assign and reassign technicians",
    "service.update_status": "Update status on assigned jobs",
    "service.override_status": "Override a status with a recorded reason",
    "service.close": "Close or cancel service requests",
    "service.report_approve": "Approve service delivery reports",
    "requirement.request": "Request spare parts and materials",
    "requirement.approve": "Approve or reject material requests",
    "inventory.view": "View inventory",
    "inventory.manage": "Manage inventory items and suppliers",
    "inventory.issue": "Issue stock to jobs",
    "inventory.adjust": "Stock adjustments and corrections",
    "estimate.create": "Draft estimates",
    "estimate.approve": "Approve estimates",
    "invoice.view": "View invoices",
    "invoice.manage": "Create and manage invoices",
    "payment.record": "Record payments, refunds, adjustments",
    "finance.claim": "Submit and view own employee expense claims",
    "finance.manage": "Manage employee advances, claims, and cash movements",
    "report.view": "View and export reports",
    "audit.view": "View audit log",
    "settings.manage": "Change company settings",
    "notification.view": "View own notifications",
}

# Default permissions for the 'staff' (technician) role. Admin receives all.
STAFF_DEFAULTS = [
    "customer.view", "customer.create",
    "generator.view", "generator.create",
    "service.create", "service.view_assigned", "service.update_status",
    "requirement.request", "inventory.view",
    "estimate.create", "notification.view",
    "finance.claim",
]

ROLE_DESCRIPTIONS = {
    "admin": "Full authority over company operations",
    "staff": "Staff and technicians with limited access",
    "sales": "Manage customers, quotations, and accepted-quote conversion",
    "operations": "Schedule and manage Job Orders and materials",
    "accountant": "Manage invoices, receipts, and employee finance operations",
    "manager": "Approve quotations, service reports, advances, and expense claims",
    "customer": "Optional customer portal user (no staff permissions)",
}

ROLE_DEFAULTS = {
    "sales": [
        "customer.view", "customer.create", "customer.edit", "generator.view", "generator.create",
        "generator.edit", "service.create", "service.view_assigned", "estimate.create", "finance.claim",
        "notification.view",
    ],
    "operations": [
        "customer.view", "generator.view", "service.create", "service.view_all", "service.assign", "service.update_status",
        "service.close", "requirement.request", "requirement.approve", "inventory.view", "inventory.issue",
        "finance.claim", "notification.view",
    ],
    "accountant": [
        "customer.view", "generator.view", "service.view_all", "invoice.view", "invoice.manage",
        "payment.record", "finance.claim", "finance.manage", "report.view", "notification.view",
    ],
    "manager": [
        "customer.view", "generator.view", "service.create", "service.view_all", "service.assign", "service.update_status",
        "service.close", "service.override_status", "service.report_approve", "requirement.approve",
        "inventory.view", "inventory.issue", "estimate.approve", "finance.manage", "report.view",
        "finance.claim", "audit.view", "notification.view",
    ],
}

DEFAULT_SETTINGS = {
    "company_name": "TSG Power Engineering Service Group",
    "company_address": "",
    "company_phone": "",
    "currency_code": "MMK",
    "currency_symbol": "Ks",
    "tax_name": "GST",
    "tax_rate": "18.00",
    "stock_policy": "issue",
    "customer_portal_enabled": "false",
    "company_email": "",
    "company_tax_id": "",
    "labor_rate_per_hour": "500.00",
    "payment_terms_days": "15",
    "invoice_footer": "Thank you for your business.",
    "company_logo": "",
}

SERVICE_TYPES = [
    ("repair", "Generator repair"), ("preventive_maintenance", "Preventive maintenance"),
    ("emergency", "Emergency service"), ("installation", "Installation"),
    ("inspection", "Inspection"), ("general_servicing", "General servicing"),
]
PRIORITIES = [("low", "Low", 1), ("normal", "Normal", 2), ("high", "High", 3), ("urgent", "Urgent", 4)]
FAULT_CATEGORIES = [
    "Engine", "Fuel system", "Electrical / alternator", "Cooling system", "Control panel / AMF",
    "Battery / starting", "Lubrication", "Exhaust", "Other",
]

INVENTORY_CATEGORIES = ["Lubricants", "Filters", "Electrical", "Batteries", "Belts and hoses", "Fuel system",
                        "Cooling system", "Consumables", "Tools", "Other"]
