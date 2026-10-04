/**
 * The mapper: facts → a proposed map.
 *
 * This is *not* a file-to-node converter. It reads the code facts and decides what
 * the meaningful units are — the way a senior engineer would draw a system on a
 * whiteboard: a handful of big pieces, each with a plain-language explanation, and
 * only as much detail as the level you asked for.
 *
 * With no model configured this runs alone (the "heuristic brain"), and every node
 * is labelled as such in the interface. With a model configured, the same structure
 * is handed to the model, which keeps the responsibility for naming, grouping and
 * explanation — the facts keep it honest.
 */
import type { Anchor, FileFacts, MapEdge, NodeKind, Provenance, RepoFacts, SymbolFact } from '../types.ts';
import { serviceLabel } from '../analyze/external.ts';

const MAX_AREAS = 8;
const MAX_CHILDREN = 6;
const MAX_DEPTH = 3;
/** An "area" covering more files than this is opened up one level further. */
const MAX_FILES_PER_AREA = 8;

export interface ProposedNode {
  key: string;
  label: string;
  kind: NodeKind;
  level: number;
  parentKey: string | null;
  summary: string;
  detail?: string;
  anchors: Anchor[];
  origin: Provenance;
  position: { x: number; y: number };
  metrics: { files: number; loc: number; symbols: number };
  heuristic: boolean;
  /** repo-relative files this node covers, at every depth below it */
  files: string[];
}

export interface ProposedEdge {
  sourceKey: string;
  targetKey: string;
  label: string;
  kind: MapEdge['kind'];
  origin: Provenance;
  weight: number;
}

export interface ProposedMap {
  nodes: ProposedNode[];
  edges: ProposedEdge[];
}

/* ------------------------------------------------------------------ naming -- */

const PREFERRED_LABELS: Record<string, string> = {
  auth: 'Authentication', authentication: 'Authentication', login: 'Sign-in',
  session: 'Sessions', permissions: 'Permissions', security: 'Security',
  api: 'HTTP API', server: 'Server', servers: 'Server', routes: 'Routes', router: 'Routing',
  handlers: 'Request handlers', controllers: 'Controllers', middleware: 'Middleware',
  http: 'HTTP layer', endpoints: 'API endpoints', graphql: 'GraphQL API',
  db: 'Persistence', database: 'Persistence', data: 'Data layer', models: 'Data model',
  model: 'Data model', repositories: 'Repositories', repo: 'Repositories', storage: 'Storage',
  migrations: 'Schema migrations', schema: 'Schema', pool: 'Connection pool',
  web: 'Web interface', frontend: 'Web interface', ui: 'User interface', views: 'Views',
  components: 'UI components', pages: 'Pages', client: 'Client', app: 'Application shell',
  orders: 'Orders', order: 'Orders', cart: 'Cart', checkout: 'Checkout', products: 'Products',
  product: 'Products', payments: 'Payments', payment: 'Payments', billing: 'Billing',
  users: 'Users', user: 'Users', accounts: 'Accounts', profile: 'Profiles',
  notifications: 'Notifications', email: 'Email', jobs: 'Background jobs',
  workers: 'Background workers', worker: 'Background worker', queue: 'Job queue',
  tasks: 'Tasks', cron: 'Scheduled jobs', analytics: 'Analytics', reporting: 'Reporting',
  reports: 'Reports', search: 'Search', exports: 'Exports', exporters: 'Exporters',
  shared: 'Shared utilities', common: 'Shared utilities', utils: 'Utilities', util: 'Utilities',
  lib: 'Library', helpers: 'Helpers', core: 'Core', engine: 'Engine', domain: 'Domain logic',
  services: 'Services', service: 'Services', config: 'Configuration', settings: 'Configuration',
  env: 'Environment', constants: 'Constants', types: 'Types', interfaces: 'Interfaces',
  tests: 'Tests', test: 'Tests', __tests__: 'Tests', spec: 'Tests', docs: 'Documentation',
  scripts: 'Scripts', cli: 'Command line', bin: 'Command line', tools: 'Tooling',
  integrations: 'Integrations', external: 'External integrations', clients: 'External clients',
  fixtures: 'Test fixtures', analysis: 'Code analysis', analyze: 'Code analysis', scanner: 'Scanning',
  scan: 'Scanning', map: 'Map model', memory: 'Memory', llm: 'Model integration', agent: 'Agent',
  store: 'Local store', packages: 'Packages', apps: 'Applications', src: 'Source',
  desktop: 'Desktop shell', templates: 'Templates', validation: 'Validation',
  errors: 'Error handling', logger: 'Logging', logging: 'Logging', monitoring: 'Monitoring',
  metrics: 'Metrics', cache: 'Cache', caching: 'Cache', render: 'Rendering', painter: 'Rendering',
  canvas: 'Canvas', graph: 'Graph model', pack: 'Packaging', publish: 'Publishing',
  firebase: 'Firebase', assets: 'Assets', rules: 'Rules', policies: 'Policies', audit: 'Audit',
  webhooks: 'Webhooks', webhook: 'Webhooks', tracing: 'Tracing', events: 'Events',
  identity: 'Identity', billing_worker: 'Billing worker', scheduler: 'Scheduler',
};

