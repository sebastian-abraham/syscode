# SysCode interface contract (v0.1)

The core engine is `packages/core` (TypeScript, run directly by Node ≥ 22.5 — no build step).
Every interface talks to it over **HTTP + SSE** on a local port, because that keeps the canvas
swappable for a Tauri shell or an editor extension later.

Types for every payload are in `packages/core/src/types.ts` — import them, don't redefine them:

```ts
import type { MapView, MapNode, MapEdge, Proposal, ProjectInfo, ScopedContext, ChatEvent, RefreshReport } from '../../packages/core/src/types.ts';
```

## HTTP API

`GET /api/project` → `ProjectInfo`
`GET /api/map?parent=<nodeId|root>` → `MapView` — siblings of `parent` (default: level 0), their edges, breadcrumb.
`GET /api/node/:id` → `MapNode` (with `anchors`, `notes`, `childCount`)
`GET /api/node/:id/context` → `ScopedContext` — exactly what the agent would be given for that node.
`GET /api/node/:id/code?anchor=<idx>` → `{ path, start, end, text, highlight }` — file slice for the code peek.
`GET /api/node/:id/descendants` → `{ nodes: MapNode[]; edges: MapEdge[] }` — every level under a node, for the "whole subtree" view.
`POST /api/node` `{ label, summary, parentId, kind?, position? }` → `MapNode` (user-authored node)
`PATCH /api/node/:id` `{ label?, summary?, detail?, position?, kind?, positionLocked?, labelLocked? }` → `MapNode`
`DELETE /api/node/:id` → `{ ok: true }`
`POST /api/edge` `{ source, target, label, kind? }` → `MapEdge`
`PATCH /api/edge/:id` `{ label?, kind? }` → `MapEdge`
`DELETE /api/edge/:id` → `{ ok: true }`
`POST /api/node/:id/note` `{ body, kind }` → `Note`
`DELETE /api/node/:id/note/:noteId` → `{ ok: true }`
`POST /api/refresh` → `RefreshReport` — re-analyze the repo, diff against the map, create proposals for anything meaning-changing. Never clobbers user edits.
`GET /api/proposals` → `Proposal[]`
`POST /api/proposals/:id/approve` → `{ proposal: Proposal; view: MapView }`
`POST /api/proposals/:id/reject` → `Proposal`
`POST /api/chat` `{ message, nodeId? }` → **SSE stream** of `ChatEvent` (`token` / `context` / `proposal` / `notice` / `done`)
`GET /api/chat/history` → `ChatMessage[]`
`GET /api/journal?limit=50` → `JournalEntry[]`
`GET /api/config` / `PATCH /api/config` → `SyscodeConfig` — provider/model settings (key is write-only, never echoed)
`GET /api/config/models` → `{ brain, models: ModelChoice[] }` — what the provider can actually serve; `supported:false` means this client cannot speak that model's endpoint shape
`POST /api/config/probe` → `{ ok, detail }` — make the provider answer, so "connected" is never claimed without evidence
`GET /api/providers` → `{ providers: {id,label,needsKey,hint}[], defaultParentDir }`
`GET /api/events` → SSE `{ type: 'map-changed' | 'proposal-created' | 'refreshed' | 'project-changed' }`
`GET /api/health` → `{ ok: true, brain: ... }`

## The app outside a project (workspace)

`GET /api/workspace` → `WorkspaceInfo` — the current project plus every project opened before, most recent first (`missing: true` when the directory has gone)
`POST /api/workspace/open` `{ path }` → `ProjectInfo` — retargets the running engine at another project; the old map is closed, so state never mixes
`POST /api/workspace/create` `{ name, parentDir?, template?: 'typescript'|'empty' }` → `ProjectInfo & { created: string[] }` — scaffolds a new project (refuses a non-empty directory) and opens it
`POST /api/workspace/forget` `{ path }` → `WorkspaceInfo`
After any of these the engine emits `{type:'project-changed'}` on `/api/events`; refetch everything rather than patching state.

## What the agent has understood (memory)

`GET /api/memory` → `MemoryInfo` — `{ text, origin: 'model'|'facts', builtAt?, model? }`
`POST /api/memory/build` → `MemoryInfo` — runs the mapping pass and stores it. With a model connected this is a real pass over the facts; without one it is composed from the facts and says so.

