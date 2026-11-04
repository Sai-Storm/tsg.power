import re

from flask import current_app
from sqlalchemy import select, update
from werkzeug.security import check_password_hash, generate_password_hash

from ..extensions import db
from ..models import ApiToken, User
from ..utils.time import utcnow
from . import audit
from .errors import ValidationError

GENERIC_FAILURE = "Invalid email or password."
_DUMMY_HASH = generate_password_hash("not-a-real-password")  # equalises timing for unknown emails


class AuthError(Exception):
    pass


def password_problems(password):
    problems = []
    if len(password or "") < 10:
        problems.append("at least 10 characters")
    if not re.search(r"[a-z]", password or ""):
        problems.append("a lowercase letter")
    if not re.search(r"[A-Z]", password or ""):
        problems.append("an uppercase letter")
    if not re.search(r"\d", password or ""):
        problems.append("a digit")
    return problems


def require_strong_password(password):
    problems = password_problems(password)
    if problems:
        raise ValidationError("Password needs " + ", ".join(problems) + ".")


def revoke_user_tokens(user_id):
    db.session.execute(
        update(ApiToken)
        .where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


def authenticate(email, password):
    """Verify credentials with lockout. Returns the User or raises AuthError. Used by web and API login."""
    email = (email or "").strip().lower()
    user = db.session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        check_password_hash(_DUMMY_HASH, password or "")
        raise AuthError(GENERIC_FAILURE)

    if user.is_locked:
        raise AuthError("Too many failed attempts. Try again later or ask an admin to reset your password.")

    if not user.check_password(password):
        user.failed_login_count += 1
        if user.failed_login_count >= current_app.config["LOGIN_MAX_FAILED"]:
            from datetime import timedelta

            user.locked_until = utcnow() + timedelta(minutes=current_app.config["LOGIN_LOCK_MINUTES"])
            user.failed_login_count = 0
            audit.log("auth.account_locked", "user", user.id, user=user)
        db.session.commit()
        raise AuthError(GENERIC_FAILURE)

    if not user.is_active:
        raise AuthError("This account is deactivated. Contact an administrator.")

    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = utcnow()
    audit.log("auth.login", "user", user.id, user=user)
    db.session.commit()
    return user


def change_password(user, current_password, new_password):
    if not user.check_password(current_password):
        raise ValidationError("Current password is incorrect.")
    require_strong_password(new_password)
    if user.check_password(new_password):
        raise ValidationError("New password must differ from the current one.")
    user.set_password(new_password)
    revoke_user_tokens(user.id)
    audit.log("auth.password_changed", "user", user.id, user=user)
    db.session.commit()
