from datetime import timedelta

from sqlalchemy import select

from app.extensions import db
from app.models import (Customer, Generator, InventoryCategory, InventoryItem, InventoryTransaction, Priority,
                        ServiceRequest, ServiceRequirement, ServiceType, Supplier)
from app.services import (customer_service, generator_service, inventory_service as inv, service_request_service as svc)
from app.utils.time import local_now
from tests.conftest import login


def switch(client, email):
    client.post("/auth/logout")
    return login(client, email)


def make_job(admin, desk, tech):
    cust = customer_service.create_customer(desk, {"name": "Acme", "phone_primary": "9876543210"})
    gen = generator_service.create_generator(desk, cust.id, {"brand": "Cummins", "model": "C1", "serial_number": "SN-0001",
                                                              "capacity_kva": "50"})
    s = svc.create_service_request(desk, {"customer_id": cust.id, "generator_id": gen.id, "complaint": "Service due",
                                          "service_type_id": db.session.scalar(select(ServiceType.id)),
                                          "priority_id": db.session.scalar(select(Priority.id))})
    svc.assign_technicians(admin, s.id, [tech.id])
    svc.schedule_visit(admin, s.id, local_now() + timedelta(days=1))
    return svc.change_status(tech, s.id, "in_progress")


def test_admin_builds_catalogue_through_forms(client, make_user):
    make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    client.post("/suppliers/new", data={"name": "Lube Traders", "phone": "9876500000", "email": "sales@lube.example"})
    sup = db.session.scalar(select(Supplier))
    client.post("/inventory/categories", data={"name": "Gaskets"})
    assert db.session.scalar(select(InventoryCategory).where(InventoryCategory.name == "Gaskets"))
    cat = db.session.scalar(select(InventoryCategory).where(InventoryCategory.name == "Lubricants"))

    resp = client.post("/inventory/new", data={
        "name": "Engine oil 15W40", "category_id": cat.id, "unit": "litre", "supplier_id": sup.id, "opening_stock": "20",
        "min_stock": "10", "purchase_price": "300", "selling_price": "450", "sku": "eo-15w40"})
    assert resp.status_code == 302
    item = db.session.scalar(select(InventoryItem))
    assert item.part_code == "PRT-000001" and item.sku == "EO-15W40" and item.supplier_id == sup.id

    client.post(f"/inventory/{item.id}/stock-in", data={"quantity": "5", "reference": "INV-9", "unit_cost": "305"})
    db.session.refresh(item)
    assert item.current_stock == 25
    bad = client.post(f"/inventory/{item.id}/adjust", data={"delta": "-1", "reason": "", "kind": "adjustment"}, follow_redirects=True)
    assert b"reason" in bad.data.lower()
    client.post(f"/inventory/{item.id}/adjust", data={"delta": "-20", "reason": "Annual stock-take shortage", "kind": "adjustment"})
    db.session.refresh(item)
    assert item.current_stock == 5
    assert b"Low" in client.get("/inventory/").data  # 5 <= minimum 10
    assert b"item" in client.get("/inventory/?low=1").data and b"Engine oil" in client.get("/inventory/?low=1").data
    ledger = client.get(f"/inventory/{item.id}").data
    assert b"Opening stock" in ledger and b"Annual stock-take" in ledger  # ledger page renders
    assert b"Annual stock-take shortage" in client.get("/inventory/transactions").data


def test_permanent_delete_for_unreferenced_inventory_records(client, make_user):
    admin = make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    category = inv.add_category(admin, "Temporary category")
    supplier = Supplier(name="Temporary supplier")
    db.session.add(supplier)
    db.session.commit()
    item = inv.create_item(admin, {
        "name": "Unused stock item", "category_id": category.id, "supplier_id": supplier.id,
        "unit": "unit", "opening_stock": "0", "min_stock": "0",
    })

    blocked_supplier = client.post(f"/suppliers/{supplier.id}/delete", follow_redirects=True)
    assert b"Deactivate it instead" in blocked_supplier.data
    blocked_category = client.post(f"/inventory/categories/{category.id}/delete", follow_redirects=True)
    assert b"Deactivate it instead" in blocked_category.data

    assert client.get(f"/inventory/{item.id}").status_code == 200
    assert client.post(f"/inventory/{item.id}/delete").status_code == 302
    assert db.session.get(InventoryItem, item.id) is None
    assert client.post(f"/inventory/categories/{category.id}/delete").status_code == 302
    assert db.session.get(InventoryCategory, category.id) is None
    assert client.post(f"/suppliers/{supplier.id}/delete").status_code == 302
    assert db.session.get(Supplier, supplier.id) is None


