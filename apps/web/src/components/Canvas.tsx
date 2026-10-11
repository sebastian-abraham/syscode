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
  useStore as useFlowStore,
  type Connection,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import type { EdgeKind, MapNode, MapView, NodeKind } from '../types.ts';
import { EDGE_KIND_COLOUR, edgePathStyle } from '../edgeStyle.ts';
import { useStore } from '../store.tsx';
import { useUi, type Theme } from '../ui.tsx';
import { NodeCard, type SysNode, type SysNodeData } from './NodeCard.tsx';
import SysEdgeComponent, { type SysEdge, type SysEdgeData } from './SysEdge.tsx';
import Breadcrumb from './Breadcrumb.tsx';
import CodePeek from './CodePeek.tsx';
import Legend from './Legend.tsx';
import Headline from './Headline.tsx';
import { IconChevron } from './icons.tsx';

const nodeTypes = { sysNode: NodeCard };
const edgeTypes = { sysEdge: SysEdgeComponent };

const EDGE_KINDS: EdgeKind[] = ['depends', 'data', 'triggers', 'stores', 'uses', 'custom'];

/**
 * The zoom the map is fitted to when it opens, and the floor under it.
 *
 * Fitting the *whole* map sounds right and is not: the root of fixtures/demo-app spans
 * a 2250×1500 flow box, so "show everything" lands at 0.31 — every card 80px wide with
 * 4px text, which is the unreadable grey grid this revamp exists to fix. So the opening
 * fit stops at a legible scale and lets the map run past the viewport edges; zooming
 * out is still there, one wheel-click away, and that is when the labels drop off.
 * (A compact root layout is the other half of this, and belongs to the engine.)
 */
const FIT_MIN_ZOOM = 0.62;

/**
 * Below this zoom an edge's verb would render smaller than the cards' own text, so
 * labels are only drawn at rest once the canvas is at or above it. Deliberately just
 * under FIT_MIN_ZOOM: the opening screen always shows the flows, and zooming out to
 * take in the whole picture drops the labels rather than piling them on top of cards.
 */
const LABEL_ZOOM = 0.58;

/** Levels 0 and 1 (a system, a subsystem) get extra width, so the hierarchy reads. */
const LEVEL_WIDTH: number[] = [16, 8, 0, 0];

/** Every card used to be 260px wide, which is why a System and a Component looked alike. */
const KIND_WIDTH: Record<NodeKind, number> = {
  system: 300,
  subsystem: 284,
  feature: 268,
  component: 260,
  data: 252,
  external: 244,
  concern: 248,
  planned: 248,
};

function nodeWidth(node: MapNode): number {
  return Math.round(KIND_WIDTH[node.kind] + (LEVEL_WIDTH[node.level] ?? 0));
}

/**
 * The colours React Flow draws itself — dots, arrowheads, the minimap and the
 * in-flight connection line. They are passed as props, not CSS, so they cannot
 * come from a token; each theme gets its own set here and `colorMode` keeps the
 * built-in chrome (controls, minimap frame) in step.
 */
const CANVAS: Record<Theme, {
  dot: string;
  edgeMarker: string;
  connection: string;
  minimapMask: string;
  fallback: string;
  origin: Record<string, string>;
}> = {
  dark: {
    dot: '#191c22',
    edgeMarker: '#3a3f4b',
    connection: '#4a5170',
    minimapMask: 'rgba(9, 10, 13, 0.72)',
    fallback: '#3a3f4b',
    origin: { verified: '#79b892', inferred: '#c9a86a', user: '#8aa9f5', planned: '#a78bd6' },
  },
  light: {
    dot: '#ccd2dd',
    edgeMarker: '#98a2b2',
    connection: '#7d8798',
    minimapMask: 'rgba(236, 238, 242, 0.66)',
    fallback: '#c3c9d4',
    origin: { verified: '#2f8a5b', inferred: '#a9761c', user: '#3b62d0', planned: '#7a4fc0' },
  },
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
  // The canvas is measured from here so the map can be re-fitted when the window settles.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="canvas-area" ref={wrapRef}>
      <ReactFlowProvider>
        <Flow wrapRef={wrapRef} />
      </ReactFlowProvider>
      <Legend />
      <Headline />
      <Breadcrumb />
      <CodePeek />
    </div>
  );
}

