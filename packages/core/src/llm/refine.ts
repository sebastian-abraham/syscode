/**
 * Let a model own the *meaning* of the map — naming, grouping, explanation — while the
 * deterministic facts keep it honest (product brief §8).
 *
 * The mapper produces the structure from code facts. This asks a model to look at that
 * structure plus the facts behind it and say what each piece actually is, in a human's
 * words. It never invents code: every target carries the files and symbols it covers, and
 * the prompt forbids anything not in them.
 *
 * Nothing here mutates the map. Suggestions come back as text; the service turns them into
 * a proposal the developer approves.
 */
import type { NodeKind, RepoFacts } from '../types.ts';
import type { Brain } from '../config.ts';
import { streamChat } from './provider.ts';

/** One node offered to the model, with the facts that justify it. */
export interface RefineTarget {
  key: string;
  id: string;
  label: string;
  kind: NodeKind;
  level: number;
  summary: string;
  /** Files this node covers, most significant first. */
  files: string[];
  /** Top-level definitions it exposes. */
  exports: string[];
  /** Labels of the nodes it depends on / that depend on it. */
  dependsOn: string[];
  usedBy: string[];
  /** Files that are entry points, if any. */
  entryFiles: string[];
  /** External services it talks to. */
  services: string[];
  /** Labels of its children, so the model can judge the grouping. */
  children: string[];
  /** True when the developer named this node — never suggest a rename for it. */
  labelLocked: boolean;
}

export interface RefineSuggestion {
  key: string;
  label?: string;
  summary?: string;
  kind?: NodeKind;
  /** The model's own note about the grouping, surfaced to the developer as-is. */
  note?: string;
}

export interface RefineOutcome {
  suggestions: RefineSuggestion[];
  /** Set when the model could not be used or its answer could not be read. */
  error?: string;
  raw?: string;
}

const ALLOWED_KINDS: NodeKind[] = ['system', 'subsystem', 'feature', 'component', 'data', 'external', 'concern', 'planned'];

function factsBrief(facts: RepoFacts): string {
  const langs = Object.entries(facts.totals.byLang)
    .map(([lang, s]) => `${lang}: ${s.files} files, ${s.loc} lines`)
    .join('; ');
  const services = facts.externals.filter((e) => e.kind === 'service').map((e) => e.name);
  return [
    `Repository: ${facts.totals.files} files, ${facts.totals.loc} lines.`,
    `Languages: ${langs || 'unknown'}.`,
    `Entry points: ${facts.entryPoints.slice(0, 6).join(', ') || 'none detected'}.`,
    `External services imported: ${services.join(', ') || 'none'}.`,
  ].join('\n');
}

function targetBlock(t: RefineTarget): string {
  const lines = [`### ${t.key}  (current label: "${t.label}", kind: ${t.kind}, level ${t.level})`];
  lines.push(`current explanation: ${t.summary}`);
  if (t.files.length) lines.push(`files (${t.files.length}): ${t.files.slice(0, 12).join(', ')}${t.files.length > 12 ? ', …' : ''}`);
  if (t.exports.length) lines.push(`exposes: ${t.exports.slice(0, 12).join(', ')}${t.exports.length > 12 ? ', …' : ''}`);
  if (t.children.length) lines.push(`contains: ${t.children.join(', ')}`);
  if (t.dependsOn.length) lines.push(`depends on: ${t.dependsOn.join(', ')}`);
  if (t.usedBy.length) lines.push(`used by: ${t.usedBy.join(', ')}`);
  if (t.entryFiles.length) lines.push(`entry points here: ${t.entryFiles.join(', ')}`);
  if (t.services.length) lines.push(`talks to: ${t.services.join(', ')}`);
  if (t.labelLocked) lines.push('NOTE: the developer named this node themselves — do not suggest a new label for it.');
  return lines.join('\n');
}

const SYSTEM = `You are naming and explaining parts of a software system for a developer who is looking at a map of it.

You are given deterministic facts extracted from the code: which files belong to each part, what those files expose, and what depends on what. Those facts are the only truth you have. Never mention a file, symbol, service or technology that is not in the facts you were given. If the facts are too thin to say what a part does, say that plainly in the explanation instead of guessing.

Your job, for each part:
- give it the name a senior engineer would actually say out loud (1-3 words, title case, no "Module"/"Area"/"Group" filler);
- explain what it is in 1-2 plain sentences: what it does and why it is shaped this way. Write for someone who has not read the code. No marketing language, no restating the file list, no "this module contains files that";
- optionally adjust the kind if the current one is clearly wrong (one of: system, subsystem, feature, component, data, external, concern, planned);
- if the grouping looks wrong to you — a part that mixes two unrelated concerns, or files that clearly belong together being split — say so briefly in "note". Do not invent new structure; just say what you see.

Answer with a single JSON array and nothing else. No prose before or after, no markdown fence.

[{"key":"<the key you were given>","label":"<name>","summary":"<explanation>","kind":"<kind, optional>","note":"<optional observation about grouping>"}]`;

