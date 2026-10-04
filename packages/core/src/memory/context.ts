/**
 * Scoped context: what the agent is actually given for a node.
 *
 * The whole point is that the agent does not re-read the repository. It gets the
 * node's explanation, the code behind it, what it talks to, the developer's notes
 * and constraints, and the project memory — bounded to a token budget, with the
 * truncations visible.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextItem, RepoFacts, ScopedContext } from '../types.ts';
import type { Store, StoredNode } from '../store/db.ts';

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function trim(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + '\n… [truncated]', truncated: true };
}

function readSnippet(root: string, file: string, range?: [number, number], maxChars = 1600): { text: string; truncated: boolean } {
  try {
    const raw = readFileSync(path.join(root, file), 'utf8');
    const lines = raw.split('\n');
    const [start, end] = range ?? [1, Math.min(lines.length, 40)];
    const slice = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join('\n');
    return trim(slice, maxChars);
  } catch {
    return { text: '(file not readable)', truncated: false };
  }
}

export interface ContextOptions {
  budgetTokens?: number;
  facts?: RepoFacts;
}

export function buildContext(store: Store, root: string, nodeId: string | null, opts: ContextOptions = {}): ScopedContext {
  const budget = opts.budgetTokens ?? 6000;
  const items: ContextItem[] = [];
  let used = 0;

  const push = (item: Omit<ContextItem, 'tokens'>) => {
    const tokens = estimateTokens(item.content);
    items.push({ ...item, tokens });
    used += tokens;
  };

  if (opts.facts) {
    const langs = Object.entries(opts.facts.totals.byLang)
      .map(([lang, s]) => `${lang} (${s.files} files, ${s.loc.toLocaleString('en-US')} lines)`)
      .join(', ');
    push({
      kind: 'memory',
      label: 'Project memory',
      content: `Repository: ${opts.facts.totals.files} files, ${opts.facts.totals.loc.toLocaleString('en-US')} lines. Languages: ${langs || 'n/a'}. Entry points: ${opts.facts.entryPoints.slice(0, 5).join(', ') || 'none detected'}.`,
    });
  }

  const projectMemory = store.getMeta('project.memory');
  if (projectMemory) push({ kind: 'memory', label: 'Project notes', content: projectMemory });

  if (!nodeId) {
    const overview = store
      .allNodes()
      .filter((n) => n.level === 0)
      .map((n) => `- ${n.label}: ${n.summary}`)
      .join('\n');
    push({ kind: 'node', label: 'Map overview', content: overview || '(the map is empty)' });
    return { nodeId: null, items, totalTokens: used, budgetTokens: budget };
  }

  const node = store.getNode(nodeId);
  if (!node) return { nodeId, items, totalTokens: used, budgetTokens: budget };

  push({ kind: 'node', label: `${node.label} (${node.kind})`, source: node.id, content: `${node.summary}${node.detail ? '\n\n' + node.detail : ''}` });

  const children = store.allNodes().filter((n) => n.parentId === node.id);
  if (children.length) {
    push({ kind: 'node', label: 'Inside this node', content: children.map((c) => `- ${c.label}: ${c.summary}`).join('\n') });
  }

  // code, anchored and labelled by whether it is a verified link
  for (const a of node.anchors.slice(0, 6)) {
    const source = a.symbol ? `${a.path}#${a.symbol}` : a.path;
    const snippet = readSnippet(root, a.path, a.lines);
    push({
      kind: 'code',
      label: `${source}${a.lines ? ` (lines ${a.lines[0]}–${a.lines[1]})` : ''} — ${node.origin === 'verified' ? 'verified link' : 'inferred link'}`,
      source,
      content: snippet.text,
      truncated: snippet.truncated,
    });
  }

  const edges = store.allEdges().filter((e) => e.source === node.id || e.target === node.id);
  if (edges.length) {
    const all = store.allNodes();
    const byId = new Map(all.map((n) => [n.id, n]));
    const lines = edges.map((e) => {
      const outgoing = e.source === node.id;
      const other = byId.get(outgoing ? e.target : e.source);
      return `${outgoing ? '→' : '←'} ${other?.label ?? 'unknown'} (${e.label}, ${e.origin})`;
    });
    push({ kind: 'edge', label: 'Relationships', content: [...new Set(lines)].join('\n') });
  }

  for (const n of node.notes) {
    push({ kind: n.kind === 'constraint' ? 'constraint' : 'note', label: `${n.kind} by ${n.author}`, content: n.body });
  }

  // trim to budget, lowest-value items last
  const priority: ContextItem['kind'][] = ['constraint', 'note', 'code', 'node', 'edge', 'memory'];
  const ordered = [...items].sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
  const kept: ContextItem[] = [];
  let total = 0;
  for (const item of ordered) {
    if (total + item.tokens <= budget) {
      kept.push(item);
      total += item.tokens;
    } else {
      const room = Math.max(0, budget - total);
      if (room > 40) {
        const shrunk = trim(item.content, room * 4);
        const tokens = estimateTokens(shrunk.text);
        kept.push({ ...item, content: shrunk.text, tokens, truncated: true });
        total += tokens;
      } else {
        kept.push({ ...item, content: '(dropped: context budget reached)', tokens: 5, truncated: true });
        total += 5;
      }
    }
  }
  kept.sort((a, b) => items.indexOf(a) - items.indexOf(b));
  return { nodeId, items: kept, totalTokens: Math.min(total, budget + 200), budgetTokens: budget };
}

export function contextAsPrompt(ctx: ScopedContext): string {
  const parts: string[] = [];
  for (const item of ctx.items) {
    parts.push(`### ${item.label}${item.source ? ` [${item.source}]` : ''}${item.truncated ? ' (truncated)' : ''}\n${item.content}`);
  }
  return parts.join('\n\n');
}

export function nodeBrief(n: StoredNode): string {
  return `${n.label} — ${n.summary}`;
}
