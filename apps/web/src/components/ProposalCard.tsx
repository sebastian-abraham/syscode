import { useStore } from '../store.tsx';
import type { MapOp, Proposal } from '../types.ts';
import { IconCheck, IconX } from './icons.tsx';

export function describeOp(op: MapOp, labelFor: (id: string) => string): { kind: string; text: string } {
  switch (op.op) {
    case 'add-node':
      return { kind: 'add node', text: `“${op.node.label}” — ${op.node.summary}` };
    case 'add-edge':
      return {
        kind: 'connect',
        text: `${labelFor(op.edge.source)} → ${labelFor(op.edge.target)}: “${op.edge.label}”`,
      };
    case 'rename-node':
      return { kind: 'rename', text: `${labelFor(op.nodeId)} → “${op.label}”` };
    case 'reanchor-node':
      return { kind: 're-anchor', text: `${labelFor(op.nodeId)} → ${op.anchors.length} anchor(s)` };
    case 'update-summary':
      return { kind: 'rewrite', text: `${labelFor(op.nodeId)} — ${op.summary}` };
    case 'move-node':
      return {
        kind: 'move',
        text: `${labelFor(op.nodeId)} → ${op.parentId ? labelFor(op.parentId) : 'top level'}`,
      };
    case 'remove-node':
      return { kind: 'remove node', text: labelFor(op.nodeId) };
    case 'remove-edge':
      return { kind: 'remove edge', text: `edge ${op.edgeId}` };
    default:
      return { kind: 'change', text: '' };
  }
}

export default function ProposalCard({
  proposal,
  inline = false,
}: {
  proposal: Proposal;
  inline?: boolean;
}) {
  const { proposals, view, approveProposal, rejectProposal } = useStore();
  const live = proposals.find((p) => p.id === proposal.id) ?? proposal;
  const pending = live.status === 'pending';
  const labelFor = (id: string) => view?.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <article className={`proposal${inline ? ' proposal--inline' : ''}`}>
      <div className="proposal__head">
        <span className={`chip chip--${live.origin}`}>
          <span className="chip__dot" />
          {live.origin === 'user' ? 'yours' : live.origin}
        </span>
        <span className="proposal__title">{live.title}</span>
        {!pending && (
          <span
            className="proposal__status"
            style={{ color: live.status === 'approved' ? 'var(--verified)' : 'var(--text-3)' }}
          >
            {live.status}
          </span>
        )}
      </div>

      {live.rationale && <div className="proposal__rationale">{live.rationale}</div>}

      <div className="proposal__ops">
        {live.ops.map((op, i) => {
          const d = describeOp(op, labelFor);
          return (
            <div className="op-row" key={i}>
              <span className="op-row__kind">{d.kind}</span>
              <span className="op-row__text">{d.text}</span>
            </div>
          );
        })}
      </div>

      {pending && (
        <div className="proposal__actions">
          <button type="button" className="btn btn--sm" onClick={() => void rejectProposal(live.id)}>
            <IconX size={13} />
            Reject
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void approveProposal(live.id)}
          >
            <IconCheck size={13} />
            Approve
          </button>
        </div>
      )}
    </article>
  );
}