/**
 * Ask the model to re-name and re-explain a set of nodes.
 * Returns suggestions keyed to the nodes it was given; anything unparseable is reported
 * as an error rather than silently dropped.
 */
export async function suggestRefinements(
  brain: Brain,
  facts: RepoFacts,
  targets: RefineTarget[],
  opts: { signal?: AbortSignal } = {},
): Promise<RefineOutcome> {
  if (!targets.length) return { suggestions: [], error: 'nothing to refine' };
  if (brain.mode !== 'model') {
    return { suggestions: [], error: 'No model is connected, so the map keeps the deterministic naming.' };
  }

  const user = [
    '## Repository facts',
    factsBrief(facts),
    '',
    '## Parts to name and explain',
    targets.map(targetBlock).join('\n\n'),
    '',
    `Answer with the JSON array for these ${targets.length} keys: ${targets.map((t) => t.key).join(', ')}.`,
  ].join('\n');

  let raw = '';
  let lastError = '';
  // A long stream occasionally drops mid-flight. One retry turns a transient failure
  // into a slow success, and the second failure is reported rather than hidden.
  for (let attempt = 0; attempt < 2; attempt++) {
    raw = '';
    try {
      for await (const chunk of streamChat(brain, {
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
        temperature: 0.3,
        // Generous: one JSON entry per node, each with a sentence or two of explanation.
        // Too small a budget truncates the array mid-way and makes it unparseable.
        maxTokens: 3000,
        signal: opts.signal,
      })) {
        raw += chunk;
      }
      lastError = '';
      break;
    } catch (err) {
      lastError = (err as Error).message.slice(0, 200);
      if (opts.signal?.aborted) break;
    }
  }
  if (lastError) {
    return { suggestions: [], error: `Model call failed: ${lastError}`, raw };
  }

  const parsed = parseSuggestions(raw, targets);
  if (parsed.error) return { suggestions: [], error: parsed.error, raw };
  return { suggestions: parsed.suggestions, raw };
}

export function parseSuggestions(raw: string, targets: RefineTarget[]): { suggestions: RefineSuggestion[]; error?: string } {
  const array = extractJsonArray(raw);
  if (!array) return { suggestions: [], error: 'the model did not return a JSON array' };

  const byKey = new Map(targets.map((t) => [t.key, t]));
  const out: RefineSuggestion[] = [];
  for (const entry of array) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key : undefined;
    if (!key || !byKey.has(key)) continue; // never accept a key we did not offer
    const target = byKey.get(key)!;
    const label = typeof e.label === 'string' ? e.label.trim() : undefined;
    const summary = typeof e.summary === 'string' ? e.summary.trim() : undefined;
    const kind = typeof e.kind === 'string' && ALLOWED_KINDS.includes(e.kind as NodeKind) ? (e.kind as NodeKind) : undefined;
    const note = typeof e.note === 'string' ? e.note.trim() : undefined;
    const suggestion: RefineSuggestion = { key };
    // A different capitalisation is not a rename — it is noise in a diff the developer reads.
    if (label && !target.labelLocked && label.toLowerCase() !== target.label.toLowerCase()) suggestion.label = label;
    if (summary && summary !== target.summary) suggestion.summary = summary;
    if (kind && kind !== target.kind) suggestion.kind = kind;
    if (note) suggestion.note = note;
    if (suggestion.label || suggestion.summary || suggestion.kind || suggestion.note) out.push(suggestion);
  }
  if (!out.length) return { suggestions: [], error: 'the model suggested no changes' };
  return { suggestions: out };
}

/**
 * Models wrap JSON in fences, add a sentence before it, or both. Take a fenced block if
 * there is one, otherwise try every plausible array start and keep the first that parses.
 */
export function extractJsonArray(raw: string): unknown[] | undefined {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);

  for (const text of candidates) {
    for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
      const slice = balancedArray(text, i);
      if (!slice) continue;
      for (const attempt of [slice, escapeControlCharsInStrings(slice)]) {
        try {
          const parsed = JSON.parse(attempt);
          if (Array.isArray(parsed) && parsed.some((e) => e && typeof e === 'object' && 'key' in (e as object))) return parsed;
        } catch {
          /* try the repaired form, then the next start */
        }
      }
    }
  }
  return undefined;
}

/**
 * Models routinely put literal newlines and tabs inside JSON strings, which is invalid
 * JSON but very common for multi-sentence values like our summaries. Escape control
 * characters that sit inside a string, leaving the structure untouched.
 */
export function escapeControlCharsInStrings(jsonish: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of jsonish) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** The substring from `start` to its matching `]`, ignoring brackets inside strings. */
function balancedArray(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
