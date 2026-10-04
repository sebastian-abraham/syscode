/**
 * The map service: the one object every surface talks to.
 * Owns the facts, the store, the proposal queue and the reconcile cycle.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  Anchor, ChatMessage, DetectedChange, JournalEntry, MapEdge, MapNode, MapOp, MemoryInfo, Note, ProjectInfo,
  Proposal, RefineResult, RefreshReport, RepoFacts, ScopedContext, SyscodeConfig,
} from '../types.ts';
import { analyzeRepo } from '../analyze/index.ts';
import { serviceLabel } from '../analyze/external.ts';
import { newId, Store, type StoredNode } from '../store/db.ts';
import { proposeMap, type ProposedMap, type ProposedNode } from './heuristic.ts';
import { applyReconcile, makeNode, reconcile } from './identity.ts';
import { brainInfo, loadConfig, resolveBrain, saveConfig, type Brain } from '../config.ts';
import { buildContext, estimateTokens } from '../memory/context.ts';
import { buildProjectMemory } from '../memory/mapping.ts';
import { suggestRefinements, type RefineTarget } from '../llm/refine.ts';

export interface CodePeek {
  path: string;
  start: number;
  end: number;
  totalLines: number;
  text: string;
  highlight?: [number, number];
  symbol?: string;
}

export class MapService {
  readonly root: string;
  readonly store: Store;
  facts: RepoFacts;
  brain: Brain;
  config: SyscodeConfig;
  private lastProposed: ProposedMap | null = null;

  private constructor(root: string, store: Store, facts: RepoFacts, brain: Brain, config: SyscodeConfig) {
    this.root = root;
    this.store = store;
    this.facts = facts;
    this.brain = brain;
    this.config = config;
  }

  static async open(root: string, opts: { refresh?: boolean } = {}): Promise<MapService> {
    const abs = path.resolve(root);
    const config = loadConfig(abs);
    const brain = resolveBrain(config);
    const facts = await analyzeRepo(abs);
    const store = new Store(abs);
    const svc = new MapService(abs, store, facts, brain, config);
    store.replaceFiles(facts.files.map((f) => ({ path: f.path, lang: f.lang, loc: f.loc, hash: f.hash })));

    if (!store.getMeta('project.createdAt')) store.setMeta('project.createdAt', new Date().toISOString());
    store.setMeta('project.root', abs);
    if (!store.getMeta('project.name')) store.setMeta('project.name', path.basename(abs));

    const nodeCount = store.stats().nodes;
    if (nodeCount === 0) {
      svc.buildInitial();
      store.log('engine', 'map-created', `Initial map: ${store.stats().nodes} nodes, ${store.stats().edges} edges.`);
    } else if (opts.refresh) {
      svc.refresh();
    }
    return svc;
  }

  setName(name: string): void {
    this.store.setMeta('project.name', name);
  }

  /* ------------------------------------------------------------------ build */

  buildInitial(): void {
    const proposed = proposeMap(this.facts);
    this.lastProposed = proposed;
    const rec = reconcile(this.store, proposed.nodes, { mode: 'initial', hashes: this.hashMap() });
    applyReconcile(this.store, rec);
    this.syncEdges(proposed);
    this.store.setJson('project.brain', brainInfo(this.brain));
  }

  refresh(): RefreshReport {
    // re-analyse happens in the CLI/server before this is called when the files moved;
    // here we work from the facts we hold, which the caller refreshes.
    const proposed = proposeMap(this.facts);
    this.lastProposed = proposed;
    const rec = reconcile(this.store, proposed.nodes, { mode: 'refresh', hashes: this.hashMap() });

    applyReconcile(this.store, { apply: { insert: rec.apply.insert, update: rec.apply.update } });

    // One proposal per detected change, so the developer can accept the ones they agree
    // with. The engine applies nothing structural on its own.
    let created = 0;
    for (const change of rec.changes) {
      if (!change.ops.length) continue;
      change.label = change.nodeId ? this.store.getNode(change.nodeId)?.label : undefined;
      const p: Proposal = {
        id: newId('prop'),
        title: proposalTitle(change),
        rationale: `${change.summary}\n\nThe map only changes here if you accept: node identity, positions, names and notes are preserved either way.`,
        ops: change.ops,
        status: 'pending',
        origin: 'inferred',
        createdAt: new Date().toISOString(),
      };
      this.store.insertProposal(p);
      change.proposalId = p.id;
      created++;
    }
    if (created) this.store.log('engine', 'proposal-created', `${created} map update${created === 1 ? '' : 's'} queued for review.`);

    this.syncEdges(proposed);
    this.store.setJson('project.brain', brainInfo(this.brain));

    return {
      scanned: { files: this.facts.totals.files, loc: this.facts.totals.loc },
      changes: rec.changes,
      proposalsCreated: created,
      staleCleared: rec.staleCleared,
      staleMarked: rec.staleMarked,
      applied: true,
      brain: brainInfo(this.brain),
    };
  }

  /** Re-read the repository from disk, then reconcile. */
  async rescan(): Promise<RefreshReport> {
    this.facts = await analyzeRepo(this.root);
    this.store.replaceFiles(this.facts.files.map((f) => ({ path: f.path, lang: f.lang, loc: f.loc, hash: f.hash })));
    return this.refresh();
  }

  private hashMap(): Map<string, string> {
    return new Map(this.facts.files.map((f) => [f.path, f.hash]));
  }

  /** Engine-owned edges follow the code; edges the developer drew are never touched. */
  syncEdges(proposed: ProposedMap): void {
    this.store.deleteEdgesByOrigin(['verified', 'inferred']);
    const idByKey = new Map<string, string>();
    for (const n of this.store.allNodes()) if (!idByKey.has(n.key)) idByKey.set(n.key, n.id);
    for (const e of proposed.edges) {
      const source = idByKey.get(e.sourceKey);
      const target = idByKey.get(e.targetKey);
      if (!source || !target || source === target) continue;
      const duplicate = this.store.allEdges().some((x) => x.source === source && x.target === target && x.origin !== 'user');
      if (duplicate) continue;
      this.store.insertEdge({
        id: newId('e'),
        source,
        target,
        label: e.label,
        kind: e.kind,
        origin: e.origin,
        weight: e.weight,
      });
    }
  }

  /* ------------------------------------------------------------------- read */

  view(parentId: string | null = null, opts: { maxNodes?: number } = {}): {
    nodes: MapNode[];
    edges: MapEdge[];
    parent: MapNode | null;
    breadcrumb: MapNode[];
    root: boolean;
    totalNodes: number;
    staleCount: number;
    truncated: boolean;
  } {
    const all = this.store.allNodes();
    const parent = parentId ? all.find((n) => n.id === parentId) ?? null : null;
    let nodes = all.filter((n) => (parent ? n.parentId === parent.id : n.parentId === null));
    if (!nodes.length && parent) nodes = [];

    const maxNodes = opts.maxNodes ?? 40;
    let truncated = false;
    if (nodes.length > maxNodes) {
      nodes = nodes.slice(0, maxNodes);
      truncated = true;
    }
    const visible = new Set(nodes.map((n) => n.id));
    const edges = this.store.allEdges().filter((e) => visible.has(e.source) && visible.has(e.target));

    const breadcrumb: MapNode[] = [];
    let cursor = parent;
    while (cursor) {
      breadcrumb.unshift(cursor);
      cursor = cursor.parentId ? all.find((n) => n.id === cursor!.parentId) ?? null : null;
    }

    return {
      nodes,
      edges,
      parent,
      breadcrumb: breadcrumb.slice(0, -1),
      root: !parentId,
      totalNodes: all.length,
      staleCount: all.filter((n) => n.stale).length,
      truncated,
    };
  }

  node(id: string): StoredNode | undefined {
    return this.store.getNode(id);
  }

  descendants(id: string): { nodes: StoredNode[]; edges: MapEdge[] } {
    const all = this.store.allNodes();
    const out: StoredNode[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of all) {
        if (n.parentId === cur) {
          out.push(n);
          stack.push(n.id);
        }
      }
    }
    const ids = new Set([id, ...out.map((n) => n.id)]);
    const edges = this.store.allEdges().filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes: out, edges };
  }

  project(): ProjectInfo {
    const stats = this.store.stats();
    const all = this.store.allNodes();
    const createdAt = this.store.getMeta('project.createdAt') ?? new Date().toISOString();
    const langs = Object.entries(this.facts.totals.byLang)
      .map(([lang, s]) => ({ lang, files: s.files, loc: s.loc }))
      .sort((a, b) => b.loc - a.loc);
    const brainMeta = this.store.getJson<ProjectInfo['brain']>('project.brain') ?? brainInfo(this.brain);
    return {
      id: this.store.getMeta('project.id') ?? 'local',
      name: this.store.getMeta('project.name') ?? path.basename(this.root),
      root: this.root,
      createdAt,
      updatedAt: new Date().toISOString(),
      stats: {
        files: this.facts.totals.files,
        loc: this.facts.totals.loc,
        languages: langs,
        nodeCount: stats.nodes,
        edgeCount: stats.edges,
        staleCount: all.filter((n) => n.stale).length,
        pendingProposals: stats.pending,
      },
      brain: brainMeta,
    };
  }

  context(nodeId: string | null): ScopedContext {
    return buildContext(this.store, this.root, nodeId, { budgetTokens: this.config.maxContextTokens, facts: this.facts });
  }

  codePeek(nodeId: string, anchorIndex = 0, windowLines = 60): CodePeek | undefined {
    const node = this.store.getNode(nodeId);
    if (!node) return undefined;
    const anchor: Anchor | undefined = node.anchors[anchorIndex];
    if (!anchor) return undefined;
    let target = anchor.path;
    const fileFacts = this.facts.files.find((f) => f.path === target);
    if (!fileFacts) {
      const fuzzy = this.facts.files.find((f) => f.path.endsWith(target) || target.endsWith(f.path));
      if (fuzzy) target = fuzzy.path;
    }
    let raw: string;
    try {
      raw = readFileSync(path.join(this.root, target), 'utf8');
    } catch {
      return { path: target, start: 1, end: 1, totalLines: 1, text: '(file not found on disk)', symbol: anchor.symbol };
    }
    const lines = raw.split('\n');
    const anchorLine = anchor.lines ? anchor.lines[0] : 1;
    const start = Math.max(1, anchorLine - Math.floor(windowLines / 3));
    const end = Math.min(lines.length, start + windowLines);
    return {
      path: target,
      start,
      end,
      totalLines: lines.length,
      text: lines.slice(start - 1, end).join('\n'),
      highlight: anchor.lines,
      symbol: anchor.symbol,
    };
  }

  /* ------------------------------------------------------------------ write */

  createNode(input: { label: string; summary: string; kind?: MapNode['kind']; parentId?: string | null; position?: { x: number; y: number }; detail?: string }): StoredNode {
    const parent = input.parentId ? this.store.getNode(input.parentId) : undefined;
    const siblings = this.store.allNodes().filter((n) => (n.parentId ?? null) === (input.parentId ?? null));
    const position = input.position ?? defaultPosition(parent, siblings);
    const node: StoredNode = {
      id: newId('n'),
      key: `user:${input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`,
      label: input.label,
      kind: input.kind ?? 'planned',
      level: parent ? parent.level + 1 : 0,
      parentId: parent?.id ?? null,
      summary: input.summary,
      detail: input.detail,
      anchors: [],
      origin: 'user',
      position,
      positionLocked: true,
      labelLocked: true,
      notes: [],
      stale: false,
      childCount: 0,
      metrics: { files: 0, loc: 0, symbols: 0 },
      heuristic: false,
      files: [],
    };
    this.store.insertNode(node);
    this.store.log('user', 'node-created', node.label, node.id);
    return this.store.getNode(node.id)!;
  }

  patchNode(id: string, patch: Partial<MapNode>): StoredNode | undefined {
    const cur = this.store.getNode(id);
    if (!cur) return undefined;
    const allowed: Partial<StoredNode> = {};
    if (typeof patch.label === 'string') {
      allowed.label = patch.label;
      // Editing a name is a decision: pin it so the mapper cannot quietly revert it.
      if (patch.labelLocked === undefined) allowed.labelLocked = true;
    }
    if (typeof patch.summary === 'string') {
      allowed.summary = patch.summary;
      allowed.origin = cur.origin === 'verified' || cur.origin === 'inferred' ? 'user' : cur.origin;
    }
    if (typeof patch.detail === 'string') allowed.detail = patch.detail;
    if (patch.kind) allowed.kind = patch.kind;
    if (patch.position) {
      allowed.position = patch.position;
      if (patch.positionLocked === undefined) allowed.positionLocked = true;
    }
    if (typeof patch.positionLocked === 'boolean') allowed.positionLocked = patch.positionLocked;
    if (typeof patch.labelLocked === 'boolean') allowed.labelLocked = patch.labelLocked;
    if (patch.parentId !== undefined) allowed.parentId = patch.parentId;
    if (patch.anchors) allowed.anchors = patch.anchors;
    this.store.updateNode(id, allowed);
    const locks = [allowed.positionLocked && 'position', allowed.labelLocked && 'name'].filter(Boolean).join(', ');
    this.store.log('user', 'node-updated', `${allowed.label ?? cur.label}${locks ? ` (pinned ${locks})` : ''}`, id);
    return this.store.getNode(id);
  }

  deleteNode(id: string): void {
    const n = this.store.getNode(id);
    this.store.deleteNode(id);
    if (n) this.store.log('user', 'node-removed', n.label, id);
  }

  createEdge(input: { source: string; target: string; label: string; kind?: MapEdge['kind'] }): MapEdge {
    const edge: MapEdge = {
      id: newId('e'),
      source: input.source,
      target: input.target,
      label: input.label,
      kind: input.kind ?? 'custom',
      origin: 'user',
      weight: 1,
    };
    this.store.insertEdge(edge);
    const a = this.store.getNode(input.source);
    const b = this.store.getNode(input.target);
    this.store.log('user', 'edge-created', `${a?.label ?? '?'} → ${b?.label ?? '?'} (${edge.label})`);
    return edge;
  }

  patchEdge(id: string, patch: Partial<MapEdge>): MapEdge | undefined {
    this.store.updateEdge(id, { ...patch, origin: 'user' });
    return this.store.allEdges().find((e) => e.id === id);
  }

  deleteEdge(id: string): void {
    this.store.deleteEdge(id);
    this.store.log('user', 'edge-removed', id);
  }

  addNote(nodeId: string, body: string, kind: Note['kind'] = 'note', author: Note['author'] = 'user'): Note {
    const note = this.store.addNote(nodeId, body, kind, author);
    this.store.log(author, 'note-added', `${kind}: ${body.slice(0, 80)}`, nodeId);
    return note;
  }

  deleteNote(noteId: string): void {
    this.store.deleteNote(noteId);
  }

  /* -------------------------------------------------------------- proposals */

  proposals(): Proposal[] {
    return this.store.allProposals();
  }

  addProposal(input: { title: string; rationale: string; ops: MapOp[]; origin?: Proposal['origin'] }): Proposal {
    // Give structural ops their ids up front. A proposal is then inspectable before it is
    // applied — an interface can key on the node it would create, and a test can look it up
    // afterwards — instead of the id only existing once someone approves it.
    const ops = input.ops.map((op) => {
      if (op.op === 'add-node' && !op.node.id) return { ...op, node: { ...op.node, id: newId('n') } };
      if (op.op === 'add-edge' && !op.edge.id) return { ...op, edge: { ...op.edge, id: newId('e') } };
      return op;
    });
    const p: Proposal = {
      id: newId('prop'),
      title: input.title,
      rationale: input.rationale,
      ops,
      status: 'pending',
      origin: input.origin ?? 'inferred',
      createdAt: new Date().toISOString(),
    };
    this.store.insertProposal(p);
    this.store.log('engine', 'proposal-created', p.title);
    return p;
  }

  approveProposal(id: string): { proposal: Proposal; view: ReturnType<MapService['view']> } | undefined {
    const proposal = this.store.allProposals().find((p) => p.id === id);
    if (!proposal) return undefined;
    for (const op of proposal.ops) this.applyOp(op);
    const decided = this.store.decideProposal(id, 'approved')!;
    this.store.log('user', 'proposal-approved', proposal.title);
    return { proposal: decided, view: this.view(null) };
  }

  rejectProposal(id: string): Proposal | undefined {
    const proposal = this.store.allProposals().find((p) => p.id === id);
    if (!proposal) return undefined;
    const decided = this.store.decideProposal(id, 'rejected');
    this.store.log('user', 'proposal-rejected', proposal.title);
    return decided;
  }

  applyOp(op: MapOp): void {
    switch (op.op) {
      case 'add-node': {
        const partial = op.node;
        const parentId = partial.parentId ?? null;
        const parent = parentId ? this.store.getNode(parentId) : undefined;
        const siblings = this.store.allNodes().filter((n) => (n.parentId ?? null) === parentId);
        const node: StoredNode = {
          id: partial.id ?? newId('n'),
          key: partial.key ?? `user:${(partial.label ?? 'node').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          label: partial.label ?? 'Untitled',
          kind: partial.kind ?? 'planned',
          level: partial.level ?? (parent ? parent.level + 1 : 0),
          parentId,
          summary: partial.summary ?? '',
          detail: partial.detail,
          anchors: partial.anchors ?? [],
          origin: partial.origin ?? 'planned',
          position: partial.position ?? defaultPosition(parent, siblings),
          positionLocked: partial.positionLocked ?? false,
          labelLocked: partial.labelLocked ?? false,
          notes: [],
          stale: false,
          childCount: 0,
          metrics: partial.metrics ?? { files: 0, loc: 0, symbols: 0 },
          heuristic: partial.heuristic ?? false,
          files: partial.files ?? [],
        };
        this.store.insertNode(node);
        break;
      }
      case 'add-edge':
        this.store.insertEdge({
          id: op.edge.id ?? newId('e'),
          source: op.edge.source,
          target: op.edge.target,
          label: op.edge.label,
          kind: op.edge.kind ?? 'custom',
          origin: op.edge.origin ?? 'inferred',
          weight: op.edge.weight ?? 1,
        });
        break;
      case 'rename-node':
        this.store.updateNode(op.nodeId, { label: op.label, labelLocked: true });
        break;
      case 'update-summary':
        this.store.updateNode(op.nodeId, { summary: op.summary });
        break;
      case 'move-node':
        this.store.updateNode(op.nodeId, { parentId: op.parentId });
        break;
      case 'reanchor-node':
        this.store.updateNode(op.nodeId, {
          anchors: op.anchors,
          files: [...new Set(op.anchors.map((a) => a.path))],
          stale: false,
        });
        break;
      case 'remove-node':
        this.store.deleteNode(op.nodeId);
        break;
      case 'remove-edge':
        this.store.deleteEdge(op.edgeId);
        break;
    }
  }

  /* ---------------------------------------------------------------- misc */

  journal(limit = 60): JournalEntry[] {
    return this.store.journal(limit);
  }

  chatHistory(): ChatMessage[] {
    return this.store.chatHistory();
  }

  addChat(m: ChatMessage): void {
    this.store.addChat(m);
  }

  setConfig(patch: Partial<SyscodeConfig>): SyscodeConfig {
    const next = saveConfig(this.root, patch);
    this.config = next;
    this.brain = resolveBrain(next);
    this.store.setJson('project.brain', brainInfo(this.brain));
    return next;
  }

  /* ------------------------------------------------------- agent-owned meaning */

  /**
   * Ask a model to re-name and re-explain part of the map. The facts that justify each
   * node are handed over with it, and the result comes back as a proposal — the map only
   * changes if the developer accepts it.
   */
  async refine(opts: { nodeId?: string | null; signal?: AbortSignal } = {}): Promise<RefineResult> {
    const all = this.store.allNodes();
    const scope = opts.nodeId ? all.find((n) => n.id === opts.nodeId) : undefined;
    const targets = scope
      ? [scope, ...all.filter((n) => n.parentId === scope.id)]
      : all.filter((n) => n.level === 0);

    const labelById = new Map(all.map((n) => [n.id, n.label]));
    const edges = this.store.allEdges();
    const factsByPath = new Map(this.facts.files.map((f) => [f.path, f]));

    const refineTargets: RefineTarget[] = targets.map((n) => {
      const deps = edges.filter((e) => e.source === n.id).map((e) => labelById.get(e.target) ?? '');
      const usedBy = edges.filter((e) => e.target === n.id).map((e) => labelById.get(e.source) ?? '');
      const exports: string[] = [];
      const services = new Set<string>();
      const entryFiles: string[] = [];
      for (const file of n.files) {
        const f = factsByPath.get(file);
        if (!f) continue;
        exports.push(...f.exports.slice(0, 4));
        if (f.isEntry) entryFiles.push(f.path);
        for (const imp of f.imports) {
          if (imp.external && imp.package) {
            const svc = serviceLabel(imp.package);
            if (svc) services.add(svc);
          }
        }
      }
      return {
        key: n.key,
        id: n.id,
        label: n.label,
        kind: n.kind,
        level: n.level,
        summary: n.summary,
        files: n.files,
        exports: [...new Set(exports)],
        dependsOn: [...new Set(deps)].filter(Boolean),
        usedBy: [...new Set(usedBy)].filter(Boolean),
        entryFiles,
        services: [...services],
        children: all.filter((c) => c.parentId === n.id).map((c) => c.label),
        labelLocked: n.labelLocked,
      };
    });

    const outcome = await suggestRefinements(this.brain, this.facts, refineTargets, { signal: opts.signal });
    const brain = brainInfo(this.brain);
    if (outcome.error) return { proposal: null, nodesTouched: 0, brain, skipped: outcome.error, raw: outcome.raw };

    const byKey = new Map(refineTargets.map((t) => [t.key, t]));
    const ops: MapOp[] = [];
    const notes: string[] = [];
    for (const s of outcome.suggestions) {
      const target = byKey.get(s.key);
      if (!target) continue;
      if (s.label) ops.push({ op: 'rename-node', nodeId: target.id, label: s.label });
      if (s.summary) ops.push({ op: 'update-summary', nodeId: target.id, summary: s.summary });
      if (s.note) notes.push(`**${s.label ?? target.label}**: ${s.note}`);
    }
    if (!ops.length) {
      return {
        proposal: null,
        nodesTouched: 0,
        brain,
        skipped: notes.length ? `The model had notes but no renames: ${notes.join(' ')}` : 'The model agreed with the current naming.',
      };
    }

    const proposal = this.addProposal({
      title: `Name and explain the map with ${this.brain.model ?? this.brain.provider}`,
      rationale: [
        `A model read the facts behind ${refineTargets.length} node${refineTargets.length === 1 ? '' : 's'} and rewrote the naming and explanations it disagreed with.`,
        'The facts came from the code; the words came from the model. Accepting this changes what the map says, not what the code does.',
        ...(notes.length ? ['', 'Grouping observations:', ...notes.map((n) => `- ${n}`)] : []),
      ].join('\n'),
      ops,
      origin: 'inferred',
    });
    return { proposal, nodesTouched: ops.length, brain };
  }

  /** What the agent currently knows about this project. */
  memory(): MemoryInfo {
    const text = this.store.getMeta('project.memory') ?? '';
    const origin = (this.store.getMeta('project.memory.origin') as MemoryInfo['origin']) ?? 'facts';
    return {
      text,
      origin,
      builtAt: this.store.getMeta('project.memory.builtAt'),
      model: this.store.getMeta('project.memory.model'),
    };
  }

  /** Run the mapping pass: read the facts, write memory the agent will reuse. */
  async buildMemory(opts: { signal?: AbortSignal } = {}): Promise<MemoryInfo> {
    const areas = this.store
      .allNodes()
      .filter((n) => n.level === 0)
      .map((n) => ({ label: n.label, summary: n.summary, files: n.metrics.files, dirs: [...new Set(n.anchors.filter((a) => a.kind === 'dir').map((a) => a.path))] }));
    const info = await buildProjectMemory(this.brain, { facts: this.facts, areas }, this.root, opts);
    this.store.setMeta('project.memory', info.text);
    this.store.setMeta('project.memory.origin', info.origin);
    if (info.builtAt) this.store.setMeta('project.memory.builtAt', info.builtAt);
    if (info.model) this.store.setMeta('project.memory.model', info.model);
    this.store.log('engine', 'memory-built', info.origin === 'model' ? `Project memory written by ${info.model ?? 'the model'}.` : 'Project memory written from the facts.');
    return info;
  }

  setMemory(text: string): void {
    this.store.setMeta('project.memory', text);
  }

  tokenEstimate(text: string): number {
    return estimateTokens(text);
  }

  lastProposalNodes(): ProposedMap | null {
    return this.lastProposed;
  }

  close(): void {
    this.store.close();
  }
}

function proposalTitle(change: DetectedChange): string {
  const name = change.label ? `"${change.label}"` : 'the map';
  switch (change.kind) {
    case 'changed-code':
      return `Refresh ${name} from the code`;
    case 'new-code':
      return `Update ${name} with new code`;
    case 'new-module':
      return `Add ${name} to the map`;
    case 'gone-module':
      return `Remove ${name} from the map`;
    case 'removed-code':
      return `Drop code from ${name}`;
    default:
      return 'Update the map';
  }
}

function defaultPosition(parent: StoredNode | undefined, siblings: StoredNode[]): { x: number; y: number } {
  const baseX = parent ? parent.position.x : 0;
  const baseY = parent ? parent.position.y : 0;
  if (!siblings.length) return { x: baseX, y: baseY };
  if (siblings.length >= 6) return { x: baseX, y: Math.max(...siblings.map((s) => s.position.y)) + 150 };
  return { x: baseX + 340, y: baseY };
}

export type { ProposedNode };