function Flow({ wrapRef }: { wrapRef: React.RefObject<HTMLDivElement | null> }) {
  const {
    view,
    busy,
    justAddedId,
    selected,
    selectNode,
    clearSelection,
    drillInto,
    renameNode,
    moveNode,
    createEdge,
  } = useStore();
  const { theme } = useUi();
  const c = CANVAS[theme];

  // The label level of detail. One subscription for the whole canvas, deliberately:
  // the alternative is one viewport subscription per edge, which is 60 of them on a
  // root map. The boolean selector means this re-renders once per threshold crossing,
  // not once per frame of a zoom.
  const labelsOn = useFlowStore((s) => s.transform[2] >= LABEL_ZOOM);
  const focusId = selected?.id ?? null;

  const [nodes, setNodes, onNodesChange] = useNodesState<SysNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SysEdge>([]);
  const { fitView, setViewport } = useReactFlow();
  const lastFitRef = useRef<string>('__none__');
  // Set once the developer pans or zooms by hand: after that the view is theirs, and a
  // window resize must not throw their framing away.
  const userAdjustedRef = useRef(false);
  const [pending, setPending] = useState<{ source: string; target: string } | null>(null);
  // One-frame flag that forces WebKit to rebuild the canvas surface after a gesture, so the
  // scaled layer is not left showing a raster from the previous zoom level.
  const [reraster, setReraster] = useState(false);
  const [pendingLabel, setPendingLabel] = useState('');
  const [pendingKind, setPendingKind] = useState<EdgeKind>('depends');

  const buildNodes = useCallback(
    (v: MapView): SysNode[] => {
      const flat = positionsAreFlat(v);
      const fallback = flat ? layoutFallback(v) : null;
      return v.nodes.map((node) => ({
        id: node.id,
        type: 'sysNode' as const,
        // Whole pixels only. The canvas is scaled, so a fractional position lands the node
        // on a fraction of a device pixel: the text inside is then resampled on every
        // repaint and goes soft — visibly so right after a selection repaints the layer.
        position: (() => {
          const p = fallback?.get(node.id) ?? { x: node.position?.x ?? 0, y: node.position?.y ?? 0 };
          return { x: Math.round(p.x), y: Math.round(p.y) };
        })(),
        width: nodeWidth(node),
        style: { width: nodeWidth(node) },
        data: {
          node,
          onOpen: (n: MapNode) => {
            if (n.childCount > 0) void drillInto(n.id);
          },
          onRename: (id: string, label: string) => void renameNode(id, label),
          // The card's own "read more" opens the inspector for this node rather than
          // unclamping the summary in place — the card stays a card at every level.
          onDetails: (n: MapNode) => selectNode(n),
          justAdded: node.id === justAddedId,
        } satisfies SysNodeData,
      }));
    },
    [drillInto, justAddedId, renameNode, selectNode],
  );

  const buildEdges = useCallback(
    (v: MapView, focus: string | null, labels: boolean): SysEdge[] => {
      const ids = new Set(v.nodes.map((n) => n.id));
      return v.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => {
          const incident = focus !== null && (e.source === focus || e.target === focus);
          const dim = focus !== null && !incident;
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            type: 'sysEdge' as const,
            // The classes carry the two readings of a link (what it is / how it is known)
            // plus the focus state; the line itself is styled by React Flow from `style`.
            className: [
              'edge',
              `edge--k-${e.kind}`,
              `edge--o-${e.origin}`,
              incident ? 'edge--incident' : '',
              dim ? 'edge--dim' : '',
            ]
              .filter(Boolean)
              .join(' '),
            data: {
              edge: e,
              labelVisible: incident || (labels && !dim),
              dim,
            } satisfies SysEdgeData,
            style: edgePathStyle(e),
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 13,
              height: 13,
              color: EDGE_KIND_COLOUR[theme][e.kind],
            },
          };
        });
    },
    [theme],
  );

  useEffect(() => {
    if (!view) {
      setNodes([]);
      setEdges([]);
      return undefined;
    }
    // Keep whatever is selected selected: this rebuild replaces every node object, and
    // React Flow's own selection flag lives on those objects.
    setNodes((current) => {
      const wasSelected = new Set(current.filter((n) => n.selected).map((n) => n.id));
      return buildNodes(view).map((n) => (wasSelected.has(n.id) ? { ...n, selected: true } : n));
    });
    const key = view.parent?.id ?? '__root__';
    if (lastFitRef.current !== key) {
      lastFitRef.current = key;
      const t = window.setTimeout(() => {
        void fitView({ padding: 0.3, duration: 240, maxZoom: 1, minZoom: FIT_MIN_ZOOM });
      }, 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [view, buildNodes, setNodes, fitView]);

  // Edges are rebuilt when the view, the selected node or the label threshold changes.
  // Both of those decisions belong here rather than inside every edge component: an
  // edge component that read the viewport itself would mean 60 viewport subscriptions
  // on a root map, and the labels would then re-render one at a time.
  useEffect(() => {
    if (!view) return;
    setEdges(buildEdges(view, focusId, labelsOn));
  }, [view, focusId, labelsOn, buildEdges, setEdges]);

  // The window settles *after* the first paint: a tiled compositor hands the window its real
  // size a moment later, and that size is not the one the map was fitted to. The result is a
  // map framed for a wider window, so the right-hand side is clipped until something else
  // re-fits it. Watch the canvas and re-fit whenever its size actually changes — unless the
  // developer has taken the view over by hand, in which case it is theirs to keep.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (Math.abs(w - lastW) < 8 && Math.abs(h - lastH) < 8) return;
      lastW = w;
      lastH = h;
      if (userAdjustedRef.current) return;
      void fitView({ padding: 0.3, duration: 0, maxZoom: 1, minZoom: FIT_MIN_ZOOM });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitView, wrapRef]);

  // Selection is React Flow's own: clicking a node sets `selected` on that node and
  // re-renders it alone. This used to be mirrored into the whole nodes array on every
  // selection change, which rebuilt every node object — so a single click repainted the
  // entire (scaled) canvas layer. Measured in the real webview: 108 frames missed per
  // 4s of clicking, and the text went soft while it re-rasterized. The store's selection
  // is still what drives the inspector; the canvas no longer needs to know about it.

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
    return c.origin[data?.node?.origin ?? ''] ?? c.fallback;
  }, [c]);

  return (
    <>
      <ReactFlow
        className={
          [reraster ? 'react-flow--reraster' : '', labelsOn ? 'react-flow--labels' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDragStop={(_e, node) => void moveNode(node.id, node.position)}
        // When the gesture ends, settle the canvas on whole pixels. The whole map is drawn
        // inside one scaled layer, so a fractional translation makes every repaint resample
        // the text — this is what keeps it from going soft after an interaction.
        onMoveStart={(event) => {
          // A user gesture (non-null event) means the framing is now theirs; a programmatic
          // fit passes null and must not count.
          if (event) userAdjustedRef.current = true;
        }}
        onMoveEnd={(_e, viewport) => {
          const x = Math.round(viewport.x);
          const y = Math.round(viewport.y);
          // Drop the gesture hint and make the canvas rebuild its surface at the final
          // scale. WebKitGTK keeps the scaled layer's raster and simply scales it again
          // after a pan or zoom, so the map goes soft until something inside it happens to
          // repaint — which is why touching an edge used to snap it back to full quality.
          // Force that repaint ourselves: one frame of imperceptible transparency makes
          // WebKit build a fresh surface, drawn at the scale the canvas is actually at now.
          setReraster(true);
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(() => setReraster(false)),
          );
          if (x !== viewport.x || y !== viewport.y) void setViewport({ x, y, zoom: viewport.zoom });
        }}
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
        colorMode={theme}
        connectionLineStyle={{ stroke: c.connection, strokeWidth: 1.6 }}
        elevateEdgesOnSelect
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color={c.dot} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapNodeColor}
          nodeStrokeWidth={0}
          maskColor={c.minimapMask}
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
