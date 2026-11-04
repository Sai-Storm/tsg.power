from sqlalchemy import select

from ..extensions import db
from ..models import (CompanySetting, FaultCategory, InventoryCategory, Permission, Priority, Role,
                      ServiceType)
from .permissions import (DEFAULT_SETTINGS, FAULT_CATEGORIES, INVENTORY_CATEGORIES, PERMISSIONS, PRIORITIES, ROLE_DESCRIPTIONS,
                          ROLE_DEFAULTS, SERVICE_TYPES, STAFF_DEFAULTS)


def seed_rbac():
    """Idempotent. Adds missing permissions/roles/settings; never strips customised role permissions."""
    existing = {p.code: p for p in db.session.scalars(select(Permission))}
    for code, desc in PERMISSIONS.items():
        if code not in existing:
            existing[code] = Permission(code=code, description=desc)
            db.session.add(existing[code])
    db.session.flush()

    roles = {r.name: r for r in db.session.scalars(select(Role))}
    for name, desc in ROLE_DESCRIPTIONS.items():
        if name not in roles:
            role = Role(name=name, description=desc)
            if name == "staff":
                role.permissions = [existing[c] for c in STAFF_DEFAULTS]
            elif name in ROLE_DEFAULTS:
                role.permissions = [existing[c] for c in ROLE_DEFAULTS[name]]
            roles[name] = role
            db.session.add(role)
    db.session.flush()

    # Admin always holds every permission (including newly added ones).
    roles["admin"].permissions = list(existing.values())
    # Newly introduced staff defaults should apply to existing installations too,
    # without removing any permissions an administrator added manually.
    staff_permissions = {permission.code: permission for permission in roles["staff"].permissions}
    roles["staff"].permissions = list({
        **staff_permissions,
        **{code: existing[code] for code in STAFF_DEFAULTS},
    }.values())
    for name, defaults in ROLE_DEFAULTS.items():
        role_permissions = {permission.code: permission for permission in roles[name].permissions}
        roles[name].permissions = list({
            **role_permissions,
            **{code: existing[code] for code in defaults},
        }.values())

    for key, value in DEFAULT_SETTINGS.items():
        setting = db.session.get(CompanySetting, key)
        if setting is None:
            db.session.add(CompanySetting(key=key, value=value))
        elif key == "company_name" and setting.value == "Generator Service Company":
            setting.value = value
    currency_code = db.session.get(CompanySetting, "currency_code")
    currency_symbol = db.session.get(CompanySetting, "currency_symbol")
    if currency_symbol is not None and currency_symbol.value == "\u20b9":
        if currency_code is not None and currency_code.value == "INR":
            currency_code.value = "MMK"
            currency_symbol.value = "Ks"
        elif currency_code is not None and currency_code.value == "MMK":
            currency_symbol.value = "Ks"
    for code, name in SERVICE_TYPES:
        if db.session.scalar(select(ServiceType).where(ServiceType.code == code)) is None:
            db.session.add(ServiceType(code=code, name=name))
    for code, name, rank in PRIORITIES:
        if db.session.scalar(select(Priority).where(Priority.code == code)) is None:
            db.session.add(Priority(code=code, name=name, rank=rank))
    for name in FAULT_CATEGORIES:
        if db.session.scalar(select(FaultCategory).where(FaultCategory.name == name)) is None:
            db.session.add(FaultCategory(name=name))
    for name in INVENTORY_CATEGORIES:
        if db.session.scalar(select(InventoryCategory).where(InventoryCategory.name == name)) is None:
            db.session.add(InventoryCategory(name=name))
    db.session.commit()
