import { useEffect, useState } from 'react';
import { useStore, type InspectorTab } from '../store.tsx';
import type { MapNode, Note } from '../types.ts';
import ContextPanel from './ContextPanel.tsx';
import { IconChevron, IconCode, IconLock, IconTag, IconX } from './icons.tsx';

const KIND_LABEL: Record<MapNode['kind'], string> = {
  system: 'System',
  subsystem: 'Subsystem',
  feature: 'Feature',
  component: 'Component',
  data: 'Data',
  external: 'External',
  concern: 'Concern',
  planned: 'Planned',
};

const ORIGIN_LABEL: Record<MapNode['origin'], string> = {
  verified: 'verified from code',
  inferred: 'inferred by the agent',
  user: 'yours',
  planned: 'planned',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Inspector() {
  const {
    selected,
    selectedContext,
    journal,
    inspectorTab,
    setInspectorTab,
    clearSelection,
    loadContext,
    openCodePeek,
    drillInto,
    addNote,
    deleteNote,
  } = useStore();

  const nodeId = selected?.id ?? null;

  useEffect(() => {
    if (inspectorTab !== 'context') return;
    if (!nodeId) return;
    if (selectedContext && selectedContext.nodeId === nodeId) return;
    void loadContext(nodeId);
  }, [inspectorTab, nodeId, selectedContext, loadContext]);

  if (!selected && !selectedContext) return null;

  const tabs: InspectorTab[] = selected ? ['overview', 'notes', 'context', 'journal'] : ['context'];
  const active: InspectorTab = tabs.includes(inspectorTab) ? inspectorTab : tabs[0];

  return (
    <aside className="panel inspector">
      <header className="panel__head">
        <span className="panel__title">Inspector</span>
        {selected && (
          <button
            type="button"
            className="close-x"
            onClick={clearSelection}
            title="Close inspector"
            aria-label="Close inspector"
          >
            <IconX size={14} />
          </button>
        )}
      </header>

      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active === tab}
            className={`tab${active === tab ? ' tab--active' : ''}`}
            onClick={() => setInspectorTab(tab)}
          >
            {tab === 'overview' ? 'Overview' : tab === 'notes' ? 'Notes' : tab === 'context' ? 'Context' : 'Journal'}
          </button>
        ))}
      </div>

      <div className="panel__body">
        {active === 'overview' && selected && (
          <Overview
            node={selected}
            onAnchor={(i) => void openCodePeek(selected, i)}
            onOpenChildren={() => void drillInto(selected.id)}
          />
        )}
        {active === 'notes' && selected && (
          <Notes node={selected} onAdd={addNote} onDelete={deleteNote} />
        )}
        {active === 'context' && (
          <ContextPanel
            context={
              selected
                ? selectedContext && selectedContext.nodeId === selected.id
                  ? selectedContext
                  : null
                : selectedContext
            }
          />
        )}
        {active === 'journal' && selected && (
          <Journal nodeId={selected.id} entries={journal} />
        )}
      </div>
    </aside>
  );
}

