from email_validator import EmailNotValidError, validate_email
from sqlalchemy import delete as sql_delete, func, select, update as sql_update
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import Role, User
from ..models.user import AVAILABILITY
from . import audit
from .auth_service import require_strong_password, revoke_user_tokens
from .errors import PermissionDenied, ValidationError
from .id_generator import new_staff_code

ASSIGNABLE_ROLES = ("admin", "staff", "sales", "operations", "accountant", "manager")


def _require_manage(actor):
    if actor is None or not actor.is_authenticated or not actor.has_permission("staff.manage"):
        raise PermissionDenied("You do not have permission to manage staff accounts.")


def _normalize_email(value):
    try:
        return validate_email((value or "").strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError:
        raise ValidationError("Enter a valid email address.")


def _email_taken(email, exclude_id=None):
    stmt = select(User.id).where(User.email == email)
    if exclude_id:
        stmt = stmt.where(User.id != exclude_id)
    return db.session.scalar(stmt) is not None


def _role(role_id):
    role = db.session.get(Role, int(role_id)) if role_id not in (None, "") else None
    if role is None or role.name not in ASSIGNABLE_ROLES:
        raise ValidationError("Select a valid role.")
    return role


def _active_admin_count(exclude_id=None):
    stmt = (
        select(func.count(User.id))
        .select_from(User)
        .join(Role, User.role_id == Role.id)
        .where(Role.name == "admin", User.is_active.is_(True))
    )
    if exclude_id:
        stmt = stmt.where(User.id != exclude_id)
    return db.session.scalar(stmt)


def _snapshot(u):
    return {
        "full_name": u.full_name, "email": u.email, "phone": u.phone, "role": u.role.name,
        "specialization": u.specialization, "availability": u.availability, "is_active": u.is_active,
    }


def _check_profile(data):
    name = (data.get("full_name") or "").strip()
    if len(name) < 2:
        raise ValidationError("Full name is required.")
    if data.get("availability") and data["availability"] not in AVAILABILITY:
        raise ValidationError("Invalid availability value.")
    return name


def create_staff(actor, data):
    _require_manage(actor)
    name = _check_profile(data)
    email = _normalize_email(data.get("email"))
    if _email_taken(email):
        raise ValidationError("That email address is already in use.")
    role = _role(data.get("role_id"))
    require_strong_password(data.get("password"))

    user = User(
        staff_code=new_staff_code(), full_name=name, email=email,
        phone=(data.get("phone") or "").strip() or None, role=role,
        specialization=(data.get("specialization") or "").strip() or None,
        availability=data.get("availability") or "available", is_active=True,
    )
    user.set_password(data["password"])
    try:
        db.session.add(user)
        db.session.flush()
        audit.log("staff.create", "user", user.id, new=_snapshot(user), user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("That email address is already in use.")
    return user


def update_staff(actor, user_id, data):
    _require_manage(actor)
    user = db.session.get(User, user_id)
    if user is None:
        raise ValidationError("Staff account not found.")
    before = _snapshot(user)

    if "full_name" in data:
        user.full_name = _check_profile(data)
    if "email" in data:
        email = _normalize_email(data["email"])
        if email != user.email:
            if _email_taken(email, exclude_id=user.id):
                raise ValidationError("That email address is already in use.")
            user.email = email
    for field in ("phone", "specialization"):
        if field in data:
            setattr(user, field, (data[field] or "").strip() or None)
    if data.get("availability"):
        if data["availability"] not in AVAILABILITY:
            raise ValidationError("Invalid availability value.")
        user.availability = data["availability"]

    if data.get("role_id") not in (None, "") and int(data["role_id"]) != user.role_id:
        if actor.id == user.id:
            raise PermissionDenied("You cannot change your own role.")
        new_role = _role(data["role_id"])
        if user.role.name == "admin" and new_role.name != "admin" and user.is_active \
                and _active_admin_count(exclude_id=user.id) == 0:
            raise ValidationError("At least one active admin account must remain.")
        user.role = new_role

    password_reset = False
    if data.get("password"):
        require_strong_password(data["password"])
        user.set_password(data["password"])
        user.failed_login_count = 0
        user.locked_until = None
        revoke_user_tokens(user.id)
        password_reset = True

    try:
        db.session.flush()
        audit.log("staff.update", "user", user.id, old=before, new=_snapshot(user), user=actor)
        if password_reset:
            audit.log("staff.password_reset", "user", user.id, user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("That email address is already in use.")
    return user


def set_active(actor, user_id, active):
    _require_manage(actor)
    user = db.session.get(User, user_id)
    if user is None:
        raise ValidationError("Staff account not found.")
    if user.is_active == active:
        return user
    if not active:
        if actor.id == user.id:
            raise PermissionDenied("You cannot deactivate your own account.")
        if user.role.name == "admin" and _active_admin_count(exclude_id=user.id) == 0:
            raise ValidationError("At least one active admin account must remain.")
    user.is_active = active
    if not active:
        revoke_user_tokens(user.id)  # Android sessions end immediately
    audit.log("staff.activate" if active else "staff.deactivate", "user", user.id,
              old={"is_active": not active}, new={"is_active": active}, user=actor)
    db.session.commit()
    return user


def delete_unreferenced_staff(actor, user_id):
    """Hard-delete only accounts with no operational history; otherwise keep deactivation."""
    _require_manage(actor)
    user = db.session.get(User, user_id)
    if user is None:
        raise ValidationError("Staff account not found.")
    if actor.id == user.id:
        raise PermissionDenied("You cannot delete your own account.")
    if user.role.name == "admin" and _active_admin_count(exclude_id=user.id) == 0:
        raise ValidationError("At least one active admin account must remain.")

    disposable_tables = {"api_tokens", "notifications", "audit_logs", "accounting_import_references"}
    for table in db.metadata.tables.values():
        if table.name in disposable_tables:
            continue
        for column in table.columns:
            if not any(fk.target_fullname == "users.id" for fk in column.foreign_keys):
                continue
            if db.session.scalar(select(column).where(column == user.id).limit(1)) is not None:
                raise ValidationError(
                    "This account is linked to operational records and cannot be deleted. Deactivate it instead."
                )

    before = _snapshot(user)
    audit_table = db.metadata.tables.get("audit_logs")
    if audit_table is not None and "user_id" in audit_table.c:
        db.session.execute(sql_update(audit_table).where(audit_table.c.user_id == user.id)
                           .values(user_id=None))
    for table_name in ("api_tokens", "notifications"):
        table = db.metadata.tables.get(table_name)
        if table is not None:
            user_column = table.c.get("user_id")
            if user_column is None:
                user_column = table.c.get("recipient_id")
            if user_column is not None:
                db.session.execute(sql_delete(table).where(user_column == user.id))
    audit.log("staff.delete", "user", user.id, old=before, user=actor)
    db.session.delete(user)
    db.session.commit()
