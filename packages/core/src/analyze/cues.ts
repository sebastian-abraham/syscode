/**
 * Deterministic cues: what a file says about the rest of the system, in the languages we
 * cannot parse. This is the "any stack" half of the mapper — a Go import, a SQL table or a
 * compose service is a fact with a line number, so an edge built from it can be *cited*
 * instead of guessed.
 *
 * Nothing here calls a model, and nothing here guesses: a cue is only emitted when the text
 * really contains it, and a target is only resolved when the repository really has that path.
 * A cue that resolves to nothing is still kept — "this file imports github.com/lib/pq" is
 * useful to the model and to the reader even though it is not an edge.
 */
import path from 'node:path';
import type { CueFact } from '../types.ts';
import type { ScannedFile } from './scan.ts';

export interface CueContext {
  /** repo-relative file paths that exist */
  files: Set<string>;
  /** repo-relative directory paths that exist */
  dirs: Set<string>;
  /** the module name from go.mod, when the repo has one */
  goModule?: string;
}

/** Extensions worth trying when a cue names a path without one. */
const EXTS = [
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.cs', '.c', '.h', '.cpp', '.hpp', '.sql', '.html', '.css',
];

/** A file can be verbose; the map only needs the shape of it. */
const MAX_CUES = 40;

/** Paths we treat as a compose file — where service names are real facts. */
const COMPOSE = /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/;

