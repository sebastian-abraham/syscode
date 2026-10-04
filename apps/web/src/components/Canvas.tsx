import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import type { EdgeKind, MapEdge, MapNode, MapView } from '../types.ts';
import { useStore } from '../store.tsx';
import { NodeCard, type SysNode, type SysNodeData } from './NodeCard.tsx';
import SysEdgeComponent from './SysEdge.tsx';
import Breadcrumb from './Breadcrumb.tsx';
import CodePeek from './CodePeek.tsx';
import { IconChevron } from './icons.tsx';

const nodeTypes = { sysNode: NodeCard };
const edgeTypes = { sysEdge: SysEdgeComponent };

type SysEdge = Edge<{ edge: MapEdge }>;

const EDGE_KINDS: EdgeKind[] = ['depends', 'data', 'triggers', 'stores', 'uses', 'custom'];

const ORIGIN_COLOR: Record<string, string> = {
  verified: '#79b892',
  inferred: '#c9a86a',
  user: '#8aa9f5',
  planned: '#a78bd6',
};

/** Top-down fallback when the engine returns no usable positions. */
function layoutFallback(view: MapView): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const count = view.nodes.length;
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(count))));
  view.nodes.forEach((node, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.set(node.id, { x: col * 340, y: row * 210 });
  });
  return out;
}

function positionsAreFlat(view: MapView): boolean {
  if (view.nodes.length <= 1) return false;
  const xs = new Set(view.nodes.map((n) => Math.round(n.position?.x ?? 0)));
  const ys = new Set(view.nodes.map((n) => Math.round(n.position?.y ?? 0)));
  return xs.size === 1 && ys.size === 1;
}

export default function Canvas() {
  return (
    <div className="canvas-area">
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>
      <Breadcrumb />
      <CodePeek />
    </div>
  );
}

function Flow() {
  const {
    view,
    selected,
    busy,
    justAddedId,
    selectNode,
    clearSelection,
    drillInto,
    renameNode,
    moveNode,
    createEdge,
  } = useStore();

  const [nodes, setNodes, onNodesChange] = useNodesState<SysNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SysEdge>([]);
  const { fitView } = useReactFlow();
  const lastFitRef = useRef<string>('__none__');
  const [pending, setPending] = useState<{ source: string; target: string } | null>(null);
  const [pendingLabel, setPendingLabel] = useState('');
  const [pendingKind, setPendingKind] = useState<EdgeKind>('depends');

  const buildNodes = useCallback(
    (v: MapView): SysNode[] => {
      const flat = positionsAreFlat(v);
      const fallback = flat ? layoutFallback(v) : null;
      return v.nodes.map((node) => ({
        id: node.id,
        type: 'sysNode' as const,
        position: fallback?.get(node.id) ?? { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
        width: 260,
        data: {
          node,
          onOpen: (n: MapNode) => {
            if (n.childCount > 0) void drillInto(n.id);
          },
          onRename: (id: string, label: string) => void renameNode(id, label),
          justAdded: node.id === justAddedId,
        } satisfies SysNodeData,
      }));
    },
    [drillInto, justAddedId, renameNode],
  );

  const buildEdges = useCallback((v: MapView): SysEdge[] => {
    const ids = new Set(v.nodes.map((n) => n.id));
    return v.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'sysEdge' as const,
        data: { edge: e },
        markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: '#3a3f4b' },
      }));
  }, []);

  useEffect(() => {
    if (!view) {
      setNodes([]);
      setEdges([]);
      return undefined;
    }
    setNodes(buildNodes(view));
    setEdges(buildEdges(view));
    const key = view.parent?.id ?? '__root__';
    if (lastFitRef.current !== key) {
      lastFitRef.current = key;
      const t = window.setTimeout(() => {
        void fitView({ padding: 0.3, duration: 240, maxZoom: 1 });
      }, 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [view, buildNodes, buildEdges, setNodes, setEdges, fitView]);

  // React Flow's own `selected` flag drives the highlight ring.
  useEffect(() => {
    setNodes((current) => current.map((n) => ({ ...n, selected: !!selected && n.id === selected.id })));
  }, [selected, setNodes]);

  // Escape cancels a pending connection before the shell's climb-out handler.
  useEffect(() => {
    if (!pending) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending]);

  const onNodeClick: NodeMouseHandler<SysNode> = useCallback(
    (_e, node) => selectNode(node.data.node),
    [selectNode],
  );

  const onNodeDoubleClick: NodeMouseHandler<SysNode> = useCallback(
    (_e, node) => {
      if (node.data.node.childCount > 0) void drillInto(node.id);
    },
    [drillInto],
  );

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    setPendingLabel('');
    setPendingKind('depends');
    setPending({ source: connection.source, target: connection.target });
  }, []);

  const submitPending = useCallback(() => {
    if (!pending) return;
    const label = pendingLabel.trim() || 'relates to';
    void createEdge({ source: pending.source, target: pending.target, label, kind: pendingKind });
    setPending(null);
  }, [pending, pendingLabel, pendingKind, createEdge]);

  const labelFor = useCallback(
    (id: string) => view?.nodes.find((n) => n.id === id)?.label ?? id,
    [view],
  );

  const isEmpty = !!view && view.nodes.length === 0;

  const minimapNodeColor = useCallback((n: Node) => {
    const data = n.data as SysNodeData | undefined;
    return ORIGIN_COLOR[data?.node?.origin ?? ''] ?? '#3a3f4b';
  }, []);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDragStop={(_e, node) => void moveNode(node.id, node.position)}
        onConnect={onConnect}
        onPaneClick={() => {
          setPending(null);
          clearSelection();
        }}
        fitView
        minZoom={0.25}
        maxZoom={1.6}
        nodesConnectable
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
        connectionLineStyle={{ stroke: '#4a5170', strokeWidth: 1.6 }}
        elevateEdgesOnSelect
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#191c22" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapNodeColor}
          nodeStrokeWidth={0}
          maskColor="rgba(9,10,13,0.72)"
          style={{ width: 148, height: 96 }}
        />
      </ReactFlow>

      {busy.view && !isEmpty && (
        <div className="canvas-loading">
          <span className="splash__spinner" />
        </div>
      )}

      {isEmpty && (
        <div className="canvas-empty">
          <div className="canvas-empty__box">
            <div className="canvas-empty__title">This level is empty</div>
            <div className="canvas-empty__text">
              Nothing meaningful is mapped here yet. Add a node in the header, or ask the agent to
              sketch this part of the system.
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="connect-form" role="dialog" aria-label="New connection">
          <div className="connect-form__head">
            <span className="connect-form__edge">
              {labelFor(pending.source)}
              <IconChevron size={11} />
              {labelFor(pending.target)}
            </span>
          </div>
          <div className="connect-form__row">
            <input
              className="input"
              autoFocus
              placeholder="How do they relate? e.g. “sends orders to”"
              value={pendingLabel}
              onChange={(e) => setPendingLabel(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') submitPending();
                if (e.key === 'Escape') setPending(null);
              }}
            />
            <select
              className="select connect-form__kind"
              value={pendingKind}
              onChange={(e) => setPendingKind(e.target.value as EdgeKind)}
            >
              {EDGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="connect-form__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary btn--sm" onClick={submitPending}>
              Connect
            </button>
          </div>
        </div>
      )}
    </>
  );
}
