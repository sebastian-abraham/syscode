import { useEffect, useState } from 'react';
import { useStore } from '../store.tsx';
import ProposalCard from './ProposalCard.tsx';
import ModelDialog from './ModelDialog.tsx';
import MemoryDialog from './MemoryDialog.tsx';
import { IconAlert, IconLayers, IconMap, IconPlus, IconRefresh, IconSpark } from './icons.tsx';

export default function HeaderBar() {
  const { project, view, pendingProposals, refresh, busy, setAddNodeOpen, goToStart, openRefine } = useStore();
  const [propsOpen, setPropsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const heuristic = project?.brain.mode === 'heuristic';
  const staleCount = view?.staleCount ?? project?.stats.staleCount ?? 0;
  const pending = pendingProposals.length;

  useEffect(() => {
    if (pending === 0) setPropsOpen(false);
  }, [pending]);

  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__mark" aria-hidden="true">
          <IconMap size={13} />
        </span>
        <button
          type="button"
          className="header__title header__title--button"
          onClick={goToStart}
          title="Back to the start screen — recent projects, open a folder, create a project"
        >
          {project?.name ?? 'SysCode'}
        </button>
        {project?.root && <span className="header__root">{project.root}</span>}
      </div>

      <div className="header__spacer" />

      <div className="header__group">
        <button
          type="button"
          className={`brain-badge brain-badge--${heuristic ? 'heuristic' : 'model'}`}
          onClick={() => setModelOpen(true)}
          title={
            heuristic
              ? 'This map was built by the deterministic fallback — connect a model for richer meaning'
              : 'A model produced this map'
          }
        >
          <IconSpark size={12} />
          {heuristic
            ? 'Heuristic map'
            : `Model · ${project?.brain.model ?? project?.brain.provider ?? 'connected'}`}
        </button>

        {heuristic && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setModelOpen(true)}>
            Connect a model
          </button>
        )}

        {staleCount > 0 && (
          <span className="chip chip--stale" title={`${staleCount} node(s) whose code changed`}>
            <IconAlert size={11} />
            {staleCount} stale
          </span>
        )}
      </div>

      <div className="header__group">
        <button
          type="button"
          className="btn"
          onClick={() => setMemoryOpen(true)}
          title="What the agent has understood about this project"
        >
          <IconLayers size={14} />
          Memory
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => void openRefine(null)}
          disabled={busy.refine}
          title="Ask the model to re-name and re-explain the map — arrives as a proposal"
        >
          <IconSpark size={14} className={busy.refine ? 'spin' : undefined} />
          {busy.refine ? 'Refining…' : 'Refine'}
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => void refresh()}
          disabled={busy.refresh}
          title="Re-analyze the repo and diff it against the map"
        >
          <IconRefresh size={14} className={busy.refresh ? 'spin' : undefined} />
          {busy.refresh ? 'Refreshing…' : 'Refresh'}
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn"
            onClick={() => setPropsOpen((v) => !v)}
            title="Pending design proposals"
          >
            Proposals
            <span className={`badge-count${pending === 0 ? ' badge-count--muted' : ''}`}>{pending}</span>
          </button>
          {propsOpen && pending > 0 && (
            <>
              <div className="popover-backdrop" onClick={() => setPropsOpen(false)} />
              <div className="popover">
                <div className="popover__title">Pending proposals — approve before anything changes</div>
                {pendingProposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} />
                ))}
              </div>
            </>
          )}
        </div>

        <button type="button" className="btn btn--primary" onClick={() => setAddNodeOpen(true)}>
          <IconPlus size={14} />
          Add node
        </button>
      </div>

      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}
      {memoryOpen && <MemoryDialog onClose={() => setMemoryOpen(false)} />}
    </header>
  );
}
