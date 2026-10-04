/**
 * SysCode shared model types.
 *
 * This file is the contract between the core engine (analysis, map, memory, agent)
 * and every interface (web canvas, desktop shell, future editor extensions).
 *
 * Design rules encoded here (from the product brief):
 *  - A node is a *meaningful unit as the AI would explain it*, not a file.
 *  - Nodes have persistent identity. Positions, names, notes and pinned
 *    constraints that a developer set are protected from the AI.
 *  - Every node links back to real code where code exists; verified links are
 *    distinguishable from inferred ones.
 */

/** What kind of thing a node represents. Deliberately open-ended, not a rigid schema. */
export type NodeKind =
  | 'system'      // the whole thing / a major area of the product
  | 'subsystem'   // a cohesive area of the codebase
  | 'feature'     // a capability ("checkout flow")
  | 'component'   // a specific implementation unit inside a feature
  | 'data'        // a piece of data ("user profile", "orders table")
  | 'external'    // something outside the codebase ("Stripe", "Postgres")
  | 'concern'     // cross-cutting ("error handling strategy")
  | 'planned';    // designed but not implemented yet

/** Where a node's content came from. Drives the honesty badges in the UI. */
export type Provenance =
  | 'verified'    // derived mechanically from code facts
  | 'inferred'    // the agent's judgement about code facts
  | 'user'        // the developer wrote/edited it
  | 'planned';    // no code yet, by design

/** A link from a node back to real code. */
export interface Anchor {
  path: string;              // repo-relative path
  kind: 'dir' | 'file' | 'symbol';
  symbol?: string;           // e.g. "createOrder"
  lines?: [number, number];  // 1-based inclusive range
  /** Content hash of the anchored file when the map last agreed with the code. */
  hash?: string;
  /** Overlap with the node, 0..1 — how much of the anchored unit belongs to it. */
  weight?: number;
}

export interface Note {
  id: string;
  body: string;
  /** A pinned constraint is protected: the AI may not silently drop or reword it. */
  kind: 'note' | 'constraint' | 'decision';
  author: 'user' | 'agent';
  createdAt: string;
}

export interface MapNode {
  id: string;                    // stable uuid, survives renames and moves
  key: string;                   // identity key the engine matches on ("area:auth")
  label: string;
  kind: NodeKind;
  level: number;                 // 0 = whole system … 3 = code-level
  parentId: string | null;
  summary: string;               // plain-language explanation, the point of the node
  detail?: string;               // longer form, shown in the inspector
  anchors: Anchor[];
  origin: Provenance;
  position: { x: number; y: number };
  positionLocked: boolean;       // developer dragged it — never re-layout over it
  labelLocked: boolean;          // developer renamed it — never overwrite without approval
  notes: Note[];
  stale: boolean;                // anchored code changed since the map last agreed
  childCount: number;
  metrics: { files: number; loc: number; symbols: number };
  /** true when this node came from the deterministic fallback rather than a model. */
  heuristic?: boolean;
}

export type EdgeKind = 'depends' | 'data' | 'triggers' | 'stores' | 'uses' | 'custom';

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  label: string;                 // short and human: "sends orders to"
  kind: EdgeKind;
  origin: Provenance;
  /** How many underlying code-level links this edge summarises. */
  weight?: number;
}

/** A view of the map: the siblings to draw plus their edges and breadcrumb. */
export interface MapView {
  nodes: MapNode[];
  edges: MapEdge[];
  parent: MapNode | null;
  breadcrumb: MapNode[];
  /** Set when the view is the whole-system level. */
  root: boolean;
  totalNodes: number;
  staleCount: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  updatedAt: string;
  stats: {
    files: number;
    loc: number;
    languages: { lang: string; files: number; loc: number }[];
    nodeCount: number;
    edgeCount: number;
    staleCount: number;
    pendingProposals: number;
  };
  /** Which brain produced the current map. */
  brain: { mode: 'heuristic' | 'model'; provider?: string; model?: string };
}

/** One entry of the "what the agent was given" transparency panel. */
export interface ContextItem {
  kind: 'node' | 'code' | 'note' | 'edge' | 'memory' | 'constraint';
  label: string;
  source?: string;       // path or node id
  content: string;
  tokens: number;
  truncated?: boolean;
}

export interface ScopedContext {
  nodeId: string | null;
  items: ContextItem[];
  totalTokens: number;
  budgetTokens: number;
}

