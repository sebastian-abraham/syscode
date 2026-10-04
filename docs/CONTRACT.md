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
`GET /api/events` → SSE `{ type: 'map-changed' | 'proposal-created' | 'refreshed' }`
`GET /api/health` → `{ ok: true, brain: ... }`

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
