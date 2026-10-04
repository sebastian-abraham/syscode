"""Central configuration for the reporting service.

Values are read from the environment once at import time so the rest of the
code never touches ``os.environ`` directly.
"""
import os


class Settings:
    def __init__(self) -> None:
        self.env = os.environ.get("APP_ENV", "development")
        self.debug = self.env != "production"

        self.database_url = os.environ.get(
            "DATABASE_URL", "postgresql://reports:reports@localhost:5432/reports"
        )
        self.redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
        self.queue_name = os.environ.get("REPORT_QUEUE", "reports:pending")

        self.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
        self.session_ttl_seconds = int(os.environ.get("SESSION_TTL", "86400"))

        self.export_dir = os.environ.get("EXPORT_DIR", "/tmp/reports")
        self.max_rows = int(os.environ.get("MAX_ROWS", "50000"))

    @property
    def is_production(self) -> bool:
        return self.env == "production"


settings = Settings()
