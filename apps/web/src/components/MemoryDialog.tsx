import { useEffect } from 'react';
import { useStore } from '../store.tsx';
import Markdown from './Markdown.tsx';
import { IconSpark, IconX } from './icons.tsx';

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** What the agent has understood about the project, kept between sessions. */
export default function MemoryDialog({ onClose }: { onClose: () => void }) {
  const { memory, loadMemory, buildMemory, busy, project } = useStore();

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const hasMemory = Boolean(memory?.text?.trim());
  const writtenBy = memory?.origin === 'model' ? `written by ${memory.model ?? 'the model'}` : 'from the code facts only';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog dialog--wide" role="dialog" aria-label="Project memory">
        <header className="dialog__head">
          <div className="grow">
            <div className="dialog__title">Project memory</div>
            <div className="dialog__sub">
              A short brief the agent reuses between sessions — what this is, the stack, the layout,
              conventions and gotchas. Kept for {project?.name ?? 'this project'}.
            </div>
          </div>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">
            <IconX size={15} />
          </button>
        </header>

        <div className="dialog__body">
          {hasMemory && memory ? (
            <>
              <div className="memory-meta">
                <span className={`chip ${memory.origin === 'model' ? 'chip--verified' : 'chip--inferred'}`}>
                  <span className="chip__dot" />
                  {writtenBy}
                </span>
                {memory.builtAt && <span className="faint">built {fmtTime(memory.builtAt)}</span>}
              </div>
              <Markdown text={memory.text} className="memory-body" />
            </>
          ) : (
            <div className="empty-note">
              No project memory yet. Build it and the agent gets a written understanding of the
              project it keeps between sessions
              {project?.brain.mode === 'model'
                ? ' — a real pass over the facts by the connected model.'
                : ' — composed from the code facts, since no model is connected.'}
            </div>
          )}
        </div>

        <footer className="dialog__foot dialog__foot--split">
          <span className="faint" style={{ fontSize: 11.5 }}>
            {memory?.origin === 'model' ? 'Written by the model from the code facts.' : 'From the code facts only.'}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void buildMemory()}
              disabled={busy.memory}
            >
              <IconSpark size={13} className={busy.memory ? 'spin' : undefined} />
              {busy.memory ? 'Building…' : hasMemory ? 'Rebuild project memory' : 'Build project memory'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
