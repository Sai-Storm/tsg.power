from flask import Blueprint, flash, redirect, render_template, request, url_for
from flask_login import current_user
from sqlalchemy import or_, select

from ...extensions import db
from ...models import Role, User
from ...security.decorators import permission_required
from ...services import service_request_service, staff_service
from ...services.errors import ServiceError
from .forms import StaffForm

bp = Blueprint("staff", __name__, url_prefix="/staff")


def _role_choices():
    roles = db.session.scalars(select(Role).where(Role.name.in_(staff_service.ASSIGNABLE_ROLES)).order_by(Role.name))
    return [(r.id, r.name.title()) for r in roles]


@bp.route("/")
@permission_required("staff.manage")
def list_staff():
    q = request.args.get("q", "").strip()
    role_id = request.args.get("role", type=int)
    status = request.args.get("status", "")
    page = request.args.get("page", 1, type=int)

    stmt = select(User).join(Role, User.role_id == Role.id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(User.full_name.ilike(like), User.email.ilike(like),
                              User.staff_code.ilike(like), User.phone.ilike(like)))
    if role_id:
        stmt = stmt.where(User.role_id == role_id)
    if status == "active":
        stmt = stmt.where(User.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(User.is_active.is_(False))
    stmt = stmt.order_by(User.full_name)

    pagination = db.paginate(stmt, page=page, per_page=15, error_out=False)
    return render_template("staff/list.html", pagination=pagination, roles=_role_choices(),
                           q=q, role_id=role_id, status=status)


@bp.route("/new", methods=["GET", "POST"])
@permission_required("staff.manage")
def create():
    form = StaffForm()
    form.role_id.choices = _role_choices()
    if form.validate_on_submit():
        if not form.password.data:
            form.password.errors = ["A password is required for a new account."]
        else:
            try:
                user = staff_service.create_staff(current_user, _form_data(form))
            except ServiceError as exc:
                flash(str(exc), "danger")
            else:
                flash(f"Account {user.staff_code} created for {user.full_name}.", "success")
                return redirect(url_for("staff.list_staff"))
    return render_template("staff/form.html", form=form, editing=False, editing_self=False, user=None)


@bp.route("/<int:user_id>/edit", methods=["GET", "POST"])
@permission_required("staff.manage")
def edit(user_id):
    user = db.get_or_404(User, user_id)
    editing_self = user.id == current_user.id
    form = StaffForm(obj=user)
    form.role_id.choices = _role_choices()
    if editing_self:
        del form.role_id  # nobody can change their own role
    if form.validate_on_submit():
        data = _form_data(form)
        if editing_self:
            data.pop("role_id", None)
        try:
            staff_service.update_staff(current_user, user.id, data)
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Staff account updated.", "success")
            return redirect(url_for("staff.list_staff"))
    return render_template("staff/form.html", form=form, editing=True, editing_self=editing_self, user=user)


@bp.post("/<int:user_id>/deactivate")
@permission_required("staff.manage")
def deactivate(user_id):
    return _toggle(user_id, False, "deactivated")


@bp.post("/<int:user_id>/activate")
@permission_required("staff.manage")
def activate(user_id):
    return _toggle(user_id, True, "reactivated")


@bp.post("/<int:user_id>/delete")
@permission_required("staff.manage")
def delete(user_id):
    try:
        staff_service.delete_unreferenced_staff(current_user, user_id)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash("Staff account permanently deleted.", "success")
    return redirect(url_for("staff.list_staff"))


@bp.post("/<int:user_id>/clear-workload")
@permission_required("staff.manage")
def clear_workload(user_id):
    user = db.get_or_404(User, user_id)
    full_name = user.full_name
    try:
        cleared = service_request_service.clear_staff_workload(current_user, user.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash(f"Removed {full_name} from {cleared} active job(s). Job history and staff account were kept.", "success")
    return redirect(url_for("staff.list_staff"))


@bp.post("/<int:user_id>/urgent-clear-workload")
@permission_required("role.manage")
def urgent_clear_workload(user_id):
    user = db.get_or_404(User, user_id)
    full_name = user.full_name
    try:
        cleared = service_request_service.clear_staff_workload(current_user, user.id)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash(
            f"Urgently removed {full_name} from {cleared} active job(s) without considering generator or customer history. "
            "Job history and staff account were kept.",
            "warning",
        )
    return redirect(request.referrer or url_for("staff.list_staff"))


def _toggle(user_id, active, verb):
    try:
        user = staff_service.set_active(current_user, user_id, active)
    except ServiceError as exc:
        flash(str(exc), "danger")
    else:
        flash(f"{user.full_name} has been {verb}.", "success")
    return redirect(url_for("staff.list_staff"))


def _form_data(form):
    data = {"full_name": form.full_name.data, "email": form.email.data, "phone": form.phone.data,
            "specialization": form.specialization.data, "availability": form.availability.data,
            "password": form.password.data}
    if "role_id" in form:
        data["role_id"] = form.role_id.data
    return data
