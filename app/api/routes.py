from datetime import date, datetime
from functools import wraps

from flask import current_app, g, jsonify, request, send_file, url_for
from sqlalchemy import func, select

from ..extensions import db, limiter
from ..models import (ApiToken, Attachment, Customer, Generator, InventoryItem, ServiceRequest,
                      ServiceRequirement, User)
from ..services import customer_service, requirement_service, service_request_service as jobs
from ..services import upload_service
from ..services.auth_service import AuthError
from ..services.errors import PermissionDenied, ValidationError
from ..utils.time import utcnow
from . import bp
from .tokens import (ACCESS_TOKEN_SECONDS, create_access_token, hash_refresh_token,
                     login as token_login, rotate_refresh_token, verify_access_token)


def _ok(data, status=200, **extra):
    return jsonify({"data": data, **extra}), status


def _error(code, message, status):
    return jsonify(error={"code": code, "message": message}), status


def _date(value):
    return value.isoformat() if value is not None else None


def _user(user):
    return {"id": user.id, "staff_code": user.staff_code, "name": user.full_name,
            "email": user.email, "role": user.role.name}


def _token_result(user, row, refresh):
    return {"access_token": create_access_token(user, row.id), "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_SECONDS, "refresh_token": refresh,
            "refresh_expires_at": row.expires_at.isoformat(), "user": _user(user)}


def _payload():
    if not request.is_json:
        raise ValidationError("A JSON request body is required.")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationError("The JSON request body must be an object.")
    return data


def _auth_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        authorization = request.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        user = verify_access_token(token) if scheme.lower() == "bearer" else None
        if user is None:
            return _error("unauthorized", "A valid bearer access token is required.", 401)
        g.api_user = user
        return view(*args, **kwargs)
    return wrapped


def _require_permission(user, permission):
    if not user.has_permission(permission):
        raise PermissionDenied("You do not have permission to access this resource.")


