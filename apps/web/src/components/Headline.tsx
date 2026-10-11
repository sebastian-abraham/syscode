import { useStore } from '../store.tsx';

/**
 * The opening sentence of the map (§3.1). Before this the canvas had no title at all:
 * you landed on a picture of boxes with nothing saying what the picture was *of*.
 *
 * Root only — at deeper levels the breadcrumb is the orientation, and the sentence is
 * about the system as a whole. It renders nothing when the engine has nothing honest to
 * say rather than filling the space with a guess (the sentence comes from the mapping
 * pass's brief, or from the facts; see `MapView.purpose`).
 */
export default function Headline() {
  const { project, view } = useStore();
  if (!view || !view.root || !view.purpose) return null;

  return (
    <div className="headline">
      <div className="headline__top">
        <span className="headline__name">{project?.name ?? 'This project'}</span>
        <span className="headline__stats">
          <span>{view.nodes.length} parts</span>
          <span className="headline__dot" />
          <span>{view.edges.length} links</span>
          {view.staleCount > 0 && (
            <>
              <span className="headline__dot" />
              <span className="headline__stale">{view.staleCount} stale</span>
            </>
          )}
        </span>
      </div>
      <p className="headline__purpose">{view.purpose}</p>
    </div>
  );
}
