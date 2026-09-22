# SysCode v0

One command reads a project folder and writes a graph file. One command opens a web page
showing that graph. Click a block and it expands into what is inside it, all the way down to
individual functions and classes.

The graph has four fixed levels:

| Level | Name | What it is |
|---|---|---|
| 0 | External | Hosts outside the project that the code talks to |
| 1 | Container | Top-level folders with a recognisable entry point |
| 2 | Component | One source file inside a container |
| 3 | Code artifact | A function or class inside a file, with its real line number |

Containment is stored as a `parent` field on nodes, never as an edge. Edges are interaction
only (`http_call`, `imports`, `calls`) and every edge carries `evidence` and a `confidence`
value. The headline feature is the inferred frontend-to-backend edge: a `fetch`/`axios` call
whose path matches a backend route becomes a component-to-component `http_call` at confidence
`1.0`.

## Install

Requires [uv](https://docs.astral.sh/uv/). No global installs.

```sh
uv sync
```

## Map a project

```sh
uv run syscode map fixtures/demo-webapp
```

This writes two files **into the mapped project's root** (never into this tool's repo):

- `syscode.graph.json` — `nodes`, `edges`, `layout` and the append-only `build` log.
  `nodes`/`edges` are rewritten on every run; `layout` is owned by the viewer and preserved.
- `syscode.ids.json` — the stable natural-key → ID map. Existing keys keep their ID; new keys
  take the next free number. Numbers are never reused.

Re-running on an unchanged project produces an identical graph apart from the `build` log.

## View a project

```sh
uv run syscode serve fixtures/demo-webapp
```

Then open <http://127.0.0.1:8765>. The page is a single self-contained HTML file that loads
Cytoscape.js from a CDN — no build step, no framework, no TypeScript.

- On load it shows only level-1 containers and level-0 externals, with edges between them.
- Click a block to expand its children inside a dashed boundary box showing the parent's name;
  click again to collapse.
- A collapsed block shows its name plus up to three interface entries per side and `+N more`.
- Clicking a block opens a side panel with its full path, the `file:line` evidence behind each
  interface entry, and the edges attached to it.
- Interface entries are colour-coded by kind (route / config / table / import).
- Positions and expanded state are saved to the `layout` section through a debounced
  `POST /api/layout`, so reopening keeps your arrangement.

### Server endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the viewer page |
| `GET` | `/api/graph` | the graph JSON |
| `POST` | `/api/layout` | merge positions into the `layout` section only |

## Development

```sh
uv run python -c "import syscode"   # sanity import
uv build                            # build the wheel
```
