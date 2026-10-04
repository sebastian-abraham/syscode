/**
 * The agent. One entry point, two brains:
 *
 *  - model:  the scoped context is handed to the configured LLM, which answers and
 *            may propose map changes as structured ops (never applied without approval).
 *  - rules:  no model configured, so the agent answers from the map itself. Grounded,
 *            limited, and upfront about it — never a fake intelligence.
 *
 * Both paths emit the same ChatEvent stream, and both always emit the context they used
 * first, because the developer is entitled to see what the agent was told.
 */
import type { ChatEvent, MapOp, MapNode, Proposal } from '../types.ts';
import type { MapService } from '../map/service.ts';
import { contextAsPrompt, estimateTokens } from '../memory/context.ts';
import { newId } from '../store/db.ts';
import { streamChat } from './provider.ts';

const RULE_BRAIN_SYSTEM = [
  'SysCode agent (rule-based brain).',
  '',
  'A model is not connected, so you answer only from the map and its memory. Be direct and',
  'concrete, cite node names and file paths that appear in the context, and never invent code',
  'that is not in the context. If the developer asks for something that needs a model',
  '(writing code, deep reasoning about the design), say plainly what is missing and what they',
  'can do instead. Keep answers under 120 words.',
].join('\n');

export interface AgentOptions {
  nodeId?: string | null;
  signal?: AbortSignal;
}

export async function* runChat(svc: MapService, message: string, opts: AgentOptions = {}): AsyncGenerator<ChatEvent> {
  const nodeId = opts.nodeId ?? null;
  const context = svc.context(nodeId);
  yield { type: 'context', context };

  if (svc.brain.mode === 'model') {
    yield* modelTurn(svc, message, nodeId, opts);
    return;
  }
  yield* ruleTurn(svc, message, nodeId);
}

/* ------------------------------------------------------------- model brain -- */

const AGENT_SYSTEM = `You are the SysCode agent: a senior engineer standing at a whiteboard sketch of this system.

You are given scoped context for one node of that map. Use it as your only source of truth about
the codebase. If something is not in the context, say so instead of guessing.

Answering questions: be concrete and short. Prefer node names, file paths and plain language over
abstract advice.

Proposing design changes: when the developer asks you to add, restructure or remove something,
explain the change in prose first. Then, at the very end of your reply, add exactly one fenced
json block with this shape and nothing after it:

\`\`\`json
{"title":"Short imperative title","rationale":"one or two sentences on why this is the right shape","ops":[
  {"op":"add-node","node":{"label":"Name","summary":"plain-language explanation","kind":"planned","parentId":"<an id from the node directory or null>","origin":"planned"}},
  {"op":"add-edge","edge":{"source":"<node id>","target":"<node id>","label":"short relationship"}}
]}
\`\`\`

Allowed ops: add-node, add-edge, rename-node {nodeId,label}, update-summary {nodeId,summary},
move-node {nodeId,parentId}, remove-node {nodeId}, remove-edge {edgeId}. Use only node ids that
appear in the context. Never claim a change is done: the developer approves it first.`;

function nodeDirectory(svc: MapService): string {
  const nodes = svc.store.allNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indent = (n: MapNode) => (n.parentId ? `${byId.get(n.parentId)?.label ?? '?'} › ` : '');
  return nodes
    .filter((n) => n.level <= 2)
    .slice(0, 120)
    .map((n) => `${n.id} | L${n.level} | ${indent(n)}${n.label} | ${n.origin}${n.stale ? ' | STALE' : ''}`)
    .join('\n');
}

async function* modelTurn(svc: MapService, message: string, nodeId: string | null, opts: AgentOptions): AsyncGenerator<ChatEvent> {
  const scopeNode = nodeId ? svc.node(nodeId) : undefined;
  const system = `${AGENT_SYSTEM}\n\n## Scoped context\n\n${contextAsPrompt(svc.context(nodeId))}\n\n## Node directory (id | level | parent › label | provenance)\n\n${nodeDirectory(svc)}`;
  const history = svc
    .chatHistory()
    .slice(-6)
    .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text }));

  let visible = '';
  let buffer = '';
  let inPlan = false;
  try {
    for await (const chunk of streamChat(svc.brain, {
      system,
      messages: [...history, { role: 'user', content: message }],
      signal: opts.signal,
    })) {
      buffer += chunk;
      if (!inPlan && buffer.includes('```json')) {
        const idx = buffer.indexOf('```json');
        const head = buffer.slice(0, idx);
        if (head.length > visible.length) {
          const add = head.slice(visible.length);
          visible += add;
          yield { type: 'token', text: add };
        }
        inPlan = true;
      } else if (!inPlan) {
        // stream out everything except a possible partial fence at the tail
        const safe = Math.max(0, buffer.length - 8);
        if (safe > visible.length) {
          const add = buffer.slice(visible.length, safe);
          visible += add;
          yield { type: 'token', text: add };
        }
      }
    }
  } catch (err) {
    yield { type: 'notice', level: 'warn', text: `Model call failed: ${(err as Error).message.slice(0, 200)}. Answering from the map instead.` };
    yield* ruleTurn(svc, message, nodeId);
    return;
  }

  if (!inPlan && buffer.length > visible.length) {
    const add = buffer.slice(visible.length);
    yield { type: 'token', text: add };
    visible += add;
  }

  const plan = extractPlan(buffer);
  if (plan) {
    const proposal = svc.addProposal({
      title: plan.title,
      rationale: plan.rationale,
      ops: plan.ops,
      origin: 'inferred',
    });
    yield { type: 'proposal', proposal };
  }
  void scopeNode;
  yield { type: 'done', messageId: newId('msg') };
}

