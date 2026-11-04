import os
from datetime import datetime

from flask import Flask, g, jsonify, render_template, request
from flask_login import current_user
from flask_wtf.csrf import CSRFError
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from config import get_config
from .utils.time import utc_to_local

from .extensions import csrf, db, limiter, login_manager, migrate

CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
    "font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; "
    "img-src 'self' data:; frame-ancestors 'self'; form-action 'self'"
)


def create_app(config_object=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(config_object or get_config())
    if not app.config.get("SECRET_KEY"):
        raise RuntimeError("SECRET_KEY is not set. Add it to your .env file.")
    if not app.config.get("TESTING"):
        database_url = app.config.get("SQLALCHEMY_DATABASE_URI")
        if not database_url:
            raise RuntimeError("DATABASE_URL must be set to a MySQL connection string.")
        if make_url(database_url).get_backend_name() != "mysql":
            raise RuntimeError("The application requires MySQL. Set DATABASE_URL to a MySQL connection string.")

    os.makedirs(app.instance_path, exist_ok=True)
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    db.init_app(app)
    migrate.init_app(app, db)
    csrf.init_app(app)
    limiter.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"
    login_manager.login_message_category = "warning"
    login_manager.session_protection = "strong"

    from .models import CompanySetting, User

    @login_manager.user_loader
    def load_user(user_id):
        user = db.session.get(User, int(user_id))
        return user if user is not None and user.is_active else None  # deactivation ends sessions at once

    from .blueprints.auth.routes import bp as auth_bp
    from .api import init_app as init_api_app
    from .blueprints.customers.routes import bp as customers_bp
    from .blueprints.dashboard.routes import bp as dashboard_bp
    from .blueprints.dashboard.reports import bp as reports_bp
    from .blueprints.files.routes import bp as files_bp
    from .blueprints.finance.routes import bp as finance_bp
    from .blueprints.generators.routes import bp as generators_bp
    from .blueprints.estimates.routes import bp as estimates_bp
    from .blueprints.inventory.routes import bp as inventory_bp
    from .blueprints.invoices.routes import bp as invoices_bp
    from .blueprints.settings.routes import bp as settings_bp
    from .blueprints.services.routes import bp as services_bp
    from .blueprints.suppliers.routes import bp as suppliers_bp
    from .blueprints.staff.routes import bp as staff_bp

    init_api_app(app)

    for bp in (auth_bp, dashboard_bp, reports_bp, staff_bp, customers_bp, generators_bp, files_bp, services_bp, inventory_bp, suppliers_bp,
               finance_bp,
               estimates_bp, invoices_bp, settings_bp):
        app.register_blueprint(bp)

    @app.context_processor
    def inject_globals():
        try:
            name = CompanySetting.get("company_name", "TSG Power Engineering Service Group")
        except SQLAlchemyError:
            db.session.rollback()
            name = "TSG Power Engineering Service Group"
        counts = {}
        try:
            if current_user.is_authenticated:
                from .services import inventory_service, requirement_service
                if current_user.has_permission("requirement.approve"):
                    counts["pending_requests"] = requirement_service.pending_count()
                if current_user.has_permission("inventory.manage"):
                    counts["low_stock"] = inventory_service.low_stock_count()
                if current_user.has_permission("estimate.approve"):
                    from .services import estimate_service
                    counts["draft_estimates"] = estimate_service.pending_count()
                if current_user.has_permission("invoice.view"):
                    from .services import invoice_service
                    counts["outstanding"] = invoice_service.outstanding_summary()
        except SQLAlchemyError:
            db.session.rollback()
        return {"company_name": name, "nav_counts": counts}

    from .models.service import PRIORITY_BADGE, STATUS_BADGE, STATUSES
    from .models.billing import ESTIMATE_BADGE, ESTIMATE_STATUSES, INVOICE_BADGE, INVOICE_STATUSES
    from .models.inventory import REQ_BADGE, REQ_STATUSES
    app.jinja_env.globals.update(ESTIMATE_BADGE=ESTIMATE_BADGE, ESTIMATE_STATUSES=ESTIMATE_STATUSES,
                                 INVOICE_BADGE=INVOICE_BADGE, INVOICE_STATUSES=INVOICE_STATUSES, REQ_BADGE=REQ_BADGE, REQ_STATUSES=REQ_STATUSES, STATUSES=STATUSES, STATUS_BADGE=STATUS_BADGE, PRIORITY_BADGE=PRIORITY_BADGE)

    from .services.common import fmt_qty

    app.add_template_filter(fmt_qty, "qty")

    @app.template_filter("money")
    def money(value):
        if value is None:
            return "\u2014"
        if not hasattr(g, "_currency"):
            g._currency = CompanySetting.get("currency_symbol", "Ks")
        amount = f"{value:,.2f}"
        if CompanySetting.get("currency_code", "MMK") == "MMK":
            return f"{g._currency} {amount}"
        return f"{g._currency}{amount}"

    @app.template_filter("dt")
    def fmt_dt(value, fmt="%d %b %Y, %H:%M"):
        if not value:
            return "\u2014"
        if isinstance(value, datetime):  # stored as UTC; show company local time
            value = utc_to_local(value)
        return value.strftime(fmt)

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("Content-Security-Policy", CSP)
        if app.config.get("SESSION_COOKIE_SECURE"):
            resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.endpoint != "static":
            resp.headers["Cache-Control"] = "no-store"
        return resp

    def error_response(code, title, message):
        if request.path.startswith("/api/"):
            return jsonify(error={"code": code, "message": message}), code
        return render_template("errors/error.html", code=code, title=title, message=message), code

    @app.errorhandler(403)
    def forbidden(_e):
        return error_response(403, "Access denied", "Your account does not have permission to open this page.")

    @app.errorhandler(404)
    def not_found(_e):
        return error_response(404, "Page not found", "The page or record you asked for does not exist.")

    @app.errorhandler(429)
    def too_many(_e):
        return error_response(429, "Too many requests", "Please wait a minute before trying again.")

    @app.errorhandler(413)
    def too_large(_e):
        return error_response(413, "Upload too large", "The upload is larger than the 16 MB request limit.")

    @app.errorhandler(CSRFError)
    def csrf_failed(_e):
        return error_response(400, "Session expired", "Your form expired. Reload the page and try again.")

    @app.errorhandler(500)
    def server_error(_e):
        db.session.rollback()
        return error_response(500, "Something went wrong", "The error was logged. Please try again.")

    from .services.requirement_service import register_completion_check

    register_completion_check()  # block completion while material requests are undecided

    from .cli import register_cli

    register_cli(app)
    return app
