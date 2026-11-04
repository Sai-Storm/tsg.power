from flask import Blueprint, flash, redirect, render_template, request, session, url_for
from flask_login import current_user, login_required, login_user, logout_user

from ...extensions import db, limiter
from ...services import audit
from ...services.auth_service import AuthError, authenticate, change_password
from ...services.errors import ServiceError
from ...utils.web import is_safe_url
from .forms import ChangePasswordForm, LoginForm

bp = Blueprint("auth", __name__, url_prefix="/auth")


@bp.route("/login", methods=["GET", "POST"])
@limiter.limit("10 per minute", methods=["POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.home"))
    form = LoginForm()
    if form.validate_on_submit():
        try:
            user = authenticate(form.email.data, form.password.data)
        except AuthError as exc:
            flash(str(exc), "danger")
        else:
            login_user(user)
            session.permanent = True
            target = request.args.get("next")
            return redirect(target if is_safe_url(target) else url_for("dashboard.home"))
    return render_template("auth/login.html", form=form)


@bp.post("/logout")
@login_required
def logout():
    audit.log("auth.logout", "user", current_user.id, user=current_user)
    db.session.commit()
    logout_user()
    flash("You have been signed out.", "info")
    return redirect(url_for("auth.login"))


@bp.route("/change-password", methods=["GET", "POST"])
@login_required
def change_own_password():
    form = ChangePasswordForm()
    if form.validate_on_submit():
        try:
            change_password(current_user, form.current_password.data, form.new_password.data)
        except ServiceError as exc:
            flash(str(exc), "danger")
        else:
            flash("Password updated.", "success")
            return redirect(url_for("dashboard.home"))
    return render_template("auth/change_password.html", form=form)
