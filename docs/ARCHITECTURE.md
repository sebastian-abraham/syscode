# Architecture

The brief asks for a **core engine** (analysis, memory, map, agent) separated from the
**interface**, so other surfaces can be added later. That separation is literal here: the
engine is a process with an HTTP + SSE API, and every surface is a client of it.

```
             ┌──────────────────────────────────────────┐
  React  ────┤                                          │
  canvas     │            packages/core                 │
             │                                          │
  Tauri  ────┤  analyze → map → store → memory → agent   │──→ .syscode/syscode.db
  shell      │                                          │
             │            HTTP + SSE on :4317           │
  CLI    ────┤                                          │
             └──────────────────────────────────────────┘
```

## The pipeline

**1. Facts (deterministic).** `analyze/` walks the repo and produces `RepoFacts`: files with
content hashes, imports that are *resolved* to real paths (not guessed), exported symbols with
line ranges, entry points, and the external packages actually imported, classified into
runtime / framework / service. TypeScript and JavaScript go through the TypeScript compiler's
parser; Python through an indentation-based parser; anything else is counted but not claimed.

Facts are the only thing that touches the filesystem. Everything above works on them, which is
why the engine can be tested without a repo and why the map can be diffed.

**2. The map (meaning).** `map/heuristic.ts` turns facts into proposed nodes. The important part
is what it refuses to do: it does not emit one node per file or per directory. It descends
through *container* directories (`src`, `packages/core`, `web/src`) until it finds directories
that actually hold files, and stops when the result is a handful of pieces — merging the
smallest into their closest neighbour by import affinity when there are too many. Each node gets
a plain-language summary assembled from real facts: its role, what it exposes, who imports it,
what it depends on, and its size. Files with no directory structure between them are clustered
by name stem and import affinity, so a flat repo still produces a meaningful map.

This is the **heuristic brain**. It runs with no model, and every node it produces is labelled
`heuristic: true` so the interface can say so.

**3. Identity and reconcile (stability).** `map/identity.ts` is where the brief's hardest
constraint lives. On every rebuild, each proposed node is matched against the existing map —
first by identity key, then by content overlap (Jaccard over covered files, ≥ 0.4 counts as
"the same node that moved"). Matched nodes keep their id, their position, their name if the
developer set one, and their notes. Unmatched proposed nodes are *additions*; unmatched existing
nodes are *removals* — but only if the engine owns them. Anything with origin `user` or
`planned` is never touched.

Then it decides what kind of change this is:

- **metadata** (anchors, metrics, explanation) → applied, because the map must track reality;
- **meaning** (add / remove / rename / move) → batched into a `Proposal`, which the developer
  approves or rejects. Nothing structural happens behind their back.

Stale detection is a hash comparison: if a file under a node changed since the map last agreed
with it, the node is flagged and a proposal is raised to re-anchor it and re-word its summary.

**4. Memory and context.** `memory/context.ts` builds the scoped context for a node: its
explanation, its children, the actual code behind its anchors (with line ranges), its
relationships, its notes and constraints, and project memory. Items are ranked by value
(constraints first, then notes, code, structure, memory) and trimmed to a token budget, with
every truncation flagged. The interface renders this bundle verbatim — that is the transparency
requirement.

**5. The agent.** `llm/agent.ts` has two brains behind one interface:

- **rules** (no model): answers from the map — reverse-reachability for "what breaks if I change
  this", node explanations, file lookup — and turns "add a node for X" / "connect A to B" /
  "rename X to Y" into proposals. It says plainly what it cannot do.
- **model**: hands the scoped context and a compact node directory to the configured provider,
  streams the answer, and extracts a structured `{title, rationale, ops[]}` plan from the tail of
  the reply. The ops become a proposal, never a mutation.

Both paths emit the same SSE event stream, and both emit the context they used first.

## Storage

One SQLite file per project at `<project>/.syscode/syscode.db` via `node:sqlite` (no native
build): `nodes`, `edges`, `notes`, `proposals`, `journal`, `chat`, `files` (the index used for
stale detection) and `meta`. `files` is replaced on each scan; everything else is diffed.

## Decisions worth knowing

- **No build step for the engine.** Node ≥ 22.5 runs the TypeScript directly, so `node
  packages/core/src/cli.ts serve .` is the whole toolchain. Types are checked separately with
  `tsc --noEmit` (`npm run typecheck`).
- **HTTP + SSE, not an embedded library.** It costs a port and buys swappable surfaces: the
  React app, the Tauri shell and the CLI all speak the same API, and the API is testable with
  curl (see `scripts/`).
- **Layout is computed by the engine, not the canvas.** A deterministic layered layout ships in
  the proposed map, so the map looks the same on every surface and a developer's drag is an
  override rather than a prerequisite.
- **Heuristic is a first-class mode, not a fallback.** The product must be honest about what it
  knows; a map built without a model is labelled as such everywhere it appears.
