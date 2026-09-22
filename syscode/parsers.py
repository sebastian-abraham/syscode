"""tree-sitter parsing for Python and JavaScript / TypeScript.

Uses the 0.25 line query API:

    Query(language, source)   -> query
    QueryCursor(query).captures(node) -> dict[capture_name, list[node]]

Extracts: level-3 symbols (functions / classes), backend route declarations,
outbound HTTP calls, environment-variable config, imports and URL literals.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from urllib.parse import urlparse

import tree_sitter_javascript as _tsjs
import tree_sitter_python as _tspy
import tree_sitter_typescript as _tsts
from tree_sitter import Language, Parser, Query, QueryCursor

# --------------------------------------------------------------------------- #
# languages and queries
# --------------------------------------------------------------------------- #

_LANGUAGES: Dict[str, Language] = {}


def _language(name: str) -> Language:
    if name not in _LANGUAGES:
        if name == "python":
            _LANGUAGES[name] = Language(_tspy.language())
        elif name == "javascript":
            _LANGUAGES[name] = Language(_tsjs.language())
        elif name == "typescript":
            _LANGUAGES[name] = Language(_tsts.language_typescript())
        elif name == "tsx":
            _LANGUAGES[name] = Language(_tsts.language_tsx())
        else:  # pragma: no cover - guarded by the scanner
            raise ValueError(f"unsupported language: {name}")
    return _LANGUAGES[name]


_PY_SOURCE = """
(function_definition) @func
(class_definition) @class
(decorator) @decorator
(call) @call
(assignment) @assignment
(import_statement) @import_stmt
(import_from_statement) @import_from
"""

_JS_SOURCE = """
(function_declaration) @func
(class_declaration) @class
(method_definition) @method
(call_expression) @call
(variable_declarator) @var
(import_statement) @import_stmt
"""

_QUERIES: Dict[str, Query] = {}


def _query(language_name: str) -> Query:
    if language_name not in _QUERIES:
        language = _language(language_name)
        source = _PY_SOURCE if language_name == "python" else _JS_SOURCE
        _QUERIES[language_name] = Query(language, source)
    return _QUERIES[language_name]


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #


@dataclass
class Symbol:
    name: str
    qualified: str
    kind: str  # "function" | "class" | "method"
    line: int
    end_line: int = 0


@dataclass
class Route:
    method: str
    path: str
    name: str
    line: int


@dataclass
class Call:
    line: int
    callee: str
    method: str
    url: Optional[str]
    host: Optional[str]
    path: Optional[str]
    text: str
    is_http: bool = False


@dataclass
class Import:
    line: int
    module: str
    level: int
    names: List[str]
    is_from: bool
    text: str


@dataclass
class UrlLiteral:
    url: str
    host: str
    line: int


@dataclass
class FileAnalysis:
    rel_path: str
    language: str
    symbols: List[Symbol] = field(default_factory=list)
    routes: List[Route] = field(default_factory=list)
    calls: List[Call] = field(default_factory=list)
    env_vars: List[tuple] = field(default_factory=list)  # (name, line)
    imports: List[Import] = field(default_factory=list)
    urls: List[UrlLiteral] = field(default_factory=list)
    all_calls: List[tuple] = field(default_factory=list)  # (callee, line, text)
    parse_ok: bool = True


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

_HTTP_METHODS = {"get", "post", "put", "delete", "patch", "head", "options", "request", "open"}
_HTTP_RECEIVERS = {
    "fetch",
    "axios",
    "requests",
    "httpx",
    "http",
    "client",
    "session",
    "aiohttp",
    "urllib",
    "xhr",
    "request",
}
_URL_RE = re.compile(r"https?://[^\s\"'`\)\]\}>]+")
_LOCALHOST_RE = re.compile(r"\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b")
_ENV_RE = re.compile(
    r"""os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]"""
    r"""|os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]"""
)
_PY_ROUTE_RE = re.compile(
    r"@\s*[A-Za-z_][\w\.]*\.(get|post|put|delete|patch|head|options|route)\s*\(",
    re.IGNORECASE,
)
_PY_ROUTE_PATH_RE = re.compile(r"""['"]([^'"]*)['"]""")
_PY_ROUTE_METHODS_RE = re.compile(r"methods\s*=\s*\[([^\]]*)\]")


def _text(source: bytes, node) -> str:
    return source[node.start_byte:node.end_byte].decode("utf-8", "replace")


def _strip_quotes(value: str) -> str:
    value = value.strip()
    for quote in ('"""', "'''", '"', "'", "`"):
        if value.startswith(quote) and value.endswith(quote) and len(value) >= 2 * len(quote):
            return value[len(quote):-len(quote)]
    return value


def _line_of(source: bytes, byte_offset: int) -> int:
    return source[:byte_offset].count(b"\n") + 1


def _qualified(source: bytes, node, container_types) -> str:
    parts: List[str] = []
    current = node
    while current is not None:
        if current.type in container_types:
            name_node = current.child_by_field_name("name")
            if name_node is not None and name_node is not node:
                parts.append(_text(source, name_node))
        current = current.parent
    parts.reverse()
    return ".".join(parts)


def _url_host(url: str) -> Optional[str]:
    parsed = urlparse(url)
    if parsed.netloc:
        return parsed.netloc.lower()
    # A scheme-less "host:port" is not parsable; take the authority manually.
    return None


def _call_path(url: str) -> Optional[str]:
    if url.startswith("/"):
        return url.split("?", 1)[0].split("#", 1)[0]
    parsed = urlparse(url)
    if parsed.netloc:
        return parsed.path or "/"
    return None


# --------------------------------------------------------------------------- #
# Python
# --------------------------------------------------------------------------- #


def _parse_python(source: bytes, rel_path: str) -> FileAnalysis:
    analysis = FileAnalysis(rel_path=rel_path, language="python")
    tree = Parser(_language("python")).parse(source)

    # Variable assignment of a string literal -> lets a call argument be
    # resolved back to the URL it points at.
    assignments: Dict[str, str] = {}
    capture_map: Dict[str, list] = {}
    try:
        all_captures = QueryCursor(_query("python")).captures(tree.root_node)
    except Exception:  # pragma: no cover - defensive
        analysis.parse_ok = False
        return analysis

    for name, nodes in all_captures.items():
        capture_map[name] = list(nodes)

    # decorator spans, so the `app.get(...)` call is not mistaken for a request
    decorator_call_offsets = set()
    for dec in capture_map.get("decorator", []):
        for child in dec.children:
            if child.type == "call":
                decorator_call_offsets.add(child.start_byte)

    # routes
    for dec in capture_map.get("decorator", []):
        text = _text(source, dec)
        match = _PY_ROUTE_RE.match(text)
        if not match:
            continue
        method = match.group(1).upper()
        paths = _PY_ROUTE_PATH_RE.findall(text)
        path = paths[0] if paths else ""
        if method == "ROUTE":
            methods = _PY_ROUTE_METHODS_RE.search(text)
            if methods:
                found = re.findall(r"""['"]([A-Za-z]+)['"]""", methods.group(1))
                method = found[0].upper() if found else "GET"
            else:
                method = "GET"
        line = dec.start_point.row + 1
        # the function this decorator belongs to
        func_name = ""
        parent = dec.parent
        if parent is not None:
            for child in parent.children:
                if child.type in {"function_definition", "class_definition"}:
                    name_node = child.child_by_field_name("name")
                    if name_node is not None:
                        func_name = _text(source, name_node)
                    break
        analysis.routes.append(Route(method=method, path=path, name=func_name, line=line))

    # symbols
    for node, kind in [(n, "function") for n in capture_map.get("func", [])] + [
        (n, "class") for n in capture_map.get("class", [])
    ]:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            continue
        name = _text(source, name_node)
        qualified = _qualified(source, node, {"function_definition", "class_definition"}) or name
        analysis.symbols.append(
            Symbol(
                name=name,
                qualified=qualified,
                kind=kind,
                line=node.start_point.row + 1,
                end_line=node.end_point.row + 1,
            )
        )

    # assignments used for URL resolution
    for node in capture_map.get("assignment", []):
        left = node.child_by_field_name("left")
        right = node.child_by_field_name("right")
        if left is None or right is None or right.type != "string":
            continue
        assignments[_text(source, left)] = _strip_quotes(_text(source, right))

    # calls
    for node in capture_map.get("call", []):
        if node.start_byte in decorator_call_offsets:
            continue
        fn = node.child_by_field_name("function")
        if fn is None:
            continue
        callee = _text(source, fn)
        args = node.child_by_field_name("arguments")
        named_args = list(args.named_children) if args is not None else []
        line = node.start_point.row + 1
        analysis.all_calls.append((callee, line, _call_text(source, callee, named_args)))
        call = _make_call(source, callee, named_args, line, assignments)
        if call is not None:
            analysis.calls.append(call)

    # env vars
    decoded = source.decode("utf-8", "replace")
    for match in _ENV_RE.finditer(decoded):
        name = match.group(1) or match.group(2)
        analysis.env_vars.append((name, _line_of(source, match.start())))

    # imports
    for node in capture_map.get("import_stmt", []):
        text = _text(source, node)
        analysis.imports.append(_parse_python_import(text, node.start_point.row + 1, is_from=False))
    for node in capture_map.get("import_from", []):
        text = _text(source, node)
        analysis.imports.append(_parse_python_import(text, node.start_point.row + 1, is_from=True))

    _collect_urls(source, analysis)
    analysis.symbols.sort(key=lambda s: (s.line, s.qualified))
    analysis.routes.sort(key=lambda r: (r.line, r.method, r.path))
    analysis.calls.sort(key=lambda c: (c.line, c.callee))
    analysis.imports.sort(key=lambda i: (i.line, i.module))
    return analysis


def _parse_python_import(text: str, line: int, is_from: bool) -> Import:
    if is_from:
        match = re.match(r"from\s+(\.*)([\w\.]*)\s+import\s+(.*)", text, re.DOTALL)
        if match:
            dots, module, names_part = match.groups()
            names = [n.strip() for n in names_part.replace("(", "").split(",") if n.strip()]
            clean_names = []
            for name in names:
                clean_names.append(name.split(" as ")[0].strip())
            return Import(line=line, module=module, level=len(dots), names=clean_names, is_from=True, text=text)
        return Import(line=line, module="", level=0, names=[], is_from=True, text=text)
    module = text.replace("import", "", 1)
    module = module.split(",")[0].strip().split(" as ")[0].strip()
    return Import(line=line, module=module, level=0, names=[], is_from=False, text=text)


# --------------------------------------------------------------------------- #
# JavaScript / TypeScript
# --------------------------------------------------------------------------- #


def _parse_js(source: bytes, rel_path: str, language: str) -> FileAnalysis:
    analysis = FileAnalysis(rel_path=rel_path, language=language)
    tree = Parser(_language(language)).parse(source)
    try:
        all_captures = QueryCursor(_query(language)).captures(tree.root_node)
    except Exception:  # pragma: no cover - defensive
        analysis.parse_ok = False
        return analysis

    assignments: Dict[str, str] = {}
    for node in all_captures.get("var", []):
        name_node = node.child_by_field_name("name")
        value_node = node.child_by_field_name("value")
        if name_node is None or value_node is None or value_node.type != "string":
            continue
        assignments[_text(source, name_node)] = _strip_quotes(_text(source, value_node))

    for node, kind in [(n, "function") for n in all_captures.get("func", [])] + [
        (n, "class") for n in all_captures.get("class", [])
    ] + [(n, "method") for n in all_captures.get("method", [])]:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            continue
        name = _text(source, name_node)
        qualified = _qualified(
            source,
            node,
            {"function_declaration", "class_declaration", "method_definition"},
        ) or name
        analysis.symbols.append(
            Symbol(
                name=name,
                qualified=qualified,
                kind=kind,
                line=node.start_point.row + 1,
                end_line=node.end_point.row + 1,
            )
        )

    for node in all_captures.get("call", []):
        fn = node.child_by_field_name("function")
        if fn is None:
            continue
        callee = _text(source, fn)
        args = node.child_by_field_name("arguments")
        named_args = list(args.named_children) if args is not None else []
        line = node.start_point.row + 1
        analysis.all_calls.append((callee, line, _call_text(source, callee, named_args)))
        call = _make_call(source, callee, named_args, line, assignments)
        if call is not None:
            analysis.calls.append(call)

    for node in all_captures.get("import_stmt", []):
        text = _text(source, node)
        match = re.search(r"""from\s+['"]([^'"]+)['"]""", text)
        if match:
            analysis.imports.append(
                Import(line=node.start_point.row + 1, module=match.group(1), level=0, names=[], is_from=True, text=text)
            )

    decoded = source.decode("utf-8", "replace")
    for match in re.finditer(r"""require\(\s*['"]([^'"]+)['"]\s*\)""", decoded):
        analysis.imports.append(
            Import(line=_line_of(source, match.start()), module=match.group(1), level=0, names=[], is_from=False, text=match.group(0))
        )

    _collect_urls(source, analysis)
    analysis.symbols.sort(key=lambda s: (s.line, s.qualified))
    analysis.calls.sort(key=lambda c: (c.line, c.callee))
    analysis.imports.sort(key=lambda i: (i.line, i.module))
    return analysis


# --------------------------------------------------------------------------- #
# shared call classification
# --------------------------------------------------------------------------- #


def _make_call(source: bytes, callee: str, named_args, line: int, assignments: Dict[str, str]) -> Optional[Call]:
    text = ""
    parts = callee.split(".")
    receiver = parts[0] if len(parts) > 1 else ""
    last = parts[-1]

    is_fetch = callee == "fetch"
    is_xhr_open = last == "open" and receiver.lower() in {"xhr", "request"} or (
        last == "open" and "xmlhttprequest" in callee.lower()
    )
    is_http = is_fetch or is_xhr_open or (
        len(parts) > 1 and receiver.lower() in _HTTP_RECEIVERS and last.lower() in _HTTP_METHODS
    )
    if not is_http:
        return None

    method = "GET"
    url: Optional[str] = None

    if is_xhr_open:
        # xhr.open("POST", "/api/x")
        if len(named_args) >= 1 and named_args[0].type == "string":
            method = _strip_quotes(_text(source, named_args[0])).upper()
        if len(named_args) >= 2:
            url = _arg_value(source, named_args[1], assignments)
    elif is_fetch:
        if named_args:
            url = _arg_value(source, named_args[0], assignments)
        if len(named_args) >= 2:
            option_text = _text(source, named_args[1])
            match = re.search(r"""method\s*:\s*['"]([A-Za-z]+)['"]""", option_text)
            if match:
                method = match.group(1).upper()
    else:
        method = last.upper()
        if named_args:
            url = _arg_value(source, named_args[0], assignments)

    host = _url_host(url) if url and url.startswith(("http://", "https://")) else None
    if url and not host:
        localhost_match = _LOCALHOST_RE.fullmatch(url.rstrip("/"))
        if localhost_match:
            host = localhost_match.group(0).lower()
    path = _call_path(url) if url else None
    if url and host and not url.startswith("http"):
        # scheme-less host:port form -> keep the path after the first slash
        rest = url
        for candidate in (host,):
            if rest.startswith(candidate):
                rest = rest[len(candidate):]
                break
        path = rest or "/"
    return Call(
        line=line,
        callee=callee,
        method=method,
        url=url,
        host=host,
        path=path,
        text=_call_text(source, callee, named_args),
        is_http=True,
    )


def _arg_value(source: bytes, node, assignments: Dict[str, str]) -> Optional[str]:
    if node.type == "string":
        return _strip_quotes(_text(source, node))
    if node.type in {"identifier", "shorthand_property_identifier"}:
        return assignments.get(_text(source, node))
    return None


def _call_text(source: bytes, callee: str, named_args) -> str:
    if named_args:
        first = _text(source, named_args[0])
        if len(first) > 80:
            first = first[:77] + "..."
        return f"{callee}({first})"
    return f"{callee}()"


def _collect_urls(source: bytes, analysis: FileAnalysis) -> None:
    decoded = source.decode("utf-8", "replace")
    seen = set()
    for match in _URL_RE.finditer(decoded):
        url = match.group(0).rstrip(".,;:")
        if url in seen:
            continue
        seen.add(url)
        host = _url_host(url)
        if host:
            analysis.urls.append(UrlLiteral(url=url, host=host, line=_line_of(source, match.start())))
    for match in _LOCALHOST_RE.finditer(decoded):
        url = match.group(0)
        if url in seen:
            continue
        seen.add(url)
        analysis.urls.append(UrlLiteral(url=url, host=url.lower(), line=_line_of(source, match.start())))
    analysis.urls.sort(key=lambda u: (u.line, u.host))


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #


def parse_source(rel_path: str, abs_path: str, language: str) -> FileAnalysis:
    if language == "html":
        return _parse_html(rel_path, abs_path)
    with open(abs_path, "rb") as fh:
        source = fh.read()
    if language == "python":
        return _parse_python(source, rel_path)
    return _parse_js(source, rel_path, language)


def _parse_html(rel_path: str, abs_path: str) -> FileAnalysis:
    analysis = FileAnalysis(rel_path=rel_path, language="html")
    with open(abs_path, "rb") as fh:
        source = fh.read()
    decoded = source.decode("utf-8", "replace")
    _collect_urls(source, analysis)
    # local asset references become "import"-kind needs
    for match in re.finditer(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", decoded):
        target = match.group(1)
        if target.startswith(("http://", "https://", "//", "data:")):
            continue
        analysis.imports.append(
            Import(line=_line_of(source, match.start()), module=target, level=0, names=[], is_from=False, text=match.group(0))
        )
    analysis.imports.sort(key=lambda i: (i.line, i.module))
    return analysis
