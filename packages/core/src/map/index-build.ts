/**
 * The source index: everything SysCode knows about a repository, computed and bounded, handed
 * to the model as *evidence*. This is the part that makes "do not invent relationships" a
 * checkable contract instead of a hope — a relationship the model claims can be tested against
 * the same facts the index was built from.
 *
 * Two rules it obeys, both from what the research showed:
 *
 *  1. It never guesses. A file's status is `read` (we parsed it) or `counted` (we did not);
 *     an import is either resolved to a path in this repo or named as a package; a cue carries
 *     the line it was seen on.
 *  2. It is **location, not architecture**. Files are listed under the directory they live in
 *     because that is where they are, and the header says so. Naming the parts of the system —
 *     deciding that two directories are one part and one directory is three — is the model's
 *     job, and the index must not do it for them by presenting the folders as the answer.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CueFact, FileFacts, RepoFacts } from '../types.ts';

export interface IndexFile {
  path: string;
  lang: string;
  loc: number;
  /** `read` = parsed (symbols, imports, calls are real). `counted` = only the text was read. */
  status: 'read' | 'counted';
  entry: boolean;
  exports: string[];
  /** resolved in-repo imports */
  inRepo: string[];
  /** third-party packages */
  packages: string[];
  cues: CueFact[];
  calls: { name: string; to?: string; line: number }[];
  fanIn: number;
}

export interface SourceIndex {
  files: IndexFile[];
  byPath: Map<string, IndexFile>;
  coreModules: string[];
  entryPoints: string[];
  externals: RepoFacts['externals'];
  totals: RepoFacts['totals'];
  /** the whole-repo index, for the outline pass */
  text: string;
  /** true when the budget forced some detail to be dropped */
  trimmed: boolean;
}

export interface IndexOptions {
  /** characters of index text; the model's context is the only real ceiling */
  maxChars?: number;
  /** lines of an excerpt */
  excerptLines?: number;
  /** how many excerpts per area pass */
  excerptsPerArea?: number;
  /** characters of README handed over */
  readmeChars?: number;
}

const DEFAULTS: Required<IndexOptions> = {
  maxChars: 60_000,
  excerptLines: 40,
  excerptsPerArea: 3,
  readmeChars: 2_000,
};

const HEADER =
  'COMPUTED BY SYSCODE FROM THE REPOSITORY FILES — NOT WRITTEN BY A MODEL.\n' +
  'It is location, not architecture: files are listed under the directory they live in because\n' +
  'that is where they are. Naming the parts of the system is your job.\n' +
  'Status is `read` (SysCode parsed it: symbols, imports and calls are real) or `counted`\n' +
  '(only the text was read: the cues are imports, tables, services and assets seen in it).';

function indexFile(f: FileFacts, facts: RepoFacts): IndexFile {
  return {
    path: f.path,
    lang: f.lang,
    loc: f.loc,
    status: f.unparsed ? 'counted' : 'read',
    entry: f.isEntry,
    exports: f.exports.slice(0, 8),
    inRepo: [...new Set(f.imports.filter((i) => i.resolved).map((i) => i.resolved as string))].slice(0, 10),
    packages: [...new Set(f.imports.filter((i) => i.external && i.package).map((i) => i.package as string))].slice(0, 8),
    cues: f.cues ?? [],
    calls: f.calls.filter((c) => c.from && c.from !== f.path).slice(0, 6).map((c) => ({ name: c.name, to: c.from, line: c.line })),
    fanIn: facts.fanIn[f.path] ?? 0,
  };
}

/** One file's detail line, at one of three levels of detail — the budget picks the level. */
function fileLine(f: IndexFile, level: 2 | 1 | 0): string {
  const head = `  ${f.path}  ${f.lang} ${f.loc}loc ${f.status.toUpperCase()}${f.entry ? ' ENTRY' : ''}`;
  if (level === 0) return head;
  const bits: string[] = [];
  if (f.exports.length) bits.push(`exports: ${f.exports.join(', ')}`);
  if (level === 1) return bits.length ? `${head}  ${bits.join('  ')}` : head;
  if (f.inRepo.length) bits.push(`imports: ${f.inRepo.join(', ')}`);
  if (f.packages.length) bits.push(`packages: ${f.packages.join(', ')}`);
  if (f.calls.length) bits.push(`calls: ${f.calls.map((c) => `${c.name}${c.to ? `->${c.to}` : ''}:${c.line}`).join(', ')}`);
  if (f.cues.length) {
    const cues = f.cues.slice(0, 8).map((c) => `${c.kind} ${c.raw}${c.target ? `->${c.target}` : ''}:${c.line}`);
    bits.push(`cues: ${cues.join(', ')}`);
  }
  if (f.fanIn > 1) bits.push(`fan-in ${f.fanIn}`);
  return bits.length ? `${head}  ${bits.join('  ')}` : head;
}

