import json

from flask import has_request_context, request

from ..extensions import db
from ..models import AuditLog

_SENSITIVE = ("password", "token", "secret")


def _clean(values):
    if values is None:
        return None
    safe = {k: v for k, v in dict(values).items() if not any(s in k.lower() for s in _SENSITIVE)}
    return json.loads(json.dumps(safe, default=str))


def log(action, entity_type, entity_id=None, old=None, new=None, user=None):
    """Adds an audit row to the CURRENT transaction (caller commits), keeping data and audit consistent."""
    db.session.add(
        AuditLog(
            user_id=user.id if user is not None else None,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            old_values=_clean(old),
            new_values=_clean(new),
            ip_address=request.remote_addr if has_request_context() else None,
        )
    )