function pick(base: string, ctx: CueContext): string | undefined {
  const clean = path.posix.normalize(base).replace(/^\.\//, '');
  if (!clean || clean === '.') return undefined;
  if (ctx.files.has(clean)) return clean;
  for (const ext of EXTS) if (ctx.files.has(clean + ext)) return clean + ext;
  if (ctx.dirs.has(clean)) return clean;
  // com.foo.Bar -> com/foo/Bar.java (java, kotlin, c#-ish)
  const slashed = clean.replace(/\./g, '/');
  if (slashed !== clean) {
    for (const ext of EXTS) if (ctx.files.has(slashed + ext)) return slashed + ext;
    if (ctx.dirs.has(slashed)) return slashed;
  }
  return undefined;
}

/** Resolve what an import names to a path in this repo, or nothing at all. */
export function resolveCueTarget(raw: string, fromPath: string, ctx: CueContext): string | undefined {
  const r = raw.trim();
  if (!r) return undefined;
  if (r.startsWith('.')) {
    return pick(path.posix.join(path.posix.dirname(fromPath), r), ctx);
  }
  // Go: the module path is the repo root, so everything after it is a directory.
  if (ctx.goModule && (r === ctx.goModule || r.startsWith(ctx.goModule + '/'))) {
    const dir = r === ctx.goModule ? '.' : r.slice(ctx.goModule.length + 1);
    const hit = pick(dir, ctx);
    if (hit) return hit;
  }
  return pick(r, ctx);
}

export function extractCues(f: ScannedFile, ctx: CueContext): CueFact[] {
  const lines = f.text.split('\n');
  const out: CueFact[] = [];
  const push = (kind: CueFact['kind'], raw: string, line: number, target?: string) => {
    if (out.length >= MAX_CUES) return;
    if (!raw) return;
    out.push(target ? { kind, raw, target, line } : { kind, raw, line });
  };

  switch (f.lang) {
    case 'go': {
      let inBlock = false;
      lines.forEach((line, i) => {
        const t = line.trim();
        if (/^import\s*\($/.test(t)) { inBlock = true; return; }
        if (inBlock && t.startsWith(')')) { inBlock = false; return; }
        const m = inBlock
          ? /^(?:[\w.]+\s+)?"([^"]+)"/.exec(t)
          : /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(t);
        if (m) push('import', m[1], i + 1, resolveCueTarget(m[1], f.path, ctx));
      });
      break;
    }
    case 'rust': {
      lines.forEach((line, i) => {
        const m = /^\s*(?:pub\s+)?(?:use|mod)\s+([A-Za-z0-9_:]+)/.exec(line);
        if (!m) return;
        let rel = m[1];
        if (rel.startsWith('crate::')) rel = rel.slice(7).replace(/::/g, '/');
        else if (rel.startsWith('super::')) rel = `../${rel.slice(7).replace(/::/g, '/')}`;
        else if (rel.startsWith('self::')) rel = `./${rel.slice(6).replace(/::/g, '/')}`;
        else rel = rel.replace(/::/g, '/');
        const target = resolveCueTarget(rel, f.path, ctx) ?? resolveCueTarget(`src/${rel}`, f.path, ctx);
        push('import', m[1], i + 1, target);
      });
      break;
    }
    case 'java':
    case 'kotlin': {
      lines.forEach((line, i) => {
        const m = /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;/.exec(line);
        if (m) push('import', m[1], i + 1, resolveCueTarget(m[1], f.path, ctx));
      });
      break;
    }
    case 'rb': {
      lines.forEach((line, i) => {
        const rel = /^\s*require_relative\s+['"]([^'"]+)/.exec(line);
        if (rel) { push('import', rel[1], i + 1, resolveCueTarget(rel[1], f.path, ctx)); return; }
        const abs = /^\s*require\s+['"]([^'"]+)/.exec(line);
        if (abs) push('import', abs[1], i + 1, resolveCueTarget(abs[1], f.path, ctx));
      });
      break;
    }
    case 'php': {
      lines.forEach((line, i) => {
        const req = /^\s*(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)/.exec(line);
        if (req) { push('import', req[1], i + 1, resolveCueTarget(req[1], f.path, ctx)); return; }
        const use = /^\s*use\s+([A-Za-z0-9_\\]+)/.exec(line);
        if (use) push('import', use[1], i + 1, resolveCueTarget(use[1].replace(/\\/g, '/'), f.path, ctx));
      });
      break;
    }
    case 'cs': {
      lines.forEach((line, i) => {
        const m = /^\s*using\s+([A-Za-z0-9_.]+)\s*;/.exec(line);
        if (m) push('import', m[1], i + 1, resolveCueTarget(m[1], f.path, ctx));
      });
      break;
    }
    case 'c':
    case 'cpp': {
      lines.forEach((line, i) => {
        const m = /^\s*#include\s+"([^"]+)"/.exec(line);
        if (m) push('import', m[1], i + 1, resolveCueTarget(m[1], f.path, ctx));
      });
      break;
    }
    case 'sql': {
      lines.forEach((line, i) => {
        const ddl = /CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)/i.exec(line);
        if (ddl) { push('table', ddl[1], i + 1); return; }
        const ref = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES)\s+["`[]?([\w.]+)/i.exec(line);
        if (ref) push('table', ref[1], i + 1);
      });
      break;
    }
    case 'html': {
      lines.forEach((line, i) => {
        const script = /<script[^>]+src=["']([^"']+)/i.exec(line);
        if (script) push('asset', script[1], i + 1, resolveCueTarget(script[1], f.path, ctx));
        const link = /<link[^>]+href=["']([^"']+)/i.exec(line);
        if (link) push('asset', link[1], i + 1, resolveCueTarget(link[1], f.path, ctx));
        const form = /<form[^>]+action=["']([^"']+)/i.exec(line);
        if (form) push('route', form[1], i + 1);
      });
      break;
    }
    case 'css': {
      lines.forEach((line, i) => {
        const m = /@import\s+(?:url\()?["']?([^"')]+)/.exec(line);
        if (m) push('asset', m[1].trim(), i + 1, resolveCueTarget(m[1].trim(), f.path, ctx));
      });
      break;
    }
    case 'yaml': {
      if (!COMPOSE.test(f.path)) break;
      lines.forEach((line, i) => {
        const img = /^\s*image:\s*["']?([^\s"']+)/.exec(line);
        if (img) push('service', img[1], i + 1);
      });
      break;
    }
    default:
      break;
  }

  return out;
}

/** The module name from go.mod, so `shopkit-go/internal/orders` resolves to `internal/orders`. */
export function goModuleName(goMod: string): string | undefined {
  const m = /^\s*module\s+(\S+)/m.exec(goMod);
  return m?.[1];
}
