/**
 * Identity and reconciliation — the stability layer.
 *
 * The map must not reshuffle. When the code changes, this decides what is *the same
 * node* and produces changes rather than a regeneration:
 *   - a node that was "Checkout" yesterday is still the same node today
 *   - anything the developer set (position, name, notes) survives
 *   - meaning changes (add / remove / rename / move) go to a proposal for approval
 */
import type { DetectedChange, MapOp, MapNode, ProposedNodeish, Provenance } from './internal.ts';
import { newId, type Store, type StoredNode } from '../store/db.ts';
import type { Anchors } from './internal.ts';

export interface ReconcileOptions {
  mode: 'initial' | 'refresh';
  /** Current hashes by file path, for stale detection. */
  hashes: Map<string, string>;
}

export interface ReconcileResult {
  /** Nodes to persist straight away (new nodes, or metadata refreshes). */
  apply: { insert?: StoredNode[]; update?: { id: string; patch: Partial<StoredNode> }[] };
  /** Meaning changes, batched into one proposal for the developer to approve. */
  changes: DetectedChange[];
  ops: MapOp[];
  staleMarked: number;
  staleCleared: number;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function anchoredPaths(n: StoredNode): { path: string; hash?: string }[] {
  return n.anchors.filter((a) => a.kind !== 'dir').map((a) => ({ path: a.path, hash: a.hash }));
}

/**
 * Decide, for every proposed node, whether it already exists in the map.
 * Returns the existing node it maps onto (if any) and whether the match was by key
 * (stable) or by content overlap (the node moved/renamed under us).
 */
export function matchNodes(
  existing: StoredNode[],
  proposed: { key: string; level: number; files: string[] }[],
): { match: Map<string, StoredNode>; unmatchedExisting: StoredNode[] } {
  const match = new Map<string, StoredNode>();
  const claimed = new Set<string>();
  const byKey = new Map(existing.map((n) => [n.key, n]));

  for (const p of proposed) {
    const hit = byKey.get(p.key);
    if (hit && !claimed.has(hit.id)) {
      match.set(p.key, hit);
      claimed.add(hit.id);
    }
  }

  // second pass: same content, different key — the node moved but is still "that node"
  const leftovers = existing.filter((n) => !claimed.has(n.id));
  const scored: { pKey: string; node: StoredNode; score: number }[] = [];
  for (const p of proposed) {
    if (match.has(p.key)) continue;
    for (const n of leftovers) {
      if (claimed.has(n.id)) continue;
      const score = jaccard(p.files, n.files) * (n.level === p.level ? 1 : 0.6);
      if (score >= 0.4) scored.push({ pKey: p.key, node: n, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    if (match.has(s.pKey) || claimed.has(s.node.id)) continue;
    match.set(s.pKey, s.node);
    claimed.add(s.node.id);
  }

  return { match, unmatchedExisting: existing.filter((n) => !claimed.has(n.id)) };
}

export function makeNode(p: ProposedNodeish, patch: Partial<MapNode> = {}): StoredNode {
  return {
    id: patch.id ?? newId('n'),
    key: p.key,
    label: p.label,
    kind: p.kind,
    level: p.level,
    parentId: patch.parentId ?? null,
    summary: p.summary,
    detail: p.detail,
    anchors: p.anchors,
    origin: (patch.origin ?? p.origin) as Provenance,
    position: patch.position ?? p.position,
    positionLocked: patch.positionLocked ?? false,
    labelLocked: patch.labelLocked ?? false,
    notes: [],
    stale: patch.stale ?? false,
    childCount: 0,
    metrics: p.metrics,
    heuristic: p.heuristic,
    files: p.files,
  } as StoredNode;
}

export function reconcile(store: Store, proposed: ProposedNodeish[], opts: ReconcileOptions): ReconcileResult {
  const existing = store.allNodes();
  const { match, unmatchedExisting } = matchNodes(existing, proposed);
  const result: ReconcileResult = { apply: { insert: [], update: [] }, changes: [], ops: [], staleMarked: 0, staleCleared: 0 };

  // Resolve every proposed key to a node id up front, so children can point at their
  // parent even when the parent is being created in this same pass.
  const idFor = new Map<string, string>();
  for (const n of existing) if (!idFor.has(n.key)) idFor.set(n.key, n.id);
  for (const p of proposed) {
    const prev = match.get(p.key);
    if (prev) idFor.set(p.key, prev.id);
    else if (!idFor.has(p.key)) idFor.set(p.key, newId('n'));
  }

  for (const p of proposed) {
    const prev = match.get(p.key);
    const parentId = p.parentKey ? idFor.get(p.parentKey) ?? null : null;
    if (!prev) {
      const node = makeNode(p, { id: idFor.get(p.key), parentId });
      if (opts.mode === 'initial') {
        result.apply.insert!.push(node);
      } else {
        result.ops.push({ op: 'add-node', node: { ...node } });
        result.changes.push({ kind: 'new-module', summary: `New area of code: ${p.label}`, ops: [{ op: 'add-node', node: { ...node } }] });
      }
      continue;
    }

    // The developer's label wins. The engine may only re-word explanations it owns.
    const label = prev.labelLocked || prev.origin === 'user' ? prev.label : p.label;
    const summary = prev.origin === 'user' ? prev.summary : p.summary;
    const renamedForUser = prev.labelLocked;

    const hashChanged = anchoredPaths(prev).some((a) => a.hash && opts.hashes.get(a.path) && opts.hashes.get(a.path) !== a.hash);
    const filesChanged = jaccard(prev.files, p.files) < 0.999;
    const keyChanged = prev.key !== p.key;
    const moved = (prev.parentId ?? null) !== parentId;
    const structureChanged = hashChanged || filesChanged || keyChanged;

    const patch: Partial<StoredNode> = {
      key: p.key,
      level: p.level,
      parentId,
      anchors: structureChanged ? prev.anchors : p.anchors,
      metrics: p.metrics,
      detail: p.detail,
      label,
      summary,
    };

    if (structureChanged) {
      if (opts.mode === 'initial') {
        patch.anchors = p.anchors;
        patch.files = p.files;
        patch.stale = false;
      } else {
        patch.stale = true;
        result.staleMarked++;
        const ops: MapOp[] = [
          { op: 'reanchor-node', nodeId: prev.id, anchors: p.anchors },
          { op: 'update-summary', nodeId: prev.id, summary },
        ];
        if (moved) ops.push({ op: 'move-node', nodeId: prev.id, parentId });
        if (keyChanged && !renamedForUser) ops.push({ op: 'rename-node', nodeId: prev.id, label: p.label });
        result.ops.push(...ops);
        result.changes.push({
          kind: hashChanged ? 'changed-code' : 'new-code',
          nodeId: prev.id,
          summary: hashChanged
            ? `Code under "${prev.label}" changed since the map agreed.`
            : `"${prev.label}" now covers different files (${p.files.length} of them).`,
          ops,
        });
      }
    } else if (prev.stale) {
      patch.stale = false;
      result.staleCleared++;
    }

    result.apply.update!.push({ id: prev.id, patch });
  }

  // engine nodes the code no longer justifies
  for (const orphan of unmatchedExisting) {
    // never touch what the developer authored, and never delete design intent that
    // simply has no code yet — a planned node is the whole point of the tool
    if (orphan.origin === 'user' || orphan.origin === 'planned') continue;
    if (opts.mode === 'initial') {
      store.deleteNode(orphan.id);
      continue;
    }
    const op: MapOp = { op: 'remove-node', nodeId: orphan.id };
    result.ops.push(op);
    result.changes.push({ kind: 'gone-module', nodeId: orphan.id, summary: `"${orphan.label}" is no longer in the code.`, ops: [op] });
  }

  return result;
}

export function applyReconcile(store: Store, r: { apply: { insert?: StoredNode[]; update?: { id: string; patch: Partial<StoredNode> }[] } }): void {
  for (const n of r.apply.insert ?? []) store.insertNode(n);
  for (const u of r.apply.update ?? []) store.updateNode(u.id, u.patch);
}

export type { Anchors };