/**
 * Role hints are matched against the *directory or file name*, with a trailing boundary so
 * `repo` cannot claim `reporting`. Add explicit plurals rather than loosening the pattern.
 */
const ROLE_HINTS: { test: RegExp; role: string }[] = [
  { test: /^(auth|authentication|login|logins|session|sessions|permission|permissions|jwt|security|acl|identity|password|passwords|token|tokens)(?![a-z])/, role: 'Establishes who the user is and what they are allowed to do.' },
  { test: /^(db|database|databases|data|datastore|model|models|persistence|persist|storage|store|stores|schema|schemas|migration|migrations|repository|repositories|repo|repos|pool|query|queries|sql|sqlite|postgres)(?![a-z])/, role: 'Owns how data is stored, shaped and retrieved.' },
  { test: /^(analytic|analytics|report|reports|reporting|metric|metrics|dashboard|dashboards|insight|insights|funnel|summary|summaries)(?![a-z])/, role: 'Turns stored data into answers about what happened.' },
  { test: /^(api|apis|server|servers|route|routes|router|routers|handler|handlers|controller|controllers|endpoint|endpoints|middleware|http)(?![a-z])/, role: 'The surface the outside world talks to.' },
  { test: /^(web|frontend|ui|view|views|page|pages|component|components|client|clients|render|rendering)(?![a-z])/, role: 'What the user actually sees and clicks.' },
  { test: /^(notification|notifications|email|emails|worker|workers|job|jobs|queue|queues|task|tasks|cron|background|mailer)(?![a-z])/, role: 'Work that happens outside a request: delivery, retries, scheduled runs.' },
  { test: /^(payment|payments|billing|charge|charges|stripe|invoice|invoices|refund|refunds)(?![a-z])/, role: 'Money movement and the accounting around it.' },
  { test: /^(order|orders|cart|carts|checkout|purchase|purchases|product|products|catalog|stock|inventory)(?![a-z])/, role: 'The core commerce flow: what is being bought and in what state.' },
  { test: /^(user|users|account|accounts|profile|profiles|tenant|tenants|member|members)(?![a-z])/, role: 'The people and organisations the system knows about.' },
  { test: /^(exporter|exporters|serializer|serializers|formatter|formatters)(?![a-z])/, role: 'Turns the system\'s data into the formats something else consumes.' },
  { test: /^(shared|common|util|utils|utility|utilities|lib|libs|helper|helpers|core|domain|service|services)(?![a-z])/, role: 'Cross-cutting pieces every other area leans on.' },
  { test: /^(config|configs|configuration|settings|setting|env|environment|constant|constants)(?![a-z])/, role: 'Where environment and runtime settings are resolved.' },
  { test: /^(test|tests|spec|specs|fixture|fixtures|__tests__)(?![a-z])/, role: 'Proof that the rest of the system behaves.' },
  { test: /^(script|scripts|cli|bin|tool|tools|command|commands)(?![a-z])/, role: 'Developer and operator entry points.' },
  { test: /^(integration|integrations|external|adapter|adapters)(?![a-z])/, role: 'Adapters to systems we do not own.' },
];

const TOKEN_WORDS: Record<string, string> = {
  auth: 'authentication', db: 'database', api: 'API', ui: 'UI', http: 'HTTP', jwt: 'JWT',
  url: 'URL', id: 'ID', ids: 'IDs', config: 'configuration', configs: 'configuration',
  util: 'helpers', utils: 'helpers', lib: 'library', cmd: 'command', pkg: 'package',
  sql: 'SQL', io: 'I/O', repo: 'storage', client: 'client', ts: '', js: '', py: '',
  svc: 'service', msg: 'message', req: 'request', res: 'response', num: 'number',
  str: 'string', obj: 'object', fn: 'function', ctx: 'context', env: 'environment',
};

export function humanize(raw: string): string {
  const words = raw
    .replace(/\.[a-z]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => {
      const low = w.toLowerCase();
      if (low in TOKEN_WORDS) return TOKEN_WORDS[low];
      if (/^[A-Z]{2,}$/.test(w)) return w;
      return low;
    })
    .filter(Boolean);
  if (!words.length) return raw;
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function preferredLabel(segment: string): string | undefined {
  const key = segment.toLowerCase();
  return PREFERRED_LABELS[key] ?? PREFERRED_LABELS[key.replace(/s$/, '')];
}

const GENERIC_SEGMENTS = new Set(['src', 'app', 'apps', 'lib', 'libs', 'packages', 'source', 'code', 'main', 'core', 'modules', 'internal', 'server', 'client']);

function labelForDir(dir: string): string {
  const segments = dir.split('/').filter(Boolean);
  // `web/src` should read as "Web interface", not "Source": skip container-ish segments.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const preferred = preferredLabel(seg);
    if (preferred && !GENERIC_SEGMENTS.has(seg.toLowerCase())) return preferred;
    if (!GENERIC_SEGMENTS.has(seg.toLowerCase())) return humanize(seg);
  }
  const base = basename(dir);
  return preferredLabel(base) ?? humanize(base || 'Source');
}

function roleFor(segment: string): string | undefined {
  const key = segment.toLowerCase();
  return ROLE_HINTS.find((h) => h.test.test(key))?.role;
}

