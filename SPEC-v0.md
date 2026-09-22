# SysCode v0 — build spec

Status: agreed scope for the first working version. Nothing here is final; it exists so the
first build is one concrete thing instead of a hundred open questions.

## What v0 is

One command that reads a project folder and writes a graph file. One command that opens a web
page showing that graph. Click a block → it expands into what's inside → keep clicking until
you are looking at individual functions.

```
syscode map <path>      # read the project, write syscode.graph.json
syscode serve <path>    # open the graph in the browser
```

## The four levels

Fixed. The tool never invents levels. Levels 0-2 match C4 (Context / Container / Component);
level 3 is what C4 lacks and what makes two-way sync possible later.

| Level | Name | What it is | How v0 finds it |
|---|---|---|---|
| 0 | External | Things outside the project that the code talks to | URLs and hosts found in code (`api.openweathermap.org`, `localhost:8000`) |
| 1 | Container | A runnable piece: the backend, the frontend | Top-level folders that contain a recognisable entry point (`main.py`, `app.py`, `app.js`, `package.json`, `index.html`, `routes/`) |
| 2 | Component | One module / file inside a container | Every source file under a container |
| 3 | Code artifact | A function or class inside a file | Symbols parsed out of the file, with real line numbers |

Containment is stored as a `parent` field on each node, **not** as edges. Containment edges
would make every view query filter out half its own data.

## Nodes

```json
{
  "id": "COMP-001",
  "level": 2,
  "kind": "component",
  "name": "orders",
  "parent": "CONT-001",
  "path": "app/orders.py",
  "interface": {
    "exposes": [{"name": "GET /orders", "kind": "route", "evidence": [{"file": "app/orders.py", "line": 12}]}],
    "needs":   [{"name": "DB_URL", "kind": "config", "evidence": []}]
  },
  "evidence": [{"file": "app/orders.py", "line": 1}]
}
```

`interface` is what gets shown when the node is collapsed. It is the only thing the collapsed
view renders, so it must stay small and readable — max 3 entries each side in the picture, the
rest in the detail panel.

## Stable IDs (non-negotiable)

An ID must survive the file moving, the function being renamed, and the tool being re-run.
v0 rule:

- `syscode.ids.json` maps a natural key → a fixed ID, e.g.
  `"level2:app/orders.py" → "COMP-001"`, `"level3:app/orders.py::create_order" → "CODE-014"`.
- On every run: existing key → keep its ID. New key → next free number for that prefix.
- Numbers are **never reused**. An ID that disappears stays reserved forever.
- Re-running on an unchanged project must produce an identical file except for the `build` log.

Prefixes: `EXT-` (level 0), `CONT-` (level 1), `COMP-` (level 2), `CODE-` (level 3).

## Edges

Only interaction, never containment.

```json
{"from": "COMP-004", "to": "EXT-001", "kind": "http_call",
 "confidence": 1.0, "evidence": [{"file": "web/app.js", "line": 9, "text": "fetch('/api/weather')"}]}
```

Kinds: `http_call`, `imports`, `uses_db`, `calls`.

**Confidence and evidence are required on every edge.** They are the difference between a
picture you can trust and a picture that looks fine and lies. Rules:

- `1.0` — the call site and the route declaration were matched on method AND path
  (`fetch('/api/weather', {method:'POST'})` matches `@app.post("/api/weather")`).
- `0.5` — only the host matched, path unknown or built dynamically.
- `0.3` — guessed from a string that looks like a URL.

## The one feature that matters most

Whether a frontend block and a backend block are joined by an edge. That edge is not written
anywhere in the code — it has to be inferred. v0 infers it like this:

1. Backend: collect route declarations (`@app.get("/x")`, `@router.post("/y")`,
   `@app.route("/z")`) as `exposes` entries on their component, with file and line.
2. Frontend: collect outbound calls (`fetch(...)`, `axios.get(...)`, `axios.post(...)`,
   `XMLHttpRequest.open(...)`, `requests.get(...)`, `httpx.post(...)`) as `needs` entries plus
   an edge to an External node for the host.
3. If a frontend call's path matches a backend route's path → a direct component-to-component
   edge at confidence 1.0. Otherwise the edge points at the External node at 0.5.

If a demo shows two blocks connected, this is the code that did it. If it shows nothing, this
is where to look.

## The graph file

`syscode.graph.json`, written into the mapped project's root, next to `syscode.ids.json`.

```json
{
  "version": 1,
  "project": {"name": "demo-webapp", "root": ".", "stack": ["python", "javascript"]},
  "nodes": [],
  "edges": [],
  "layout": {},
  "build": []
}
```

Two halves that must never mix:

- **nodes + edges** — owned by the tool. Rewritten from scratch on every `map`.
- **layout** — owned by the human. `{"COMP-001": {"x": 120, "y": 300, "collapsed": true}}`.
  The tool never writes it, the viewer only appends to it. So dragging a box around is not a
  change to the graph, and re-mapping the project does not move anything you placed.

`build` is the append-only log of what the mapping did, in order
(`{"n": 1, "event": "scanned", "detail": "14 files"}`). It gives the page something to animate
later, and it makes a run reproducible and debuggable.

## The page

No TypeScript, no build step: one HTML file plus Cytoscape.js from a CDN, served by
`syscode serve` on `http://127.0.0.1:8765`.

- Opening the page shows **only the level-1 containers and the level-0 externals**, with edges
  between them. That is the "fully zoomed out" view.
- **Click a block → it expands**: its children appear, inside a dashed boundary box showing the
  parent's name. Click again to collapse.
- A collapsed block shows its name and its interface, capped at 3 lines per side
  (`GET /orders`, `needs DB_URL`) plus `+2 more`.
- Click a block → side panel with: full path, the `file:line` evidence behind each interface
  entry, and the edges attached to it.
- Positions are saved to `layout` automatically (debounced) so reopening keeps your arrangement.
- The interface entries are colour-coded by kind (route / config / table / import) so the eye
  can tell them apart without reading them.

## Stack

- Python 3.13 (or 3.14 — both verified working), managed with `uv`. No global installs.
- `tree-sitter` + `tree-sitter-python`, `tree-sitter-javascript`, `tree-sitter-typescript`.
  Prebuilt wheels, no compiling. Query API in the 0.25 line is:
  `QueryCursor(Query(language, "...")).captures(node)` → `dict[capture_name, list[node]]`.
- `fastapi` + `uvicorn` for the tiny local server.
- `pathspec` for `.gitignore` handling; skip `node_modules`, `.venv`, `__pycache__`, `dist`,
  `build`, `.git`.

## Out of scope for v0 (do not build)

Editing the design and generating code. Git sync. The LLM. Memory notes. Watch mode. Lazy
loading. More languages than Python and JavaScript. Anything that writes to the mapped
project except `syscode.graph.json` and `syscode.ids.json`.

## Definition of done

On a small demo project that has a Python backend and a JavaScript frontend calling an external
API, `syscode map` writes a graph that, checked by hand against the source:

1. has the frontend and backend as two level-1 containers, plus one external node per outside
   host actually used;
2. has every source file as a level-2 component with the right parent;
3. has the real functions/classes of at least the backend file as level-3 artifacts with
   correct line numbers;
4. has an edge from the frontend component to the backend component for a route that genuinely
   exists, with the correct file and line as evidence;
5. has an edge from the backend to the external API host;
6. produces byte-identical output on a second run with no source changes (apart from `build`);
7. `syscode serve` renders it, expands a container on click, and keeps positions after reload.
