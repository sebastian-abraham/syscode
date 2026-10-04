/**
 * Local storage for the project index, the map and its memory.
 * SQLite via node:sqlite — no native build, no server, one file per project
 * at <project>/.syscode/syscode.db.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Anchor, ChatMessage, JournalEntry, MapEdge, MapNode, Note, Proposal } from '../types.ts';

const SCHEMA = `
create table if not exists meta (k text primary key, v text not null);
create table if not exists nodes (
  id text primary key,
  key text not null,
  label text not null,
  kind text not null,
  level integer not null default 0,
  parent_id text,
  summary text not null default '',
  detail text,
  anchors text not null default '[]',
  origin text not null default 'inferred',
  x real not null default 0,
  y real not null default 0,
  position_locked integer not null default 0,
  label_locked integer not null default 0,
  stale integer not null default 0,
  heuristic integer not null default 0,
  metrics text not null default '{}',
  files text not null default '[]',
  created_at text not null,
  updated_at text not null
);
create index if not exists nodes_parent on nodes(parent_id);
create index if not exists nodes_key on nodes(key);
create table if not exists notes (
  id text primary key, node_id text not null, body text not null,
  kind text not null default 'note', author text not null default 'user', created_at text not null
);
create table if not exists edges (
  id text primary key, source text not null, target text not null,
  label text not null, kind text not null, origin text not null default 'inferred',
  weight integer not null default 1, created_at text not null
);
create table if not exists proposals (
  id text primary key, title text not null, rationale text not null, ops text not null,
  status text not null default 'pending', origin text not null default 'inferred',
  created_at text not null, decided_at text
);
create table if not exists journal (
  id text primary key, at text not null, actor text not null, action text not null,
  detail text not null, node_id text
);
create table if not exists chat (
  id text primary key, role text not null, text text not null, node_id text,
  created_at text not null, brain text not null default 'heuristic', model text, proposal_id text
);
create table if not exists files (
  path text primary key, lang text not null, loc integer not null, hash text not null,
  facts text not null, seen_at text not null
);
`;

export interface StoredNode extends MapNode {
  files: string[];
}

function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export class Store {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly file: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    const dir = path.join(this.root, '.syscode');
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'syscode.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('pragma journal_mode = wal;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /* ------------------------------------------------------------------ meta */

  getMeta(k: string): string | undefined {
    const row = this.db.prepare('select v from meta where k = ?').get(k) as { v: string } | undefined;
    return row?.v;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, v);
  }

  getJson<T>(k: string): T | undefined {
    const raw = this.getMeta(k);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  setJson(k: string, v: unknown): void {
    this.setMeta(k, JSON.stringify(v));
  }

  /* ----------------------------------------------------------------- nodes */

  private rowToNode(r: Record<string, unknown>): StoredNode {
    return {
      id: String(r.id),
      key: String(r.key),
      label: String(r.label),
      kind: String(r.kind) as MapNode['kind'],
      level: Number(r.level),
      parentId: (r.parent_id as string | null) ?? null,
      summary: String(r.summary ?? ''),
      detail: (r.detail as string | undefined) ?? undefined,
      anchors: JSON.parse(String(r.anchors ?? '[]')) as Anchor[],
      origin: String(r.origin) as MapNode['origin'],
      position: { x: Number(r.x), y: Number(r.y) },
      positionLocked: Boolean(r.position_locked),
      labelLocked: Boolean(r.label_locked),
      notes: [],
      stale: Boolean(r.stale),
      childCount: 0,
      metrics: JSON.parse(String(r.metrics ?? '{}')) as MapNode['metrics'],
      heuristic: Boolean(r.heuristic),
      files: JSON.parse(String(r.files ?? '[]')) as string[],
    };
  }

  allNodes(): StoredNode[] {
    const rows = this.db.prepare('select * from nodes order by level, label').all() as Record<string, unknown>[];
    const nodes = rows.map((r) => this.rowToNode(r));
    const notes = this.allNotes();
    const byNode = new Map<string, Note[]>();
    for (const n of notes) {
      if (!byNode.has(n.nodeId)) byNode.set(n.nodeId, []);
      byNode.get(n.nodeId)!.push(n);
    }
    const counts = new Map<string, number>();
    for (const n of nodes) if (n.parentId) counts.set(n.parentId, (counts.get(n.parentId) ?? 0) + 1);
    for (const n of nodes) {
      n.notes = byNode.get(n.id) ?? [];
      n.childCount = counts.get(n.id) ?? 0;
    }
    return nodes;
  }

  getNode(id: string): StoredNode | undefined {
    const r = this.db.prepare('select * from nodes where id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const n = this.rowToNode(r);
    n.notes = this.notesFor(id);
    n.childCount = (this.db.prepare('select count(*) as c from nodes where parent_id = ?').get(id) as { c: number }).c;
    return n;
  }

  findByKey(key: string): StoredNode | undefined {
    const r = this.db.prepare('select * from nodes where key = ? limit 1').get(key) as Record<string, unknown> | undefined;
    return r ? this.rowToNode(r) : undefined;
  }

  insertNode(n: StoredNode): void {
    const ts = now();
    this.db
      .prepare(
        `insert into nodes (id, key, label, kind, level, parent_id, summary, detail, anchors, origin, x, y,
          position_locked, label_locked, stale, heuristic, metrics, files, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n.id, n.key, n.label, n.kind, n.level, n.parentId ?? null, n.summary, n.detail ?? null,
        JSON.stringify(n.anchors ?? []), n.origin, n.position.x, n.position.y,
        n.positionLocked ? 1 : 0, n.labelLocked ? 1 : 0, n.stale ? 1 : 0, n.heuristic ? 1 : 0,
        JSON.stringify(n.metrics ?? { files: 0, loc: 0, symbols: 0 }), JSON.stringify(n.files ?? []), ts, ts,
      );
  }

  updateNode(id: string, patch: Partial<StoredNode>): void {
    const cur = this.getNode(id);
    if (!cur) return;
    const next: StoredNode = { ...cur, ...patch, position: patch.position ?? cur.position, id };
    this.db
      .prepare(
        `update nodes set key = ?, label = ?, kind = ?, level = ?, parent_id = ?, summary = ?, detail = ?,
          anchors = ?, origin = ?, x = ?, y = ?, position_locked = ?, label_locked = ?, stale = ?,
          heuristic = ?, metrics = ?, files = ?, updated_at = ? where id = ?`,
      )
      .run(
        next.key, next.label, next.kind, next.level, next.parentId ?? null, next.summary, next.detail ?? null,
        JSON.stringify(next.anchors ?? []), next.origin, next.position.x, next.position.y,
        next.positionLocked ? 1 : 0, next.labelLocked ? 1 : 0, next.stale ? 1 : 0, next.heuristic ? 1 : 0,
        JSON.stringify(next.metrics ?? { files: 0, loc: 0, symbols: 0 }), JSON.stringify(next.files ?? []),
        now(), id,
      );
  }

  deleteNode(id: string): void {
    const children = this.allNodes().filter((n) => n.parentId === id);
    for (const c of children) this.deleteNode(c.id);
    this.db.prepare('delete from notes where node_id = ?').run(id);
    this.db.prepare('delete from edges where source = ? or target = ?').run(id, id);
    this.db.prepare('delete from nodes where id = ?').run(id);
  }

  childCount(id: string): number {
    return (this.db.prepare('select count(*) as c from nodes where parent_id = ?').get(id) as { c: number }).c;
  }

  /* ----------------------------------------------------------------- notes */

  private allNotes(): (Note & { nodeId: string })[] {
    const rows = this.db.prepare('select * from notes order by created_at').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      nodeId: String(r.node_id),
      body: String(r.body),
      kind: String(r.kind) as Note['kind'],
      author: String(r.author) as Note['author'],
      createdAt: String(r.created_at),
    }));
  }

  notesFor(nodeId: string): Note[] {
    return this.allNotes().filter((n) => n.nodeId === nodeId).map(({ nodeId: _n, ...rest }) => rest);
  }

  addNote(nodeId: string, body: string, kind: Note['kind'], author: Note['author']): Note {
    const note: Note = { id: newId('note'), body, kind, author, createdAt: now() };
    this.db.prepare('insert into notes (id, node_id, body, kind, author, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(note.id, nodeId, body, kind, author, note.createdAt);
    return note;
  }

  deleteNote(noteId: string): void {
    this.db.prepare('delete from notes where id = ?').run(noteId);
  }

  /* ----------------------------------------------------------------- edges */

  allEdges(): MapEdge[] {
    const rows = this.db.prepare('select * from edges order by created_at').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      source: String(r.source),
      target: String(r.target),
      label: String(r.label),
      kind: String(r.kind) as MapEdge['kind'],
      origin: String(r.origin) as MapEdge['origin'],
      weight: Number(r.weight ?? 1),
    }));
  }

  insertEdge(e: MapEdge): void {
    this.db.prepare('insert or replace into edges (id, source, target, label, kind, origin, weight, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.source, e.target, e.label, e.kind, e.origin, e.weight ?? 1, now());
  }

  updateEdge(id: string, patch: Partial<MapEdge>): void {
    const cur = this.allEdges().find((e) => e.id === id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db.prepare('update edges set source = ?, target = ?, label = ?, kind = ?, origin = ?, weight = ? where id = ?')
      .run(next.source, next.target, next.label, next.kind, next.origin, next.weight ?? 1, id);
  }

  deleteEdge(id: string): void {
    this.db.prepare('delete from edges where id = ?').run(id);
  }

  /** Engine-owned edges are rebuilt on refresh; anything the developer authored is kept. */
  deleteEdgesByOrigin(origins: MapEdge['origin'][]): void {
    for (const o of origins) this.db.prepare('delete from edges where origin = ?').run(o);
  }

  /* ------------------------------------------------------------- proposals */

  allProposals(): Proposal[] {
    const rows = this.db.prepare('select * from proposals order by created_at desc').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      rationale: String(r.rationale),
      ops: JSON.parse(String(r.ops ?? '[]')) as Proposal['ops'],
      status: String(r.status) as Proposal['status'],
      origin: String(r.origin) as Proposal['origin'],
      createdAt: String(r.created_at),
      decidedAt: (r.decided_at as string | undefined) ?? undefined,
    }));
  }

  pendingProposals(): Proposal[] {
    return this.allProposals().filter((p) => p.status === 'pending');
  }

  insertProposal(p: Proposal): void {
    this.db.prepare('insert into proposals (id, title, rationale, ops, status, origin, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.title, p.rationale, JSON.stringify(p.ops), p.status, p.origin, p.createdAt);
  }

  decideProposal(id: string, status: Proposal['status']): Proposal | undefined {
    this.db.prepare('update proposals set status = ?, decided_at = ? where id = ?').run(status, now(), id);
    return this.allProposals().find((p) => p.id === id);
  }

  /* --------------------------------------------------------------- journal */

  journal(limit = 100): JournalEntry[] {
    const rows = this.db.prepare('select * from journal order by at desc limit ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      actor: String(r.actor) as JournalEntry['actor'],
      action: String(r.action),
      detail: String(r.detail),
      nodeId: (r.node_id as string | undefined) ?? undefined,
    }));
  }

  log(actor: JournalEntry['actor'], action: string, detail: string, nodeId?: string): void {
    this.db.prepare('insert into journal (id, at, actor, action, detail, node_id) values (?, ?, ?, ?, ?, ?)')
      .run(newId('j'), now(), actor, action, detail, nodeId ?? null);
  }

  /* ------------------------------------------------------------------ chat */

  chatHistory(limit = 200): ChatMessage[] {
    const rows = this.db.prepare('select * from chat order by created_at desc limit ?').all(limit) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        id: String(r.id),
        role: String(r.role) as ChatMessage['role'],
        text: String(r.text),
        nodeId: (r.node_id as string | undefined) ?? null,
        createdAt: String(r.created_at),
        brain: String(r.brain) as ChatMessage['brain'],
        model: (r.model as string | undefined) ?? undefined,
        proposalId: (r.proposal_id as string | undefined) ?? undefined,
      }))
      .reverse();
  }

  addChat(m: ChatMessage): void {
    this.db.prepare('insert into chat (id, role, text, node_id, created_at, brain, model, proposal_id) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.role, m.text, m.nodeId ?? null, m.createdAt, m.brain, m.model ?? null, m.proposalId ?? null);
  }

  /* ----------------------------------------------------------- file index */

  files(): { path: string; lang: string; loc: number; hash: string }[] {
    const rows = this.db.prepare('select path, lang, loc, hash from files').all() as Record<string, unknown>[];
    return rows.map((r) => ({ path: String(r.path), lang: String(r.lang), loc: Number(r.loc), hash: String(r.hash) }));
  }

  replaceFiles(list: { path: string; lang: string; loc: number; hash: string }[]): void {
    const ts = now();
    this.db.exec('delete from files');
    const stmt = this.db.prepare('insert into files (path, lang, loc, hash, facts, seen_at) values (?, ?, ?, ?, ?, ?)');
    for (const f of list) stmt.run(f.path, f.lang, f.loc, f.hash, '{}', ts);
  }

  stats(): { nodes: number; edges: number; notes: number; pending: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      nodes: one('select count(*) as c from nodes'),
      edges: one('select count(*) as c from edges'),
      notes: one('select count(*) as c from notes'),
      pending: one("select count(*) as c from proposals where status = 'pending'"),
    };
  }
}
