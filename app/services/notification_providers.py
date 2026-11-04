class NotificationProvider:
    channel = None

    def send(self, recipient, subject, message):
        raise NotImplementedError(f"{self.channel} delivery is not configured.")


class EmailProvider(NotificationProvider):
    channel = "email"


class SMSProvider(NotificationProvider):
    channel = "SMS"


class WhatsAppProvider(NotificationProvider):
    channel = "WhatsApp"
