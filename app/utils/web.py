from urllib.parse import urljoin, urlparse

from flask import request


def is_safe_url(target):
    """True only for same-host http(s) redirects (blocks open redirects)."""
    if not target:
        return False
    ref = urlparse(request.host_url)
    test = urlparse(urljoin(request.host_url, target))
    return test.scheme in ("http", "https") and ref.netloc == test.netloc
