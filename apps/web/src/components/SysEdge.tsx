import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

/**
 * Thin muted edge whose label stays hidden until the edge is hovered or
 * selected. Keeping labels off the resting canvas is what stops them colliding
 * with node cards (see the visual direction in docs/CONTRACT.md).
 */
export default function SysEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const show = hovered || selected;

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
      {show && label ? (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
