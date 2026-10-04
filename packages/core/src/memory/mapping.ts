/**
 * Project memory: what the agent has understood about this codebase, kept so it never has
 * to re-explore the repo (product brief §9).
 *
 * With a model connected this is a real mapping pass over the facts. Without one, the same
 * structure is filled in deterministically from the facts — thinner, but never invented, and
 * labelled as coming from the facts rather than from a model.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MemoryInfo, RepoFacts } from '../types.ts';
import type { Brain } from '../config.ts';
import { streamChat } from '../llm/provider.ts';

export interface MemoryInputs {
  facts: RepoFacts;
  /** The top level of the map, so memory and map agree about what the project is. */
  areas: { label: string; summary: string; files: number; dirs: string[] }[];
}

const MAX_README = 1800;

function readReadme(root: string): string | undefined {
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      const text = readFileSync(path.join(root, name), 'utf8');
      return text.slice(0, MAX_README);
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}

function factsBlock(inputs: MemoryInputs, readme?: string): string {
  const { facts } = inputs;
  const langs = Object.entries(facts.totals.byLang)
    .sort((a, b) => b[1].loc - a[1].loc)
    .map(([lang, s]) => `${lang} (${s.files} files, ${s.loc} lines)`)
    .join(', ');
  const lines = [
    `Files: ${facts.totals.files}. Lines: ${facts.totals.loc}.`,
    `Languages: ${langs || 'unknown'}.`,
    `Entry points: ${facts.entryPoints.slice(0, 8).join(', ') || 'none detected'}.`,
  ];
  const services = facts.externals.filter((e) => e.kind === 'service');
  if (services.length) lines.push(`External services imported: ${services.map((s) => `${s.name} (${s.usedBy} file(s))`).join(', ')}.`);
  const frameworks = facts.externals.filter((e) => e.kind === 'framework').slice(0, 12);
  if (frameworks.length) lines.push(`Frameworks and tooling imported: ${frameworks.map((f) => f.name).join(', ')}.`);
  lines.push('', 'Areas of the system (from the map):');
  for (const a of inputs.areas) {
    lines.push(`- ${a.label} — ${a.summary}${a.dirs.length ? ` [${a.dirs.slice(0, 4).join(', ')}]` : ''}`);
  }
  if (readme) lines.push('', 'The project\'s own README (excerpt):', readme);
  return lines.join('\n');
}

const SYSTEM = `You are writing a short internal brief about a codebase, for an AI agent that will work on it later.

You are given deterministic facts extracted from the code, plus an excerpt of the project's own README. Those are your only sources. Never state a technology, convention, file or command that does not appear in them. Where the facts are silent, say nothing rather than guessing.

Write markdown with exactly these sections and nothing else:

## What this is
One or two sentences: the kind of software this is.

## Stack
The languages, frameworks and external services that are actually imported.

## Layout
Where things live. Name the areas and what each is responsible for.

## Conventions and gotchas
Only what the facts or README actually support — how errors are handled, how data is accessed, anything that would surprise a newcomer. If you cannot tell, write "Not established by the facts available."

## Entry points
The files that start the system.

Be specific and compact — under 250 words total. No preamble, no closing remarks, no bullet-point padding.`;

/** A model-authored brief, or a deterministic one when no model is connected. */
export async function buildProjectMemory(
  brain: Brain,
  inputs: MemoryInputs,
  root: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MemoryInfo> {
  const readme = readReadme(root);
  if (brain.mode !== 'model') return memoryFromFacts(inputs);

  let text = '';
  try {
    for await (const chunk of streamChat(brain, {
      system: SYSTEM,
      messages: [{ role: 'user', content: factsBlock(inputs, readme) }],
      temperature: 0.2,
      maxTokens: 900,
      signal: opts.signal,
    })) {
      text += chunk;
    }
  } catch {
    return memoryFromFacts(inputs);
  }
  const cleaned = text.trim();
  // a model that returns nothing useful should not overwrite memory with silence
  if (cleaned.length < 80) return memoryFromFacts(inputs);
  return {
    text: cleaned,
    origin: 'model',
    builtAt: new Date().toISOString(),
    model: brain.model,
  };
}

/** The same brief, composed from facts alone. Honest about its own limits. */
export function memoryFromFacts(inputs: MemoryInputs): MemoryInfo {
  const { facts } = inputs;
  const langs = Object.entries(facts.totals.byLang)
    .sort((a, b) => b[1].loc - a[1].loc)
    .map(([lang, s]) => `${lang} (${s.files} files, ${s.loc.toLocaleString('en-US')} lines)`);
  const services = facts.externals.filter((e) => e.kind === 'service');
  const frameworks = facts.externals.filter((e) => e.kind === 'framework').slice(0, 10);

  const parts: string[] = [];
  parts.push('## What this is');
  parts.push(
    `A ${langs.length > 1 ? 'multi-language' : langs[0]?.split(' ')[0] ?? 'code'} project: ${facts.totals.files} files, ${facts.totals.loc.toLocaleString('en-US')} lines.`,
  );
  parts.push('', '## Stack');
  parts.push(langs.join(', ') || 'Not established by the facts available.');
  if (frameworks.length) parts.push(`Frameworks and tooling: ${frameworks.map((f) => f.name).join(', ')}.`);
  if (services.length) parts.push(`External services: ${services.map((s) => `${s.name} (${s.usedBy} file(s))`).join(', ')}.`);
  parts.push('', '## Layout');
  for (const a of inputs.areas) parts.push(`- **${a.label}** — ${a.summary}`);
  parts.push('', '## Conventions and gotchas');
  parts.push('Not established by the facts available — connect a model to have this written from the code.');
  parts.push('', '## Entry points');
  parts.push(facts.entryPoints.slice(0, 8).map((e) => `- \`${e}\``).join('\n') || 'None detected.');

  return {
    text: parts.join('\n'),
    origin: 'facts',
    builtAt: new Date().toISOString(),
  };
}