/** A design change the agent proposes on the map, applied only after approval. */
export type MapOp =
  | { op: 'add-node'; node: Partial<MapNode> & { label: string; summary: string; files?: string[]; heuristic?: boolean } }
  | { op: 'add-edge'; edge: Partial<MapEdge> & { source: string; target: string; label: string } }
  | { op: 'rename-node'; nodeId: string; label: string }
  | { op: 'reanchor-node'; nodeId: string; anchors: Anchor[] }
  | { op: 'update-summary'; nodeId: string; summary: string }
  | { op: 'move-node'; nodeId: string; parentId: string | null }
  | { op: 'remove-node'; nodeId: string }
  | { op: 'remove-edge'; edgeId: string };

export interface Proposal {
  id: string;
  title: string;
  rationale: string;
  ops: MapOp[];
  status: 'pending' | 'approved' | 'rejected';
  origin: Provenance;
  createdAt: string;
  decidedAt?: string;
}

/** A change the refresh/analyze pass detected between the map and the code. */
export interface DetectedChange {
  kind: 'new-code' | 'removed-code' | 'changed-code' | 'new-module' | 'gone-module';
  nodeId?: string;
  /** Human label of the affected node, so an interface never has to show a raw id. */
  label?: string;
  summary: string;
  ops: MapOp[];
  /** The proposal this change was queued as — accepting it is what applies the change. */
  proposalId?: string;
}

export interface RefreshReport {
  scanned: { files: number; loc: number };
  changes: DetectedChange[];
  proposalsCreated: number;
  staleCleared: number;
  staleMarked: number;
  applied: boolean;
  brain: ProjectInfo['brain'];
}

/** Facts extracted deterministically from the repo. The AI's honest grounding. */
export interface FileFacts {
  path: string;
  lang: string;
  loc: number;
  hash: string;
  isEntry: boolean;
  imports: ImportFact[];
  symbols: SymbolFact[];
  exports: string[];
}

export interface ImportFact {
  specifier: string;
  /** Repo-relative resolved path, when the import lands inside the project. */
  resolved?: string;
  external: boolean;
  package?: string;
}

export interface SymbolFact {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'method';
  line: number;
  endLine: number;
  exported: boolean;
}

export interface RepoFacts {
  root: string;
  files: FileFacts[];
  /** External packages actually imported, with the importer count. */
  externals: { name: string; usedBy: number; kind: 'runtime' | 'service' | 'framework' | 'unknown' }[];
  entryPoints: string[];
  totals: { files: number; loc: number; byLang: Record<string, { files: number; loc: number }> };
  scannedAt: string;
}

/** Chat events streamed to the interface (SSE). */
export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'context'; context: ScopedContext }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'done'; messageId: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  nodeId: string | null;
  createdAt: string;
  brain: 'heuristic' | 'model';
  model?: string;
  proposalId?: string;
}

export interface JournalEntry {
  id: string;
  at: string;
  actor: 'user' | 'agent' | 'engine';
  action: string;
  detail: string;
  nodeId?: string;
}

export interface SyscodeConfig {
  provider: 'none' | 'openai-compatible' | 'anthropic' | 'ollama' | 'opencode-go';
  baseUrl?: string;
  model?: string;
  /** Present only when written to .syscode/config.json; never committed. */
  apiKey?: string;
  maxContextTokens: number;
}

/** A project the developer has opened before, for the start screen. */
export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
  /** Set when the directory has since disappeared. */
  missing?: boolean;
}

export interface WorkspaceInfo {
  current: ProjectInfo;
  recent: RecentProject[];
  /** Where new projects are created by default. */
  defaultParentDir: string;
}

/** What the agent has understood about the project, kept between sessions. */
export interface MemoryInfo {
  text: string;
  origin: 'model' | 'facts';
  builtAt?: string;
  model?: string;
}

/** Outcome of asking a model to re-name, re-group or re-explain part of the map. */
export interface RefineResult {
  proposal: Proposal | null;
  nodesTouched: number;
  brain: ProjectInfo['brain'];
  /** Why nothing was proposed, when that is the case. */
  skipped?: string;
  /** What the model actually said, so a failure can be diagnosed rather than guessed at. */
  raw?: string;
}

/** One model offered by the configured provider. */
export interface ModelChoice {
  id: string;
  /** False when this client cannot speak the shape that model needs. */
  supported: boolean;
  note?: string;
}
