class ServiceError(Exception):
    """Base class for business-rule failures. Web and API both translate these to user messages."""


class ValidationError(ServiceError):
    pass


class PermissionDenied(ServiceError):
    pass


class DuplicateWarning(ServiceError):
    """Raised when likely duplicates exist and the caller has not confirmed. `matches` = [{'customer', 'reasons'}]."""

    def __init__(self, matches):
        super().__init__("Possible duplicate customers found.")
        self.matches = matches
