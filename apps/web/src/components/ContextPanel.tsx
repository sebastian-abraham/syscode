import type { ContextItem, ScopedContext } from '../types.ts';

const KIND_LABEL: Record<ContextItem['kind'], string> = {
  node: 'node',
  code: 'code',
  note: 'note',
  edge: 'edge',
  memory: 'memory',
  constraint: 'constraint',
};

export default function ContextPanel({ context }: { context: ScopedContext | null }) {
  if (!context) {
    return <div className="empty-note">No context captured yet for this node.</div>;
  }

  const pct =
    context.budgetTokens > 0
      ? Math.min(100, Math.round((context.totalTokens / context.budgetTokens) * 100))
      : 0;
  const over = context.budgetTokens > 0 && context.totalTokens > context.budgetTokens;

  return (
    <div>
      <div className="ctx-summary">
        <span className="field__label" style={{ margin: 0 }}>
          What the agent was given
        </span>
        <span className="faint mono" style={{ fontSize: 11 }}>
          {context.totalTokens.toLocaleString()} / {context.budgetTokens.toLocaleString()} tokens
        </span>
      </div>
      <div className="ctx-budget" title={`${pct}% of the node's context budget`}>
        <div
          className="ctx-budget__fill"
          style={{ width: `${pct}%`, background: over ? 'var(--stale)' : undefined }}
        />
      </div>

      {context.items.length === 0 && (
        <div className="empty-note">Nothing is attached to this node yet — the agent sees only the node itself.</div>
      )}

      {context.items.map((item, i) => (
        <article className="ctx-item" key={`${item.kind}-${i}`}>
          <div className="ctx-item__head">
            <span className={`chip chip--${kindChip(item.kind)}`}>{KIND_LABEL[item.kind]}</span>
            <span className="ctx-item__label" title={item.label}>
              {item.label}
            </span>
            {item.truncated && (
              <span className="chip tag-trunc" title="This item was truncated to fit the budget">
                truncated
              </span>
            )}
            <span className="ctx-item__tokens">{item.tokens.toLocaleString()} tok</span>
          </div>
          {item.source && (
            <div className="ctx-item__src" title={item.source}>
              {item.source}
            </div>
          )}
          <pre className="ctx-item__content">{item.content}</pre>
        </article>
      ))}
    </div>
  );
}

function kindChip(kind: ContextItem['kind']): string {
  switch (kind) {
    case 'constraint':
      return 'inferred';
    case 'note':
      return 'user';
    case 'code':
      return 'verified';
    default:
      return 'kind';
  }
}