/* ------------------------------------------------------------------- units -- */

interface Unit {
  dir: string;
  files: FileFacts[];
  loc: number;
  symbols: number;
  exports: string[];
  entryFiles: string[];
  internalDeps: Set<string>;
  serviceDeps: Set<string>;
  importedBy: Set<string>;
}

export function buildUnits(facts: RepoFacts): Map<string, Unit> {
  const units = new Map<string, Unit>();
  const ownerByFile = new Map<string, string>();
  for (const f of facts.files) ownerByFile.set(f.path, dirOf(f.path));

  const ensure = (dir: string): Unit => {
    let u = units.get(dir);
    if (!u) {
      u = { dir, files: [], loc: 0, symbols: 0, exports: [], entryFiles: [], internalDeps: new Set(), serviceDeps: new Set(), importedBy: new Set() };
      units.set(dir, u);
    }
    return u;
  };

  for (const f of facts.files) {
    const u = ensure(dirOf(f.path));
    u.files.push(f);
    u.loc += f.loc;
    u.symbols += f.symbols.length;
    u.exports.push(...f.exports.slice(0, 6));
    if (f.isEntry) u.entryFiles.push(f.path);
  }

  const servicePkgs = new Set(facts.externals.filter((e) => e.kind === 'service').map((e) => e.name));
  for (const f of facts.files) {
    const from = dirOf(f.path);
    const u = ensure(from);
    for (const imp of f.imports) {
      if (imp.external && imp.package && servicePkgs.has(imp.package)) u.serviceDeps.add(imp.package);
      if (!imp.resolved) continue;
      const to = ownerByFile.get(imp.resolved) ?? dirOf(imp.resolved);
      if (to === from) continue;
      u.internalDeps.add(to);
      ensure(to).importedBy.add(from);
    }
  }

  return units;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function basename(dir: string): string {
  const i = dir.lastIndexOf('/');
  return i === -1 ? dir : dir.slice(i + 1);
}

function stemOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '');
}

/** The label a single file deserves: its own name, decoded where it means something. */
function fileLabel(f: FileFacts): string {
  const stem = stemOf(f.path);
  return preferredLabel(stem) ?? humanize(stem);
}

function under(dir: string, p: string): boolean {
  return dir === '' ? true : p.startsWith(dir + '/') || dirOf(p) === dir;
}

function locOf(files: FileFacts[]): number {
  return files.reduce((n, f) => n + f.loc, 0);
}

function affinity(a: FileFacts[], b: FileFacts[]): number {
  let n = 0;
  const dirsOf = (files: FileFacts[]) => new Set(files.map((f) => dirOf(f.path)));
  const bDirs = dirsOf(b);
  const aDirs = dirsOf(a);
  for (const f of a) {
    for (const imp of f.imports) {
      if (imp.resolved && (bDirs.has(dirOf(imp.resolved)) || b.some((x) => x.path === imp.resolved))) n += 2;
    }
  }
  for (const f of b) {
    for (const imp of f.imports) {
      if (imp.resolved && (aDirs.has(dirOf(imp.resolved)) || a.some((x) => x.path === imp.resolved))) n += 2;
    }
  }
  return n;
}

/* ------------------------------------------------------------------ groups -- */

interface Group {
  key: string;
  name: string;
  kind: NodeKind;
  dirs: string[];
  files: FileFacts[];
  children: Group[];
  /** true when the name was synthesised by clustering, so it may not claim a role */
  synthetic?: boolean;
}

/** Split files into at most `k` groups, keeping import-related files together. */
function splitByAffinity(files: FileFacts[], k: number): FileFacts[][] {
  if (files.length <= k) return files.map((f) => [f]);
  const adj = new Map<string, Set<string>>();
  for (const f of files) adj.set(f.path, new Set());
  for (const f of files) {
    for (const imp of f.imports) {
      if (!imp.resolved || !adj.has(imp.resolved)) continue;
      adj.get(f.path)!.add(imp.resolved);
      adj.get(imp.resolved)!.add(f.path);
    }
  }
  const byDegree = [...files].sort(
    (a, b) => (adj.get(b.path)!.size - adj.get(a.path)!.size) || b.loc - a.loc,
  );
  const clusters: FileFacts[][] = byDegree.slice(0, k).map((f) => [f]);
  const assigned = new Set(byDegree.slice(0, k).map((f) => f.path));
  for (const f of byDegree) {
    if (assigned.has(f.path)) continue;
    let best = 0;
    let bestScore = -1;
    clusters.forEach((c, i) => {
      const score = c.reduce((n, m) => n + (adj.get(f.path)!.has(m.path) ? 1 : 0), 0);
      if (score > bestScore || (score === bestScore && c.length < clusters[best].length)) {
        bestScore = score;
        best = i;
      }
    });
    clusters[best].push(f);
    assigned.add(f.path);
  }
  return clusters.filter((c) => c.length);
}

