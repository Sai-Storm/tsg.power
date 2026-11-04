import io
import os

import pytest
from PIL import Image
from werkzeug.datastructures import FileStorage

from app.extensions import db
from app.models import Attachment
from app.services import customer_service, generator_service, upload_service
from app.services.errors import PermissionDenied, ValidationError


@pytest.fixture()
def gen(app, make_user):
    staff = make_user("tech@example.com", "staff")
    c = customer_service.create_customer(staff, {"name": "Acme", "phone_primary": "9876543210"})
    g = generator_service.create_generator(staff, c.id, {
        "brand": "Cummins", "model": "X", "serial_number": "SER-1234", "capacity_kva": "100"})
    return staff, g


def fs(data, name):
    return FileStorage(stream=io.BytesIO(data), filename=name)


def png_bytes(size=(40, 30), exif=False):
    buf = io.BytesIO()
    img = Image.new("RGB", size, (200, 120, 20))
    if exif:
        ex = Image.Exif()
        ex[0x010E] = "secret description"
        img.save(buf, "PNG", exif=ex)
    else:
        img.save(buf, "PNG")
    return buf.getvalue()


def jpeg_with_exif():
    buf = io.BytesIO()
    ex = Image.Exif()
    ex[0x010F] = "SecretCamera"
    Image.new("RGB", (30, 30), (1, 2, 3)).save(buf, "JPEG", exif=ex)
    return buf.getvalue()


def test_valid_png_saved_with_random_name(app, gen):
    staff, g = gen
    att = upload_service.save_upload(staff, "generator", g.id, fs(png_bytes(), "../../evil name.png"), "Name plate")
    assert att.kind == "photo" and att.content_type == "image/png"
    assert att.stored_filename != att.original_filename and att.stored_filename.endswith(".png")
    assert len(att.stored_filename.split(".")[0]) == 32
    path = upload_service.attachment_path(att)
    assert os.path.isfile(path)
    assert att.original_filename == "evil_name.png"  # path components stripped from the display name
    assert str(app.config["UPLOAD_FOLDER"]) in path


def test_exif_metadata_is_stripped(app, gen):
    staff, g = gen
    att = upload_service.save_upload(staff, "generator", g.id, fs(jpeg_with_exif(), "cam.jpg"))
    with Image.open(upload_service.attachment_path(att)) as img:
        assert not img.getexif()
    with open(upload_service.attachment_path(att), "rb") as fh:
        assert b"SecretCamera" not in fh.read()


def test_pdf_accepted_and_fake_pdf_rejected(app, gen):
    staff, g = gen
    pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
    att = upload_service.save_upload(staff, "generator", g.id, fs(pdf, "warranty.pdf"))
    assert att.kind == "document" and att.content_type == "application/pdf"
    with pytest.raises(ValidationError):
        upload_service.save_upload(staff, "generator", g.id, fs(b"just text", "fake.pdf"))


@pytest.mark.parametrize("data,name", [
    (b"<?php echo 1; ?>", "shell.php"), (b"MZ\x90\x00", "tool.exe"), (b"<svg onload=alert(1)/>", "x.svg"),
    (b"not an image at all", "photo.jpg"), (b"", "empty.png"), (png_bytes(), "noextension"),
])
def test_dangerous_or_invalid_files_rejected(app, gen, data, name):
    staff, g = gen
    with pytest.raises(ValidationError):
        upload_service.save_upload(staff, "generator", g.id, fs(data, name))
    assert db.session.query(Attachment).count() == 0


def test_extension_must_match_real_content(app, gen):
    staff, g = gen
    with pytest.raises(ValidationError) as exc:
        upload_service.save_upload(staff, "generator", g.id, fs(png_bytes(), "disguised.jpg"))
    assert "do not match" in str(exc.value)


def test_oversize_rejected(app, gen):
    staff, g = gen
    big = b"%PDF-" + b"0" * (upload_service.MAX_BYTES + 10)
    with pytest.raises(ValidationError) as exc:
        upload_service.save_upload(staff, "generator", g.id, fs(big, "big.pdf"))
    assert "MB" in str(exc.value)


def test_unknown_owner_and_missing_record(app, gen):
    staff, g = gen
    with pytest.raises(ValidationError):
        upload_service.save_upload(staff, "customer", 1, fs(png_bytes(), "a.png"))
    with pytest.raises(ValidationError):
        upload_service.save_upload(staff, "generator", 9999, fs(png_bytes(), "a.png"))


def test_soft_delete_hides_file_but_keeps_row(app, gen, make_user):
    staff, g = gen
    att = upload_service.save_upload(staff, "generator", g.id, fs(png_bytes(), "a.png"))
    other = make_user("other@example.com", "staff")
    with pytest.raises(PermissionDenied):
        upload_service.delete_attachment(other, att.id)  # not the uploader, no edit right
    upload_service.delete_attachment(staff, att.id)  # uploader may remove their own
    assert upload_service.list_attachments("generator", g.id) == []
    assert db.session.get(Attachment, att.id).deleted_at is not None
