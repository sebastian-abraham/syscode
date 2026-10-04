# SysCode

An agentic dev tool built around a **living design map**.

An AI agent writes the code; a zoomable map of the system — not a file tree, not a call
graph — keeps the developer in control of the architecture and in understanding of what is
being built. The map is a *communication space*: the agent's way of explaining "here is what
this system is, how its parts relate, and why it is shaped this way", at whatever level of
detail you care about right now.

The product brief is the spec: [`product-brief.md`](product-brief.md).

---

## What exists today (v0.1)

Working, verified, and meant to be built on:

| Piece | State |
|---|---|
| **Deterministic analysis** — TS/JS via the TypeScript parser, Python via an indentation parser. Files, imports (resolved, not guessed), exports, symbols with line ranges, entry points, external services actually imported. | done |
| **The map model** — persistent nodes with stable identity, plain-language summaries, anchors back to real code, provenance (`verified` / `inferred` / `user` / `planned`), stale flags, pinned notes and constraints. | done |
| **Reconcile, not regenerate** — a refresh diffs the map against the code and produces *changes*: re-anchor, rename, move, remove. Meaning changes go into a proposal for approval; user edits are never overwritten. | done |
| **The mapper** (heuristic brain) — groups the repo into a handful of meaningful areas, descending past container directories, and explains each one from the facts. No model required. | done |
| **Scoped context + memory** — what the agent gets for a node: its explanation, the anchored code, relationships, notes, constraints and project memory, inside a token budget with visible truncation. | done |
| **The agent** — model-agnostic (OpenCode Go, OpenAI-compatible, Anthropic, Ollama). With a model connected it answers from scoped context, proposes structured changes, **names and explains the map**, and **writes the project's memory**. With none connected the deterministic mapper and a rule-based agent take over, and the interface says so. | done |
| **Project memory** — a mapping pass that reads the facts, the map and the project's README and writes a short brief the agent reuses: what this is, the stack, the layout, conventions and gotchas, entry points. Labelled `model` or `facts` so you always know which. | done |
| **Refinement** — the model re-names and re-explains nodes from the facts behind them, and reports what it thinks of the grouping. Arrives as a proposal; the map changes only when you accept it. | done |
| **The interface** — start screen (recent projects, open a folder, create a project), React canvas with semantic zoom, inspector with anchors and code peek, the "what the agent sees" context panel, approval cards, stale markers, honest provenance badges. | done |
| **Desktop shell** — Tauri v2 wrapper that starts the local engine and points the webview at it. | scaffold + build |
| **Agent writes code** | not yet — the agent proposes design changes and explains the system; it does not yet edit files |

### Where the model actually sits

The map is a **harness for a model**, not a diagram generator. The deterministic analysis and
the mapper exist for two reasons: to give the model facts it cannot hallucinate, and to keep the
tool useful when no model is configured. The model owns the meaning — naming, grouping,
explanation, memory — and the facts keep it honest. That split is the product: a model that is
powerful enough to not care about the code itself still needs to be told what is really there,
and a developer still needs to see the system at the level they care about.

## Quickstart

Requires **Node ≥ 22.5** (the engine runs TypeScript directly — no build step) and npm.

```bash
npm install                 # this repo pins include=dev; see .npmrc
```

Map a project and look at it from the terminal:

```bash
npm run map   -- fixtures/demo-app     # build/update the map, report what changed
npm run serve -- fixtures/demo-app     # engine + interface on http://127.0.0.1:4317
```

The map is stored per project in `<project>/.syscode/syscode.db` (SQLite). Nothing is written
into your source tree except that directory.

### Terminal-only tour (no UI needed)

```bash
node packages/core/src/cli.ts analyze fixtures/demo-app      # deterministic facts
node packages/core/src/cli.ts show    fixtures/demo-app      # the map as an explained tree
node packages/core/src/cli.ts show    fixtures/demo-app --all
node packages/core/src/cli.ts context fixtures/demo-app --find Orders
node packages/core/src/cli.ts ask     fixtures/demo-app "what depends on Persistence?"
node packages/core/src/cli.ts ask     fixtures/demo-app "add a node for exporting orders to CSV"

# with a model configured
node packages/core/src/cli.ts probe   fixtures/demo-app      # does it actually answer?
node packages/core/src/cli.ts memory  fixtures/demo-app      # the mapping pass, printed
node packages/core/src/cli.ts refine  fixtures/demo-app      # let the model name the map
node packages/core/src/cli.ts refine  fixtures/demo-app --apply
node packages/core/src/cli.ts workspace                      # projects opened before
```

