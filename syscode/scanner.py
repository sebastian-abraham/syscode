"""Walk a project folder and find the source files worth mapping.

Honours .gitignore via pathspec and always skips VCS / dependency / build
directories.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List

from pathspec import PathSpec

# Directories that are never part of the mapped source.
SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "dist",
    "build",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
}

# Extensions we understand. Everything here becomes a level-2 component.
SOURCE_EXTENSIONS = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".html": "html",
    ".htm": "html",
}

# Recognisable entry points that turn a top-level folder into a container.
ENTRY_FILES = {"main.py", "app.py", "app.js", "package.json", "index.html"}
ENTRY_DIRS = {"routes"}


@dataclass
class SourceFile:
    abs_path: str
    rel_path: str
    language: str


def _gitignore_spec(root: str) -> PathSpec:
    """Merge every .gitignore under root into one spec.

    Patterns from a nested .gitignore are prefixed with their directory so they
    keep the meaning they have in git for the common cases.
    """
    lines: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        if ".gitignore" not in filenames:
            continue
        reldir = os.path.relpath(dirpath, root)
        reldir = "" if reldir == "." else reldir.replace(os.sep, "/")
        try:
            with open(os.path.join(dirpath, ".gitignore"), "r", encoding="utf-8", errors="replace") as fh:
                raw_lines = fh.readlines()
        except OSError:
            continue
        for raw in raw_lines:
            pattern = raw.rstrip("\n")
            if not pattern.strip() or pattern.lstrip().startswith("#"):
                continue
            negate = pattern.startswith("!")
            body = pattern[1:] if negate else pattern
            if body.startswith("/"):
                new_pattern = (reldir + body) if reldir else body
            elif "/" in body:
                new_pattern = (reldir + "/" + body) if reldir else body
            else:
                new_pattern = (reldir + "/**/" + body) if reldir else ("**/" + body)
            lines.append(("!" if negate else "") + new_pattern)
    return PathSpec.from_lines("gitwildmatch", lines)


def scan(project_root: str) -> List[SourceFile]:
    """Return the source files of a project in a stable, sorted order."""
    root = os.path.abspath(project_root)
    spec = _gitignore_spec(root)
    found: List[SourceFile] = []

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        # Prune ignored directories as early as possible.
        kept = []
        for name in dirnames:
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if spec.match_file(rel + "/") or spec.match_file(rel):
                continue
            kept.append(name)
        dirnames[:] = kept

        for name in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if name in {"syscode.graph.json", "syscode.ids.json"}:
                continue
            if spec.match_file(rel):
                continue
            ext = os.path.splitext(name)[1].lower()
            language = SOURCE_EXTENSIONS.get(ext)
            if language is None:
                continue
            found.append(SourceFile(os.path.join(dirpath, name), rel, language))

    found.sort(key=lambda f: f.rel_path)
    return found


def all_dirs(project_root: str) -> List[str]:
    """Relative paths of every non-skipped directory, sorted."""
    root = os.path.abspath(project_root)
    spec = _gitignore_spec(root)
    dirs: List[str] = []
    for dirpath, dirnames, _filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        kept = []
        for name in dirnames:
            rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if spec.match_file(rel + "/") or spec.match_file(rel):
                continue
            kept.append(name)
            dirs.append(rel)
        dirnames[:] = kept
    dirs.sort()
    return dirs


def find_containers(project_root: str, source_files: List[SourceFile], dirs: List[str]):
    """Top-level folders that contain a recognisable entry point.

    Returns a list of (container_name, container_relpath, entry_relpath) sorted
    by name.  A top-level folder qualifies if any depth below it holds one of
    the entry files or a directory named like one of ENTRY_DIRS.
    """
    root = os.path.abspath(project_root)
    top_level = sorted(d for d in dirs if "/" not in d)
    file_rels = [f.rel_path for f in source_files]
    dir_set = set(dirs)

    containers = []
    for top in top_level:
        prefix = top + "/"
        entry = None
        for rel in file_rels:
            if rel.startswith(prefix) and os.path.basename(rel) in ENTRY_FILES:
                entry = rel
                break
        if entry is None:
            for d in dirs:
                if d.startswith(prefix) and os.path.basename(d) in ENTRY_DIRS:
                    entry = d
                    break
        if entry is None:
            # A top-level folder that is itself just one of the entry names.
            if top in ENTRY_DIRS:
                entry = top
        if entry is not None:
            containers.append((top, top, entry))
    return containers
