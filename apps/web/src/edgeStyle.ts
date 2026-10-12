/**
 * How an edge is drawn.
 *
 * Two different questions, two different visual channels:
 *   - *what the link is*   → colour, from `kind`   (data / triggers / stores / …)
 *   - *how we know it*     → line style, from `origin` (verified / inferred / …)
 *
 * React Flow draws the path and the arrowhead itself, so these colours have to be
 * passed as props rather than read from CSS tokens. The legend reads the very same
 * table, so there is one source of truth instead of a hex repeated in two files.
 * (Node provenance stripes are still the --verified / --inferred / … CSS tokens.)
 *
 * The values are deliberately calm: at the overview every edge is context, and the
 * one that matters is the one you are looking at (`SysEdge` brightens on hover/select).
 */
import type { CSSProperties } from 'react';
import type { EdgeKind, MapEdge, Provenance } from './types.ts';
import type { Theme } from './ui.tsx';

/**
 * Line colour per edge kind, per theme. The same six values are the `--edge-k-*`
 * tokens in styles.css, which is what the paths themselves are drawn with; this
 * copy exists because an SVG arrowhead marker cannot read a CSS variable.
 * Keep the two sets in step.
 */
export const EDGE_KIND_COLOUR: Record<Theme, Record<EdgeKind, string>> = {
  dark: {
    depends: '#666b76', // the plain "it uses it" case stays grey and quiet
    data: '#4fb0c0',
    triggers: '#d5925f',
    stores: '#a184dd',
    uses: '#8fa3c9',
    custom: '#c9809a',
  },
  light: {
    depends: '#6f7480',
    data: '#1f7d8c',
    triggers: '#a85c2c',
    stores: '#6344a8',
    uses: '#3f6398',
    custom: '#9c4762',
  },
};

/** One-word reading of each kind, for the legend (a real edge prints its own verb). */
export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  depends: 'depends on',
  data: 'data',
  triggers: 'triggers',
  stores: 'stores',
  uses: 'uses',
  custom: 'custom',
};

/** The kinds in the order the legend lists them. */
export const EDGE_KINDS: EdgeKind[] = ['depends', 'data', 'triggers', 'stores', 'uses', 'custom'];

/**
 * Line style says how the link is known — the honesty channel:
 *   verified  solid       a resolved import or call site
 *   inferred  short dash  reasoned from names, paths or docs
 *   planned   dots        designed, not built yet
 *   user      long dash   drawn by the developer
 * `undefined` means "leave the path solid".
 */
export const EDGE_ORIGIN_DASH: Record<Provenance, string | undefined> = {
  verified: undefined,
  inferred: '6 4',
  planned: '1.5 4',
  user: '12 4',
};

export const EDGE_ORIGIN_LABEL: Record<Provenance, string> = {
  verified: 'verified from code',
  inferred: 'inferred',
  planned: 'planned',
  user: 'yours',
};

/** The origins the legend lists, strongest evidence first. */
export const EDGE_ORIGINS: Provenance[] = ['verified', 'inferred', 'user', 'planned'];

/**
 * Thicker line = more underlying code links. Log scale, so an edge that summarises
 * 30 links still reads as a line rather than a slab, and the cap keeps the widest
 * edge from competing with the node borders.
 */
export function edgeWidth(edge: MapEdge): number {
  const n = Math.max(1, edge.weight ?? 1);
  return Math.round((1.4 + Math.min(1.8, Math.log2(n) * 0.7)) * 100) / 100;
}

/**
 * The per-edge numbers React Flow writes onto the path. The *colour* is not here on
 * purpose — it is a class plus a CSS token (`.edge--k-*`, `--edge-k-*`), so that a
 * theme swap or a hover emphasis is a stylesheet concern and never fights an inline
 * style. An SVG `<marker>` cannot read a CSS variable, which is why the same six
 * colours also exist in this file as hex: the arrowheads and the legend come from
 * here, the paths from the stylesheet.
 */
export function edgePathStyle(edge: MapEdge): CSSProperties {
  const dash = EDGE_ORIGIN_DASH[edge.origin];
  return {
    ['--edge-w' as string]: String(edgeWidth(edge)),
    ...(dash ? { strokeDasharray: dash } : {}),
  } as CSSProperties;
}

/**
 * Wording for a computed confidence. The number comes from the engine (map/confidence.ts);
 * the sentence belongs to the interface, which is why it lives here and not there.
 */
export function confidenceLabel(confidence: number | undefined): string {
  if (confidence === undefined) return 'confidence unstated';
  if (confidence >= 0.9) return 'certain — found in the code';
  if (confidence >= 0.6) return 'likely — matched by name or path';
  if (confidence >= 0.45) return 'plausible — stated in the docs';
  return 'a guess — nothing to point at';
}

/**
 * What an edge says when you hover it: what it is, how sure the map is, and the lines it
 * was found on. The citation is the point — an edge you cannot check is an edge you have
 * to take on trust, which is exactly what this revamp is against.
 */
export function edgeTitle(edge: MapEdge): string {
  const bits: string[] = [`${edge.label} · ${EDGE_ORIGIN_LABEL[edge.origin]} · ${confidenceLabel(edge.confidence)}`];
  if (edge.callSites && edge.callSites > 1) bits.push(`${edge.callSites} links in the code`);
  const evidence = edge.evidence ?? [];
  bits.push(
    evidence.length
      ? evidence
          .slice(0, 3)
          .map((e) => `${e.path}:${e.line}`)
          .join(', ')
      : 'no citation recorded',
  );
  return bits.join(' · ');
}
