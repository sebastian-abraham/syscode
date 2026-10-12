/**
 * Turn a directory into grounded facts about the code in it.
 * This is the only place that touches the filesystem; everything above works on RepoFacts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CallFact, FileFacts, RepoFacts } from '../types.ts';
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
  const parsedPaths = new Set<string>();
  for (const f of scanned) {
    if (!f.isSource) continue;
    let facts: FileFacts | undefined;
    try {
      if (isTsJs(f)) facts = analyzeTsJs(f, index);
      else if (f.lang === 'python') facts = analyzePython(f, index);
    } catch {
      facts = undefined;
    }
    // Rust and Go are listed as analyzable but have no analyzer yet, and any language can
    // fail to parse. Either way the file exists, so it goes on the map as counted-not-read
    // rather than vanishing — a Go or Rust repo used to map to nothing at all.
    if (!facts) facts = unparsedFacts(f);
    facts.isEntry = detectEntry(f.path, declaredEntries);
    files.push(facts);
    parsedPaths.add(f.path);
  }

  // Code files outside the analyzable set (SQL, CSS, HTML, Java, Ruby, …) are part of the
  // system too. They are counted, and the map says so.
  for (const f of scanned) {
    if (parsedPaths.has(f.path)) continue;
    if (!CODE_LANGS.has(f.lang)) continue;
    const facts = unparsedFacts(f);
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
    calls: resolveCalls(files),
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

/**
 * A file SysCode counted but could not read the structure of — a language with no analyzer,
 * or one that failed to parse. The path, language, size and hash are facts. The empty
 * imports/symbols/calls are *not* a claim that the file has none: `unparsed` says nobody
 * looked, and everything that renders these facts has to say so too.
 */
function unparsedFacts(f: ScannedFile): FileFacts {
  return {
    path: f.path,
    lang: f.lang,
    loc: f.loc,
    hash: f.hash,
    isEntry: false,
    imports: [],
    symbols: [],
    exports: [],
    calls: [],
    unparsed: true,
  };
}


/** How many calls between the same two files are worth keeping — the verb needs a name, not a census. */
const MAX_CALLS_PER_PAIR = 6;

/**
 * Cross-file resolution: a call names a symbol, and the symbol is looked up in the module
 * the caller imported it from. That is what turns "this file imports that one" into "this
 * file *calls* `insertOrder` there, on line 12".
 *
 * Only exported definitions count — a call cannot reach what a module does not export — and
 * a call whose target file cannot be found is dropped, because a verb derived from a name
 * that resolves nowhere would be a guess dressed up as a fact.
 */
function resolveCalls(files: FileFacts[]): CallFact[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const perPair = new Map<string, number>();
  const out: CallFact[] = [];
  for (const file of files) {
    for (const call of file.calls) {
      if (!call.from || call.from === file.path) continue;
      const target = byPath.get(call.from);
      if (!target) continue;
      const defined = target.symbols.some((s) => s.name === call.name) || target.exports.includes(call.name);
      if (!defined) continue;
      const pair = `${file.path}\u0000${target.path}`;
      const seen = perPair.get(pair) ?? 0;
      if (seen >= MAX_CALLS_PER_PAIR) continue;
      perPair.set(pair, seen + 1);
      out.push({
        from: file.path,
        to: target.path,
        symbol: call.name,
        line: call.line,
        ...(call.textual ? { textual: true } : {}),
      });
    }
  }
  return out;
}

