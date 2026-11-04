from functools import wraps

from flask import abort
from flask_login import current_user

from ..extensions import login_manager


def permission_required(*codes):
    """Require login and ALL listed permissions. Web: redirect to login, or 403."""

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not current_user.is_authenticated:
                return login_manager.unauthorized()
            if not all(current_user.has_permission(c) for c in codes):
                abort(403)
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def any_permission_required(*codes):
    """Require login and AT LEAST ONE of the listed permissions."""

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not current_user.is_authenticated:
                return login_manager.unauthorized()
            if not any(current_user.has_permission(c) for c in codes):
                abort(403)
            return fn(*args, **kwargs)

        return wrapper

    return decorator
