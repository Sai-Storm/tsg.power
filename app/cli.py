import click
from email_validator import EmailNotValidError, validate_email
from flask import current_app
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .extensions import db
from .models import (Customer, FaultCategory, Generator, Priority, Role, ServiceRequest, ServiceType,
                     User)
from .security.seed import seed_rbac
from .services import audit
from .services.auth_service import require_strong_password, revoke_user_tokens
from .services.errors import ServiceError
from .services.customer_service import create_customer
from .services.generator_service import create_generator
from .services.id_generator import new_staff_code
from .services.service_request_service import create_service_request

DEMO_CUSTOMER_EMAIL = "demo.customer@example.com"
DEMO_GENERATOR_SERIAL = "DEMO-GEN-0001"
DEMO_SERVICE_COMPLAINT = "DEMO DATA: Annual preventive maintenance sample request."


def register_cli(app):
    @app.cli.command("seed-rbac")
    def seed_rbac_cmd():
        """Create permissions, roles and default company settings (safe to re-run)."""
        seed_rbac()
        click.echo("Roles, permissions and default settings are in place.")

    @app.cli.command("create-admin")
    @click.option("--name", prompt="Full name")
    @click.option("--email", prompt="Email")
    @click.option("--password", prompt=True, hide_input=True, confirmation_prompt=True)
    def create_admin(name, email, password):
        """Create the first Admin account (run seed-rbac first)."""
        role = db.session.scalar(select(Role).where(Role.name == "admin"))
        if role is None:
            raise click.ClickException("Run 'flask seed-rbac' first.")
        email = email.strip().lower()
        if db.session.scalar(select(User).where(User.email == email)):
            raise click.ClickException("A user with that email already exists.")
        try:
            require_strong_password(password)
        except ServiceError as exc:
            raise click.ClickException(str(exc))
        user = User(staff_code=new_staff_code(), full_name=name.strip(), email=email, role=role)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        click.echo(f"Admin {user.staff_code} ({email}) created.")

    @app.cli.command("recover-admin")
    def recover_admin():
        """Recover an existing active Admin account when normal sign-in is unavailable."""
        admins = db.session.scalars(
            select(User).join(Role).where(
                Role.name == "admin",
                User.is_active.is_(True),
            ).order_by(User.staff_code)
        ).all()
        if not admins:
            raise click.ClickException(
                "No active Admin account exists. Run 'flask seed-rbac' then 'flask create-admin'."
            )

        click.echo("Active Admin accounts:")
        for admin in admins:
            click.echo(f"  {admin.staff_code}  {admin.email}")
        staff_code = click.prompt("Admin staff code to recover").strip().upper()
        user = db.session.execute(
            select(User).join(Role).where(
                User.staff_code == staff_code,
                Role.name == "admin",
                User.is_active.is_(True),
            ).with_for_update()
        ).scalar_one_or_none()
        if user is None:
            raise click.ClickException("That active Admin staff code was not found.")

        try:
            email = validate_email(
                click.prompt("New Admin email").strip(),
                check_deliverability=False,
            ).normalized.lower()
        except EmailNotValidError:
            raise click.ClickException("Enter a valid email address.")
        email_owner = db.session.scalar(select(User.id).where(User.email == email, User.id != user.id))
        if email_owner is not None:
            raise click.ClickException("That email address is already in use.")

        password = click.prompt("New Admin password", hide_input=True, confirmation_prompt=True)
        try:
            require_strong_password(password)
        except ServiceError as exc:
            raise click.ClickException(str(exc))
        if user.check_password(password):
            raise click.ClickException("Choose a password different from the current password.")

        old_email = user.email
        user.email = email
        user.set_password(password)
        user.failed_login_count = 0
        user.locked_until = None
        revoke_user_tokens(user.id)
        try:
            db.session.flush()
            audit.log(
                "auth.admin_recovery",
                "user",
                user.id,
                old={"email": old_email},
                new={"email": email},
                user=user,
            )
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            raise click.ClickException("That email address is already in use.")
        click.echo(f"Admin account {user.staff_code} updated. Sign in with {email} and the new password.")

    @app.cli.command("demo-data")
    def demo_data():
        """Add one repeatable demo customer, generator, and service request."""
        if not current_app.debug and not current_app.testing:
            raise click.ClickException("Demo data is disabled unless the app is in development or testing mode.")

        seed_rbac()
        admin = db.session.scalar(
            select(User)
            .join(Role)
            .where(Role.name == "admin", User.is_active.is_(True))
            .order_by(User.id)
        )
        if admin is None:
            raise click.ClickException("Create an active Admin account before running 'flask demo-data'.")

        customer = db.session.scalar(select(Customer).where(Customer.email == DEMO_CUSTOMER_EMAIL))
        if customer is None:
            customer = create_customer(admin, {
                "name": "Demo Generator Services",
                "customer_type": "business",
                "contact_person": "Demo Contact",
                "phone_primary": "+91 90000 00001",
                "email": DEMO_CUSTOMER_EMAIL,
                "address": "1 Sample Road",
                "city": "Dehradun",
                "state": "Uttarakhand",
                "notes": "Sample record created by flask demo-data.",
            }, confirm_duplicate=True)
        elif not customer.is_active:
            raise click.ClickException(f"The demo customer ({DEMO_CUSTOMER_EMAIL}) is inactive; reactivate it first.")

        generator = db.session.scalar(
            select(Generator).where(
                Generator.brand_key == "demo",
                Generator.serial_number == DEMO_GENERATOR_SERIAL,
            )
        )
        if generator is None:
            generator = create_generator(admin, customer.id, {
                "brand": "Demo",
                "model": "DG-100",
                "serial_number": DEMO_GENERATOR_SERIAL,
                "capacity_kva": "100",
                "fuel_type": "diesel",
                "condition": "good",
                "location": "Dehradun",
                "notes": "Sample record created by flask demo-data.",
            })
        elif generator.customer_id != customer.id or not generator.is_active:
            raise click.ClickException("The demo generator exists but is inactive or linked to another customer.")

        service = db.session.scalar(
            select(ServiceRequest).where(
                ServiceRequest.customer_id == customer.id,
                ServiceRequest.generator_id == generator.id,
                ServiceRequest.complaint == DEMO_SERVICE_COMPLAINT,
            )
        )
        if service is None:
            service = create_service_request(admin, {
                "customer_id": customer.id,
                "generator_id": generator.id,
                "service_type_id": db.session.scalar(
                    select(ServiceType.id).where(ServiceType.code == "preventive_maintenance")
                ),
                "priority_id": db.session.scalar(select(Priority.id).where(Priority.code == "normal")),
                "fault_category_id": db.session.scalar(
                    select(FaultCategory.id).where(FaultCategory.name == "Other")
                ),
                "complaint": DEMO_SERVICE_COMPLAINT,
                "location": "Dehradun",
            })

        click.echo(
            f"Demo data is ready: customer {customer.customer_code}, "
            f"generator {generator.generator_code}, service {service.service_id}."
        )
