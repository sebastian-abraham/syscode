"""Export a ``Report`` to csv, json or xlsx.

The exporters share a dispatch table so callers ask for a format by name and
get back bytes or a path. pandas does the heavy lifting for csv/xlsx; json is
handled directly to keep datetimes readable.
"""
import io
import json
import os
from typing import Callable, Dict

import pandas as pd

from models import Report
from settings import settings

Format = str


def _to_dataframe(report: Report) -> pd.DataFrame:
    return pd.DataFrame(report.rows, columns=report.columns or None)


def to_csv(report: Report) -> bytes:
    frame = _to_dataframe(report)
    return frame.to_csv(index=False).encode("utf-8")


def to_json(report: Report) -> bytes:
    payload = {
        "name": report.name,
        "generated_at": report.generated_at.isoformat(),
        "columns": report.columns,
        "rows": report.rows,
    }
    return json.dumps(payload, default=str, indent=2).encode("utf-8")


def to_xlsx(report: Report) -> bytes:
    frame = _to_dataframe(report)
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        frame.to_excel(writer, index=False, sheet_name=report.name[:31])
    return buffer.getvalue()


EXPORTERS: Dict[Format, Callable[[Report], bytes]] = {
    "csv": to_csv,
    "json": to_json,
    "xlsx": to_xlsx,
}


def export(report: Report, fmt: Format) -> bytes:
    if fmt not in EXPORTERS:
        raise ValueError(f"unsupported format: {fmt}")
    if report.is_empty():
        # Still emit headers so downstream tooling does not choke on a 0-byte file.
        return EXPORTERS[fmt](report)
    return EXPORTERS[fmt](report)


def export_to_file(report: Report, fmt: Format, filename: str | None = None) -> str:
    os.makedirs(settings.export_dir, exist_ok=True)
    name = filename or f"{report.name}.{fmt}"
    path = os.path.join(settings.export_dir, name)
    with open(path, "wb") as handle:
        handle.write(export(report, fmt))
    return path


def content_type(fmt: Format) -> str:
    return {
        "csv": "text/csv",
        "json": "application/json",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }.get(fmt, "application/octet-stream")