### Interface

```bash
npm run web            # Vite dev server on :5173, proxying /api to the engine
npm run build:web      # or build it once; the engine then serves it at :4317
```

### Desktop

```bash
npm run cargo:build -w @syscode/desktop        # cargo build --release, no bundling
npx tauri build -w @syscode/desktop            # full bundle (deb/AppImage), needs @tauri-apps/cli
SYSCODE_PROJECT=/path/to/project ./apps/desktop/src-tauri/target/release/syscode-desktop
```

### Connecting a model

This is the point of the tool — the map is how the model explains itself to you. The provider
layer is model-agnostic; **OpenCode Go** is first-class:

```bash
# OpenCode Go (opencode.ai/zen/go). The key is read from OPENCODE_GO_API_KEY, or from
# ~/.hermes/.env on a machine that already runs Hermes.
SYSCODE_PROVIDER=opencode-go SYSCODE_MODEL=deepseek-v4.1-flash npm run serve -- fixtures/demo-app

# any OpenAI-compatible endpoint
SYSCODE_PROVIDER=openai-compatible SYSCODE_BASE_URL=https://api.groq.com/openai/v1 \
SYSCODE_API_KEY=... SYSCODE_MODEL=llama-3.3-70b-versatile npm run serve -- fixtures/demo-app
```

Or set it in the app (start screen → Connect a model, or the header). Whatever you configure,
the interface can **test it** (`POST /api/config/probe`) and list what the provider can actually
serve (`GET /api/config/models`), so "connected" is never a claim without evidence.

Once connected, three things change: the agent answers with real reasoning instead of the rule
brain, **Refine** lets it rename and re-explain the map from the facts, and **Build project
memory** gives it a written understanding of the project it keeps between sessions. Keys live in
`<project>/.syscode/config.json` or the environment — never in the repo.

## Verification

Two scripted suites drive the real HTTP API and assert the product rules from the brief:

```bash
npm run serve -- fixtures/demo-app &        # port 4317
./scripts/smoke.sh                          # 28 checks: read, write, agent, approval, delete
./scripts/stability.sh                      # 13 checks: stale detection, identity, protected edits
```

`stability.sh` is the interesting one. It renames a node and pins it, appends a function to
`src/orders/create-order.ts`, refreshes, and then asserts that:

- the node is marked **stale** rather than silently lying,
- the refresh produced a **proposal** instead of regenerating the map,
- the developer's **name, position, and pinned constraint survived**,
- the node count did not collapse (identity held),
- approving the proposal **clears the stale flag and re-anchors** the node to the new code.

## Layout

```
packages/core/src/
  analyze/     scan, TypeScript parser, Python parser, facts           (the honesty layer)
  map/         heuristic mapper, identity + reconcile, the map service  (the map)
  store/       SQLite: nodes, edges, notes, proposals, journal, chat, file index
  memory/      scoped context builder (what the agent is given)
  llm/         provider abstraction + the agent's two brains
  server/      HTTP + SSE API consumed by every interface
  cli.ts       map / show / analyze / context / ask / serve
apps/web/      React canvas, inspector, chat, approval flow
apps/desktop/  Tauri shell
fixtures/      demo-app (TypeScript shopkit) and legacy-py — real code to map
scripts/       smoke.sh, stability.sh
docs/          CONTRACT.md (interface contract), ARCHITECTURE.md
```

## Rules this codebase is held to

1. **Never a file tree.** Nodes are meaningful units; the top level is a handful of areas, not a directory listing.
2. **Semantic zoom.** Drilling into a node shows what is *inside* it conceptually.
3. **Stability over freshness.** Updates are diffs to an existing map. A node that was "Checkout" yesterday is the same node today.
4. **The developer's work is protected.** Names, positions, notes and constraints survive refreshes; the agent may only re-word what it owns.
5. **Honest grounding.** Every node links to real code where code exists, and verified links are distinguishable from inferred ones.
6. **No hidden context.** The interface can show exactly what the agent was given.

## Next

- The agent actually editing files (the loop from proposal → code → map update).
- Map memory written back as the project is used (decisions captured as a byproduct).
- Grouping and naming refined by a model, with the deterministic map as the fallback.
- Evaluation: can someone who did not write the code change it faster with this than without it?
