"""Stock items, categories and the stock ledger. Every change to current_stock goes through _move()."""
from decimal import Decimal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import (InventoryCategory, InventoryItem, InventoryTransaction, ServiceRequirement, Supplier)
from ..models.inventory import TXN_TYPES, UNITS
from ..utils.time import local_to_utc
from . import audit
from .common import fmt_qty, parse_money, parse_qty, require
from .errors import ValidationError
from .id_generator import new_part_code

OPEN_REQ = ("pending_approval", "approved", "partially_available")
SORTS = {"code": InventoryItem.part_code, "name": InventoryItem.name, "stock": InventoryItem.current_stock,
         "created": InventoryItem.created_at}


def lock_item(item_id):
    item = db.session.execute(select(InventoryItem).where(InventoryItem.id == item_id).with_for_update()
                              .execution_options(populate_existing=True)).scalar_one_or_none()
    if item is None:
        raise ValidationError("Stock item not found.")
    return item


def move(item, delta, txn_type, actor, *, reason=None, reference=None, requirement=None, service_pk=None,
         approved_by=None):
    """The ONLY place stock changes. Caller holds the item row lock. Refuses to go below zero."""
    new_balance = item.current_stock + delta
    if new_balance < 0:
        raise ValidationError(f"Not enough stock of {item.name}: {fmt_qty(item.current_stock)} {item.unit} available, "
                              f"{fmt_qty(-delta)} needed.")
    item.current_stock = new_balance
    db.session.add(InventoryTransaction(
        item_id=item.id, requirement_id=requirement.id if requirement is not None else None,
        service_request_id=service_pk, txn_type=txn_type, quantity_delta=delta, balance_after=new_balance,
        reference=(reference or None), reason=(reason or None), performed_by_id=actor.id,
        approved_by_id=approved_by.id if approved_by is not None else None))
    db.session.flush()


def _item_values(data, existing=None):
    name = (data.get("name") or "").strip()
    if len(name) < 2:
        raise ValidationError("Item name is required.")
    unit = data.get("unit") or "unit"
    if unit not in UNITS:
        raise ValidationError("Select a valid unit of measurement.")
    sku = (data.get("sku") or "").strip().upper() or None
    if sku:
        clash = db.session.scalar(select(InventoryItem).where(InventoryItem.sku == sku))
        if clash is not None and (existing is None or clash.id != existing.id):
            raise ValidationError(f"Part number / SKU {sku} is already used by {clash.part_code} ({clash.name}).")
    category = supplier = None
    if data.get("category_id"):
        category = db.session.get(InventoryCategory, int(data["category_id"]))
        if category is None or not category.is_active:
            raise ValidationError("Select a valid category.")
    if data.get("supplier_id"):
        supplier = db.session.get(Supplier, int(data["supplier_id"]))
        if supplier is None or not supplier.is_active:
            raise ValidationError("Select a valid supplier.")
    return {
        "name": name, "unit": unit, "sku": sku, "category": category, "supplier": supplier,
        "description": (data.get("description") or "").strip() or None,
        "storage_location": (data.get("storage_location") or "").strip() or None,
        "min_stock": parse_qty(data.get("min_stock") or 0, "Minimum stock", unit, allow_zero=True),
        "purchase_price": parse_money(data.get("purchase_price") or 0, "Purchase price"),
        "selling_price": parse_money(data.get("selling_price"), "Selling price"),
    }


def _snapshot(i):
    return {"part_code": i.part_code, "name": i.name, "sku": i.sku, "unit": i.unit, "min_stock": i.min_stock,
            "purchase_price": i.purchase_price, "selling_price": i.selling_price,
            "category": i.category.name if i.category else None, "supplier": i.supplier.name if i.supplier else None,
            "storage_location": i.storage_location, "is_active": i.is_active}


