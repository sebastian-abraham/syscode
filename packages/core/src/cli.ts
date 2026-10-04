#!/usr/bin/env node
/**
 * syscode — the engine from the terminal.
 *
 *   syscode map <dir>        build or update the map, report what changed
 *   syscode show <dir>       print the map as an indented, explained tree
 *   syscode analyze <dir>    deterministic facts only (files, imports, externals)
 *   syscode context <dir>    the exact scoped context the agent gets for a node
 *   syscode ask <dir> "..."  ask the agent about the project (rule brain or model)
 *   syscode serve <dir>      HTTP API + the interface on :4317
 */
import path from 'node:path';
import { MapService } from './map/service.ts';
import { analyzeRepo } from './analyze/index.ts';
import { runChat } from './llm/agent.ts';
import { startServer } from './server/http.ts';
import { brainInfo } from './config.ts';

const HELP = `syscode — an agentic dev tool built around a living design map

usage:
  syscode map <dir>              build or update the map
  syscode show <dir> [--all]     print the map tree with explanations
  syscode analyze <dir>          deterministic facts about the repo
  syscode context <dir> [--node <id>] [--find <text>]
  syscode ask <dir> "<question>" [--node <id>]
  syscode serve <dir> [--port 4317]

flags:
  --all        show every level, not just the top two
  --json       machine-readable output
  --refresh    force a re-scan before acting`;

