"""Domain models for the reporting service.

Plain dataclasses with ``from_row`` constructors. Keeping them dumb means the
exporters can serialize them without pulling in an ORM.
"""
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import List, Optional

import db


@dataclass
class User:
    id: int
    email: str
    password_hash: str
    role: str
    created_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, row: dict) -> "User":
        return cls(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            role=row["role"],
            created_at=row.get("created_at"),
        )

    @classmethod
    def find_by_email(cls, email: str) -> Optional["User"]:
        row = db.fetch_one(
            "SELECT * FROM users WHERE email = %s", (email,)
        )
        return cls.from_row(row) if row else None

    @classmethod
    def find_by_id(cls, user_id: int) -> Optional["User"]:
        row = db.fetch_one("SELECT * FROM users WHERE id = %s", (user_id,))
        return cls.from_row(row) if row else None


@dataclass
class Order:
    id: int
    customer_id: int
    status: str
    total_cents: int
    created_at: datetime

    @property
    def total(self) -> float:
        return self.total_cents / 100.0

    @classmethod
    def from_row(cls, row: dict) -> "Order":
        return cls(
            id=row["id"],
            customer_id=row["customer_id"],
            status=row["status"],
            total_cents=row["total_cents"],
            created_at=row["created_at"],
        )


@dataclass
class Report:
    name: str
    generated_at: datetime = field(default_factory=datetime.utcnow)
    rows: List[dict] = field(default_factory=list)
    columns: List[str] = field(default_factory=list)

    def is_empty(self) -> bool:
        return len(self.rows) == 0

    def add_row(self, row: dict) -> None:
        if not self.columns:
            self.columns = list(row.keys())
        self.rows.append(row)


@dataclass
class Schedule:
    id: int
    report_name: str
    cadence: str
    last_run: Optional[date] = None

    @classmethod
    def due_today(cls) -> List["Schedule"]:
        rows = db.fetch_all(
            "SELECT * FROM schedules WHERE last_run IS NULL OR last_run < CURRENT_DATE"
        )
        return [
            cls(
                id=r["id"],
                report_name=r["report_name"],
                cadence=r["cadence"],
                last_run=r.get("last_run"),
            )
            for r in rows
        ]
