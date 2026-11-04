import pytest
from sqlalchemy import select

from app import create_app
from app.extensions import db
from app.models import Role, User
from app.security.seed import seed_rbac
from app.services.id_generator import new_staff_code
from config import TestConfig

PASSWORD = "Str0ngPassw0rd"


@pytest.fixture()
def app(tmp_path):
    class Cfg(TestConfig):
        UPLOAD_FOLDER = str(tmp_path / "uploads")

    app = create_app(Cfg)
    with app.app_context():
        db.create_all()
        seed_rbac()
        yield app
        db.session.remove()
        db.drop_all()


@pytest.fixture()
def make_user(app):
    def _make(email, role="staff", password=PASSWORD, active=True, name=None):
        user = User(
            staff_code=new_staff_code(), full_name=name or email.split("@")[0].title(),
            email=email, role=db.session.scalar(select(Role).where(Role.name == role)), is_active=active,
        )
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        return user

    return _make


@pytest.fixture()
def client(app):
    return app.test_client()


def login(client, email, password=PASSWORD):
    return client.post("/auth/login", data={"email": email, "password": password})
