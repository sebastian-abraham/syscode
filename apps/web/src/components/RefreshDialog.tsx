import { useEffect, useState } from 'react';
import { useStore } from '../store.tsx';
import type { DetectedChange, MapOp } from '../types.ts';
import { describeOp } from './ProposalCard.tsx';
import { IconCheck, IconX } from './icons.tsx';

type Decision = 'accepted' | 'rejected';

const CHANGE_LABEL: Record<DetectedChange['kind'], string> = {
  'new-code': 'new code',
  'removed-code': 'removed code',
  'changed-code': 'changed code',
  'new-module': 'new module',
  'gone-module': 'gone module',
};

export default function RefreshDialog() {
  const { refreshReport, closeRefreshReport, applyOps, approveProposal, rejectProposal, view, toast } = useStore();
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [busyIndex, setBusyIndex] = useState<number | null>(null);

  useEffect(() => {
    setDecisions({});
    setBusyIndex(null);
  }, [refreshReport]);

  if (!refreshReport) return null;

  const report = refreshReport;
  const labelFor = (id: string) => view?.nodes.find((n) => n.id === id)?.label ?? id;

  const decide = async (index: number, change: DetectedChange, decision: Decision) => {
    // A detected change is queued in the engine as its own proposal: accepting it is what
    // re-anchors / renames / moves anything. Nothing is decided in the browser.
    setBusyIndex(index);
    try {
      if (change.proposalId) {
        if (decision === 'rejected') await rejectProposal(change.proposalId);
        else await approveProposal(change.proposalId);
      } else if (decision === 'accepted') {
        // older engines did not attach a proposal id; fall back to applying the ops directly
        const result = await applyOps(change.ops ?? []);
        if (result.skipped > 0) {
          toast('warn', `${result.applied} change(s) applied; ${result.skipped} need the engine.`);
        }
      }
      setDecisions((d) => ({ ...d, [index]: decision }));
      toast('success', decision === 'accepted' ? 'Map updated from the code.' : 'Change rejected — the map stays as it was.');
    } catch (err) {
      toast('warn', `Could not ${decision === 'accepted' ? 'apply' : 'reject'}: ${(err as Error).message}`);
    } finally {
      setBusyIndex(null);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeRefreshReport()}>
      <div className="dialog dialog--wide" role="dialog" aria-label="Refresh report">
        <header className="dialog__head">
          <div className="grow">
            <div className="dialog__title">Refresh report</div>
            <div className="dialog__sub">
              The engine re-read the repository and diffed it against the map. Nothing is applied
              until you accept it.
            </div>
          </div>
          <button type="button" className="close-x" onClick={closeRefreshReport} aria-label="Close">
            <IconX size={15} />
          </button>
        </header>

        <div className="dialog__body">
          <div className="report-stats">
            <div className="stat">
              <div className="stat__value">{report.scanned.files.toLocaleString()}</div>
              <div className="stat__label">files scanned</div>
            </div>
            <div className="stat">
              <div className="stat__value">{report.scanned.loc.toLocaleString()}</div>
              <div className="stat__label">lines of code</div>
            </div>
            <div className="stat">
              <div className="stat__value">{report.staleMarked}</div>
              <div className="stat__label">marked stale</div>
            </div>
            <div className="stat">
              <div className="stat__value">{report.staleCleared}</div>
              <div className="stat__label">stale cleared</div>
            </div>
          </div>

          <div className="row" style={{ marginBottom: 14, gap: 10 }}>
            <span className="chip chip--quiet">{report.proposalsCreated} proposals created</span>
            <span className="chip chip--quiet">
              brain: {report.brain.mode}
              {report.brain.model ? ` · ${report.brain.model}` : ''}
            </span>
            {report.applied && <span className="chip chip--verified">applied by engine</span>}
          </div>

          <div className="field__label">Detected changes</div>
          {report.changes.length === 0 ? (
            <div className="empty-note">
              No meaningful drift detected — the map still matches the code.
            </div>
          ) : (
            report.changes.map((change, index) => {
              const decision = decisions[index];
              return (
                <div className={`change${decision ? ' change--decided' : ''}`} key={index}>
                  <div className="change__head">
                    <span className={`tag tag--${change.kind}`}>{CHANGE_LABEL[change.kind]}</span>
                    {change.nodeId && (
                      <span className="change__node" title={change.nodeId}>
                        {change.label ?? labelFor(change.nodeId)}
                      </span>
                    )}
                    {decision && (
                      <span
                        className="proposal__status"
                        style={{
                          marginLeft: 'auto',
                          color: decision === 'accepted' ? 'var(--verified)' : 'var(--text-3)',
                        }}
                      >
                        {decision}
                      </span>
                    )}
                  </div>
                  <div className="change__summary">{change.summary}</div>

                  {change.ops.length > 0 && (
                    <div className="proposal__ops">
                      {change.ops.map((op, i) => {
                        const d = describeOp(op, labelFor);
                        return (
                          <div className="op-row" key={i}>
                            <span className="op-row__kind">{d.kind}</span>
                            <span className="op-row__text">{d.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!decision && (
                    <div className="change__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => void decide(index, change, 'rejected')}
                      >
                        <IconX size={13} />
                        Reject
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={busyIndex === index}
                        onClick={() => void decide(index, change, 'accepted')}
                      >
                        <IconCheck size={13} />
                        {busyIndex === index ? 'Applying…' : 'Accept'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <footer className="dialog__foot dialog__foot--split">
          <span className="faint" style={{ fontSize: 11.5 }}>
            User positions, names and notes are never overwritten.
          </span>
          <button type="button" className="btn" onClick={closeRefreshReport}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
