/**
 * Deterministic repo scanning: which files exist, what they contain, how big they
 * are and what they hash to. Everything downstream is grounded in this.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'target', 'vendor', '.cache', '.turbo', '.svelte-kit', '.idea',
  '.vscode', '.syscode', 'site-packages', '.gradle', 'bin', 'obj', 'Pods',
]);

export const IGNORE_FILE_RE = /(^package-lock\.json$|^pnpm-lock\.yaml$|^yarn\.lock$|\.min\.(js|css)$|\.d\.ts$|\.map$|\.lock$|^\.DS_Store$)/;

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.java': 'java',
  '.php': 'php', '.cs': 'csharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.sql': 'sql', '.css': 'css', '.scss': 'css', '.html': 'html',
  '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
};

/** Languages we can extract symbols and imports from. */
export const ANALYZABLE = new Set(['typescript', 'javascript', 'python', 'rust', 'go']);
/** Languages that count toward the project's code size. */
export const CODE_LANGS = new Set(['typescript', 'javascript', 'python', 'rust', 'go', 'sql', 'css', 'html', 'java', 'rb', 'php', 'cs', 'c', 'cpp']);

const MAX_FILE_BYTES = 1_500_000;

export interface ScannedFile {
  /** repo-relative, posix separators */
  path: string;
  abs: string;
  lang: string;
  loc: number;
  bytes: number;
  hash: string;
  text: string;
  isSource: boolean;
}

export function langOf(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return LANG_BY_EXT[ext] ?? 'other';
}

export function countLoc(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.length && text[text.length - 1] !== '\n' ? n + 1 : n;
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export interface ScanOptions {
  /** Extra paths to skip, repo-relative. Prefixes ending in `/` skip a whole subtree. */
  ignore?: string[];
  maxFiles?: number;
}

function makeIgnoreMatcher(patterns: string[]): (rel: string) => boolean {
  const rules = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'))
    .map((p) => p.replace(/^\.\//, '').replace(/^\//, ''));
  if (!rules.length) return () => false;
  const regexes = rules.map((rule) => {
    const escaped = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return new RegExp(`^${escaped}${rule.endsWith('/') ? '' : '(/.*)?$'}`);
  });
  return (rel: string) => regexes.some((re) => re.test(rel));
}

export async function scanRepo(root: string, opts: ScanOptions = {}): Promise<ScannedFile[]> {
  const abs = path.resolve(root);
  const isIgnored = makeIgnoreMatcher(opts.ignore ?? []);
  const maxFiles = opts.maxFiles ?? 4000;
  const out: ScannedFile[] = [];
  const seenDirs = new Set<string>();

  async function walk(dir: string, rel: string) {
    if (out.length >= maxFiles) return;
    if (seenDirs.has(dir)) return;
    seenDirs.add(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnored(childRel)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.') ) continue;
        await walk(path.join(dir, e.name), childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      if (IGNORE_FILE_RE.test(e.name) && e.name !== 'package.json') continue;

      const p = path.join(dir, e.name);
      let st;
      try {
        st = await stat(p);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;

      const lang = langOf(e.name);
      if (lang === 'other') continue;
      let text = '';
      try {
        text = await readFile(p, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // binary
      out.push({
        path: childRel,
        abs: p,
        lang,
        loc: countLoc(text),
        bytes: st.size,
        hash: hashText(text),
        text,
        isSource: ANALYZABLE.has(lang),
      });
    }
  }

  await walk(abs, '');
  return out;
}

/** Read a project's declared dependencies without running anything. */
export async function readDeclaredDeps(root: string): Promise<string[]> {
  const deps = new Set<string>();
  const pkg = path.join(root, 'package.json');
  try {
    const j = JSON.parse(await readFile(pkg, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(j[field] ?? {})) deps.add(name);
    }
  } catch {
    /* no package.json */
  }
  const req = path.join(root, 'requirements.txt');
  try {
    const txt = await readFile(req, 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.\-]+)/.exec(line);
      if (m && !line.trim().startsWith('#')) deps.add(m[1]);
    }
  } catch {
    /* no requirements.txt */
  }
  return [...deps];
}
