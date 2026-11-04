import os
from datetime import timedelta

from dotenv import load_dotenv

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY")
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True, "pool_recycle": 280}

    AIVEN_CA_CERT = os.environ.get("AIVEN_CA_CERT")
    if AIVEN_CA_CERT:
        SQLALCHEMY_ENGINE_OPTIONS["connect_args"] = {
            "ssl": {
                "ca": AIVEN_CA_CERT
            }
        }

    UPLOAD_FOLDER = os.environ.get(
        "UPLOAD_FOLDER", os.path.join(BASE_DIR, "instance", "uploads")
    )
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB request limit

    # Session / cookie hardening
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = False  # True in ProductionConfig (HTTPS)
    PERMANENT_SESSION_LIFETIME = timedelta(hours=8)
    WTF_CSRF_TIME_LIMIT = 8 * 3600

    # Rate limiting
    RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
    RATELIMIT_HEADERS_ENABLED = True

    # Login lockout policy
    APP_TIMEZONE = os.environ.get("APP_TIMEZONE", "Asia/Kolkata")

    LOGIN_MAX_FAILED = 5
    LOGIN_LOCK_MINUTES = 15


class DevelopmentConfig(Config):
    DEBUG = True
    SECRET_KEY = Config.SECRET_KEY or "dev-only-insecure-key-change-me"


class ProductionConfig(Config):
    DEBUG = False
    SESSION_COOKIE_SECURE = True
    REMEMBER_COOKIE_SECURE = True
    PREFERRED_URL_SCHEME = "https"


class TestConfig(Config):
    TESTING = True
    SECRET_KEY = "test-secret"
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    SQLALCHEMY_ENGINE_OPTIONS = {}
    WTF_CSRF_ENABLED = False
    RATELIMIT_ENABLED = False


def get_config():
    env = os.environ.get("APP_ENV", "development").lower()
    return {
        "development": DevelopmentConfig,
        "production": ProductionConfig,
        "testing": TestConfig,
    }.get(env, DevelopmentConfig)