/** Files with no useful directory structure between them get clustered by name stem, then by import affinity. */
function clusterFiles(keyPrefix: string, files: FileFacts[]): Group[] {
  const byStem = new Map<string, FileFacts[]>();
  for (const f of files) {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '');
    const stem = base.split(/[-_.]/)[0];
    const key = stem.length > 2 ? stem : '__other';
    if (!byStem.has(key)) byStem.set(key, []);
    byStem.get(key)!.push(f);
  }

  let groups: FileFacts[][] = [];
  const singles: FileFacts[] = [];
  for (const [, group] of byStem) {
    if (group.length >= 2) groups.push(group);
    else singles.push(...group);
  }
  if (!groups.length && singles.length) {
    // nothing in common by name: fall back to how the files actually import each other
    groups = splitByAffinity(singles.splice(0, singles.length), Math.min(MAX_CHILDREN, Math.ceil(files.length / 3)));
  } else {
    for (const s of singles) {
      const targets = new Set(s.imports.filter((i) => i.resolved).map((i) => i.resolved!));
      let best: FileFacts[] | undefined;
      let bestScore = 0;
      for (const g of groups) {
        const score = g.filter((f) => targets.has(f.path) || dirOf(f.path) === dirOf(s.path)).length;
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
      if (best && bestScore > 0) best.push(s);
      else groups.push([s]);
    }
  }

  // a group that is still too big to read is split by affinity, not left as a pile
  groups = groups.flatMap((g) => (g.length > MAX_CHILDREN ? splitByAffinity(g, Math.min(MAX_CHILDREN, Math.ceil(g.length / 3))) : [g]));

  while (groups.length > MAX_CHILDREN) {
    groups.sort((a, b) => locOf(a) - locOf(b));
    const small = groups.shift()!;
    let target = groups[0];
    let bestScore = -1;
    for (const g of groups) {
      const score = affinity(small, g);
      if (score > bestScore) {
        bestScore = score;
        target = g;
      }
    }
    target.push(...small);
  }

  return groups.map((g, i) => ({
    key: `${keyPrefix}#c${i}`,
    name: stemName(g),
    kind: 'component' as NodeKind,
    dirs: [...new Set(g.map((f) => dirOf(f.path)))],
    files: [...g].sort((a, b) => b.loc - a.loc),
    children: [],
    synthetic: true,
  }));
}

function stemName(files: FileFacts[]): string {
  const stems = files.map((f) => f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '').split(/[-_.]/)[0]);
  const counts = new Map<string, number>();
  for (const s of stems) counts.set(s, (counts.get(s) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) return humanize(top[0]);
  if (files.length === 1) return humanize(stems[0]);
  // no shared name: lead with the most-connected module and say what it is
  const lead = [...files].sort((a, b) => b.loc - a.loc)[0];
  return `${humanize(lead.path.slice(lead.path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, ''))} group`;
}

function fileGroup(file: FileFacts, level: number): Group {
  return {
    key: `file:${file.path}`,
    name: humanize(file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '')),
    kind: level <= 1 ? 'component' : 'component',
    dirs: [dirOf(file.path)],
    files: [file],
    children: [],
  };
}

/** The node for one directory, with its children already grouped. */
function dirGroup(dir: string, files: FileFacts[], level: number, units: Map<string, Unit>): Group {
  const node: Group = {
    key: `dir:${dir || '.'}`,
    name: labelForDir(dir),
    kind: level === 0 ? 'subsystem' : level === 1 ? 'feature' : 'component',
    dirs: [dir],
    files,
    children: [],
  };
  if (level >= MAX_DEPTH) return node;

  const subdirs = [...units.keys()].filter((d) => d !== dir && dirOf(d) === dir).sort();
  const direct = files.filter((f) => dirOf(f.path) === dir);
  const children: Group[] = [];
  for (const sub of subdirs) children.push(dirGroup(sub, files.filter((f) => under(sub, f.path)), level + 1, units));
  if (direct.length > MAX_CHILDREN) children.push(...clusterFiles(`${node.key}#direct`, direct));
  else for (const f of direct.sort((a, b) => b.loc - a.loc)) children.push(fileGroup(f, level + 1));

  node.children = children;
  return node;
}

/* ------------------------------------------------------------------- areas -- */

interface AreaPlan {
  key: string;
  label: string;
  segment: string;
  dirs: string[];
  files: FileFacts[];
  children: Group[];
}

/**
 * Choose the level of abstraction the map should open at.
 *
 * Directories that hold no source files of their own (`src`, `packages/core`) are
 * containers, not areas — we descend through them. If that leaves too few pieces to
 * be a useful map, we open the pieces up one level and try again.
 */
