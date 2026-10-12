import { useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { MapEdge } from '../types.ts';
import { edgeTitle } from '../edgeStyle.ts';

/**
 * What the canvas hands an edge: the model edge, plus what the *current* view says
 * about it. The canvas owns both decisions (it is the only thing that knows the zoom
 * and the selected node), so this component stays presentational and cheap: it does
 * not subscribe to the viewport, and it re-renders only when its own data changes.
 */
export type SysEdgeData = {
  edge: MapEdge;
  /** The verb should be readable at rest: the zoom is high enough, or this edge is
   *  one of the selected node's own. */
  labelVisible: boolean;
  /** Another node is focused and this edge is not incident to it. */
  dim: boolean;
};

export type SysEdge = Edge<SysEdgeData, 'sysEdge'>;

/**
 * An edge that says what it is. Colour and dash come from the edge's kind and
 * origin (see edgeStyle.ts); the verb sits on the line at rest once the canvas is
 * zoomed in far enough for it to be legible, and appears on hover/selection at any
 * zoom. Hovering an edge also promotes it over the dimmed background.
 */
export default function SysEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
  selected,
}: EdgeProps<SysEdge>) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const edge = data?.edge;
  const show = hovered || selected || Boolean(data?.labelVisible);
  const classes = [
    'edge-label',
    hovered || selected ? 'edge-label--hi' : '',
    data?.dim && !hovered && !selected ? 'edge-label--dim' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {/* Wider invisible path so the thin line is easy to hover. */}
      <path
        d={path}
        fill="none"
        strokeWidth={18}
        stroke="transparent"
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {show && edge?.label ? (
        <EdgeLabelRenderer>
          <div
            className={classes}
            // What the edge is, how sure the map is, and the lines it was found on.
            title={edgeTitle(edge)}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {edge.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
