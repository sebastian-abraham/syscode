/**
 * Small internal re-exports so the map modules don't each reach across the tree.
 */
export type { Anchor, MapEdge, MapNode, NodeKind, Provenance } from '../types.ts';
export type { ProposedNode, ProposedMap, ProposedEdge } from './heuristic.ts';
export type { MapOp, DetectedChange } from '../types.ts';

/** What reconcile() consumes: a proposed node, before it has an id. */
export interface ProposedNodeish {
  key: string;
  label: string;
  kind: import('../types.ts').NodeKind;
  level: number;
  parentKey: string | null;
  summary: string;
  detail?: string;
  anchors: import('../types.ts').Anchor[];
  origin: import('../types.ts').Provenance;
  position: { x: number; y: number };
  metrics: { files: number; loc: number; symbols: number };
  heuristic: boolean;
  files: string[];
}

export type Anchors = import('../types.ts').Anchor[];
