import { useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { MapNode, NodeKind, Provenance } from '../types.ts';
import { IconChevron, IconLock, IconTag } from './icons.tsx';

export type SysNodeData = {
  node: MapNode;
  onOpen: (node: MapNode) => void;
  onRename: (id: string, label: string) => void;
  justAdded: boolean;
};

export type SysNode = Node<SysNodeData, 'sysNode'>;

const KIND_LABEL: Record<NodeKind, string> = {
  system: 'System',
  subsystem: 'Subsystem',
  feature: 'Feature',
  component: 'Component',
  data: 'Data',
  external: 'External',
  concern: 'Concern',
  planned: 'Planned',
};

const ORIGIN_LABEL: Record<Provenance, string> = {
  verified: 'verified from code',
  inferred: 'inferred',
  user: 'yours',
  planned: 'planned',
};

function metricLine(node: MapNode): string {
  const { files, loc } = node.metrics;
  if (node.kind === 'external') {
    // an external service has no code of its own; what matters is how it is reached
    return files ? `reached from ${files} file${files === 1 ? '' : 's'}` : 'external service';
  }
  if (!files) return 'no code yet';
  const f = `${files} ${files === 1 ? 'file' : 'files'}`;
  const l = `${loc.toLocaleString()} ${loc === 1 ? 'line' : 'lines'}`;
  return `${f} · ${l}`;
}

export function NodeCard({ data, selected }: NodeProps<SysNode>) {
  const { node, onOpen, onRename, justAdded } = data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(node.label);
  }, [node.label]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== node.label) onRename(node.id, next);
    else setDraft(node.label);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(node.label);
  };

  const classes = [
    'node',
    `node--${node.origin}`,
    selected ? 'node--selected' : '',
    node.stale ? 'node--stale' : '',
    justAdded ? 'node--just-added' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-node-id={node.id}>
      <Handle type="target" position={Position.Top} />
      <div className="node__top">
        <div className="grow">
          {editing ? (
            <input
              ref={inputRef}
              className="node__rename-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') cancel();
              }}
            />
          ) : (
            <div
              className="node__title"
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              {node.label}
            </div>
          )}
        </div>
        {(node.positionLocked || node.labelLocked) && (
          <div className="node__locks" title={lockTitle(node)}>
            {node.positionLocked && <IconLock size={12} />}
            {node.labelLocked && <IconTag size={12} />}
          </div>
        )}
      </div>

      <div className="node__chips">
        <span className={`chip chip--${node.origin}`}>
          <span className="chip__dot" />
          {ORIGIN_LABEL[node.origin]}
        </span>
        <span className="chip chip--kind">{KIND_LABEL[node.kind]}</span>
        {node.stale && (
          <span className="chip chip--stale" title="Code changed since the map agreed">
            code changed
          </span>
        )}
      </div>

      <div className="node__summary">{node.summary}</div>

      <div className="node__metric">
        <span>{metricLine(node)}</span>
        {node.anchors.length > 0 && (
          <>
            <span className="node__sep" />
            <span>{node.anchors.length} anchor{node.anchors.length === 1 ? '' : 's'}</span>
          </>
        )}
      </div>

      {node.childCount > 0 && (
        <div className="node__footer">
          <span className="node__hint">
            {node.childCount} inside
          </span>
          <button
            type="button"
            className="node__open nodrag"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(node);
            }}
            title={`Open ${node.label}`}
          >
            Open
            <IconChevron size={12} />
          </button>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function lockTitle(node: MapNode): string {
  const parts: string[] = [];
  if (node.positionLocked) parts.push('position pinned by you');
  if (node.labelLocked) parts.push('label protected from the agent');
  return parts.join(' · ');
}
