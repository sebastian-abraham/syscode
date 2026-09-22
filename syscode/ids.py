"""Stable ID map (syscode.ids.json).

Natural key -> fixed ID.  Existing keys keep their ID; new keys get the next
free number for their prefix.  Numbers are never reused.
"""

from __future__ import annotations

import json
import os
from typing import Dict

PREFIXES: Dict[int, str] = {0: "EXT", 1: "CONT", 2: "COMP", 3: "CODE"}


def ids_path(project_root: str) -> str:
    return os.path.join(project_root, "syscode.ids.json")


def load_ids(path: str) -> dict:
    """Read an existing id map, or return an empty one."""
    if not os.path.exists(path):
        return {"version": 1, "next": {}, "ids": {}}
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        return {"version": 1, "next": {}, "ids": {}}
    data.setdefault("version", 1)
    data.setdefault("next", {})
    data.setdefault("ids", {})
    if not isinstance(data["ids"], dict):
        data["ids"] = {}
    if not isinstance(data["next"], dict):
        data["next"] = {}
    # Repair a missing counter by deriving it from the existing ids, so a
    # hand-edited file can never hand out a number that is already used.
    for prefix in set(PREFIXES.values()):
        highest = 0
        for assigned in data["ids"].values():
            if isinstance(assigned, str) and assigned.startswith(prefix + "-"):
                try:
                    highest = max(highest, int(assigned.split("-", 1)[1]))
                except ValueError:
                    continue
        current = int(data["next"].get(prefix, 1) or 1)
        data["next"][prefix] = max(current, highest + 1)
    return data


def save_ids(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


class IdAllocator:
    """Assigns stable IDs from a loaded id map.

    Allocate keys in a deterministic (sorted) order so a fresh run is stable.
    """

    def __init__(self, data: dict):
        self.data = data
        self.next: Dict[str, int] = data["next"]
        self.ids: Dict[str, str] = data["ids"]

    def allocate(self, key: str, level: int) -> str:
        if key in self.ids:
            return self.ids[key]
        prefix = PREFIXES[level]
        number = int(self.next.get(prefix, 1) or 1)
        self.ids[key] = f"{prefix}-{number:03d}"
        self.next[prefix] = number + 1
        return self.ids[key]

    def get(self, key: str):
        return self.ids.get(key)