async function readReadme(root: string, chars: number): Promise<string | undefined> {
  for (const name of ['README.md', 'README', 'readme.md', 'README.rst', 'README.txt']) {
    try {
      const text = await readFile(path.join(root, name), 'utf8');
      const clean = text.trim();
      return clean.length > chars ? `${clean.slice(0, chars)}…` : clean;
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}

export async function buildSourceIndex(facts: RepoFacts, opts: IndexOptions = {}): Promise<SourceIndex> {
  const o = { ...DEFAULTS, ...opts };
  const files = facts.files.map((f) => indexFile(f, facts));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const readme = await readReadme(facts.root, o.readmeChars);

  const header: string[] = [HEADER, ''];
  header.push(`PROJECT: ${facts.totals.files} files, ${facts.totals.loc} lines` + langSummary(facts));
  if (facts.entryPoints.length) header.push(`ENTRY POINTS: ${facts.entryPoints.slice(0, 12).join(', ')}`);
  const services = facts.externals.filter((e) => e.kind === 'service');
  const others = facts.externals.filter((e) => e.kind !== 'service');
  if (services.length) header.push(`EXTERNAL SERVICES (imported, not in this repo): ${services.map((e) => `${e.name} (${e.usedBy} files)`).join(', ')}`);
  if (others.length) header.push(`EXTERNAL PACKAGES: ${others.slice(0, 20).map((e) => `${e.name} (${e.usedBy})`).join(', ')}`);
  if (facts.coreModules.length) {
    header.push(`CORE MODULES (most depended-on, computed; every one of these belongs on the map):`);
    for (const p of facts.coreModules) {
      const f = byPath.get(p);
      header.push(`  ${p}  fan-in ${f?.fanIn ?? 0}${f?.entry ? '  ENTRY' : ''}`);
    }
  }
  if (readme) header.push('', 'README:', readme);

  // Files, under the directory they live in — location, grouped for readability only.
  const byDir = new Map<string, IndexFile[]>();
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }

  const levels = new Map<string, 2 | 1 | 0>(files.map((f) => [f.path, 2]));
  const render = (): string => {
    const body: string[] = ['', 'FILES (location, not architecture):'];
    for (const dir of [...byDir.keys()].sort()) {
      body.push(`${dir === '.' ? '(repo root)' : `${dir}/`}`);
      for (const f of byDir.get(dir)!) body.push(fileLine(f, levels.get(f.path) ?? 2));
    }
    return `${header.join('\n')}\n${body.join('\n')}`;
  };

  // Deterministic trimming: the least-load-bearing files lose detail first, then the list is
  // cut. Sorted by fan-in so the same repo always trims the same way.
  const byImportance = [...files].sort((a, b) => a.fanIn - b.fanIn || b.loc - a.loc || a.path.localeCompare(b.path));
  let text = render();
  let trimmed = false;
  for (const f of byImportance) {
    if (text.length <= o.maxChars) break;
    const lvl = levels.get(f.path) ?? 2;
    if (lvl === 0) continue;
    levels.set(f.path, (lvl === 2 ? 1 : 0) as 1 | 0);
    trimmed = true;
    text = render();
  }

  return {
    files,
    byPath,
    coreModules: facts.coreModules,
    entryPoints: facts.entryPoints,
    externals: facts.externals,
    totals: facts.totals,
    text,
    trimmed,
  };
}

function langSummary(facts: RepoFacts): string {
  const parts = Object.entries(facts.totals.byLang)
    .sort((a, b) => b[1].loc - a[1].loc)
    .map(([lang, t]) => `${lang} ${t.files} files/${t.loc} lines`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The files one area pass should see: full detail, plus excerpts of its most load-bearing ones. */
export function areaIndexText(index: SourceIndex, paths: string[], excerpts: { path: string; text: string }[]): string {
  const chosen = paths.map((p) => index.byPath.get(p)).filter((f): f is IndexFile => Boolean(f));
  const lines = chosen.map((f) => fileLine(f, 2));
  const out = [
    `FILES IN THIS PART OF THE SYSTEM (${chosen.length}):`,
    ...lines,
  ];
  const own = chosen.filter((f) => f.entry || f.fanIn > 1).sort((a, b) => Number(b.entry) - Number(a.entry) || b.fanIn - a.fanIn);
  const want = new Set(own.slice(0, excerpts.length).map((f) => f.path));
  const keep = excerpts.filter((e) => want.has(e.path));
  if (keep.length) {
    out.push('', 'EXCERPTS (read from the files, so you can name what they actually do):');
    for (const e of keep) out.push(`--- ${e.path}`, e.text, '');
  }
  return out.join('\n');
}

/** Read bounded excerpts of the files a pass should actually see the text of. */
export async function readExcerpts(
  root: string,
  paths: string[],
  opts: IndexOptions = {},
): Promise<{ path: string; text: string }[]> {
  const o = { ...DEFAULTS, ...opts };
  const out: { path: string; text: string }[] = [];
  for (const p of paths.slice(0, o.excerptsPerArea)) {
    try {
      const raw = await readFile(path.join(root, p), 'utf8');
      const lines = raw.split('\n');
      const head = lines.slice(0, o.excerptLines).join('\n');
      out.push({ path: p, text: lines.length > o.excerptLines ? `${head}\n… (${lines.length - o.excerptLines} more lines)` : head });
    } catch {
      /* a file that vanished between scan and read is simply not excerpted */
    }
  }
  return out;
}
