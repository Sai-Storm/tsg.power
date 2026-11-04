import base64
import hashlib
import hmac
import json
import secrets
from datetime import timedelta

from flask import current_app

from ..extensions import db
from ..models import ApiToken, User
from ..services.auth_service import authenticate
from ..services.auth_service import AuthError
from ..utils.time import utcnow

ACCESS_TOKEN_SECONDS = 15 * 60
REFRESH_TOKEN_DAYS = 30


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_refresh_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user, device_name=None):
    refresh = secrets.token_urlsafe(48)
    row = ApiToken(user_id=user.id, token_hash=hash_refresh_token(refresh),
                   device_name=(device_name or "")[:100] or None,
                   expires_at=utcnow() + timedelta(days=REFRESH_TOKEN_DAYS))
    db.session.add(row)
    db.session.flush()
    return row, refresh


def create_access_token(user, session_id):
    now = int(utcnow().timestamp())
    payload = {"sub": user.id, "sid": session_id, "iat": now,
               "exp": now + ACCESS_TOKEN_SECONDS}
    encoded = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(current_app.config["SECRET_KEY"].encode("utf-8"),
                         encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_b64(signature)}"


def verify_access_token(token):
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(current_app.config["SECRET_KEY"].encode("utf-8"),
                            encoded.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(_decode(signature), expected):
            return None
        claims = json.loads(_decode(encoded))
        if not isinstance(claims["sub"], int) or not isinstance(claims["sid"], int):
            return None
        if not isinstance(claims["exp"], int) or claims["exp"] <= int(utcnow().timestamp()):
            return None
        row = db.session.get(ApiToken, claims["sid"])
        if (row is None or row.user_id != claims["sub"] or row.revoked_at is not None
                or row.expires_at <= utcnow()):
            return None
        user = db.session.get(User, claims["sub"])
        return user if user is not None and user.is_active else None
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def login(email, password, device_name=None):
    user = authenticate(email, password)
    row, refresh = create_session(user, device_name)
    db.session.commit()
    return user, row, refresh


def rotate_refresh_token(token):
    if not isinstance(token, str) or not token:
        return None
    row = db.session.query(ApiToken).filter_by(token_hash=hash_refresh_token(token)).with_for_update().one_or_none()
    if row is None or row.revoked_at is not None or row.expires_at <= utcnow():
        return None
    user = db.session.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    row.revoked_at = utcnow()
    new_row, new_refresh = create_session(user, row.device_name)
    db.session.commit()
    return user, new_row, new_refresh
