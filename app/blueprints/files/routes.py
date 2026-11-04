import os

from flask import Blueprint, abort, send_file
from flask_login import current_user, login_required

from ...extensions import db
from ...models import Attachment
from ...services import upload_service

bp = Blueprint("files", __name__, url_prefix="/files")


@bp.route("/<int:attachment_id>")
@login_required
def download(attachment_id):
    att = db.session.get(Attachment, attachment_id)
    if att is None or att.deleted_at is not None or not upload_service.can_view(current_user, att):
        abort(404)  # same response for "missing" and "not allowed": does not reveal which files exist
    path = upload_service.attachment_path(att)
    if not os.path.isfile(path):
        abort(404)
    is_pdf = att.content_type == "application/pdf"
    return send_file(path, mimetype=att.content_type, as_attachment=is_pdf, download_name=att.original_filename,
                     max_age=0)
