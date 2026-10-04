/**
 * The local API the interface talks to. HTTP + SSE on one port, so the React canvas,
 * a Tauri shell and (later) an editor extension all consume the same engine.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MapService } from '../map/service.ts';
import { runChat } from '../llm/agent.ts';
import { listModels, probeBrain } from '../llm/provider.ts';
import { brainInfo, loadConfig, providerCatalogue } from '../config.ts';
import {
  WorkspaceError, createProject, defaultParentDir, forgetProject, rememberProject, workspaceInfo,
} from '../workspace.ts';
import { newId } from '../store/db.ts';
import type { ChatEvent, ChatMessage, MapNode, Note } from '../types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Where the built interface lives. */
  webRoot?: string;
}

/** The engine can be pointed at a different project while it runs — the app has a life
 *  outside one repository, so the served map is state, not a closure. */
interface ServerState {
  svc: MapService;
  webRoot: string;
}

export interface SyscodeServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  events: EventEmitter;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...corsHeaders(),
  });
  res.end(text);
}

/**
 * The interface may be served from a different origin than the engine (Tauri's
 * tauri://localhost, a Vite dev server, an editor webview), so the local API is
 * explicitly open to any origin. It only ever listens on loopback.
 */
function corsHeaders(req?: IncomingMessage): Record<string, string> {
  const origin = req?.headers.origin;
  return {
    'access-control-allow-origin': origin && origin !== 'null' ? origin : '*',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startServer(root: string, opts: ServerOptions = {}): Promise<SyscodeServer> {
  const svc = await MapService.open(root, { refresh: true });
  rememberProject(svc.root);
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const state: ServerState = { svc, webRoot: opts.webRoot ?? resolveWebRoot(root) };
  const port = opts.port ?? 4317;
  const host = opts.host ?? '127.0.0.1';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      if (route.startsWith('/api/')) {
        await handleApi(state, events, route, method, req, res, url.searchParams);
        return;
      }
      serveStatic(state.webRoot, route, res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    url: `http://${host}:${actual}`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        state.svc.close();
        server.close(() => resolve());
      }),
  };
}

/**
 * Point the running engine at a different project. The old map is closed cleanly and the
 * new one is mapped from scratch, so switching projects never mixes their state.
 */
async function switchProject(state: ServerState, dir: string): Promise<MapService> {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new Error(`${abs} is not a directory.`);
  const next = await MapService.open(abs, { refresh: true });
  rememberProject(next.root);
  const previous = state.svc;
  state.svc = next;
  try {
    previous.close();
  } catch {
    /* already closed */
  }
  return next;
}

/**
 * Where the built interface lives. A mapped project usually does not contain the UI,
 * so fall back to the SysCode checkout this engine is running from.
 */