def test_inventory_with_stock_ledger_cannot_be_permanently_deleted(client, make_user):
    admin = make_user("admin@example.com", "admin")
    login(client, "admin@example.com")
    item = inv.create_item(admin, {"name": "Tracked item", "unit": "unit", "opening_stock": "2"})

    response = client.post(f"/inventory/{item.id}/delete", follow_redirects=True)
    assert b"transaction" in response.data
    assert db.session.get(InventoryItem, item.id) is not None


def test_full_parts_workflow_through_the_web(client, make_user):
    admin = make_user("admin@example.com", "admin")
    tech = make_user("tech@example.com", "staff", name="Tara Tech")
    desk = make_user("desk@example.com", "staff")
    make_user("other@example.com", "staff")
    oil = inv.create_item(admin, {"name": "Engine oil", "unit": "litre", "opening_stock": "20", "min_stock": "5",
                                  "purchase_price": "300", "selling_price": "450"})
    filt = inv.create_item(admin, {"name": "Oil filter", "unit": "unit", "opening_stock": "1", "selling_price": "250"})
    s = make_job(admin, desk, tech)

    # technician requests two stock lines and one non-stock line, then submits
    login(client, "tech@example.com")
    dropdowns = {"category": "other", "unit": "unit"}  # browsers always submit the dropdown defaults
    for data in ({"item_id": oil.id, "quantity": "5", "purpose": "Oil change", **dropdowns},
                 {"item_id": filt.id, "quantity": "2", "purpose": "Filter change", **dropdowns},
                 {"item_id": 0, "description": "Transport of old oil drum", "category": "transport", "quantity": "1", "unit": "unit"}):
        assert client.post(f"/services/{s.id}/requirements", data=data).status_code == 302
    assert db.session.query(ServiceRequirement).count() == 3
    page = client.get(f"/services/{s.id}").data
    assert b"Engine oil" in page and b"Submit request list for approval" in page
    assert b"Decide" not in page and b"Issue</button>" not in page  # staff cannot decide or issue
    client.post(f"/services/{s.id}/requirements/submit")
    assert all(r.status == "pending_approval" for r in db.session.scalars(select(ServiceRequirement)))
    assert client.get("/inventory/requests").status_code == 403

    # admin approves (reduce one, reject one), then issues
    switch(client, "admin@example.com")
    queue = client.get("/inventory/requests").data
    assert b"Engine oil" in queue and b"Oil filter" in queue and b"Awaiting approval" in queue
    lines = {r.description: r for r in db.session.scalars(select(ServiceRequirement))}
    client.post(f"/inventory/requirements/{lines['Engine oil'].id}/approve", data={"approved_qty": "4", "note": "4 is enough"})
    client.post(f"/inventory/requirements/{lines['Oil filter'].id}/approve", data={"approved_qty": "2"})
    client.post(f"/inventory/requirements/{lines['Transport of old oil drum'].id}/reject", data={"note": ""})  # reason missing
    assert lines["Transport of old oil drum"].status == "pending_approval"
    client.post(f"/inventory/requirements/{lines['Transport of old oil drum'].id}/reject", data={"note": "Customer will arrange"})
    for r in lines.values():
        db.session.refresh(r)
    assert [lines[k].status for k in ("Engine oil", "Oil filter", "Transport of old oil drum")] == ["approved", "approved", "rejected"]
    assert lines["Engine oil"].approved_qty == 4

    resp = client.post(f"/inventory/requirements/{lines['Engine oil'].id}/issue", data={"quantity": "4"}, follow_redirects=True)
    assert b"Issued 4" in resp.data
    resp = client.post(f"/inventory/requirements/{lines['Oil filter'].id}/issue", data={"quantity": "2"}, follow_redirects=True)
    assert b"still waiting for stock" in resp.data  # only 1 filter in stock
    db.session.refresh(oil); db.session.refresh(filt); db.session.refresh(s)
    assert (oil.current_stock, filt.current_stock) == (16, 0) and s.status == "waiting_parts"
    assert s.service_id.encode() in client.get("/inventory/waiting").data
    assert b"short by 1" in client.get("/inventory/waiting").data

    # receive the missing filter and finish issuing
    client.post(f"/inventory/{filt.id}/stock-in", data={"quantity": "5", "reference": "PO-2"})
    client.post(f"/inventory/requirements/{lines['Oil filter'].id}/issue", data={"quantity": ""})
    db.session.refresh(lines["Oil filter"])
    assert lines["Oil filter"].status == "issued" and lines["Oil filter"].issued_qty == 2

    # technician resumes, records usage; the store takes back the leftover oil
    switch(client, "tech@example.com")
    client.post(f"/services/{s.id}/status", data={"to_status": "in_progress"})
    client.post(f"/services/requirements/{lines['Engine oil'].id}/usage", data={"used_qty": "3"})
    client.post(f"/services/requirements/{lines['Oil filter'].id}/usage", data={"used_qty": "2"})
    detail = client.get(f"/services/{s.id}").data
    assert b"Used" in detail and b"Rejected" in detail and b"Customer will arrange" in detail
    switch(client, "admin@example.com")
    client.post(f"/inventory/requirements/{lines['Engine oil'].id}/return", data={"quantity": "1", "reason": "Leftover"})
    db.session.refresh(oil)
    assert oil.current_stock == 17
    for r in lines.values():
        db.session.refresh(r)
    assert lines["Engine oil"].status == "used" and lines["Oil filter"].status == "used"
    types = [t.txn_type for t in db.session.scalars(select(InventoryTransaction).order_by(InventoryTransaction.id))]
    assert types.count("issue") == 3 and types.count("return") == 1


