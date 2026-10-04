/**
 * Python analysis. Line-oriented rather than a full AST: we need imports,
 * top-level defs/classes and their ranges, which is exactly what indentation gives us.
 */
import type { FileFacts, ImportFact, SymbolFact } from '../types.ts';
import { countLoc, hashText, type ScannedFile } from './scan.ts';
import { packageOf } from './tsjs.ts';

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

  const addImport = (spec: string) => {
    const root = spec.split('.')[0];
    const pkg = packageOf(root) ?? root;
    const local = findLocal(spec, file.path, index);
    imports.push({ specifier: spec, resolved: local, external: !local, package: local ? undefined : pkg });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const from = FROM_RE.exec(line);
    if (from) {
      addImport(from[1]);
      continue;
    }
    const imp = IMPORT_RE.exec(line);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) addImport(name);
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

  return {
    path: file.path,
    lang: 'python',
    loc: countLoc(file.text),
    hash: hashText(file.text),
    isEntry: false,
    imports,
    symbols,
    exports,
  };
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