function Overview({
  node,
  onAnchor,
  onOpenChildren,
}: {
  node: MapNode;
  onAnchor: (index: number) => void;
  onOpenChildren: () => void;
}) {
  return (
    <div>
      <div className="inspector__title">{node.label}</div>
      <div className="inspector__chips">
        <span className={`chip chip--${node.origin}`}>
          <span className="chip__dot" />
          {ORIGIN_LABEL[node.origin]}
        </span>
        <span className="chip chip--kind">{KIND_LABEL[node.kind]}</span>
        <span className="chip chip--quiet">level {node.level}</span>
        {node.stale && <span className="chip chip--stale">code changed</span>}
        {node.heuristic && <span className="chip chip--inferred">heuristic</span>}
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <div className="field__label">What this is</div>
        <div className="field__value">{node.summary}</div>
      </div>

      {node.detail && (
        <div className="field">
          <div className="field__label">Detail</div>
          <div className="field__value">{node.detail}</div>
        </div>
      )}

      <div className="field">
        <div className="field__label">Size</div>
        <div className="field__value field__value--strong">
          {node.metrics.files} {node.metrics.files === 1 ? 'file' : 'files'} ·{' '}
          {node.metrics.loc.toLocaleString()} lines · {node.metrics.symbols} symbols
        </div>
      </div>

      {(node.positionLocked || node.labelLocked) && (
        <div className="field">
          <div className="field__label">Protected from the agent</div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {node.positionLocked && (
              <span className="chip chip--quiet">
                <IconLock size={11} /> position pinned
              </span>
            )}
            {node.labelLocked && (
              <span className="chip chip--quiet">
                <IconTag size={11} /> label protected
              </span>
            )}
          </div>
        </div>
      )}

      <div className="field">
        <div className="field__label">Anchors — links back to real code</div>
        {node.anchors.length === 0 ? (
          <div className="empty-note">
            {node.origin === 'planned'
              ? 'Planned — no code exists for this node yet.'
              : 'No code anchors recorded for this node.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {node.anchors.map((a, i) => {
              const line = a.lines?.[0];
              return (
                <button
                  key={`${a.path}-${i}`}
                  type="button"
                  className="anchor-row"
                  onClick={() => onAnchor(i)}
                  title={`Open ${a.path}${line ? `:${line}` : ''}`}
                >
                  <IconCode size={12} />
                  <span className="anchor-row__path">
                    {a.path}
                    {line ? `:${line}` : ''}
                  </span>
                  <span className="anchor-row__kind">{a.symbol ?? a.kind}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {node.childCount > 0 && (
        <button type="button" className="btn" style={{ width: '100%' }} onClick={onOpenChildren}>
          Open {node.childCount} child {node.childCount === 1 ? 'node' : 'nodes'}
          <IconChevron size={13} />
        </button>
      )}
    </div>
  );
}

function Notes({
  node,
  onAdd,
  onDelete,
}: {
  node: MapNode;
  onAdd: (nodeId: string, body: string, kind: Note['kind']) => Promise<void>;
  onDelete: (nodeId: string, noteId: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Note['kind']>('note');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);
    await onAdd(node.id, text, kind);
    setSaving(false);
    setBody('');
  };

  return (
    <div>
      {node.notes.length === 0 && (
        <div className="empty-note">
          No notes yet. Pin a constraint (“never call the database directly here”) and the agent
          will be told about it.
        </div>
      )}
      {node.notes.map((note) => (
        <div className={`note note--${note.kind}`} key={note.id}>
          <div className="note__head">
            <span className="chip chip--quiet">{note.kind}</span>
            <span className="note__meta">
              {note.author === 'agent' ? 'agent' : 'you'} · {fmtTime(note.createdAt)}
            </span>
            <button
              type="button"
              className="close-x"
              style={{ width: 20, height: 20 }}
              onClick={() => void onDelete(node.id, note.id)}
              title="Remove note"
              aria-label="Remove note"
            >
              <IconX size={12} />
            </button>
          </div>
          <div className="note__body">{note.body}</div>
        </div>
      ))}

      <div className="field" style={{ marginTop: 14 }}>
        <div className="field__label">Add a note or constraint</div>
        <textarea
          className="textarea"
          placeholder="A decision, a gotcha, or a rule the agent must respect…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <select
            className="select"
            style={{ width: 150 }}
            value={kind}
            onChange={(e) => setKind(e.target.value as Note['kind'])}
          >
            <option value="note">note</option>
            <option value="constraint">constraint</option>
            <option value="decision">decision</option>
          </select>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={!body.trim() || saving}
          >
            {saving ? 'Pinning…' : 'Pin to node'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Journal({
  nodeId,
  entries,
}: {
  nodeId: string;
  entries: ReturnType<typeof useStore>['journal'];
}) {
  const mine = entries.filter((e) => e.nodeId === nodeId);
  if (mine.length === 0) {
    return <div className="empty-note">No journal entries for this node yet.</div>;
  }
  return (
    <div>
      {mine.map((entry) => (
        <div className="journal-entry" key={entry.id}>
          <span className={`journal-entry__dot journal-entry__dot--${entry.actor}`} />
          <div className="journal-entry__body">
            <div className="journal-entry__action">{entry.action}</div>
            <div className="journal-entry__detail">{entry.detail}</div>
            <div className="journal-entry__time">
              {entry.actor} · {fmtTime(entry.at)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
