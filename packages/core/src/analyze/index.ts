/**
 * Turn a directory into grounded facts about the code in it.
 * This is the only place that touches the filesystem; everything above works on RepoFacts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileFacts, RepoFacts } from '../types.ts';
import { CODE_LANGS, scanRepo, type ScanOptions, type ScannedFile } from './scan.ts';
import { analyzeTsJs, buildPathIndex, isTsJs } from './tsjs.ts';
import { analyzePython } from './py.ts';

import { classifyExternal, serviceLabel } from './external.ts';

export { serviceLabel };

const ENTRY_NAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'entry', 'bootstrap', '__main__', 'manage', 'wsgi', 'asgi', 'run', 'worker',
]);

function detectEntry(pathRel: string, declaredEntryPaths: Set<string>): boolean {
  if (declaredEntryPaths.has(pathRel)) return true;
  const base = pathRel.slice(pathRel.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '');
  if (!ENTRY_NAMES.has(base)) return false;
  // shallow files called main/app/index are far more likely to be entries than deep ones
  return pathRel.split('/').length <= 2;
}

async function readIgnoreFile(root: string): Promise<string[]> {
  try {
    const txt = await readFile(path.join(root, '.syscodeignore'), 'utf8');
    return txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

async function readDeclaredEntries(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const j = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const add = (p: unknown) => {
      if (typeof p === 'string') {
        const clean = p.replace(/^\.\//, '').replace(/^dist\//, '').replace(/\.[a-z]+$/, '');
        out.add(clean);
        for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs', ''] as const) out.add(clean + ext);
      }
    };
    add(j.main);
    if (j.bin) {
      if (typeof j.bin === 'string') add(j.bin);
      else for (const v of Object.values(j.bin ?? {})) add(v);
    }
    for (const v of Object.values(j.scripts ?? {})) {
      const m = /(?:node|tsx|bun|python3?|deno)\s+([^\s&|;]+)/.exec(String(v));
      if (m) add(m[1]);
    }
  } catch {
    /* fine */
  }
  return out;
}

export async function analyzeRepo(root: string, opts: ScanOptions = {}): Promise<RepoFacts> {
  const abs = path.resolve(root);
  const ignore = [...(opts.ignore ?? []), ...(await readIgnoreFile(abs))];
  const scanned = await scanRepo(abs, { ...opts, ignore });
  const index = buildPathIndex(scanned);
  const declaredEntries = await readDeclaredEntries(abs);

  const files: FileFacts[] = [];
  for (const f of scanned) {
    if (!f.isSource) continue;
    let facts: FileFacts | undefined;
    try {
      if (isTsJs(f)) facts = analyzeTsJs(f, index);
      else if (f.lang === 'python') facts = analyzePython(f, index);
    } catch {
      facts = undefined;
    }
    if (!facts) continue;
    facts.isEntry = detectEntry(f.path, declaredEntries);
    files.push(facts);
  }

  const byLang: RepoFacts['totals']['byLang'] = {};
  for (const f of scanned) {
    if (!CODE_LANGS.has(f.lang)) continue;
    byLang[f.lang] ??= { files: 0, loc: 0 };
    byLang[f.lang].files++;
    byLang[f.lang].loc += f.loc;
  }

  const usage = new Map<string, number>();
  for (const f of files) {
    const seen = new Set<string>();
    for (const imp of f.imports) {
      if (!imp.external || !imp.package) continue;
      if (seen.has(imp.package)) continue;
      seen.add(imp.package);
      usage.set(imp.package, (usage.get(imp.package) ?? 0) + 1);
    }
  }
  const externals = [...usage.entries()]
    .map(([name, usedBy]) => ({ name, usedBy, kind: classifyExternal(name) }))
    .sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name));

  return {
    root: abs,
    files,
    externals,
    entryPoints: files.filter((f) => f.isEntry).map((f) => f.path),
    totals: {
      files: scanned.length,
      loc: scanned.reduce((n, f) => n + f.loc, 0),
      byLang,
    },
    scannedAt: new Date().toISOString(),
  };
}

export type { ScannedFile };