def create_item(actor, data):
    require(actor, "inventory.manage")
    values = _item_values(data)
    opening = parse_qty(data.get("opening_stock") or 0, "Opening stock", values["unit"], allow_zero=True)
    item = InventoryItem(part_code=new_part_code(), current_stock=Decimal(0), is_active=True, **values)
    try:
        db.session.add(item)
        db.session.flush()
        if opening > 0:
            move(item, opening, "purchase_in", actor, reason="Opening stock", reference="OPENING")
        audit.log("inventory.item_create", "inventory_item", item.id, new={**_snapshot(item), "opening": opening},
                  user=actor)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("That part number / SKU is already in use.")
    return item


def update_item(actor, item_id, data):
    require(actor, "inventory.manage")
    item = lock_item(item_id)
    values = _item_values(data, existing=item)
    if values["unit"] != item.unit and db.session.scalar(
            select(func.count(InventoryTransaction.id)).where(InventoryTransaction.item_id == item.id)):
        raise ValidationError("The unit cannot be changed after stock movements exist.")
    before = _snapshot(item)
    for key, value in values.items():
        setattr(item, key, value)
    db.session.flush()
    audit.log("inventory.item_update", "inventory_item", item.id, old=before, new=_snapshot(item), user=actor)
    db.session.commit()
    return item


def set_item_active(actor, item_id, active):
    require(actor, "inventory.manage")
    item = lock_item(item_id)
    if item.is_active != active:
        if not active:
            open_lines = db.session.scalar(select(func.count(ServiceRequirement.id)).where(
                ServiceRequirement.item_id == item.id, ServiceRequirement.status.in_(OPEN_REQ)))
            if open_lines:
                raise ValidationError(f"{open_lines} material request(s) for this item are still open. Resolve them first.")
        item.is_active = active
        audit.log("inventory.item_activate" if active else "inventory.item_deactivate", "inventory_item", item.id,
                  new={"is_active": active}, user=actor)
        db.session.commit()
    return item


def stock_in(actor, item_id, qty, reference=None, reason=None, unit_cost=None):
    """Goods received from a supplier."""
    require(actor, "inventory.manage")
    item = lock_item(item_id)
    if not item.is_active:
        raise ValidationError("This item is inactive.")
    qty = parse_qty(qty, "Quantity received", item.unit)
    cost = parse_money(unit_cost, "Unit cost")
    move(item, qty, "purchase_in", actor, reason=reason, reference=(reference or "").strip()[:100] or None)
    if cost is not None:
        item.purchase_price = cost  # latest purchase price
    audit.log("inventory.stock_in", "inventory_item", item.id,
              new={"qty": qty, "reference": reference, "balance": item.current_stock}, user=actor)
    db.session.commit()
    return item


def adjust_stock(actor, item_id, delta, reason, kind="adjustment", reference=None):
    """Authorised stock-take adjustment or correction (positive or negative). A reason is mandatory."""
    require(actor, "inventory.adjust")
    if kind not in ("adjustment", "correction"):
        raise ValidationError("Choose adjustment or correction.")
    item = lock_item(item_id)
    delta = parse_qty(delta, "Quantity change", item.unit, allow_negative=True)
    if delta == 0:
        raise ValidationError("The quantity change cannot be zero.")
    if len((reason or "").strip()) < 5:
        raise ValidationError("Give a reason (at least 5 characters) for the stock change.")
    move(item, delta, kind, actor, reason=reason.strip(), reference=(reference or "").strip()[:100] or None,
         approved_by=actor)
    audit.log(f"inventory.{kind}", "inventory_item", item.id,
              new={"delta": delta, "reason": reason, "balance": item.current_stock}, user=actor)
    db.session.commit()
    return item


def delete_item(actor, item_id):
    require(actor, "inventory.manage")
    item = lock_item(item_id)
    has_transactions = db.session.scalar(
        select(InventoryTransaction.id).where(InventoryTransaction.item_id == item.id).limit(1)
    )
    has_requirements = db.session.scalar(
        select(ServiceRequirement.id).where(ServiceRequirement.item_id == item.id).limit(1)
    )
    if item.current_stock != 0 or has_transactions or has_requirements:
        raise ValidationError("This item has stock, transaction, or service history. Deactivate it instead.")
    before = {"part_code": item.part_code, "name": item.name, "sku": item.sku}
    audit.log("inventory.item_delete", "inventory_item", item.id, old=before, user=actor)
    db.session.delete(item)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("This item is referenced by other records. Deactivate it instead.")
    return True


