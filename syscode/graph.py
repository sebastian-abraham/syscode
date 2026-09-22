"""Build the four-level graph from parsed source files.

Levels:
  0 External   hosts the code talks to
  1 Container  top-level folders with a recognisable entry point
  2 Component  source files
  3 Artifact   functions and classes, with real line numbers

Containment is a `parent` field, never an edge.  Every edge carries evidence
and a confidence value.
"""

from __future__ import annotations

import json
import os
from typing import Dict, List, Optional, Tuple

from . import ids as ids_mod
from . import scanner
from .parsers import Call, FileAnalysis, Import, Route, Symbol, parse_source

STACK_ORDER = ["python", "javascript", "typescript"]


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #


def _evidence(file: str, line: int, text: Optional[str] = None) -> dict:
    item = {"file": file, "line": int(line)}
    if text:
        item["text"] = text
    return item


def _sort_evidence(items: List[dict]) -> List[dict]:
    unique: Dict[Tuple, dict] = {}
    for item in items:
        key = (item.get("file"), item.get("line"), item.get("text"))
        unique[key] = item
    return [unique[k] for k in sorted(unique, key=lambda k: (k[0] or "", k[1] or 0, k[2] or ""))]


def _merge_interface(target: dict, exposes: List[dict], needs: List[dict]) -> None:
    for side, entries in (("exposes", exposes), ("needs", needs)):
        merged: Dict[Tuple[str, str], dict] = {}
        for entry in target[side]:
            merged[(entry["name"], entry["kind"])] = dict(entry)
            merged[(entry["name"], entry["kind"])]["evidence"] = list(entry.get("evidence", []))
        for entry in entries:
            key = (entry["name"], entry["kind"])
            if key not in merged:
                merged[key] = dict(entry)
                merged[key]["evidence"] = list(entry.get("evidence", []))
            else:
                merged[key]["evidence"].extend(entry.get("evidence", []))
        result = []
        for key in sorted(merged):
            entry = merged[key]
            entry["evidence"] = _sort_evidence(entry.get("evidence", []))
            result.append(entry)
        target[side] = result


def _normalise_path(path: str) -> str:
    if not path:
        return "/"
    path = path.split("?", 1)[0].split("#", 1)[0]
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return path or "/"


# --------------------------------------------------------------------------- #
# import resolution
# --------------------------------------------------------------------------- #