function planAreas(facts: RepoFacts, units: Map<string, Unit>): AreaPlan[] {
  const direct = new Map<string, FileFacts[]>();
  for (const f of facts.files) {
    const d = dirOf(f.path);
    if (!direct.has(d)) direct.set(d, []);
    direct.get(d)!.push(f);
  }
  const allDirs = new Set<string>();
  for (const f of facts.files) {
    let d = dirOf(f.path);
    for (;;) {
      allDirs.add(d);
      if (!d) break;
      const parent = dirOf(d);
      if (parent === d) break;
      d = parent;
    }
  }
  const subdirsOf = (d: string) => [...allDirs].filter((x) => x !== d && dirOf(x) === d).sort();

  const collapse = (d: string): string[] => {
    if (direct.has(d) || !subdirsOf(d).length) return [d];
    return subdirsOf(d).flatMap(collapse);
  };

  let current = collapse('');
  // Keep opening the map up while it is too coarse to be useful: either a piece covers
  // more than a screenful of files, or there are too few pieces to be a map at all.
  for (let guard = 0; guard < 8; guard++) {
    const filesUnder = (d: string) => facts.files.filter((f) => under(d, f.path)).length;
    const tooFew = current.length < 4;
    const needsOpening = current.some((d) => filesUnder(d) > MAX_FILES_PER_AREA);
    if (!tooFew && !needsOpening) break;
    const next = current.flatMap((d) => {
      const subs = subdirsOf(d);
      if (!subs.length) return [d];
      if (!tooFew && filesUnder(d) <= MAX_FILES_PER_AREA) return [d];
      return subs.flatMap(collapse);
    });
    if (next.length <= current.length) break;
    current = next;
  }
  if (!current.length) current = [''];

  const owned = new Map<string, FileFacts[]>();
  for (const d of current) owned.set(d, facts.files.filter((f) => under(d, f.path)));

  // files sitting directly in an ancestor of the chosen areas still need a home
  const orphans = facts.files.filter((f) => !current.some((d) => under(d, f.path)));
  for (const f of orphans) {
    let target = current[0];
    let best = -1;
    for (const d of current) {
      const score = affinity([f], owned.get(d) ?? []);
      if (score > best) {
        best = score;
        target = d;
      }
    }
    owned.get(target)!.push(f);
  }

  let entries = current
    .map((dir) => ({ dir, files: owned.get(dir) ?? [] }))
    .filter((e) => e.files.length);

  if (!entries.length) entries = [{ dir: '', files: facts.files }];

  // A flat repo (everything in one directory) has no directory structure to read, so the
  // file names themselves are the architecture. Few enough files: one node each, labelled
  // from the name — not a "Source" blob with fake groupings inside it.
  if (entries.length === 1) {
    const flatFiles = [...entries[0].files].sort((a, b) => b.loc - a.loc);
    if (flatFiles.length <= MAX_AREAS) {
      return flatFiles.map((f) => ({
        key: `area:${slug(fileLabel(f))}`,
        label: fileLabel(f),
        segment: stemOf(f.path),
        dirs: [dirOf(f.path)],
        files: [f],
        children: [],
      }));
    }
    const clusters = clusterFiles(`dir:${entries[0].dir}`, flatFiles);
    if (clusters.length > 1) {
      return clusters.map((c) => ({
        key: `area:${slug(c.name)}`,
        label: c.name,
        segment: slug(c.name),
        dirs: c.dirs,
        files: c.files,
        children: c.files.map((f) => fileGroup(f, 1)),
      }));
    }
  }

  // too many pieces for one screen: fold the smallest into their closest neighbour
  while (entries.length > MAX_AREAS) {
    entries.sort((a, b) => locOf(a.files) - locOf(b.files));
    const victim = entries.shift()!;
    let target = entries[0];
    let best = -1;
    for (const e of entries) {
      const score = affinity(victim.files, e.files);
      if (score > best) {
        best = score;
        target = e;
      }
    }
    target.files = [...target.files, ...victim.files];
    target.dir = target.dir;
  }

  return entries
    .sort((a, b) => locOf(b.files) - locOf(a.files))
    .map((e) => {
      const segment = basename(e.dir) || 'source';
      const label = labelForDir(e.dir);
      const children = e.files.length > 1 && !dirGroup(e.dir, e.files, 1, units).children.length
        ? clusterFiles(`dir:${e.dir}`, e.files)
        : dirGroup(e.dir, e.files, 1, units).children;
      return {
        key: `area:${slug(label)}`,
        label,
        segment,
        dirs: [...new Set(e.files.map((f) => dirOf(f.path)))],
        files: e.files,
        children,
      };
    });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------ summarising -- */

function kindOfExports(files: FileFacts[]): Map<string, SymbolFact['kind']> {
  const map = new Map<string, SymbolFact['kind']>();
  for (const f of files) {
    for (const s of f.symbols) if (s.exported && !map.has(s.name)) map.set(s.name, s.kind);
  }
  return map;
}

const KIND_ORDER: SymbolFact['kind'][] = ['function', 'class', 'const', 'type', 'interface', 'method'];

function renderExport(name: string, kind: SymbolFact['kind'] | undefined): string {
  if (kind === 'function' || kind === 'method') return `\`${name}()\``;
  if (kind === 'class') return `\`${name}\``;
  if (kind === 'interface' || kind === 'type') return `\`${name}\``;
  return `\`${name}\``;
}

function exportsPhrase(files: FileFacts[]): string {
  const kinds = kindOfExports(files);
  const names = [...new Set(files.flatMap((f) => f.exports))].filter((n) => n && n !== 'default' && n.length > 1 && !/^[A-Z_]{2,}$/.test(n));
  if (!names.length) return '';
  const ranked = names.sort((a, b) => KIND_ORDER.indexOf(kinds.get(a) ?? 'const') - KIND_ORDER.indexOf(kinds.get(b) ?? 'const'));
  const shown = ranked.slice(0, 3).map((n) => renderExport(n, kinds.get(n)));
  const rest = ranked.length - shown.length;
  return `Exposes ${listPhrase(shown)}${rest > 0 ? ` and ${rest} more` : ''}.`;
}

function listPhrase(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function areaSummary(plan: AreaPlan, usedBy: string[], dependsOn: string[]): string {
  // Only the directory the area actually came from may claim a role. Reading it off the
  // human label produced confidently wrong sentences ("Model integration" → data layer).
  const role = roleFor(plan.segment);
  const parts: string[] = [];
  parts.push(role ?? `The ${plan.label.toLowerCase()} part of the system.`);
  const ex = exportsPhrase(plan.files);
  if (ex) parts.push(ex);
  if (usedBy.length) parts.push(`Used by ${listPhrase(usedBy.slice(0, 3))}.`);
  else parts.push('Nothing else in the repo imports it yet.');
  if (dependsOn.length) parts.push(`Depends on ${listPhrase(dependsOn.slice(0, 3))}.`);
  return parts.join(' ');
}

function groupSummary(group: Group, parentSegment: string): string {
  if (group.files.length === 1) {
    const f = group.files[0];
    const ex = exportsPhrase([f]);
    const entry = f.isEntry ? 'Entry point into the system. ' : '';
    const role = roleFor(f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, ''));
    const lead = role ? `${role} ` : '';
    return `${entry}${lead}${ex || `\`${f.path}\` — one module.`}`;
  }
  const role = group.synthetic ? undefined : roleFor(group.name) ?? roleFor(basename(group.dirs[0] ?? ''));
  const ex = exportsPhrase(group.files);
  const lead = role ? `${role} ` : '';
  return `${lead}${ex || `Sits inside ${humanize(parentSegment)}.`}`;
}

/* ---------------------------------------------------------------- assemble -- */

export function proposeMap(facts: RepoFacts): ProposedMap {
  const units = buildUnits(facts);
  const plans = planAreas(facts, units);
  const nodes: ProposedNode[] = [];
  const edges: ProposedEdge[] = [];

  const fileIndex = new Map(facts.files.map((f) => [f.path, f]));
  const areaByFile = new Map<string, string>();
  for (const plan of plans) for (const f of plan.files) areaByFile.set(f.path, plan.key);

  const areaDeps = new Map<string, Set<string>>();
  const areaUsedBy = new Map<string, Set<string>>();
  for (const plan of plans) {
    areaDeps.set(plan.key, new Set());
    areaUsedBy.set(plan.key, new Set());
  }
  for (const plan of plans) {
    for (const f of plan.files) {
      for (const imp of f.imports) {
        if (!imp.resolved) continue;
        const other = areaByFile.get(imp.resolved);
        if (!other || other === plan.key) continue;
        areaDeps.get(plan.key)!.add(other);
        areaUsedBy.get(other)!.add(plan.key);
      }
    }
  }
  const labelOf = new Map(plans.map((p) => [p.key, p.label]));

  for (const plan of plans) {
    const files = [...plan.files].sort((a, b) => b.loc - a.loc);
    const anchors: Anchor[] = [];
    for (const d of [...new Set(plan.dirs)].slice(0, 3)) if (d) anchors.push({ path: d, kind: 'dir' });
    for (const f of files.slice(0, 5)) anchors.push({ path: f.path, kind: 'file', hash: f.hash, weight: 1 });

    nodes.push({
      key: plan.key,
      label: plan.label,
      kind: plan.children.length ? 'subsystem' : 'component',
      level: 0,
      parentKey: null,
      summary: areaSummary(
        plan,
        [...areaUsedBy.get(plan.key)!].map((k) => labelOf.get(k) ?? k),
        [...areaDeps.get(plan.key)!].map((k) => labelOf.get(k) ?? k),
      ),
      detail: areaDetail(files),
      anchors,
      origin: 'verified',
      position: { x: 0, y: 0 },
      metrics: { files: files.length, loc: locOf(files), symbols: files.reduce((n, f) => n + f.symbols.length, 0) },
      heuristic: true,
      files: files.map((f) => f.path),
    });

    const walk = (group: Group, parentKey: string, level: number) => {
      const gFiles = group.files;
      const gAnchors: Anchor[] = [];
      if (!group.children.length) {
        for (const f of [...gFiles].sort((a, b) => b.loc - a.loc).slice(0, 12)) {
          gAnchors.push({ path: f.path, kind: 'file', hash: f.hash, weight: 1 });
        }
        for (const f of gFiles.slice(0, 4)) {
          for (const s of f.symbols.filter((x) => x.exported).slice(0, 2)) {
            gAnchors.push({ path: f.path, kind: 'symbol', symbol: s.name, lines: [s.line, s.endLine], hash: f.hash, weight: 1 });
          }
        }
      } else {
        for (const d of [...new Set(group.dirs)].slice(0, 4)) if (d) gAnchors.push({ path: d, kind: 'dir' });
      }

      nodes.push({
        key: group.key,
        label: group.name,
        kind: group.kind,
        level,
        parentKey,
        summary: groupSummary(group, plan.segment),
        detail: groupDetail(group),
        anchors: gAnchors,
        origin: 'verified',
        position: { x: 0, y: 0 },
        metrics: { files: gFiles.length, loc: locOf(gFiles), symbols: gFiles.reduce((n, f) => n + f.symbols.length, 0) },
        heuristic: true,
        files: gFiles.map((f) => f.path),
      });
      for (const c of group.children) walk(c, group.key, level + 1);
    };
    for (const c of plan.children) walk(c, plan.key, 1);
  }

  /* external services the code actually talks to */
  const externalNodes = new Map<string, ProposedNode>();
  for (const ext of facts.externals) {
    if (ext.kind !== 'service') continue;
    const name = serviceLabel(ext.name);
    if (!name) continue;
    const key = `ext:${ext.name}`;
    if (externalNodes.has(key)) continue;
    const users = facts.files.filter((f) => f.imports.some((i) => i.package === ext.name));
    const userAreaKeys = [...new Set(users.map((f) => areaByFile.get(f.path)).filter(Boolean) as string[])];
    const userAreas = userAreaKeys.map((k) => labelOf.get(k) ?? k);
    const node: ProposedNode = {
      key,
      label: name,
      kind: 'external',
      level: 0,
      parentKey: null,
      summary: `Outside the codebase: a service this project talks to through \`${ext.name}\`. Reached from ${listPhrase(userAreas.slice(0, 3)) || 'the code'}.`,
      detail: `Imported in ${users.length} file${users.length === 1 ? '' : 's'}: ${users.slice(0, 6).map((f) => f.path).join(', ')}.`,
      anchors: users.slice(0, 6).map((f) => ({ path: f.path, kind: 'file' as const, hash: f.hash, weight: 1 })),
      origin: 'verified',
      position: { x: 0, y: 0 },
      metrics: { files: users.length, loc: 0, symbols: 0 },
      heuristic: true,
      files: users.map((f) => f.path),
    };
    externalNodes.set(key, node);
    nodes.push(node);
    for (const areaKey of userAreaKeys) {
      edges.push({ sourceKey: areaKey, targetKey: key, label: 'uses', kind: 'uses', origin: 'verified', weight: 1 });
    }
  }

  /* edges between areas, from real import links */
  const pairCounts = new Map<string, number>();
  for (const plan of plans) {
    for (const f of plan.files) {
      for (const imp of f.imports) {
        if (!imp.resolved) continue;
        const other = areaByFile.get(imp.resolved);
        if (!other || other === plan.key) continue;
        const k = `${plan.key}\u0000${other}`;
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
      }
    }
  }
  for (const [k, weight] of pairCounts) {
    const [sourceKey, targetKey] = k.split('\u0000');
    const targetSegment = plans.find((p) => p.key === targetKey)?.segment ?? '';
    const { label, kind, origin } = edgeSemantics(targetKey, targetSegment, labelOf);
    edges.push({ sourceKey, targetKey, label, kind, origin, weight });
  }

  /* edges between siblings at every depth */
  const byParent = new Map<string, ProposedNode[]>();
  for (const n of nodes) {
    if (!n.parentKey) continue;
    if (!byParent.has(n.parentKey)) byParent.set(n.parentKey, []);
    byParent.get(n.parentKey)!.push(n);
  }
  for (const [, siblings] of byParent) {
    const owner = new Map<string, ProposedNode>();
    for (const s of siblings) for (const f of s.files) owner.set(f, s);
    const pairWeights = new Map<string, number>();
    for (const s of siblings) {
      for (const f of s.files) {
        const ff = fileIndex.get(f);
        if (!ff) continue;
        for (const imp of ff.imports) {
          if (!imp.resolved) continue;
          const other = owner.get(imp.resolved);
          if (!other || other.key === s.key) continue;
          const k = `${s.key}\u0000${other.key}`;
          pairWeights.set(k, (pairWeights.get(k) ?? 0) + 1);
        }
      }
    }
    for (const [k, weight] of pairWeights) {
      const [sourceKey, targetKey] = k.split('\u0000');
      const { label, kind, origin } = edgeSemantics(targetKey, '', labelOf);
      const exists = edges.some((e) => e.sourceKey === sourceKey && e.targetKey === targetKey);
      if (!exists) edges.push({ sourceKey, targetKey, label, kind, origin, weight });
    }
  }

  layoutLevels(nodes, edges);
  return { nodes, edges };
}

