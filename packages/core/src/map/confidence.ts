/**
 * How sure the map is that an edge exists.
 *
 * This number is *computed from the facts*, never asked of a model: the same facts must
 * always produce the same number, or the number is decoration. It is the finer-grained
 * companion to `origin` — `origin` says where the link came from (code, the agent, the
 * developer, a plan), `confidence` says how much of it rests on evidence you can go and
 * look at (product brief rule 5, CONTRACT rule 4).
 *
 * The rule, in full:
 *
 *   verified, with at least one resolved import/call site   0.90 → 1.00
 *     (each further site adds a little, to a ceiling: twenty links are not certainty
 *      about the *relationship*, only about the links)
 *   verified, matched on names or paths alone               0.60
 *   inferred, backed by a statement in the docs             0.50
 *   inferred, with nothing to point at                      0.25
 *   drawn by the developer, or planned on purpose           1.00
 *     (the map is not guessing at all there — it is recording a decision. `origin`
 *      still says it is not code, which is the distinction that matters on screen.)
 */
import type { Provenance } from '../types.ts';

export function edgeConfidence(
  origin: Provenance,
  links: number,
  opts: { documented?: boolean } = {},
): number {
  if (origin === 'user' || origin === 'planned') return 1;
  if (origin === 'verified') {
    if (links > 0) {
      const extra = Math.min(0.1, (links - 1) * 0.025);
      return round(0.9 + extra);
    }
    return 0.6;
  }
  return opts.documented ? 0.5 : 0.25;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