function parseArgs(argv: string[]): { cmd: string; target: string; rest: string[]; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...tail] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (tail[i + 1] && !tail[i + 1].startsWith('--') && ['node', 'find', 'port', 'host'].includes(k)) flags[k] = tail[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  const [target = '.', ...rest] = positional;
  return { cmd, target, rest, flags };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { cmd, target, rest, flags } = parseArgs(argv);
  const root = path.resolve(target || '.');

  if (cmd === 'help' || flags.help) {
    console.log(HELP);
    return;
  }

  if (cmd === 'analyze') {
    const facts = await analyzeRepo(root);
    if (flags.json) {
      console.log(JSON.stringify({ totals: facts.totals, entryPoints: facts.entryPoints, externals: facts.externals, files: facts.files.length }, null, 2));
      return;
    }
    console.log(`\n  ${path.basename(root)}  —  ${fmt(facts.totals.files)} files · ${fmt(facts.totals.loc)} lines\n`);
    console.log('  languages');
    for (const [lang, s] of Object.entries(facts.totals.byLang).sort((a, b) => b[1].loc - a[1].loc)) {
      console.log(`    ${lang.padEnd(14)} ${String(s.files).padStart(5)} files  ${fmt(s.loc).padStart(9)} lines`);
    }
    console.log('\n  entry points');
    for (const e of facts.entryPoints.slice(0, 8)) console.log(`    ${e}`);
    if (!facts.entryPoints.length) console.log('    (none detected)');
    console.log('\n  external services actually imported');
    const services = facts.externals.filter((e) => e.kind === 'service');
    for (const s of services.slice(0, 12)) console.log(`    ${s.name.padEnd(22)} used in ${s.usedBy} file(s)`);
    if (!services.length) console.log('    (none)');
    console.log(`\n  ${facts.files.reduce((n, f) => n + f.symbols.length, 0)} top-level definitions across ${facts.files.length} analysed files\n`);
    return;
  }

  const svc = await MapService.open(root, { refresh: Boolean(flags.refresh) });

  if (cmd === 'map') {
    const report = await svc.rescan();
    const stats = svc.store.stats();
    const project = svc.project();
    console.log(`\n  ${project.name}  —  ${fmt(project.stats.files)} files · ${fmt(project.stats.loc)} lines`);
    console.log(`  brain: ${project.brain.mode}${project.brain.model ? ` (${project.brain.provider}/${project.brain.model})` : ''}`);
    console.log(`  map:   ${stats.nodes} nodes · ${stats.edges} edges · ${project.stats.staleCount} stale · ${stats.pending} pending proposal(s)\n`);
    if (report.changes.length) {
      console.log('  changes detected');
      for (const c of report.changes) console.log(`    • ${c.summary}`);
      console.log(`\n  ${report.proposalsCreated} proposal(s) queued — review them in the interface, nothing is applied without approval.\n`);
    } else {
      console.log('  no changes since the last map — nodes keep their identity, positions and notes.\n');
    }
    svc.close();
    return;
  }

  if (cmd === 'show') {
    const all = svc.store.allNodes();
    const edges = svc.store.allEdges();
    const byId = new Map(all.map((n) => [n.id, n]));
    const depthLimit = flags.all ? 9 : 2;
    const print = (parentId: string | null, depth: number) => {
      const children = all.filter((n) => (n.parentId ?? null) === parentId).sort((a, b) => b.metrics.loc - a.metrics.loc);
      for (const n of children) {
        const pad = '  '.repeat(depth + 1);
        const marks = [n.stale ? 'STALE' : '', n.origin === 'user' ? 'user' : n.origin === 'planned' ? 'planned' : ''].filter(Boolean).join(' ');
        const metric = n.kind === 'external'
          ? `reached from ${n.files.length} file${n.files.length === 1 ? '' : 's'}`
          : `${n.metrics.files} file${n.metrics.files === 1 ? '' : 's'} · ${fmt(n.metrics.loc)} lines`;
        console.log(`${pad}${n.label}${marks ? `  [${marks}]` : ''}  · ${metric}`);
        if (depth < depthLimit) console.log(`${pad}  ${n.summary}`);
        const outgoing = edges.filter((e) => e.source === n.id && byId.has(e.target));
        if (outgoing.length && depth < depthLimit + 1) {
          for (const e of outgoing) console.log(`${pad}  → ${e.label} → ${byId.get(e.target)!.label}`);
        }
        print(n.id, depth + 1);
      }
    };
    console.log(`\n  ${svc.store.getMeta('project.name')} — living map (brain: ${brainInfo(svc.brain).mode})\n`);
    print(null, 0);
    console.log(`\n  ${all.length} nodes total. \`--all\` prints every level.\n`);
    svc.close();
    return;
  }

  if (cmd === 'context') {
    const find = typeof flags.find === 'string' ? flags.find : undefined;
    let nodeId = typeof flags.node === 'string' ? flags.node : null;
    if (!nodeId && find) {
      const hit = svc.store.allNodes().find((n) => n.label.toLowerCase().includes(find.toLowerCase()));
      nodeId = hit?.id ?? null;
    }
    const ctx = svc.context(nodeId);
    const node = nodeId ? svc.node(nodeId) : null;
    console.log(`\n  scoped context${node ? ` for "${node.label}"` : ' (whole map)'} — ${ctx.totalTokens}/${ctx.budgetTokens} tokens\n`);
    for (const item of ctx.items) {
      console.log(`  ── ${item.label}${item.source ? ` [${item.source}]` : ''} · ${item.tokens} tokens${item.truncated ? ' · truncated' : ''}`);
      console.log(item.content.split('\n').slice(0, 12).map((l) => `     ${l}`).join('\n'));
      console.log('');
    }
    svc.close();
    return;
  }

  if (cmd === 'ask') {
    const question = rest.join(' ') || 'what is in this project?';
    let nodeId = typeof flags.node === 'string' ? flags.node : null;
    if (!nodeId) {
      const hit = svc.store.allNodes().find((n) => question.toLowerCase().includes(n.label.toLowerCase()));
      nodeId = hit?.id ?? null;
    }
    process.stdout.write(`\n  `);
    let first = true;
    for await (const event of runChat(svc, question, { nodeId })) {
      if (event.type === 'token') {
        process.stdout.write(event.text);
        first = false;
      } else if (event.type === 'notice' && first) {
        process.stdout.write(`(${event.text})\n\n  `);
      } else if (event.type === 'proposal') {
        process.stdout.write(`\n\n  ⧗ proposal queued: ${event.proposal.title}\n     ${event.proposal.rationale.replace(/\n/g, '\n     ')}\n     ops: ${event.proposal.ops.map((o) => o.op).join(', ')} — approve it in the interface.\n`);
      }
    }
    console.log('\n');
    svc.close();
    return;
  }

  if (cmd === 'serve') {
    const port = Number(flags.port ?? 4317);
    const server = await startServer(root, { port, host: typeof flags.host === 'string' ? flags.host : undefined });
    const project = svc.project();
    console.log(`\n  SysCode  ·  ${project.name}`);
    console.log(`  map      ${project.stats.nodeCount} nodes · ${project.stats.edgeCount} edges · ${project.stats.pendingProposals} pending proposal(s)`);
    console.log(`  brain    ${project.brain.mode}${project.brain.model ? ` (${project.brain.provider}/${project.brain.model})` : ' — deterministic mapper'}`);
    console.log(`  engine   ${server.url}  (api: /api/health)`);
    console.log(`  ui       ${server.url}\n`);
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`syscode: ${(err as Error).message}`);
  if (process.env.SYSCODE_DEBUG) console.error(err);
  process.exitCode = 1;
});
