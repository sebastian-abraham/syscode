"""Background worker.

Drains the Redis queue of report jobs, builds the report, writes it to the
export directory and records completion. Run with ``python workers.py``.
"""
import json
import logging
import signal
import time
from datetime import date

import redis

import exporters
import reporting
from models import Report
from settings import settings

log = logging.getLogger("workers")

_running = True


def build_report(name: str, params: dict) -> Report:
    """Dispatch a job name to the matching report builder."""
    if name == "sales_by_day":
        return reporting.sales_by_day(
            start=date.fromisoformat(params["start"]),
            end=date.fromisoformat(params["end"]),
        )
    if name == "top_products":
        return reporting.top_products(limit=params.get("limit", 10))
    if name == "customer_activity":
        return reporting.customer_activity(days=params.get("days", 30))
    if name == "refund_rate":
        return reporting.refund_rate(days=params.get("days", 90))
    raise ValueError(f"unknown report {name}")


def handle_job(raw: str) -> None:
    job = json.loads(raw)
    report = build_report(job["name"], job.get("params", {}))
    fmt = job.get("format", "csv")
    path = exporters.export_to_file(report, fmt)
    log.info("wrote %s (%d rows)", path, len(report.rows))


def _stop(signum, frame):  # noqa: ANN001
    global _running
    _running = False
    log.info("shutdown requested")


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    client = redis.from_url(settings.redis_url)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log.info("worker listening on %s", settings.queue_name)
    while _running:
        item = client.blpop(settings.queue_name, timeout=5)
        if item is None:
            continue
        _, payload = item
        try:
            handle_job(payload.decode("utf-8"))
        except Exception as exc:  # keep the loop alive across bad jobs
            log.exception("job failed: %s", exc)
        time.sleep(0.05)


if __name__ == "__main__":
    main()
