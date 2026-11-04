import pytest

from app import create_app


@pytest.mark.parametrize("database_url", [None, "sqlite://"])
def test_non_test_app_requires_mysql(database_url):
    class NonMySqlConfig:
        TESTING = False
        SECRET_KEY = "test-secret"
        SQLALCHEMY_DATABASE_URI = database_url

    with pytest.raises(RuntimeError, match="MySQL"):
        create_app(NonMySqlConfig)