function edgeSemantics(
  targetKey: string,
  targetSegment: string,
  labelOf: Map<string, string>,
): { label: string; kind: MapEdge['kind']; origin: Provenance } {
  if (targetKey.startsWith('ext:')) return { label: 'uses', kind: 'uses', origin: 'verified' };
  const seg = (targetSegment || labelOf.get(targetKey) || '').toLowerCase();
  if (/^(db|data|persistence|storage|schema|model)/.test(seg)) return { label: 'reads and writes', kind: 'stores', origin: 'verified' };
  if (/^(api|server|http|route|endpoint|handler|controller)/.test(seg)) return { label: 'calls', kind: 'data', origin: 'inferred' };
  if (/^(notification|worker|job|queue|email)/.test(seg)) return { label: 'hands work to', kind: 'triggers', origin: 'inferred' };
  if (/^(web|frontend|ui|view|page|component|client)/.test(seg)) return { label: 'is rendered by', kind: 'custom', origin: 'inferred' };
  return { label: 'depends on', kind: 'depends', origin: 'verified' };
}

function areaDetail(files: FileFacts[]): string {
  const lines: string[] = [];
  const entries = files.filter((f) => f.isEntry);
  if (entries.length) lines.push(`Entry points: ${entries.map((f) => f.path).join(', ')}.`);
  const tops = [...files].sort((a, b) => b.loc - a.loc).slice(0, 5).map((f) => f.path);
  lines.push(`Main modules: ${tops.join(', ')}.`);
  const services = new Set<string>();
  for (const f of files) for (const i of f.imports) if (i.external && i.package && serviceLabel(i.package)) services.add(serviceLabel(i.package)!);
  if (services.size) lines.push(`Talks to: ${[...services].join(', ')}.`);
  return lines.join(' ');
}

