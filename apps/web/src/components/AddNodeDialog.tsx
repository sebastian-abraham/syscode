import { useEffect, useState } from 'react';
import { useStore } from '../store.tsx';
import type { MapNode } from '../types.ts';

const KINDS: MapNode['kind'][] = [
  'feature',
  'subsystem',
  'component',
  'data',
  'external',
  'concern',
  'planned',
  'system',
];

export default function AddNodeDialog() {
  const { addNodeOpen, setAddNodeOpen, view, viewParentId, createNode, busy } = useStore();
  const [label, setLabel] = useState('');
  const [summary, setSummary] = useState('');
  const [kind, setKind] = useState<MapNode['kind']>('feature');
  const [parentChoice, setParentChoice] = useState<string>('__current__');

  useEffect(() => {
    if (addNodeOpen) {
      setLabel('');
      setSummary('');
      setKind('feature');
      setParentChoice('__current__');
    }
  }, [addNodeOpen]);

  if (!addNodeOpen) return null;

  const currentParent = view?.parent ?? null;
  const candidates = (view?.nodes ?? []).filter((n) => n.id !== currentParent?.id);

  const resolveParent = (): string | null => {
    if (parentChoice === '__current__') return viewParentId;
    if (parentChoice === '__root__') return null;
    return parentChoice;
  };

  const submit = async () => {
    if (!label.trim() || !summary.trim()) return;
    const node = await createNode({
      label: label.trim(),
      summary: summary.trim(),
      kind,
      parentId: resolveParent(),
    });
    if (node) setAddNodeOpen(false);
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && setAddNodeOpen(false)}
    >
      <div className="dialog" role="dialog" aria-label="Add node">
        <header className="dialog__head">
          <div className="grow">
            <div className="dialog__title">Add a node</div>
            <div className="dialog__sub">
              Describe a part of the system in plain language. It is marked as yours and the agent
              will not silently rewrite it.
            </div>
          </div>
        </header>

        <div className="dialog__body">
          <div className="form-row">
            <label className="form-row__label" htmlFor="add-label">
              Name
            </label>
            <input
              id="add-label"
              className="input"
              autoFocus
              placeholder="e.g. Referrals"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          <div className="form-row">
            <label className="form-row__label" htmlFor="add-summary">
              What it is, in plain language
            </label>
            <textarea
              id="add-summary"
              className="textarea"
              placeholder="e.g. Users earn credits when they invite someone; credits expire after 90 days."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="form-row__help">
              This sentence is what shows on the canvas — lead with meaning, not file names.
            </div>
          </div>

          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="form-row grow">
              <label className="form-row__label" htmlFor="add-kind">
                Kind
              </label>
              <select
                id="add-kind"
                className="select"
                value={kind}
                onChange={(e) => setKind(e.target.value as MapNode['kind'])}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row grow">
              <label className="form-row__label" htmlFor="add-parent">
                Belongs to
              </label>
              <select
                id="add-parent"
                className="select"
                value={parentChoice}
                onChange={(e) => setParentChoice(e.target.value)}
              >
                <option value="__current__">
                  {currentParent ? `Inside ${currentParent.label}` : 'Current level (top)'}
                </option>
                {candidates.map((n) => (
                  <option key={n.id} value={n.id}>
                    Inside {n.label}
                  </option>
                ))}
                <option value="__root__">Top level</option>
              </select>
            </div>
          </div>
        </div>

        <footer className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={() => setAddNodeOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={!label.trim() || !summary.trim() || busy.node}
          >
            {busy.node ? 'Adding…' : 'Add node'}
          </button>
        </footer>
      </div>
    </div>
  );
}
