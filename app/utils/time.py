"""All timestamps are stored as naive UTC. People see and enter the company's local time (APP_TIMEZONE)."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DEFAULT_TZ = "Asia/Kolkata"


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _tz():
    try:
        from flask import current_app
        name = current_app.config.get("APP_TIMEZONE")
    except RuntimeError:  # no app context
        name = None
    return ZoneInfo(name or DEFAULT_TZ)


def utc_to_local(dt):
    return dt.replace(tzinfo=timezone.utc).astimezone(_tz()).replace(tzinfo=None) if dt else None


def local_to_utc(dt):
    return dt.replace(tzinfo=_tz()).astimezone(timezone.utc).replace(tzinfo=None) if dt else None


def local_now():
    return utc_to_local(utcnow())


def local_today():
    return local_now().date()