class ModuleIndex:
    """Maps project files to the module names import statements refer to."""

    def __init__(self, files: List[scanner.SourceFile]):
        self.python_modules: Dict[str, str] = {}
        self.js_files: Dict[str, str] = {}
        for f in files:
            if f.language == "python":
                dotted = f.rel_path[:-3].replace("/", ".")
                if f.rel_path.endswith("/__init__.py"):
                    dotted = f.rel_path[: -len("/__init__.py")].replace("/", ".")
                self.python_modules[dotted] = f.rel_path
            elif f.language in {"javascript", "typescript", "tsx"}:
                self.js_files[f.rel_path] = f.rel_path

    def resolve_python(self, importer: str, imp: Import) -> Optional[str]:
        dir_parts = importer.split("/")[:-1]
        candidates: List[str] = []
        if imp.level > 0:
            drop = imp.level - 1
            base = dir_parts[: len(dir_parts) - drop] if drop else dir_parts
            if imp.module:
                candidates.append(".".join(base + imp.module.split(".")))
            else:
                for name in imp.names:
                    candidates.append(".".join(base + [name]))
        elif imp.is_from and imp.names:
            for name in imp.names:
                candidates.append(imp.module + "." + name)
            candidates.append(imp.module)
        else:
            candidates.append(imp.module)
        for candidate in candidates:
            if candidate in self.python_modules:
                return self.python_modules[candidate]
        return None

    def resolve_js(self, importer: str, module: str) -> Optional[str]:
        if not module.startswith("."):
            return None
        base = os.path.normpath(os.path.join(os.path.dirname(importer), module)).replace(os.sep, "/")
        for ext in (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"):
            if base + ext in self.js_files:
                return base + ext
        for index in ("index.js", "index.jsx", "index.ts", "index.tsx"):
            if f"{base}/{index}" in self.js_files:
                return f"{base}/{index}"
        return None


# --------------------------------------------------------------------------- #
# builder
# --------------------------------------------------------------------------- #


class GraphBuilder:
    def __init__(self, project_root: str):
        self.project_root = os.path.abspath(project_root)
        self.files = scanner.scan(self.project_root)
        self.dirs = scanner.all_dirs(self.project_root)
        self.analyses: Dict[str, FileAnalysis] = {}
        for f in self.files:
            self.analyses[f.rel_path] = parse_source(f.rel_path, f.abs_path, f.language)
        self.containers = scanner.find_containers(self.project_root, self.files, self.dirs)
        self.container_of: Dict[str, str] = {}
        for name, rel, _entry in self.containers:
            for f in self.files:
                if f.rel_path == rel or f.rel_path.startswith(rel + "/"):
                    self.container_of[f.rel_path] = name
        self.index = ModuleIndex(self.files)

        # nodes keyed by natural id key
        self.nodes_by_key: Dict[str, dict] = {}
        self.node_id_by_key: Dict[str, str] = {}
        self.component_id_by_file: Dict[str, str] = {}
        self.artifact_id_by_qualified: Dict[str, str] = {}
        self.external_id_by_host: Dict[str, str] = {}
        self.route_decls: List[Tuple[str, Route, str]] = []  # (component_file, route, component_id)

    # -- node creation ---------------------------------------------------- #

    def build(self) -> dict:
        self._collect_keys()
        allocator = ids_mod.IdAllocator(self._load_id_map())
        self._assign_ids(allocator)

        nodes = self._build_nodes()
        edges = self._build_edges()
        layout = self._load_layout()
        build_log = self._load_build_log()

        build_log = self._append_build(build_log, nodes, edges)

        self._save_id_map(allocator, allocator.data)

        project = {
            "name": os.path.basename(self.project_root.rstrip(os.sep)) or "project",
            "root": ".",
            "stack": self._stack(),
        }
        return {
            "version": 1,
            "project": project,
            "nodes": nodes,
            "edges": edges,
            "layout": layout,
            "build": build_log,
        }

    def _stack(self) -> List[str]:
        present = {f.language for f in self.files}
        return [name for name in STACK_ORDER if name in present]

    # -- ids -------------------------------------------------------------- #

    def _load_id_map(self) -> dict:
        return ids_mod.load_ids(ids_mod.ids_path(self.project_root))

    def _save_id_map(self, _allocator, data: dict) -> None:
        ids_mod.save_ids(ids_mod.ids_path(self.project_root), data)

    def _collect_keys(self):
        self._keys: List[Tuple[str, int]] = []
        for host in self._external_hosts():
            self._keys.append((f"level0:{host}", 0))
        for name, rel, _entry in self.containers:
            self._keys.append((f"level1:{rel}", 1))
        for f in self.files:
            self._keys.append((f"level2:{f.rel_path}", 2))
        for f in self.files:
            for symbol in self.analyses[f.rel_path].symbols:
                self._keys.append((f"level3:{f.rel_path}::{symbol.qualified}", 3))

    def _assign_ids(self, allocator: ids_mod.IdAllocator):
        for key, level in sorted(self._keys, key=lambda item: item[0]):
            self.node_id_by_key[key] = allocator.allocate(key, level)

    # -- external hosts --------------------------------------------------- #

    def _external_hosts(self) -> List[str]:
        hosts = set()
        for analysis in self.analyses.values():
            for url in analysis.urls:
                if url.host:
                    hosts.add(url.host)
            for call in analysis.calls:
                if call.host:
                    hosts.add(call.host)
        return sorted(hosts)

    # -- nodes ------------------------------------------------------------ #

    def _build_nodes(self) -> List[dict]:
        nodes: List[dict] = []

        # level 0 externals
        for host in self._external_hosts():
            key = f"level0:{host}"
            evidence: List[dict] = []
            for f in self.files:
                analysis = self.analyses[f.rel_path]
                for url in analysis.urls:
                    if url.host == host:
                        evidence.append(_evidence(f.rel_path, url.line, url.url))
                for call in analysis.calls:
                    if call.host == host and call.url:
                        evidence.append(_evidence(f.rel_path, call.line, call.text))
            node = {
                "id": self.node_id_by_key[key],
                "level": 0,
                "kind": "external",
                "name": host,
                "parent": None,
                "path": host,
                "interface": {"exposes": [], "needs": []},
                "evidence": _sort_evidence(evidence),
            }
            nodes.append(node)
            self.external_id_by_host[host] = node["id"]

        # level 1 containers
        container_nodes: Dict[str, dict] = {}
        for name, rel, entry in self.containers:
            key = f"level1:{rel}"
            node = {
                "id": self.node_id_by_key[key],
                "level": 1,
                "kind": "container",
                "name": name,
                "parent": None,
                "path": rel,
                "interface": {"exposes": [], "needs": []},
                "evidence": [_evidence(entry, 1)],
            }
            container_nodes[name] = node
            nodes.append(node)

        # level 2 components
        for f in self.files:
            key = f"level2:{f.rel_path}"
            container = self.container_of.get(f.rel_path)
            parent = self.node_id_by_key.get(f"level1:{container}") if container else None
            node = {
                "id": self.node_id_by_key[key],
                "level": 2,
                "kind": "component",
                "name": os.path.splitext(os.path.basename(f.rel_path))[0],
                "parent": parent,
                "path": f.rel_path,
                "interface": {"exposes": [], "needs": []},
                "evidence": [_evidence(f.rel_path, 1)],
            }
            self._fill_component_interface(node, self.analyses[f.rel_path])
            nodes.append(node)
            self.component_id_by_file[f.rel_path] = node["id"]
            for route in self.analyses[f.rel_path].routes:
                self.route_decls.append((f.rel_path, route, node["id"]))

        # level 3 artifacts
        for f in self.files:
            analysis = self.analyses[f.rel_path]
            for symbol in analysis.symbols:
                key = f"level3:{f.rel_path}::{symbol.qualified}"
                node = {
                    "id": self.node_id_by_key[key],
                    "level": 3,
                    "kind": symbol.kind,
                    "name": symbol.name,
                    "parent": self.component_id_by_file[f.rel_path],
                    "path": f.rel_path,
                    "interface": {"exposes": [], "needs": []},
                    "evidence": [_evidence(f.rel_path, symbol.line)],
                }
                nodes.append(node)
                self.artifact_id_by_qualified[f"{f.rel_path}::{symbol.qualified}"] = node["id"]

        # aggregate container interfaces from their child components
        for f in self.files:
            container = self.container_of.get(f.rel_path)
            if not container:
                continue
            analysis = self.analyses[f.rel_path]
            child = next(n for n in nodes if n["id"] == self.component_id_by_file[f.rel_path])
            _merge_interface(
                container_nodes[container]["interface"],
                child["interface"]["exposes"],
                child["interface"]["needs"],
            )

        nodes.sort(key=lambda n: (n["level"], n.get("path") or "", n["id"]))
        return nodes

    def _fill_component_interface(self, node: dict, analysis: FileAnalysis) -> None:
        exposes: List[dict] = []
        needs: List[dict] = []

        for route in analysis.routes:
            exposes.append(
                {
                    "name": f"{route.method} {route.path}",
                    "kind": "route",
                    "evidence": [_evidence(analysis.rel_path, route.line)],
                }
            )

        seen_needs = set()
        for call in analysis.calls:
            label = f"{call.method} {call.path}" if call.path else call.method
            key = (label, "route")
            if key in seen_needs:
                continue
            seen_needs.add(key)
            needs.append(
                {
                    "name": label,
                    "kind": "route",
                    "evidence": [_evidence(analysis.rel_path, call.line, call.text)],
                }
            )

        for name, line in analysis.env_vars:
            key = (name, "config")
            if key in seen_needs:
                continue
            seen_needs.add(key)
            needs.append({"name": name, "kind": "config", "evidence": [_evidence(analysis.rel_path, line)]})

        for imp in analysis.imports:
            target = self._resolve_import(analysis.rel_path, imp)
            if target is None:
                continue
            label = os.path.splitext(os.path.basename(target))[0]
            if analysis.language == "html":
                label = imp.module
            key = (label, "import")
            if key in seen_needs:
                continue
            seen_needs.add(key)
            needs.append({"name": label, "kind": "import", "evidence": [_evidence(analysis.rel_path, imp.line)]})

        node["interface"]["exposes"] = _dedup_entries(exposes)
        node["interface"]["needs"] = _dedup_entries(needs)

    def _resolve_import(self, rel_path: str, imp: Import) -> Optional[str]:
        if rel_path.endswith(".py"):
            return self.index.resolve_python(rel_path, imp)
        if rel_path.endswith(".html"):
            base = os.path.normpath(os.path.join(os.path.dirname(rel_path), imp.module)).replace(os.sep, "/")
            if base in self.index.js_files:
                return base
            return None
        if imp.module.startswith("."):
            return self.index.resolve_js(rel_path, imp.module)
        return None

    # -- edges ------------------------------------------------------------ #

    def _build_edges(self) -> List[dict]:
        edges: Dict[Tuple[str, str, str], dict] = {}

        def add_edge(source: str, target: str, kind: str, confidence: float, evidence: dict) -> None:
            if not target:
                return
            key = (source, target, kind)
            if key not in edges:
                edges[key] = {
                    "from": source,
                    "to": target,
                    "kind": kind,
                    "confidence": confidence,
                    "evidence": [],
                }
            edge = edges[key]
            edge["confidence"] = max(edge["confidence"], confidence)
            edge["evidence"].append(evidence)

        # routes, keyed by (method, path)
        route_lookup: Dict[Tuple[str, str], List[Tuple[str, str]]] = {}
        for file, route, component_id in self.route_decls:
            route_lookup.setdefault((route.method.upper(), _normalise_path(route.path)), []).append((component_id, file))

        # imports edges
        for f in self.files:
            analysis = self.analyses[f.rel_path]
            source_id = self.component_id_by_file.get(f.rel_path)
            if not source_id:
                continue
            for imp in analysis.imports:
                target = self._resolve_import(f.rel_path, imp)
                if target is None or target == f.rel_path:
                    continue
                target_id = self.component_id_by_file.get(target)
                if not target_id:
                    continue
                add_edge(source_id, target_id, "imports", 1.0, _evidence(f.rel_path, imp.line, imp.text.strip()))

        # http_call edges
        tied_hosts: set = set()
        for f in self.files:
            analysis = self.analyses[f.rel_path]
            source_id = self.component_id_by_file.get(f.rel_path)
            if not source_id:
                continue
            for call in analysis.calls:
                if not call.is_http:
                    continue
                evidence = _evidence(f.rel_path, call.line, call.text)
                path = _normalise_path(call.path) if call.path else None
                matched = None
                if path:
                    matched = route_lookup.get((call.method.upper(), path))
                    if not matched and call.method.upper() == "GET":
                        matched = route_lookup.get(("GET", path))
                if matched:
                    for component_id, _file in matched:
                        add_edge(source_id, component_id, "http_call", 1.0, evidence)
                elif call.host and call.host in self.external_id_by_host:
                    tied_hosts.add((source_id, call.host))
                    add_edge(source_id, self.external_id_by_host[call.host], "http_call", 0.5, evidence)
                elif path and not call.host:
                    # same-origin call with no matching route: no external to point at
                    continue
            # URL literals that never fed an HTTP call -> a guess
            for url in analysis.urls:
                if url.host in self.external_id_by_host and (source_id, url.host) not in tied_hosts:
                    add_edge(
                        source_id,
                        self.external_id_by_host[url.host],
                        "http_call",
                        0.3,
                        _evidence(f.rel_path, url.line, url.url),
                    )

        # calls edges (project-internal symbols)
        for f in self.files:
            if f.language == "html":
                continue
            analysis = self.analyses[f.rel_path]
            symbols_by_name: Dict[str, Symbol] = {}
            for symbol in analysis.symbols:
                symbols_by_name.setdefault(symbol.name, symbol)
            for callee, line, _text in analysis.all_calls:
                target = self._resolve_call(f.rel_path, callee, symbols_by_name)
                if target is None:
                    continue
                source_symbol = _enclosing_symbol(analysis, line)
                if source_symbol is None:
                    continue
                source_id = self.artifact_id_by_qualified.get(f"{f.rel_path}::{source_symbol.qualified}")
                target_id = self.artifact_id_by_qualified.get(target)
                if not source_id or not target_id or source_id == target_id:
                    continue
                add_edge(source_id, target_id, "calls", 1.0, _evidence(f.rel_path, line, callee))

        result = []
        for key in sorted(edges, key=lambda k: (k[0], k[2], k[1])):
            edge = edges[key]
            edge["evidence"] = _sort_evidence(edge["evidence"])
            result.append(edge)
        return result

    def _resolve_call(self, rel_path: str, callee: str, symbols_by_name: Dict[str, Symbol]) -> Optional[str]:
        if callee in symbols_by_name:
            symbol = symbols_by_name[callee]
            return f"{rel_path}::{symbol.qualified}"
        if "." in callee:
            head, tail = callee.split(".", 1)
            analysis = self.analyses[rel_path]
            for imp in analysis.imports:
                target_file = self._imported_name_to_file(rel_path, imp)
                if target_file is None:
                    continue
                if imp.names and head in imp.names:
                    base_file = target_file
                    target_symbol_name = tail
                elif not imp.names and head == os.path.splitext(os.path.basename(target_file))[0]:
                    base_file = target_file
                    target_symbol_name = tail.split(".")[-1]
                elif not imp.names and imp.module.endswith(head):
                    base_file = target_file
                    target_symbol_name = tail.split(".")[-1]
                else:
                    continue
                target_analysis = self.analyses.get(base_file)
                if target_analysis is None:
                    continue
                for symbol in target_analysis.symbols:
                    if symbol.name == target_symbol_name:
                        return f"{base_file}::{symbol.qualified}"
        return None

    def _imported_name_to_file(self, rel_path: str, imp: Import) -> Optional[str]:
        return self._resolve_import(rel_path, imp)

    # -- preserved sections ----------------------------------------------- #

    def _load_layout(self) -> dict:
        return _read_section(self.project_root, "layout", {})

    def _load_build_log(self) -> list:
        return _read_section(self.project_root, "build", [])

    def _append_build(self, previous: list, nodes: List[dict], edges: List[dict]) -> list:
        log = list(previous) if isinstance(previous, list) else []
        start = max([e.get("n", 0) for e in log if isinstance(e, dict)] + [0])
        events = [
            ("scanned", f"{len(self.files)} files"),
            ("languages", ", ".join(self._stack()) or "none"),
            ("externals", f"{sum(1 for n in nodes if n['level'] == 0)} hosts"),
            ("containers", f"{sum(1 for n in nodes if n['level'] == 1)} containers"),
            ("components", f"{sum(1 for n in nodes if n['level'] == 2)} components"),
            ("artifacts", f"{sum(1 for n in nodes if n['level'] == 3)} artifacts"),
            ("edges", f"{len(edges)} edges"),
            ("written", "syscode.graph.json"),
        ]
        for index, (event, detail) in enumerate(events, start=1):
            log.append({"n": start + index, "event": event, "detail": detail})
        return log


def _read_section(project_root: str, key: str, default):
    path = os.path.join(project_root, "syscode.graph.json")
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return default
    value = data.get(key, default)
    return value if isinstance(value, type(default)) else default


def _enclosing_symbol(analysis: FileAnalysis, line: int) -> Optional[Symbol]:
    best = None
    for symbol in analysis.symbols:
        if symbol.line <= line and (symbol.end_line == 0 or line <= symbol.end_line):
            if best is None or (symbol.line >= best.line and (symbol.end_line - symbol.line) <= (best.end_line - best.line)):
                best = symbol
    return best


def _dedup_entries(entries: List[dict]) -> List[dict]:
    merged: Dict[Tuple[str, str], dict] = {}
    for entry in entries:
        key = (entry["name"], entry["kind"])
        if key not in merged:
            merged[key] = {"name": entry["name"], "kind": entry["kind"], "evidence": []}
        merged[key]["evidence"].extend(entry.get("evidence", []))
    result = []
    for key in sorted(merged):
        entry = merged[key]
        entry["evidence"] = _sort_evidence(entry["evidence"])
        result.append(entry)
    return result


def build_graph(project_root: str) -> dict:
    return GraphBuilder(project_root).build()


def write_graph(project_root: str, graph: dict) -> str:
    path = os.path.join(os.path.abspath(project_root), "syscode.graph.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(graph, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return path
