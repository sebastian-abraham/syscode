import { Fragment } from 'react';
import { useStore } from '../store.tsx';
import { IconMap } from './icons.tsx';

export default function Breadcrumb() {
  const { view, climbTo } = useStore();
  if (!view) return null;

  const crumbs = view.breadcrumb ?? [];

  return (
    <nav className="breadcrumb" aria-label="Map depth">
      <button
        type="button"
        className={`breadcrumb__item${view.root ? ' breadcrumb__item--current' : ''}`}
        onClick={() => void climbTo(null)}
        title="The whole system"
      >
        <IconMap size={12} />
        System
      </button>
      {crumbs.map((crumb, i) => {
        const current = i === crumbs.length - 1;
        return (
          <Fragment key={crumb.id}>
            <span className="breadcrumb__sep" aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className={`breadcrumb__item${current ? ' breadcrumb__item--current' : ''}`}
              onClick={() => void climbTo(crumb.id)}
              title={crumb.summary}
            >
              {crumb.label}
              {crumb.childCount > 0 && <span className="breadcrumb__count">{crumb.childCount}</span>}
            </button>
          </Fragment>
        );
      })}
      {!view.root && (
        <span className="breadcrumb__hint">
          <span className="kbd">Esc</span> to go up
        </span>
      )}
    </nav>
  );
}