## The model owning the map's meaning

`POST /api/refine` `{ nodeId? }` → `RefineResult` — asks the configured model to re-name and re-explain nodes (the whole top level, or one node plus its children). Returns `{ proposal, nodesTouched, brain, skipped?, raw? }`:
- `proposal` is a normal pending proposal (`rename-node` / `update-summary` ops) — **the map changes only when the developer approves it**;
- `skipped` explains why nothing was proposed (no model connected, model agreed, reply unparseable) and must be shown verbatim, not swallowed;
- `raw` carries what the model actually said when parsing failed, for diagnosis.

Static assets are served from the same origin at `/`.

## Product rules the UI must express

1. **Never render a file tree.** Show the handful of meaningful nodes for the current level (the
   engine guarantees a small count). Layout is left-to-right or top-down, airy, few edges.
2. **Semantic zoom, not scale.** Clicking a node that `childCount > 0` drills into its contents
   (the view swaps to that node's children, breadcrumb grows). Esc / breadcrumb climbs back out.
3. **Plain-language first.** The node's `summary` is the primary text on the canvas — not the id,
   not a file path. Anchors (`file:line`) are secondary, in the inspector.
4. **Honest badges.** `origin: 'verified'` = mechanical fact; `'inferred'` = agent judgement;
   `'user'` = developer; `'planned'` = no code yet. `stale: true` must be visibly marked
   ("code changed since the map agreed"), never silently hidden. A heuristic map must be labelled
   as such in the header, with an obvious path to connecting a model.
5. **User work is protected.** Dragging a node sets `positionLocked`; renaming sets `labelLocked`.
   The UI shows a small lock affordance and must send those flags through `PATCH /api/node/:id`.
6. **Approval before implementation.** Engine-proposed changes arrive as `Proposal`s and are shown
   as pending diff cards (add this node, connect these two, rename that). Nothing is applied until
   Approve. Reject discards.
7. **Transparency.** The node inspector must have a "Context" tab rendering `/api/node/:id/context`
   verbatim — this is what the agent sees, with token counts and truncation flags.
8. **Chat is scoped.** The chat panel carries the currently selected node as scope ("working on:
   Authentication ×"). Streaming tokens render live; `proposal` events render as inline approval cards.

## Visual direction

Dark, calm, technical — closer to Linear/Things than to a graph demo. One accent colour used
sparingly (selection, focus, primary button). Node cards: label in medium weight, summary below in
muted text at a smaller size, kind chip and a small metric line (`4 files · 812 lines`). Thin
1px borders, 10–12px radii, soft shadow, generous whitespace between nodes. Edges: thin, muted,
label on hover or on the emphasised path. Zoom controls and a minimap, small and unobtrusive.
Everything must render cleanly at 1440×900 with no scrollbars inside the canvas.
`prefers-reduced-motion` respected. No emoji, no neon gradients, no glassmorphism.

## The start screen (the app outside a project)

The app is not a single-repository viewer. Like an editor, it opens on a **start screen** when no
project is chosen, and the header always offers a way back to it. Requirements:

- **Recent projects** from `GET /api/workspace`, most recent first, each showing its name and
  full path; a missing directory is marked as missing and cannot be opened. Clicking one opens it
  (`POST /api/workspace/open`) and the app switches to the map.
- **Open a folder**: in the desktop shell use the native directory picker; in the browser fall back
  to a text input for the path. Never guess a path.
- **New project**: name + parent directory (default from `defaultParentDir`) + template; on success
  the app opens the new project. A refusal (directory exists and is not empty) must be shown as the
  engine phrased it.
- **Connect a model** is available from the start screen too — the point of the tool is the model.
  Choosing a provider, fetching `/api/config/models` and running `/api/config/probe` all belong
  here, and the result of the probe must be shown ("deepseek-v4.1-flash answered: ready") rather
  than a green tick with nothing behind it.
- While a project is open, the header shows the project name; clicking it returns to the start
  screen. Opening another project while one is open must fully refetch (the engine closed the old
  map).
- With no projects yet, the start screen explains what the tool is in two sentences and offers
  "Open a folder" and "New project" — not an empty list.