def _pagination(stmt):
    try:
        page = int(request.args.get("page", 1))
        per_page = int(request.args.get("per_page", 20))
    except (TypeError, ValueError):
        raise ValidationError("Page and per_page must be integers.")
    if page < 1 or per_page < 1 or per_page > 100:
        raise ValidationError("Page must be positive and per_page must be between 1 and 100.")
    count = db.session.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    items = db.session.scalars(stmt.limit(per_page).offset((page - 1) * per_page)).all()
    return items, {"page": page, "per_page": per_page, "total": count,
                   "pages": (count + per_page - 1) // per_page}


def _job(job):
    return {
        "id": job.id, "service_id": job.service_id, "status": job.status,
        "status_label": job.status_label, "priority": job.priority.code,
        "service_type": job.service_type.name, "complaint": job.complaint,
        "location": job.location, "scheduled_at": _date(job.scheduled_at),
        "estimated_completion": _date(job.estimated_completion),
        "customer": {"id": job.customer.id, "code": job.customer.customer_code,
                     "name": job.customer.name, "phone": job.customer.phone_primary,
                     "address": job.customer.address, "city": job.customer.city},
        "generator": {"id": job.generator.id, "code": job.generator.generator_code,
                      "brand": job.generator.brand, "model": job.generator.model,
                      "serial_number": job.generator.serial_number,
                      "capacity_kva": str(job.generator.capacity_kva)},
        "technicians": [{"id": a.user.id, "name": a.user.full_name, "lead": a.is_lead}
                        for a in job.active_assignments],
        "created_at": _date(job.created_at),
    }


def _requirement(item):
    return {"id": item.id, "type": item.requirement_type, "item_id": item.item_id,
            "description": item.description, "category": item.category, "unit": item.unit,
            "requested_qty": str(item.requested_qty), "approved_qty": str(item.approved_qty),
            "issued_qty": str(item.issued_qty), "used_qty": str(item.used_qty),
            "returned_qty": str(item.returned_qty), "status": item.status, "purpose": item.purpose}


@bp.post("/auth/login")
@limiter.limit("5 per minute")
def api_login():
    data = _payload()
    if not isinstance(data.get("email"), str) or not isinstance(data.get("password"), str):
        raise ValidationError("Email and password must be strings.")
    if data.get("device_name") is not None and not isinstance(data.get("device_name"), str):
        raise ValidationError("device_name must be a string.")
    try:
        user, row, refresh = token_login(data.get("email"), data.get("password"), data.get("device_name"))
    except AuthError as error:
        return _error("invalid_credentials", str(error), 401)
    return _ok(_token_result(user, row, refresh))


@bp.post("/auth/refresh")
@limiter.limit("10 per minute")
def api_refresh():
    data = _payload()
    result = rotate_refresh_token(data.get("refresh_token"))
    if result is None:
        return _error("invalid_refresh_token", "The refresh token is invalid, expired, or revoked.", 401)
    return _ok(_token_result(*result))


@bp.post("/auth/logout")
@_auth_required
def api_logout():
    header = request.headers.get("Authorization", "").partition(" ")[2]
    # Access validation already verified this token's session; the session id is its signed claim.
    from .tokens import _decode
    import json
    session_id = json.loads(_decode(header.split(".", 1)[0]))["sid"]
    row = db.session.get(ApiToken, session_id)
    if row is not None and row.revoked_at is None:
        row.revoked_at = utcnow()
        db.session.commit()
    return _ok({"logged_out": True})


@bp.get("/me")
@_auth_required
def api_me():
    return _ok(_user(g.api_user))


@bp.get("/jobs")
@_auth_required
def list_jobs():
    stmt = jobs.search_services(g.api_user, q=request.args.get("q"),
                                status=request.args.get("status"), mine=request.args.get("mine") == "true")
    items, meta = _pagination(stmt)
    return _ok([_job(item) for item in items], meta=meta)


def _visible_job(job_id):
    job = jobs.get_visible(g.api_user, job_id)
    if job is None:
        raise PermissionDenied("You cannot access this job.")
    return job


@bp.get("/jobs/<int:job_id>")
@_auth_required
def get_job(job_id):
    return _ok(_job(_visible_job(job_id)))


@bp.patch("/jobs/<int:job_id>/status")
@_auth_required
def change_job_status(job_id):
    data = _payload()
    job = jobs.change_status(g.api_user, job_id, data.get("status"), data.get("remarks"))
    return _ok(_job(job))


@bp.get("/jobs/<int:job_id>/history")
@_auth_required
def job_history(job_id):
    job = _visible_job(job_id)
    timeline = [{
        "at": _date(entry["at"]), "kind": entry["kind"], "status": entry["status"],
        "title": entry["title"], "detail": entry["detail"], "by": entry["by"],
        "from_label": entry["from_label"],
    } for entry in jobs.timeline(job)]
    return _ok(timeline)


@bp.get("/history")
@_auth_required
def history():
    customer_id = request.args.get("customer_id", type=int)
    generator_id = request.args.get("generator_id", type=int)
    try:
        limit = int(request.args.get("limit", 50))
    except ValueError:
        raise ValidationError("Limit must be an integer.")
    if limit < 1 or limit > 100:
        raise ValidationError("Limit must be between 1 and 100.")
    records = jobs.history_for(g.api_user, customer_id=customer_id, generator_id=generator_id, limit=limit)
    return _ok([_job(item) for item in records])


@bp.post("/jobs/<int:job_id>/completion")
@_auth_required
def complete_job(job_id):
    data = _payload()
    for field in ("actual_completion", "estimated_completion"):
        if data.get(field):
            try:
                data[field] = date.fromisoformat(data[field])
            except (TypeError, ValueError):
                raise ValidationError(f"{field} must use YYYY-MM-DD format.")
    return _ok(_job(jobs.complete_service(g.api_user, job_id, data)))


@bp.get("/jobs/<int:job_id>/materials")
@_auth_required
def list_job_materials(job_id):
    job = _visible_job(job_id)
    return _ok([_requirement(line) for line in job.requirements])


@bp.post("/jobs/<int:job_id>/materials")
@_auth_required
def add_job_material(job_id):
    item = requirement_service.add_requirement(g.api_user, job_id, _payload())
    return _ok(_requirement(item), 201)


@bp.post("/jobs/<int:job_id>/materials/submit")
@_auth_required
def submit_job_materials(job_id):
    lines = requirement_service.submit_requirements(g.api_user, job_id)
    return _ok([_requirement(line) for line in lines])


@bp.get("/materials")
@_auth_required
def list_materials():
    _require_permission(g.api_user, "inventory.view")
    stmt = select(InventoryItem).where(InventoryItem.is_active.is_(True)).order_by(InventoryItem.name)
    items, meta = _pagination(stmt)
    return _ok([{"id": item.id, "part_code": item.part_code, "name": item.name,
                 "unit": item.unit, "current_stock": str(item.current_stock),
                 "selling_price": str(item.selling_price) if item.selling_price is not None else None}
                for item in items], meta=meta)


@bp.get("/jobs/<int:job_id>/photos")
@_auth_required
def list_job_photos(job_id):
    job = _visible_job(job_id)
    attachments = upload_service.list_attachments("service", job.id)
    return _ok([{"id": file.id, "filename": file.original_filename,
                 "content_type": file.content_type, "size_bytes": file.size_bytes,
                 "description": file.description,
                 "url": url_for("api_v1.get_photo", photo_id=file.id, _external=False)}
                for file in attachments if file.kind == "photo"])


@bp.post("/jobs/<int:job_id>/photos")
@_auth_required
@limiter.limit("20 per hour")
def upload_job_photo(job_id):
    _visible_job(job_id)
    photo = request.files.get("photo") or request.files.get("file")
    if photo is None:
        raise ValidationError("Upload a photo using the photo field.")
    attachment = upload_service.save_upload(g.api_user, "service", job_id, photo,
                                            request.form.get("description"))
    return _ok({"id": attachment.id, "filename": attachment.original_filename,
                "content_type": attachment.content_type, "size_bytes": attachment.size_bytes},
               201)


@bp.get("/photos/<int:photo_id>")
@_auth_required
def get_photo(photo_id):
    attachment = db.session.get(Attachment, photo_id)
    if attachment is None or attachment.deleted_at is not None or attachment.kind != "photo":
        return _error("not_found", "Photo not found.", 404)
    if not upload_service.can_view(g.api_user, attachment):
        raise PermissionDenied("You cannot view this photo.")
    return send_file(upload_service.attachment_path(attachment), mimetype=attachment.content_type,
                     download_name=attachment.original_filename, as_attachment=False)


@bp.get("/customers")
@_auth_required
def list_customers():
    _require_permission(g.api_user, "customer.view")
    stmt = customer_service.search_customers(q=request.args.get("q"), status="active")
    items, meta = _pagination(stmt)
    return _ok([_customer(item) for item in items], meta=meta)


def _customer(customer):
    return {"id": customer.id, "code": customer.customer_code, "name": customer.name,
            "contact_person": customer.contact_person, "phone_primary": customer.phone_primary,
            "phone_alt": customer.phone_alt, "email": customer.email, "address": customer.address,
            "city": customer.city, "state": customer.state, "customer_type": customer.customer_type,
            "is_active": customer.is_active}


@bp.get("/customers/<int:customer_id>")
@_auth_required
def get_customer(customer_id):
    _require_permission(g.api_user, "customer.view")
    customer = db.session.get(Customer, customer_id)
    if customer is None or not customer.is_active:
        return _error("not_found", "Customer not found.", 404)
    return _ok(_customer(customer))


@bp.get("/customers/<int:customer_id>/generators")
@_auth_required
def customer_generators(customer_id):
    _require_permission(g.api_user, "generator.view")
    if db.session.get(Customer, customer_id) is None:
        return _error("not_found", "Customer not found.", 404)
    stmt = select(Generator).where(Generator.customer_id == customer_id,
                                  Generator.is_active.is_(True)).order_by(Generator.id.desc())
    items, meta = _pagination(stmt)
    return _ok([_generator(item) for item in items], meta=meta)


def _generator(generator):
    return {"id": generator.id, "code": generator.generator_code,
            "customer_id": generator.customer_id, "brand": generator.brand, "model": generator.model,
            "serial_number": generator.serial_number, "capacity_kva": str(generator.capacity_kva),
            "fuel_type": generator.fuel_type, "condition": generator.condition,
            "location": generator.location, "warranty_end": _date(generator.warranty_end),
            "last_service_date": _date(generator.last_service_date),
            "next_maintenance_date": _date(generator.next_maintenance_date)}


@bp.get("/generators")
@_auth_required
def list_generators():
    _require_permission(g.api_user, "generator.view")
    stmt = select(Generator).where(Generator.is_active.is_(True)).order_by(Generator.id.desc())
    if request.args.get("customer_id", type=int):
        stmt = stmt.where(Generator.customer_id == request.args.get("customer_id", type=int))
    if request.args.get("q"):
        term = f"%{request.args['q'].strip()}%"
        stmt = stmt.where(Generator.generator_code.ilike(term) | Generator.serial_number.ilike(term)
                          | Generator.model.ilike(term) | Generator.brand.ilike(term))
    items, meta = _pagination(stmt)
    return _ok([_generator(item) for item in items], meta=meta)


@bp.get("/generators/<int:generator_id>")
@_auth_required
def get_generator(generator_id):
    _require_permission(g.api_user, "generator.view")
    generator = db.session.get(Generator, generator_id)
    if generator is None or not generator.is_active:
        return _error("not_found", "Generator not found.", 404)
    return _ok(_generator(generator))


@bp.route("/", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
@bp.route("/<path:unknown>", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def api_not_found(unknown=None):
    return _error("not_found", "The requested API resource was not found.", 404)
