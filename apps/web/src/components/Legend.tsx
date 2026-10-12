import { useState } from 'react';
import { useUi } from '../ui.tsx';
import {
  EDGE_KINDS,
  EDGE_KIND_COLOUR,
  EDGE_KIND_LABEL,
  EDGE_ORIGINS,
  EDGE_ORIGIN_DASH,
  EDGE_ORIGIN_LABEL,
} from '../edgeStyle.ts';
import type { EdgeKind, Provenance } from '../types.ts';
import { IconChevron } from './icons.tsx';

/** The stripe colour the node cards use for each origin (see styles.css). */
const ORIGIN_TOKEN: Record<Provenance, string> = {
  verified: 'var(--verified)',
  inferred: 'var(--inferred)',
  user: 'var(--user)',
  planned: 'var(--planned)',
};

/**
 * The key to the picture. Nothing on the canvas explained the provenance stripe or
 * the edge colours before this: you could see that two edges differed and had no way
 * to find out why.
 *
 * Each swatch is drawn with the same primitive the canvas uses — an SVG line with the
 * exact colour, dash and width from edgeStyle.ts — so the legend cannot drift out of
 * step with the map it explains.
 */
export default function Legend() {
  const { theme } = useUi();
  const [open, setOpen] = useState(true);
  const colours = EDGE_KIND_COLOUR[theme];

  const line = (colour: string, dash: string | undefined, width = 1.8) => (
    <svg className="legend__line" width="30" height="10" aria-hidden="true">
      <line
        x1="1"
        y1="5"
        x2="29"
        y2="5"
        stroke={colour}
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  );

  return (
    <div className={'legend' + (open ? '' : ' legend--shut')} role="note" aria-label="Map legend">
      <button
        type="button"
        className="legend__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="legend__title">Legend</span>
        <span className={'legend__chev' + (open ? ' legend__chev--open' : '')}>
          <IconChevron size={11} />
        </span>
      </button>

      {open && (
        <div className="legend__body">
          <div className="legend__group">Line colour — the kind of link</div>
          <ul className="legend__grid">
            {EDGE_KINDS.map((kind: EdgeKind) => (
              <li key={kind} className="legend__row">
                {line(colours[kind], undefined)}
                <span className="legend__label">{EDGE_KIND_LABEL[kind]}</span>
              </li>
            ))}
          </ul>
          {/* Width is a third channel on the same mark, so it belongs with the kinds. */}
          <div className="legend__row legend__row--note">
            {line(colours.depends, undefined, 3.0)}
            <span className="legend__label legend__label--dim">a thicker line is many links</span>
          </div>

          <div className="legend__group">How it&rsquo;s known</div>
          <ul className="legend__list">
            {EDGE_ORIGINS.map((origin) => (
              <li key={origin} className="legend__row">
                {line('var(--text-2)', EDGE_ORIGIN_DASH[origin])}
                <span className="legend__stripe" style={{ background: ORIGIN_TOKEN[origin] }} />
                <span className="legend__label">{EDGE_ORIGIN_LABEL[origin]}</span>
              </li>
            ))}
          </ul>
          <div className="legend__foot">
            The verb on a line says what it does; its colour says what kind of link it is.
            The stripe on a card works the same way. Select a node to light its own
            connections and dim the rest.
          </div>
        </div>
      )}
    </div>
  );
}