function groupDetail(group: Group): string {
  if (group.files.length === 1) {
    const f = group.files[0];
    const exports = f.exports.length ? `Exports ${f.exports.slice(0, 6).map((e) => `\`${e}\``).join(', ')}.` : 'No exports.';
    const symbols = f.symbols.length ? `${f.symbols.length} top-level definition${f.symbols.length === 1 ? '' : 's'}.` : '';
    return `${f.path} — ${f.loc} lines. ${exports} ${symbols}`.trim();
  }
  const names = group.files.slice(0, 8).map((f) => f.path.split('/').pop());
  return `${group.files.length} modules: ${names.join(', ')}${group.files.length > 8 ? ', …' : ''}.`;
}

/* --------------------------------------------------------------- layout ---- */

const H_GAP = 360;
const V_GAP = 132;
/** Nodes per column before the layout wraps into another column. */
const PER_COL = 5;

/**
 * Rank siblings into layers by dependency direction.
 *
 * Real codebases are full of cycles (persistence ↔ orders), so a naive longest-path
 * layering collapses everything into one column. Back edges found by DFS are dropped
 * before ranking, which keeps the picture readable and stable.
 */
function layerize(keys: string[], localEdges: { source: string; target: string }[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const k of keys) adj.set(k, []);
  for (const e of localEdges) {
    if (e.source === e.target) continue;
    if (adj.has(e.source) && adj.has(e.target)) adj.get(e.source)!.push(e.target);
  }

  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (k: string) => {
    state.set(k, 1);
    for (const t of adj.get(k) ?? []) {
      const s = state.get(t);
      if (s === 1) back.add(`${k}\u0000${t}`);
      else if (!s) visit(t);
    }
    state.set(k, 2);
  };
  for (const k of [...keys].sort((a, b) => (adj.get(b)!.length - adj.get(a)!.length))) {
    if (!state.get(k)) visit(k);
  }

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const k of keys) {
    preds.set(k, []);
    succs.set(k, []);
  }
  for (const e of localEdges) {
    if (e.source === e.target || back.has(`${e.source}\u0000${e.target}`)) continue;
    if (!preds.has(e.target) || !succs.has(e.source)) continue;
    preds.get(e.target)!.push(e.source);
    succs.get(e.source)!.push(e.target);
  }

  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const k of keys) {
    layer.set(k, 0);
    indegree.set(k, preds.get(k)!.length);
  }
  const queue = keys.filter((k) => (indegree.get(k) ?? 0) === 0);
  while (queue.length) {
    const k = queue.shift()!;
    for (const s of succs.get(k)!) {
      layer.set(s, Math.max(layer.get(s) ?? 0, (layer.get(k) ?? 0) + 1));
      indegree.set(s, (indegree.get(s) ?? 0) - 1);
      if ((indegree.get(s) ?? 0) === 0) queue.push(s);
    }
  }
  return layer;
}

/** Deterministic layered layout: dependencies flow left → right, columns wrap when long. */
export function layoutLevels(nodes: ProposedNode[], edges: ProposedEdge[]): void {
  const byParent = new Map<string, ProposedNode[]>();
  for (const n of nodes) {
    const p = n.parentKey ?? '__root__';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(n);
  }

  for (const [, siblings] of byParent) {
    const keys = new Set(siblings.map((s) => s.key));
    const local = edges.filter((e) => keys.has(e.sourceKey) && keys.has(e.targetKey));
    const layerOf = layerize(
      siblings.map((s) => s.key),
      local.map((e) => ({ source: e.sourceKey, target: e.targetKey })),
    );

    const layers = new Map<number, ProposedNode[]>();
    for (const s of siblings) {
      const l = layerOf.get(s.key) ?? 0;
      if (!layers.has(l)) layers.set(l, []);
      layers.get(l)!.push(s);
    }

    let cursorX = 0;
    for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
      const ordered = [...layers.get(layer)!].sort((a, b) => {
        if (a.kind === 'external' && b.kind !== 'external') return 1;
        if (b.kind === 'external' && a.kind !== 'external') return -1;
        return b.metrics.loc - a.metrics.loc || a.label.localeCompare(b.label);
      });
      const cols = Math.max(1, Math.ceil(ordered.length / PER_COL));
      ordered.forEach((n, i) => {
        const col = Math.floor(i / PER_COL);
        const row = i % PER_COL;
        const inCol = Math.min(PER_COL, ordered.length - col * PER_COL);
        const height = (inCol - 1) * V_GAP;
        n.position = {
          x: Math.round(cursorX + col * H_GAP),
          y: Math.round(row * V_GAP - height / 2),
        };
      });
      cursorX += cols * H_GAP;
    }
  }
}
