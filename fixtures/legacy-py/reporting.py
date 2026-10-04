"""Report builders.

Each function returns a ``Report`` populated from the database. The exporters
consume these objects; the HTTP layer and the worker both call into here.
"""
from datetime import date
from typing import Optional

import db
from models import Report


def sales_by_day(start: date, end: date) -> Report:
    report = Report(name="sales_by_day")
    rows = db.fetch_all(
        """
        SELECT date_trunc('day', created_at)::date AS day,
               COUNT(*) AS orders,
               SUM(total_cents) AS gross_cents
        FROM orders
        WHERE created_at >= %s AND created_at < %s
          AND status <> 'cancelled'
        GROUP BY 1
        ORDER BY 1
        """,
        (start, end),
    )
    for row in rows:
        report.add_row(
            {
                "day": row["day"],
                "orders": row["orders"],
                "gross": round(row["gross_cents"] / 100.0, 2),
            }
        )
    return report


def top_products(limit: int = 10, since: Optional[date] = None) -> Report:
    report = Report(name="top_products")
    where = "WHERE o.created_at >= %s" if since else ""
    params = (since,) if since else ()
    rows = db.fetch_all(
        f"""
        SELECT p.sku, p.name, SUM(ol.quantity) AS units, SUM(ol.quantity * ol.unit_price_cents) AS revenue
        FROM order_lines ol
        JOIN products p ON p.id = ol.product_id
        JOIN orders o ON o.id = ol.order_id
        {where}
        GROUP BY p.sku, p.name
        ORDER BY units DESC
        LIMIT %s
        """,
        params + (limit,),
    )
    for row in rows:
        report.add_row(
            {
                "sku": row["sku"],
                "name": row["name"],
                "units": row["units"],
                "revenue": round(row["revenue"] / 100.0, 2),
            }
        )
    return report


def customer_activity(days: int = 30) -> Report:
    report = Report(name="customer_activity")
    rows = db.fetch_all(
        """
        SELECT u.id, u.email, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_cents), 0) AS spend_cents
        FROM users u
        LEFT JOIN orders o ON o.customer_id = u.id
          AND o.created_at >= now() - (%s || ' days')::interval
        GROUP BY u.id, u.email
        ORDER BY spend_cents DESC
        """,
        (days,),
    )
    for row in rows:
        report.add_row(
            {
                "customer_id": row["id"],
                "email": row["email"],
                "order_count": row["order_count"],
                "spend": round(row["spend_cents"] / 100.0, 2),
            }
        )
    return report


def refund_rate(days: int = 90) -> Report:
    report = Report(name="refund_rate")
    row = db.fetch_one(
        """
        SELECT
          COUNT(*) FILTER (WHERE status = 'refunded') AS refunded,
          COUNT(*) AS total
        FROM orders
        WHERE created_at >= now() - (%s || ' days')::interval
        """,
        (days,),
    ) or {"refunded": 0, "total": 0}
    rate = 0.0 if row["total"] == 0 else row["refunded"] / row["total"]
    report.add_row({"refunded": row["refunded"], "total": row["total"], "rate": round(rate, 4)})
    return report
