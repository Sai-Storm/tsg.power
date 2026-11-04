from flask_login import UserMixin
from werkzeug.security import check_password_hash, generate_password_hash

from ..extensions import db
from ..utils.time import local_today, utcnow
from .base import TimestampMixin

AVAILABILITY = ("available", "busy", "on_leave")

role_permissions = db.Table(
    "role_permissions",
    db.Column("role_id", db.Integer, db.ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    db.Column("permission_id", db.Integer, db.ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)


class Permission(db.Model):
    __tablename__ = "permissions"
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(80), unique=True, nullable=False)
    description = db.Column(db.String(200), nullable=False, default="")


class Role(db.Model):
    __tablename__ = "roles"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(30), unique=True, nullable=False)
    description = db.Column(db.String(200), nullable=False, default="")
    permissions = db.relationship("Permission", secondary=role_permissions, lazy="selectin")
    users = db.relationship("User", back_populates="role")


class User(UserMixin, TimestampMixin, db.Model):
    __tablename__ = "users"
    __table_args__ = (
        db.CheckConstraint("availability IN ('available','busy','on_leave')", name="ck_users_availability"),
    )

    id = db.Column(db.Integer, primary_key=True)
    staff_code = db.Column(db.String(20), unique=True, nullable=False)  # STF-0001
    full_name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    phone = db.Column(db.String(20))
    password_hash = db.Column(db.String(255), nullable=False)
    role_id = db.Column(db.Integer, db.ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False, index=True)
    specialization = db.Column(db.String(100))
    availability = db.Column(db.String(20), nullable=False, default="available")
    is_active = db.Column(db.Boolean, nullable=False, default=True, index=True)
    date_joined = db.Column(db.Date, nullable=False, default=local_today)
    failed_login_count = db.Column(db.Integer, nullable=False, default=0)
    locked_until = db.Column(db.DateTime)
    last_login_at = db.Column(db.DateTime)
    password_changed_at = db.Column(db.DateTime)

    role = db.relationship("Role", back_populates="users", lazy="joined")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
        self.password_changed_at = utcnow()

    def check_password(self, password):
        return check_password_hash(self.password_hash, password or "")

    def permission_codes(self):
        if not hasattr(self, "_perm_cache"):
            self._perm_cache = {p.code for p in self.role.permissions}
        return self._perm_cache

    def has_permission(self, code):
        return bool(self.is_active) and code in self.permission_codes()

    @property
    def is_admin(self):
        return self.role.name == "admin"

    @property
    def is_locked(self):
        return bool(self.locked_until and self.locked_until > utcnow())

    def __repr__(self):
        return f"<User {self.staff_code} {self.email}>"


class ApiToken(db.Model):
    """Refresh tokens for the Android API (stored hashed). Used from Phase 8; revoked on deactivation."""

    __tablename__ = "api_tokens"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = db.Column(db.String(64), unique=True, nullable=False)
    device_name = db.Column(db.String(100))
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    revoked_at = db.Column(db.DateTime)
