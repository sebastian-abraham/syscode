import { useEffect, useState } from 'react';
import { useStore } from '../store.tsx';
import { useUi } from '../ui.tsx';
import ProposalCard from './ProposalCard.tsx';
import ModelDialog from './ModelDialog.tsx';
import MemoryDialog from './MemoryDialog.tsx';
import {
  IconAlert,
  IconLayers,
  IconMap,
  IconMoon,
  IconPanel,
  IconPlus,
  IconRefresh,
  IconSpark,
  IconSun,
} from './icons.tsx';

export default function HeaderBar() {
  const { project, view, pendingProposals, refresh, busy, setAddNodeOpen, goToStart, openRefine } = useStore();
  const { theme, toggleTheme, chatOpen, toggleChat } = useUi();
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

      <div className="header__group header__group--status">
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
            <IconSpark size={12} />
            <span className="btn__label">Connect a model</span>
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
          <span className="btn__label">Memory</span>
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => void openRefine(null)}
          disabled={busy.refine}
          title="Ask the model to re-name and re-explain the map — arrives as a proposal"
        >
          <IconSpark size={14} className={busy.refine ? 'spin' : undefined} />
          <span className="btn__label">{busy.refine ? 'Refining…' : 'Refine'}</span>
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => void refresh()}
          disabled={busy.refresh}
          title="Re-analyze the repo and diff it against the map"
        >
          <IconRefresh size={14} className={busy.refresh ? 'spin' : undefined} />
          <span className="btn__label">{busy.refresh ? 'Refreshing…' : 'Refresh'}</span>
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn"
            onClick={() => setPropsOpen((v) => !v)}
            title="Pending design proposals"
          >
            <span className="btn__label">Proposals</span>
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
          <span className="btn__label">Add node</span>
        </button>
      </div>

      <div className="header__group header__group--view">
        <button
          type="button"
          className={`btn btn--icon${chatOpen ? ' btn--active' : ''}`}
          onClick={toggleChat}
          aria-pressed={chatOpen}
          title={chatOpen ? 'Hide the agent panel' : 'Show the agent panel'}
        >
          <IconPanel size={15} />
        </button>

        <button
          type="button"
          className="btn btn--icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
      </div>

      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}
      {memoryOpen && <MemoryDialog onClose={() => setMemoryOpen(false)} />}
    </header>
  );
}