def test_staff_inventory_access_and_price_privacy(client, make_user):
    admin = make_user("admin@example.com", "admin")
    make_user("tech@example.com", "staff")
    item = inv.create_item(admin, {"name": "Fuel filter", "unit": "unit", "opening_stock": "4", "purchase_price": "123.45",
                                   "selling_price": "199"})
    login(client, "tech@example.com")
    listing = client.get("/inventory/")
    assert listing.status_code == 200 and b"Fuel filter" in listing.data
    assert b"123.45" not in listing.data and b"123.45" not in client.get(f"/inventory/{item.id}").data  # cost hidden
    assert b"199.00" in listing.data  # selling price visible
    for url in ("/inventory/new", f"/inventory/{item.id}/edit", "/inventory/transactions", "/inventory/categories",
                "/suppliers/", "/suppliers/new", "/inventory/requests"):
        assert client.get(url).status_code == 403, url
    assert client.post(f"/inventory/{item.id}/stock-in", data={"quantity": "5"}).status_code == 403
    assert client.post(f"/inventory/{item.id}/adjust", data={"delta": "5", "reason": "free stock please"}).status_code == 403
    assert client.post("/inventory/requirements/1/approve", data={}).status_code == 403
    assert client.post("/inventory/requirements/1/issue", data={}).status_code == 403
    db.session.refresh(item)
    assert item.current_stock == 4


def test_other_staff_cannot_touch_another_jobs_materials(client, make_user):
    admin = make_user("admin@example.com", "admin")
    tech = make_user("tech@example.com", "staff")
    make_user("other@example.com", "staff")
    desk = make_user("desk@example.com", "staff")
    item = inv.create_item(admin, {"name": "Belt", "unit": "unit", "opening_stock": "4"})
    s = make_job(admin, desk, tech)
    login(client, "other@example.com")
    assert client.post(f"/services/{s.id}/requirements", data={"item_id": item.id, "quantity": "1", "category": "other",
                                                                "unit": "unit"}).status_code == 404
    assert client.post(f"/services/{s.id}/requirements/submit").status_code == 404
    assert client.post("/services/requirements/1/usage", data={"used_qty": "1"}).status_code == 404
    assert db.session.query(ServiceRequirement).count() == 0
    assert s.service_id.encode() not in client.get("/inventory/waiting").data