interface ExtractedPlan {
  title: string;
  rationale: string;
  ops: MapOp[];
}

function extractPlan(text: string): ExtractedPlan | undefined {
  const start = text.indexOf('```json');
  if (start === -1) return undefined;
  const end = text.indexOf('```', start + 7);
  const body = text.slice(start + 7, end === -1 ? undefined : end).trim();
  try {
    const json = JSON.parse(body) as { title?: string; rationale?: string; ops?: MapOp[] };
    if (!json.ops?.length) return undefined;
    return {
      title: json.title ?? 'Proposed map change',
      rationale: json.rationale ?? '',
      ops: json.ops.filter((o) => o && typeof o === 'object' && 'op' in o),
    };
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------- rule brain -- */

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function findNode(svc: MapService, query: string, prefer?: string | null): { node: MapNode | undefined; score: number } {
  const q = tokenize(query);
  const lowerQuery = query.toLowerCase();
  const nodes = svc.store.allNodes();

  const scoreOf = (n: MapNode): number => {
    const label = tokenize(n.label).join(' ');
    const hay = tokenize(`${n.label} ${n.key} ${n.summary}`).join(' ');
    let score = 0;
    // naming a node outright beats every weak signal, including the selected scope
    if (n.label.length > 2 && lowerQuery.includes(n.label.toLowerCase())) score += 6;
    for (const t of q) {
      if (label.includes(t)) score += 3;
      else if (hay.includes(t)) score += 1;
    }
    if (n.kind === 'external') score -= 0.5;
    return score;
  };

  let best: MapNode | undefined;
  let bestScore = 0;
  for (const n of nodes) {
    const score = scoreOf(n);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  // the selected node is a tiebreaker, not an override
  if (prefer) {
    const scoped = nodes.find((n) => n.id === prefer);
    if (scoped) {
      const scopedScore = scoreOf(scoped);
      if (scopedScore > 0 && scopedScore >= bestScore) {
        best = scoped;
        bestScore = scopedScore;
      }
    }
  }
  return { node: best, score: bestScore };
}

async function* ruleTurn(svc: MapService, message: string, nodeId: string | null): AsyncGenerator<ChatEvent> {
  const replies = ruleAnswer(svc, message, nodeId);
  for (const event of replies) {
    if (event.type === 'token') {
      for (const piece of chunkText(event.text)) {
        yield { type: 'token', text: piece };
        await new Promise((r) => setTimeout(r, 8));
      }
    } else {
      yield event;
    }
  }
  if (!replies.some((r) => r.type === 'proposal')) {
    yield { type: 'notice', level: 'info', text: 'Rule-based brain: map questions only. Connect a model for design work and code changes.' };
  }
  yield { type: 'done', messageId: newId('msg') };
}

function chunkText(text: string): string[] {
  const out: string[] = [];
  const words = text.split(' ');
  let cur = '';
  for (const w of words) {
    cur += (cur ? ' ' : '') + w;
    if (cur.length > 18) {
      out.push(cur + ' ');
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function ruleAnswer(svc: MapService, message: string, nodeId: string | null): ChatEvent[] {
  const text = message.trim();
  const lower = text.toLowerCase();
  const scope = nodeId ? svc.node(nodeId) : undefined;
  const events: ChatEvent[] = [];
  const say = (t: string) => events.push({ type: 'token', text: t });

  /* what depends on / what breaks */
  if (/(what (breaks|depends|uses|imports)|who uses|dependenc|impact|reverse)/.test(lower)) {
    const target = findNode(svc, text, nodeId).node ?? scope;
    if (!target) {
      say('I could not tell which node you mean. Select a node first, or name it.');
      return events;
    }
    const dependents = reverseReachability(svc, target.id);
    if (!dependents.length) {
      say(`Nothing else in the map points at **${target.label}** — it is a leaf. Changing it is contained.`);
    } else {
      const lines = dependents.map((d) => `- **${d.node.label}** → ${target.label} _(${d.via})_`);
      say(`**${dependents.length} node${dependents.length === 1 ? '' : 's'} depend on ${target.label}:**\n\n${lines.join('\n')}\n\nEverything in that list is a candidate to break. The map only knows what the code says — the anchors under each node are the actual files to check.`);
    }
    return events;
  }

  /* where is X */
  const whereMatch = /(?:where is|where'?s|find|locate)\s+(.+?)\??$/.exec(lower);
  if (whereMatch) {
    const term = whereMatch[1].replace(/\bthe\b|\bfile\b|\bcode\b/g, '').trim();
    const hits = svc.facts.files.filter((f) => f.path.toLowerCase().includes(term.replace(/\s+/g, '-')) || f.path.toLowerCase().includes(term));
    if (hits.length) {
      say(`**${hits.length} file${hits.length === 1 ? '' : 's'} match "${term}":**\n\n${hits.slice(0, 8).map((h) => `- \`${h.path}\` (${h.loc} lines)`).join('\n')}`);
    } else {
      const node = findNode(svc, term, nodeId).node;
      say(node ? `No file matches "${term}", but the node **${node.label}** looks closest: ${node.summary}\n\nIts anchors:\n${node.anchors.slice(0, 5).map((a) => `- \`${a.path}\``).join('\n')}` : `Nothing in the map or the file index matches "${term}".`);
    }
    return events;
  }

  /* connect two things */
  const connect = /connect\s+(.+?)\s+(?:to|with|→|->)\s+(.+?)\??$/.exec(lower);
  if (connect) {
    const a = findNode(svc, connect[1], nodeId).node;
    const b = findNode(svc, connect[2]).node;
    if (!a || !b) {
      say(`I could not match both ends of that connection. I found ${a ? `**${a.label}**` : 'nothing'} for the first half and ${b ? `**${b.label}**` : 'nothing'} for the second.`);
      return events;
    }
    const proposal = svc.addProposal({
      title: `Connect ${a.label} → ${b.label}`,
      rationale: `You asked for **${a.label}** to relate to **${b.label}**. If this relationship is real in the code, the agent should make it explicit; if it is a planned dependency, the edge keeps the intent on the map until it exists.`,
      ops: [{ op: 'add-edge', edge: { source: a.id, target: b.id, label: 'relates to', kind: 'custom', origin: 'planned' } }],
      origin: 'user',
    });
    events.push({ type: 'proposal', proposal });
    say(`Proposed an edge from **${a.label}** to **${b.label}**. Approve it and the map keeps that relationship even after the next refresh.`);
    return events;
  }

  /* rename / delete */
  const rename = /rename\s+(?:the\s+)?(?:node\s+)?(.+?)\s+to\s+(.+?)\??$/.exec(lower);
  if (rename) {
    const node = findNode(svc, rename[1], nodeId).node;
    if (!node) {
      say('Could not find that node to rename.');
      return events;
    }
    const proposal = svc.addProposal({
      title: `Rename ${node.label}`,
      rationale: `You want **${node.label}** called "${rename[2]}". Renaming pins the new name so the mapper will not overwrite it.`,
      ops: [{ op: 'rename-node', nodeId: node.id, label: rename[2] }],
      origin: 'user',
    });
    events.push({ type: 'proposal', proposal });
    say(`Proposed renaming **${node.label}** to **${rename[2]}**.`);
    return events;
  }

  const del = /(?:delete|remove)\s+(?:the\s+)?(?:node\s+)?(.+?)\??$/.exec(lower);
  if (del && !/remove-edge/.test(lower)) {
    const node = findNode(svc, del[1], nodeId).node;
    if (node) {
      const proposal = svc.addProposal({
        title: `Remove ${node.label}`,
        rationale: `You asked to remove **${node.label}** from the map. Its children and edges go with it. Nothing in the code changes.`,
        ops: [{ op: 'remove-node', nodeId: node.id }],
        origin: 'user',
      });
      events.push({ type: 'proposal', proposal });
      say(`Proposed removing **${node.label}**. Approve to apply; the code on disk is untouched.`);
      return events;
    }
  }

  /* add something */
  const add = /(?:add|create|introduce|design)\s+(?:a\s+|an\s+|the\s+)?(node|feature|piece|component|service|module|flow|system)?\s*(?:that|which|for|to)?\s*(.+)$/.exec(text);
  if (add && add[2].length > 3) {
    const description = add[2].trim();
    const label = labelFromDescription(description);
    const parent = scope && scope.level < 2 ? scope.id : null;
    const proposal = svc.addProposal({
      title: `Add node: ${label}`,
      rationale: `You described something that does not exist yet: "${description}". This adds it to the map as a planned node${scope ? ` under **${scope.label}**` : ''}, so the shape of the system is decided before the code is written. Approve, then hand it to the agent to implement.`,
      ops: [
        {
          op: 'add-node',
          node: {
            label,
            summary: description.charAt(0).toUpperCase() + description.slice(1) + (description.endsWith('.') ? '' : '.'),
            kind: 'planned',
            parentId: parent,
            origin: 'planned',
          },
        },
      ],
      origin: 'user',
    });
    events.push({ type: 'proposal', proposal });
    say(`Proposed a new node, **${label}**, ${parent && scope ? `inside **${scope.label}**` : 'at the top level'}, with your description pinned to it. Approve to place it on the map; nothing is implemented yet.`);
    return events;
  }

  /* explain */
  const target = findNode(svc, text, nodeId).node ?? scope;
  if (target) {
    const ctx = svc.context(target.id);
    const children = svc.store.allNodes().filter((n) => n.parentId === target.id);
    const edges = svc.store.allEdges().filter((e) => e.source === target.id || e.target === target.id);
    const byId = new Map(svc.store.allNodes().map((n) => [n.id, n]));
    const lines: string[] = [`**${target.label}** — ${target.summary}`];
    if (target.detail) lines.push('', target.detail);
    if (children.length) lines.push('', `Inside it: ${children.map((c) => c.label).join(', ')}.`);
    if (edges.length) {
      lines.push('', 'Relationships:');
      for (const e of [...new Set(edges.map((e2) => `${e2.source === target.id ? '→' : '←'} ${byId.get(e2.source === target.id ? e2.target : e2.source)?.label} (${e2.label})`))]) {
        lines.push(`- ${e}`);
      }
    }
    if (target.anchors.length) {
      lines.push('', `Code behind it: ${target.anchors.slice(0, 4).map((a) => `\`${a.path}${a.symbol ? '#' + a.symbol : ''}\``).join(', ')}${target.anchors.length > 4 ? ', …' : ''}.`);
    }
    if (target.notes.length) lines.push('', `Pinned: ${target.notes.map((n) => `${n.kind} — ${n.body}`).join('; ')}.`);
    if (target.stale) lines.push('', '⚠️ This node is marked stale: the code under it changed since the map last agreed.');
    lines.push('', `_(${ctx.items.length} context items, ~${ctx.totalTokens} of ${ctx.budgetTokens} tokens — see the Context tab.)_`);
    say(lines.join('\n'));
    return events;
  }

  /* overview */
  const top = svc.store.allNodes().filter((n) => n.level === 0);
  say(
    `No model is connected, so I answer from the map itself. This project is mapped as ${top.length} areas:\n\n${top
      .map((n) => `- **${n.label}** — ${n.summary}`)
      .join('\n')}\n\nAsk me things like _"what depends on ${top[0]?.label ?? 'X'}"_, _"where is auth"_, _"add a node for export to CSV"_ — or connect a model in settings and I can propose real design changes and write the code.`,
  );
  return events;
}

function labelFromDescription(description: string): string {
  const words = description
    .replace(/^(a|an|the)\s+/i, '')
    .split(/[\s,.;:]+/)
    .filter(Boolean)
    .slice(0, 4);
  const label = words.join(' ').replace(/\bwith\b|\bthat\b|\bwhich\b/g, '').trim();
  return (label.charAt(0).toUpperCase() + label.slice(1)) || 'New node';
}

export interface DependencyHit {
  node: MapNode;
  via: string;
}

export function reverseReachability(svc: MapService, nodeId: string): DependencyHit[] {
  const nodes = svc.store.allNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = svc.store.allEdges();
  const seen = new Set<string>([nodeId]);
  const out: DependencyHit[] = [];
  const queue: { id: string; via: string; depth: number }[] = [{ id: nodeId, via: 'self', depth: 0 }];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth > 4) continue;
    for (const e of edges) {
      if (e.target !== cur.id || seen.has(e.source)) continue;
      const dep = byId.get(e.source);
      if (!dep) continue;
      seen.add(dep.id);
      out.push({ node: dep, via: e.label });
      queue.push({ id: dep.id, via: e.label, depth: cur.depth + 1 });
    }
    // a node's parent depends on it conceptually
    const self = byId.get(cur.id);
    if (self?.parentId && !seen.has(self.parentId)) {
      const parent = byId.get(self.parentId);
      if (parent) {
        seen.add(parent.id);
        out.push({ node: parent, via: 'contains it' });
        queue.push({ id: parent.id, via: 'contains it', depth: cur.depth + 1 });
      }
    }
  }
  return out;
}

export { RULE_BRAIN_SYSTEM, estimateTokens };
export type { Proposal };
