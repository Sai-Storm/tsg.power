"""Safe uploads: extension allow-list, size limit, real content checks (Pillow / PDF header),
EXIF stripping by re-encoding, random server-side filenames, storage outside static/."""
import io
import os
import uuid

from flask import current_app
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.utils import secure_filename

from ..extensions import db
from ..models import Attachment, Generator, ServiceRequest
from ..utils.time import utcnow
from . import audit
from .errors import PermissionDenied, ValidationError

Image.MAX_IMAGE_PIXELS = 40_000_000

MAX_BYTES = 8 * 1024 * 1024
MAX_FILES_PER_OWNER = 25
EXT_TO_FORMAT = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "pdf": "PDF"}
FORMAT_TO_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "PDF": "pdf"}
FORMAT_TO_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "PDF": "application/pdf"}
OWNER_TYPES = {"generator": Generator, "service": ServiceRequest}


def _can_upload(user, owner_type, owner):
    from . import service_request_service as svc
    if owner_type == "generator":
        return user.has_permission("generator.create") or user.has_permission("generator.edit")
    return svc.can_upload(user, owner)


def _can_delete(user, att):
    from . import service_request_service as svc
    if att.owner_type == "generator":
        return user.has_permission("generator.edit") or (
            att.uploaded_by_id == user.id and user.has_permission("generator.create"))
    service = db.session.get(ServiceRequest, att.owner_id)
    return service is not None and (user.has_permission("service.view_all") or (
        att.uploaded_by_id == user.id and svc.can_upload(user, service)))


def _can_view(user, att):
    from . import service_request_service as svc
    if att.owner_type == "generator":
        return user.has_permission("generator.view")
    service = db.session.get(ServiceRequest, att.owner_id)
    return service is not None and svc.can_view(user, service)


def _base_dir():
    return os.path.realpath(current_app.config["UPLOAD_FOLDER"])


def attachment_path(att):
    path = os.path.realpath(os.path.join(_base_dir(), att.owner_type, att.stored_filename))
    if not path.startswith(_base_dir() + os.sep):
        raise ValidationError("Invalid file path.")
    return path


def _inspect(data, ext):
    """Return (format, bytes_to_store). Raises ValidationError for anything that is not what it claims."""
    expected = EXT_TO_FORMAT[ext]
    if expected == "PDF":
        if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-2048:]:
            raise ValidationError("That file is not a valid PDF.")
        return "PDF", data
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = probe.format
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise ValidationError("That file is not a valid image.")
    if fmt != expected:
        raise ValidationError("The file contents do not match its extension.")
    img = ImageOps.exif_transpose(img)  # apply rotation, then drop all metadata (GPS etc.) on re-encode
    out = io.BytesIO()
    if fmt == "JPEG":
        img.convert("RGB").save(out, "JPEG", quality=90, optimize=True)
    elif fmt == "PNG":
        img.save(out, "PNG", optimize=True)
    else:
        img.save(out, "WEBP", quality=90)
    return fmt, out.getvalue()


def save_upload(actor, owner_type, owner_id, file_storage, description=None):
    if owner_type not in OWNER_TYPES:
        raise ValidationError("Unsupported attachment target.")
    owner = db.session.get(OWNER_TYPES[owner_type], owner_id)
    if owner is None:
        raise ValidationError("The record for this upload was not found.")
    if actor is None or not _can_upload(actor, owner_type, owner):
        raise PermissionDenied("You do not have permission to upload files here.")

    original = secure_filename(file_storage.filename or "")
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    if ext not in EXT_TO_FORMAT:
        raise ValidationError("Only JPG, PNG, WEBP images and PDF documents are allowed.")
    data = file_storage.stream.read(MAX_BYTES + 1)
    if not data:
        raise ValidationError("The file is empty.")
    if len(data) > MAX_BYTES:
        raise ValidationError(f"Each file must be {MAX_BYTES // (1024 * 1024)} MB or smaller.")

    existing = db.session.query(Attachment).filter_by(owner_type=owner_type, owner_id=owner_id, deleted_at=None).count()
    if existing >= MAX_FILES_PER_OWNER:
        raise ValidationError(f"A record can hold at most {MAX_FILES_PER_OWNER} files.")

    fmt, payload = _inspect(data, ext)
    stored = f"{uuid.uuid4().hex}.{FORMAT_TO_EXT[fmt]}"
    folder = os.path.join(_base_dir(), owner_type)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, stored)
    with open(path, "wb") as fh:
        fh.write(payload)
    try:
        att = Attachment(
            owner_type=owner_type, owner_id=owner_id, kind="document" if fmt == "PDF" else "photo",
            original_filename=original[:200], stored_filename=stored, content_type=FORMAT_TO_MIME[fmt],
            size_bytes=len(payload), description=(description or "").strip()[:200] or None, uploaded_by_id=actor.id,
        )
        db.session.add(att)
        db.session.flush()
        audit.log("attachment.upload", owner_type, owner_id, new={"attachment_id": att.id, "file": original}, user=actor)
        db.session.commit()
    except Exception:
        db.session.rollback()
        os.remove(path)
        raise
    return att


def delete_attachment(actor, attachment_id):
    att = db.session.get(Attachment, attachment_id)
    if att is None or att.deleted_at is not None:
        raise ValidationError("File not found.")
    if not _can_delete(actor, att):
        raise PermissionDenied("You do not have permission to remove this file.")
    att.deleted_at = utcnow()  # soft delete; file kept on disk for the audit trail
    audit.log("attachment.delete", att.owner_type, att.owner_id, old={"attachment_id": att.id}, user=actor)
    db.session.commit()
    return att


def list_attachments(owner_type, owner_id):
    return db.session.query(Attachment).filter_by(owner_type=owner_type, owner_id=owner_id, deleted_at=None) \
        .order_by(Attachment.created_at.desc()).all()


def can_view(user, att):
    return _can_view(user, att)
