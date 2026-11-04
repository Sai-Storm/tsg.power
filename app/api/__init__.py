from flask import Blueprint, jsonify, request
from flask_wtf.csrf import CSRFError

from ..extensions import csrf
from ..services.errors import DuplicateWarning, PermissionDenied, ValidationError

bp = Blueprint("api_v1", __name__, url_prefix="/api/v1")

from . import routes  # noqa: E402,F401

csrf.exempt(bp)


def init_app(app):
    """Register Phase 8 routes without coupling API code to the web app factory."""
    if "api_v1" not in app.blueprints:
        app.register_blueprint(bp)


@bp.errorhandler(ValidationError)
def validation_error(error):
    return jsonify(error={"code": "validation_error", "message": str(error)}), 400


@bp.errorhandler(PermissionDenied)
def permission_error(error):
    return jsonify(error={"code": "forbidden", "message": str(error)}), 403


@bp.errorhandler(DuplicateWarning)
def duplicate_error(error):
    matches = [
        {"customer_code": match["customer"].customer_code, "name": match["customer"].name,
         "reasons": match["reasons"]}
        for match in error.matches
    ]
    return jsonify(error={"code": "duplicate_warning", "message": str(error), "matches": matches}), 409


@bp.errorhandler(CSRFError)
def csrf_error(_error):
    return jsonify(error={"code": "csrf_failed", "message": "CSRF validation failed."}), 400


@bp.errorhandler(404)
def not_found(_error):
    return jsonify(error={"code": "not_found", "message": "The requested resource was not found."}), 404


@bp.errorhandler(429)
def rate_limited(_error):
    return jsonify(error={"code": "rate_limited", "message": "Too many requests. Please try again later."}), 429
