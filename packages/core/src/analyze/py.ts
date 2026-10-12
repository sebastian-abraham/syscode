/**
 * Python analysis. Line-oriented rather than a full AST: we need imports,
 * top-level defs/classes and their ranges, which is exactly what indentation gives us.
 */
import type { CallRef, FileFacts, ImportFact, SymbolFact } from '../types.ts';
import { countLoc, hashText, type ScannedFile } from './scan.ts';
import { packageOf } from './tsjs.ts';

/** Per file. Mirrors the TypeScript pass; the ceiling keeps a dispatcher from flooding the map. */
const MAX_CALLS = 60;

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const CLASS_RE = /^(\s*)(?:@[\w.]+\(?[^)]*\)?\s*)?class\s+([A-Za-z_][A-Za-z0-9_]*)/;
const IMPORT_RE = /^\s*import\s+(.+)$/;
const FROM_RE = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/;

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

export function analyzePython(file: ScannedFile, index: Map<string, string>): FileFacts {
  const lines = file.text.split('\n');
  const imports: ImportFact[] = [];
  const symbols: SymbolFact[] = [];
  const exports: string[] = [];
  /** Local name → the module it came from. */
  const bindings = new Map<string, { resolved?: string }>();

  const addImport = (spec: string, line: number, local?: string) => {
    const root = spec.split('.')[0];
    const pkg = packageOf(root) ?? root;
    const localPath = findLocal(spec, file.path, index);
    imports.push({ specifier: spec, resolved: localPath, external: !localPath, package: localPath ? undefined : pkg, line });
    const bound = local ?? root;
    if (bound) bindings.set(bound, { resolved: localPath });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const from = FROM_RE.exec(line);
    if (from) {
      // `from pkg.mod import a, b as c` — each imported name is a binding of that module.
      for (const part of from[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) addImport(from[1], i + 1, name);
      }
      continue;
    }
    const imp = IMPORT_RE.exec(line);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const name = bits[bits.length - 1].trim();
        if (name) addImport(bits[0].trim(), i + 1, name);
      }
      continue;
    }

    const cls = CLASS_RE.exec(line);
    const def = DEF_RE.exec(line);
    const m = cls ?? def;
    if (m) {
      const indent = indentOf(line);
      const name = m[2];
      const kind: SymbolFact['kind'] = cls ? 'class' : 'function';
      const endLine = endOfBlock(lines, i, indent);
      const topLevel = indent === 0;
      const exported = topLevel && !name.startsWith('_');
      if (topLevel) {
        symbols.push({ name, kind, line: i + 1, endLine, exported });
        if (exported) exports.push(name);
      }
      i = Math.min(i, lines.length - 1);
    }
  }

  // Call sites, matched textually: a bound name followed by `(`. Line-oriented, like the
  // rest of this file — so it can be fooled by a name inside a string or a comment, which
  // is exactly why each fact carries `textual: true` instead of pretending to the fidelity
  // the TypeScript pass has.
  const localNames = new Set(symbols.map((s) => s.name));
  const found: CallRef[] = [];
  for (const name of [...new Set([...bindings.keys(), ...localNames])]) {
    const re = new RegExp(`\\b${escapeRe(name)}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (DEF_RE.test(text) || CLASS_RE.test(text) || IMPORT_RE.test(text) || FROM_RE.test(text)) continue;
      if (!re.test(text.replace(/#.*$/, ''))) continue;
      const bound = bindings.get(name);
      found.push(bound ? { name, line: i + 1, from: bound.resolved, textual: true } : { name, line: i + 1, textual: true });
      break;
    }
  }
  found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const calls = found.slice(0, MAX_CALLS);
  for (const s of symbols) {
    const mine = calls.filter((c) => c.line >= s.line && c.line <= s.endLine);
    if (mine.length) s.calls = mine;
  }

  return {
    path: file.path,
    lang: 'python',
    loc: countLoc(file.text),
    hash: hashText(file.text),
    isEntry: false,
    imports,
    symbols,
    exports,
    calls,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function endOfBlock(lines: string[], startIdx: number, indent: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) <= indent) return i; // exclusive: last line of the block
  }
  return lines.length;
}

function findLocal(spec: string, fromPath: string, index: Map<string, string>): string | undefined {
  const asPath = spec.replace(/\./g, '/');
  const candidates = [`${asPath}.py`, `${asPath}/__init__.py`, `src/${asPath}.py`, `app/${asPath}.py`];
  for (const c of candidates) {
    const hit = index.get(c.toLowerCase());
    if (hit) return hit;
  }
  // same-package sibling
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  for (const c of candidates) {
    const hit = index.get(`${dir}/${c}`.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}