function resolveWebRoot(root: string): string {
  const candidates = [
    process.env.SYSCODE_WEB,
    path.resolve(root, 'apps/web/dist'),
    path.resolve(import.meta.dirname, '../../../../apps/web/dist'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(path.join(c, 'index.html'))) return c;
  return candidates[1];
}

async function handleApi(
  state: ServerState,
  events: EventEmitter,
  route: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const svc = state.svc;
  const seg = route.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  /* ---------------------------------------------------------------- health */
  if (seg[0] === 'health') {
    json(res, 200, { ok: true, root: svc.root, brain: brainInfo(svc.brain), node: svc.store.stats() });
    return;
  }
  if (seg[0] === 'project') {
    json(res, 200, svc.project());
    return;
  }
  if (seg[0] === 'map') {
    const parent = query.get('parent');
    json(res, 200, svc.view(parent && parent !== 'root' ? parent : null));
    return;
  }
  if (seg[0] === 'proposals') {
    if (seg.length === 1) {
      json(res, 200, svc.proposals());
      return;
    }
    const id = seg[1];
    if (seg[2] === 'approve') {
      const out = svc.approveProposal(id);
      if (!out) {
        json(res, 404, { error: 'proposal not found' });
        return;
      }
      events.emit('change', { type: 'map-changed' });
      json(res, 200, out);
      return;
    }
    if (seg[2] === 'reject') {
      const p = svc.rejectProposal(id);
      json(res, p ? 200 : 404, p ?? { error: 'proposal not found' });
      return;
    }
    json(res, 404, { error: 'unknown proposal action' });
    return;
  }
  if (seg[0] === 'refresh' && method === 'POST') {
    const report = await svc.rescan();
    events.emit('change', { type: 'refreshed', report });
    json(res, 200, report);
    return;
  }
  if (seg[0] === 'journal') {
    json(res, 200, svc.journal(Number(query.get('limit') ?? 60)));
    return;
  }
  if (seg[0] === 'config') {
    if (seg[1] === 'models' && method === 'GET') {
      json(res, 200, { brain: brainInfo(svc.brain), models: await listModels(svc.brain) });
      return;
    }
    if (method === 'GET') {
      const cfg = loadConfig(svc.root);
      json(res, 200, { ...cfg, apiKey: cfg.apiKey ? '••••••' : undefined, brain: brainInfo(svc.brain), note: svc.brain.note });
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const k of ['provider', 'baseUrl', 'model', 'maxContextTokens'] as const) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      if (typeof body.apiKey === 'string' && body.apiKey && body.apiKey !== '••••••') patch.apiKey = body.apiKey;
      svc.setConfig(patch as never);
      events.emit('change', { type: 'map-changed' });
      json(res, 200, { ...loadConfig(svc.root), apiKey: undefined, brain: brainInfo(svc.brain), note: svc.brain.note });
      return;
    }
    if (method === 'POST' && seg[1] === 'probe') {
      json(res, 200, await probeBrain(svc.brain));
      return;
    }
  }
  /* ------------------------------------------------------------- workspace */
  if (seg[0] === 'providers') {
    json(res, 200, { providers: providerCatalogue(), defaultParentDir: defaultParentDir() });
    return;
  }
  if (seg[0] === 'workspace') {
    if (method === 'GET') {
      json(res, 200, workspaceInfo(svc.project()));
      return;
    }
    if (method === 'POST' && seg[1] === 'open') {
      const body = await readBody(req);
      const target = String(body.path ?? '').trim();
      if (!target) {
        json(res, 400, { error: 'path is required' });
        return;
      }
      try {
        const next = await switchProject(state, target);
        events.emit('change', { type: 'project-changed' });
        json(res, 200, next.project());
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (method === 'POST' && seg[1] === 'create') {
      const body = await readBody(req);
      try {
        const created = createProject({
          name: String(body.name ?? ''),
          parentDir: body.parentDir ? String(body.parentDir) : undefined,
          template: (body.template as 'empty' | 'typescript' | undefined) ?? undefined,
        });
        const next = await switchProject(state, created.path);
        events.emit('change', { type: 'project-changed' });
        json(res, 200, { ...next.project(), created: created.files });
      } catch (err) {
        json(res, err instanceof WorkspaceError ? 400 : 500, { error: (err as Error).message });
      }
      return;
    }
    if (method === 'POST' && seg[1] === 'forget') {
      const body = await readBody(req);
      forgetProject(String(body.path ?? ''));
      json(res, 200, workspaceInfo(svc.project()));
      return;
    }
  }

  /* ---------------------------------------------------------------- memory */
  if (seg[0] === 'memory') {
    if (method === 'GET') {
      json(res, 200, svc.memory());
      return;
    }
    if (method === 'POST' && seg[1] === 'build') {
      const info = await svc.buildMemory();
      events.emit('change', { type: 'map-changed' });
      json(res, 200, info);
      return;
    }
  }

  /* ---------------------------------------------------------------- refine */
  if (seg[0] === 'refine' && method === 'POST') {
    const body = await readBody(req);
    const result = await svc.refine({ nodeId: (body.nodeId as string | null | undefined) ?? null });
    if (result.proposal) events.emit('change', { type: 'proposal-created' });
    json(res, 200, result);
    return;
  }

  if (seg[0] === 'events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const onChange = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    events.on('change', onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      events.off('change', onChange);
    });
    return;
  }

  /* ------------------------------------------------------------------ chat */
  if (seg[0] === 'chat') {
    if (method === 'GET') {
      json(res, 200, svc.chatHistory());
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message ?? '').trim();
      const nodeId = (body.nodeId as string | null | undefined) ?? null;
      if (!message) {
        json(res, 400, { error: 'message is required' });
        return;
      }
      const userMsg: ChatMessage = {
        id: newId('msg'),
        role: 'user',
        text: message,
        nodeId,
        createdAt: new Date().toISOString(),
        brain: svc.brain.mode,
      };
      svc.addChat(userMsg);

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: ChatEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'notice', level: 'info', text: `scoped to ${nodeId ? svc.node(nodeId)?.label ?? 'node' : 'the whole map'}` });

      let answer = '';
      let proposalId: string | undefined;
      try {
        for await (const event of runChat(svc, message, { nodeId })) {
          if (event.type === 'token') answer += event.text;
          if (event.type === 'proposal') {
            proposalId = event.proposal.id;
            events.emit('change', { type: 'proposal-created' });
          }
          send(event);
        }
      } catch (err) {
        send({ type: 'notice', level: 'warn', text: `chat failed: ${(err as Error).message}` });
      }
      svc.addChat({
        id: newId('msg'),
        role: 'agent',
        text: answer,
        nodeId,
        createdAt: new Date().toISOString(),
        brain: svc.brain.mode,
        model: svc.brain.model,
        proposalId,
      });
      res.end();
      return;
    }
  }

  /* ----------------------------------------------------------------- nodes */
  if (seg[0] === 'node') {
    const id = seg[1];
    if (!id && method === 'POST') {
      const body = await readBody(req);
      const node = svc.createNode({
        label: String(body.label ?? 'Untitled'),
        summary: String(body.summary ?? ''),
        kind: (body.kind as MapNode['kind']) ?? 'planned',
        parentId: (body.parentId as string | null) ?? null,
        position: body.position as { x: number; y: number } | undefined,
      });
      events.emit('change', { type: 'map-changed' });
      json(res, 200, node);
      return;
    }
    if (!id) {
      json(res, 404, { error: 'node id required' });
      return;
    }
    if (seg.length === 2) {
      if (method === 'GET') {
        const node = svc.node(id);
        json(res, node ? 200 : 404, node ?? { error: 'not found' });
        return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const node = svc.patchNode(id, body as Partial<MapNode>);
        events.emit('change', { type: 'map-changed' });
        json(res, node ? 200 : 404, node ?? { error: 'not found' });
        return;
      }
      if (method === 'DELETE') {
        svc.deleteNode(id);
        events.emit('change', { type: 'map-changed' });
        json(res, 200, { ok: true });
        return;
      }
    }
    if (seg[2] === 'context') {
      json(res, 200, svc.context(id));
      return;
    }
    if (seg[2] === 'descendants') {
      json(res, 200, svc.descendants(id));
      return;
    }
    if (seg[2] === 'code') {
      const peek = svc.codePeek(id, Number(query.get('anchor') ?? 0));
      json(res, peek ? 200 : 404, peek ?? { error: 'no anchor' });
      return;
    }
    if (seg[2] === 'note' && method === 'POST') {
      const body = await readBody(req);
      const note = svc.addNote(id, String(body.body ?? ''), (body.kind as Note['kind']) ?? 'note');
      events.emit('change', { type: 'map-changed' });
      json(res, 200, note);
      return;
    }
    if (seg[2] === 'note' && seg[3] && method === 'DELETE') {
      svc.deleteNote(seg[3]);
      events.emit('change', { type: 'map-changed' });
      json(res, 200, { ok: true });
      return;
    }
  }

  /* ----------------------------------------------------------------- edges */
  if (seg[0] === 'edge') {
    if (method === 'POST') {
      const body = await readBody(req);
      const edge = svc.createEdge({
        source: String(body.source ?? ''),
        target: String(body.target ?? ''),
        label: String(body.label ?? 'relates to'),
        kind: (body.kind as never) ?? 'custom',
      });
      events.emit('change', { type: 'map-changed' });
      json(res, 200, edge);
      return;
    }
    if (seg[1] && method === 'PATCH') {
      const body = await readBody(req);
      const edge = svc.patchEdge(seg[1], body as never);
      events.emit('change', { type: 'map-changed' });
      json(res, edge ? 200 : 404, edge ?? { error: 'not found' });
      return;
    }
    if (seg[1] && method === 'DELETE') {
      svc.deleteEdge(seg[1]);
      events.emit('change', { type: 'map-changed' });
      json(res, 200, { ok: true });
      return;
    }
  }

  json(res, 404, { error: `no route for ${method} ${route}` });
}

function serveStatic(webRoot: string, route: string, res: ServerResponse): void {
  const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const candidates = [path.join(webRoot, rel), path.join(webRoot, 'index.html')];
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const ext = path.extname(candidate).toLowerCase();
    const body = readFileSync(candidate);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body style="font:14px/1.6 system-ui;background:#0d0f12;color:#e7e9ee;padding:48px">
    <h1 style="font-size:20px">SysCode engine is running</h1>
    <p>The interface has not been built yet. Either run the dev server:</p>
    <pre style="background:#161a20;padding:12px;border-radius:8px">npm run web</pre>
    <p>or build it once and reload this page:</p>
    <pre style="background:#161a20;padding:12px;border-radius:8px">npm run build:web</pre>
    <p style="color:#8b93a3">API is live at <code>/api/health</code>.</p>
  </body></html>`);
}
