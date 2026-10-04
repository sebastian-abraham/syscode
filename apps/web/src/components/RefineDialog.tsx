import { useStore } from '../store.tsx';
import ProposalCard from './ProposalCard.tsx';
import { IconSpark, IconX } from './icons.tsx';

/**
 * The outcome of asking the model to re-name and re-explain the map. On success it is a
 * normal proposal the developer approves; when nothing was proposed the engine's sentence
 * is shown verbatim, and any unparseable reply is kept behind a disclosure.
 */
export default function RefineDialog() {
  const { refineResult, refineTarget, refineOpen, busy, closeRefine, openRefine, view } = useStore();

  if (!refineOpen) return null;

  const targetLabel = refineTarget
    ? view?.nodes.find((n) => n.id === refineTarget)?.label ?? 'the selected node'
    : 'the whole top level';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeRefine()}>
      <div className="dialog dialog--wide" role="dialog" aria-label="Refine with the model">
        <header className="dialog__head">
          <div className="grow">
            <div className="dialog__title">Name and explain with the model</div>
            <div className="dialog__sub">
              The model re-names and re-explains {targetLabel} from the facts behind each node. The map
              changes only when you approve the proposal.
            </div>
          </div>
          <button type="button" className="close-x" onClick={closeRefine} aria-label="Close">
            <IconX size={15} />
          </button>
        </header>

        <div className="dialog__body">
          {busy.refine && !refineResult ? (
            <div className="refine-busy">
              <span className="splash__spinner" />
              Asking the model to name and explain the map…
            </div>
          ) : refineResult ? (
            <>
              {refineResult.proposal ? (
                <>
                  <div className="refine-note">
                    The model touched {refineResult.nodesTouched}{' '}
                    {refineResult.nodesTouched === 1 ? 'node' : 'nodes'}. Nothing changes until you approve it.
                  </div>
                  <ProposalCard proposal={refineResult.proposal} inline />
                </>
              ) : (
                <div className="refine-skipped">
                  {refineResult.skipped ?? 'The model returned nothing usable for this map.'}
                </div>
              )}

              {refineResult.raw && (
                <details className="raw-disclosure">
                  <summary>what the model said</summary>
                  <pre>{refineResult.raw}</pre>
                </details>
              )}
            </>
          ) : (
            <div className="empty-note">No result yet.</div>
          )}
        </div>

        <footer className="dialog__foot dialog__foot--split">
          <span className="faint" style={{ fontSize: 11.5 }}>
            {refineResult?.brain?.model ? `Model: ${refineResult.brain.model}` : 'Model owns the meaning; facts keep it honest.'}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={closeRefine}>
              Close
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void openRefine(refineTarget)}
              disabled={busy.refine}
            >
              <IconSpark size={13} className={busy.refine ? 'spin' : undefined} />
              {busy.refine ? 'Asking…' : 'Run again'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