# ---------------------------------------------------------------- categories
def add_category(actor, name):
    require(actor, "inventory.manage")
    name = (name or "").strip()
    if len(name) < 2:
        raise ValidationError("Category name is required.")
    if db.session.scalar(select(InventoryCategory).where(func.lower(InventoryCategory.name) == name.lower())):
        raise ValidationError("That category already exists.")
    cat = InventoryCategory(name=name)
    db.session.add(cat)
    audit.log("inventory.category_create", "inventory_category", name, new={"name": name}, user=actor)
    db.session.commit()
    return cat


def toggle_category(actor, category_id):
    require(actor, "inventory.manage")
    cat = db.session.get(InventoryCategory, category_id)
    if cat is None:
        raise ValidationError("Category not found.")
    cat.is_active = not cat.is_active
    audit.log("inventory.category_toggle", "inventory_category", cat.id, new={"is_active": cat.is_active}, user=actor)
    db.session.commit()
    return cat


def delete_category(actor, category_id):
    require(actor, "inventory.manage")
    cat = db.session.execute(
        select(InventoryCategory).where(InventoryCategory.id == category_id).with_for_update()
    ).scalar_one_or_none()
    if cat is None:
        raise ValidationError("Category not found.")
    has_items = db.session.scalar(
        select(InventoryItem.id).where(InventoryItem.category_id == cat.id).limit(1)
    )
    if has_items:
        raise ValidationError("This category is used by inventory items. Deactivate it instead.")
    audit.log("inventory.category_delete", "inventory_category", cat.id,
              old={"name": cat.name, "is_active": cat.is_active}, user=actor)
    db.session.delete(cat)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("This category is referenced by other records. Deactivate it instead.")
    return True


# ---------------------------------------------------------------- queries
def search_items(q=None, category_id=None, supplier_id=None, low=False, status=None, sort="name", direction="asc"):
    stmt = select(InventoryItem)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(InventoryItem.name.ilike(like), InventoryItem.part_code.ilike(like),
                              InventoryItem.sku.ilike(like), InventoryItem.description.ilike(like)))
    if category_id:
        stmt = stmt.where(InventoryItem.category_id == category_id)
    if supplier_id:
        stmt = stmt.where(InventoryItem.supplier_id == supplier_id)
    if low:
        stmt = stmt.where(InventoryItem.is_active.is_(True), InventoryItem.current_stock <= InventoryItem.min_stock)
    if status == "active":
        stmt = stmt.where(InventoryItem.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(InventoryItem.is_active.is_(False))
    col = SORTS.get(sort, InventoryItem.name)
    return stmt.order_by(col.desc() if direction == "desc" else col.asc(), InventoryItem.id)


def low_stock_count():
    return db.session.scalar(select(func.count(InventoryItem.id)).where(
        InventoryItem.is_active.is_(True), InventoryItem.current_stock <= InventoryItem.min_stock))


def search_transactions(item_id=None, txn_type=None, date_from=None, date_to=None, service_pk=None):
    from datetime import datetime, time, timedelta
    stmt = select(InventoryTransaction)
    if item_id:
        stmt = stmt.where(InventoryTransaction.item_id == item_id)
    if service_pk:
        stmt = stmt.where(InventoryTransaction.service_request_id == service_pk)
    if txn_type in TXN_TYPES:
        stmt = stmt.where(InventoryTransaction.txn_type == txn_type)
    if date_from:
        stmt = stmt.where(InventoryTransaction.created_at >= local_to_utc(datetime.combine(date_from, time.min)))
    if date_to:
        stmt = stmt.where(InventoryTransaction.created_at < local_to_utc(
            datetime.combine(date_to + timedelta(days=1), time.min)))
    return stmt.order_by(InventoryTransaction.id.desc())
