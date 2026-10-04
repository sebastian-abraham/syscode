import type {
  ChatEvent,
  ChatMessage,
  EdgeKind,
  JournalEntry,
  MapEdge,
  MapNode,
  MapView,
  MemoryInfo,
  ModelChoice,
  Note,
  ProjectInfo,
  Proposal,
  RefineResult,
  RefreshReport,
  ScopedContext,
  SyscodeConfig,
  WorkspaceInfo,
} from './types.ts';

/** Shape of a `GET /api/node/:id/code` response — the code peek slice. */
export interface CodeSlice {
  path: string;
  start: number;
  end: number;
  text: string;
  highlight: [number, number] | null;
}

export interface HealthInfo {
  ok: true;
  brain: ProjectInfo['brain'];
}

/** One provider the interface can offer, from `GET /api/providers`. */
export interface ProviderInfo {
  id: SyscodeConfig['provider'];
  label: string;
  /** When true the provider needs a key, so the form must ask for one. */
  needsKey: boolean;
  hint: string;
}

export interface ProviderCatalogue {
  providers: ProviderInfo[];
  defaultParentDir: string;
}

/** `GET /api/config/models` — what the configured provider can actually serve. */
export interface ModelsResponse {
  brain: ProjectInfo['brain'];
  models: ModelChoice[];
}

/** `POST /api/config/probe` — the provider's own words about whether it answers. */
export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** The result of opening or creating a project, so the form can show the engine's phrasing. */
export type WorkspaceActionResult = { ok: true } | { ok: false; error: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

declare global {
  interface Window {
    /** Injected by the Tauri shell so the webview can talk to the local engine. */
    __SYSCODE_API_BASE__?: string;
    __SYSCODE_DESKTOP__?: boolean;
    /** Present only inside the desktop shell. The native directory picker is not
     *  implemented yet, so calling it throws — callers fall back to a text input. */
    __TAURI__?: {
      core?: {
        invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }
}

/**
 * The interface normally talks to the engine on the same origin (`/api`), which covers
 * both `npm run web` (Vite proxies it) and the engine serving the built UI itself.
 * The desktop shell and any remote-engine setup inject an absolute base instead.
 */
function resolveApiBase(): string {
  if (typeof window === 'undefined') return '/api';
  const injected = window.__SYSCODE_API_BASE__;
  if (injected) return `${injected.replace(/\/+$/, '')}/api`;
  const fromQuery = new URLSearchParams(window.location.search).get('api');
  if (fromQuery) return `${fromQuery.replace(/\/+$/, '')}/api`;
  return '/api';
}

const BASE = resolveApiBase();

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
  let body = init.body;
  if (body !== undefined && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, body });
  } catch (err) {
    throw new ApiError(0, `Cannot reach the SysCode engine (${(err as Error).message})`);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          detail = parsed.error ?? parsed.message ?? text.slice(0, 240);
        } catch {
          detail = text.slice(0, 240);
        }
      }
    } catch {
      /* keep status text */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const enc = encodeURIComponent;

export const api = {
  health: () => req<HealthInfo>('/health'),
  project: () => req<ProjectInfo>('/project'),

  map: (parent?: string | null) =>
    req<MapView>(parent ? `/map?parent=${enc(parent)}` : '/map'),

  node: (id: string) => req<MapNode>(`/node/${enc(id)}`),
  nodeContext: (id: string) => req<ScopedContext>(`/node/${enc(id)}/context`),
  nodeCode: (id: string, anchor: number) =>
    req<CodeSlice>(`/node/${enc(id)}/code?anchor=${anchor}`),
  descendants: (id: string) =>
    req<{ nodes: MapNode[]; edges: MapEdge[] }>(`/node/${enc(id)}/descendants`),

  createNode: (body: {
    label: string;
    summary: string;
    parentId?: string | null;
    kind?: MapNode['kind'];
    position?: { x: number; y: number };
  }) => req<MapNode>('/node', { method: 'POST', body: body as unknown as BodyInit }),

  patchNode: (
    id: string,
    body: Partial<{
      label: string;
      summary: string;
      detail: string;
      position: { x: number; y: number };
      kind: MapNode['kind'];
      positionLocked: boolean;
      labelLocked: boolean;
    }>,
  ) => req<MapNode>(`/node/${enc(id)}`, { method: 'PATCH', body: body as unknown as BodyInit }),

  deleteNode: (id: string) => req<{ ok: true }>(`/node/${enc(id)}`, { method: 'DELETE' }),

  createEdge: (body: { source: string; target: string; label: string; kind?: EdgeKind }) =>
    req<MapEdge>('/edge', { method: 'POST', body: body as unknown as BodyInit }),

  patchEdge: (id: string, body: { label?: string; kind?: EdgeKind }) =>
    req<MapEdge>(`/edge/${enc(id)}`, { method: 'PATCH', body: body as unknown as BodyInit }),

  deleteEdge: (id: string) => req<{ ok: true }>(`/edge/${enc(id)}`, { method: 'DELETE' }),

  addNote: (nodeId: string, body: { body: string; kind: Note['kind'] }) =>
    req<Note>(`/node/${enc(nodeId)}/note`, { method: 'POST', body: body as unknown as BodyInit }),

  deleteNote: (nodeId: string, noteId: string) =>
    req<{ ok: true }>(`/node/${enc(nodeId)}/note/${enc(noteId)}`, { method: 'DELETE' }),

  refresh: () => req<RefreshReport>('/refresh', { method: 'POST' }),

  proposals: () => req<Proposal[]>('/proposals'),

  approveProposal: (id: string) =>
    req<{ proposal: Proposal; view: MapView }>(`/proposals/${enc(id)}/approve`, { method: 'POST' }),

  rejectProposal: (id: string) =>
    req<Proposal>(`/proposals/${enc(id)}/reject`, { method: 'POST' }),

  chatHistory: () => req<ChatMessage[]>('/chat/history'),

  journal: (limit = 50) => req<JournalEntry[]>(`/journal?limit=${limit}`),

  config: () => req<SyscodeConfig>('/config'),

  patchConfig: (body: Partial<SyscodeConfig>) =>
    req<SyscodeConfig>('/config', { method: 'PATCH', body: body as unknown as BodyInit }),

  // ---- What the provider can actually serve, and whether it answers ------
  models: () => req<ModelsResponse>('/config/models'),
  probe: () => req<ProbeResult>('/config/probe', { method: 'POST' }),
  providers: () => req<ProviderCatalogue>('/providers'),

  // ---- Workspace: the app outside a single project -----------------------
  workspace: () => req<WorkspaceInfo>('/workspace'),
  openWorkspace: (path: string) =>
    req<ProjectInfo>('/workspace/open', { method: 'POST', body: { path } as unknown as BodyInit }),
  createWorkspace: (body: { name: string; parentDir?: string; template?: 'typescript' | 'empty' }) =>
    req<ProjectInfo & { created: string[] }>('/workspace/create', {
      method: 'POST',
      body: body as unknown as BodyInit,
    }),
  forgetWorkspace: (path: string) =>
    req<WorkspaceInfo>('/workspace/forget', { method: 'POST', body: { path } as unknown as BodyInit }),

  // ---- Memory + refinement: the model owning the map's meaning -----------
  memory: () => req<MemoryInfo>('/memory'),
  buildMemory: () => req<MemoryInfo>('/memory/build', { method: 'POST' }),
  refine: (body: { nodeId?: string | null }) =>
    req<RefineResult>('/refine', { method: 'POST', body: body as unknown as BodyInit }),
};

// ---------------------------------------------------------------------------
// SSE — fetch + ReadableStream (never EventSource) so POST /api/chat works.
// ---------------------------------------------------------------------------

export interface SSEMessage {
  event?: string;
  data: string;
}

export interface SSEHandlers {
  onMessage: (message: SSEMessage) => void;
  signal?: AbortSignal;
}

function parseFrame(raw: string): SSEMessage | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

/** Reads an SSE response, dispatching one callback per `data:` frame. */
export async function readSSE(res: Response, onMessage: (m: SSEMessage) => void): Promise<void> {
  if (!res.body) throw new ApiError(res.status, 'Streaming is not supported in this browser');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const message = parseFrame(raw);
        if (message) onMessage(message);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const message = parseFrame(buffer);
      if (message) onMessage(message);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function openStream(url: string, init: RequestInit, onMessage: (m: SSEMessage) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { Accept: 'text/event-stream', ...(init.headers as Record<string, string> | undefined) } });
  } catch (err) {
    throw new ApiError(0, `Cannot reach the SysCode engine (${(err as Error).message})`);
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  await readSSE(res, onMessage);
}

/** `POST /api/chat` → live `ChatEvent` stream. */
export async function streamChat(
  body: { message: string; nodeId?: string | null },
  handlers: { onEvent: (event: ChatEvent) => void; onError?: (err: unknown) => void; signal?: AbortSignal },
): Promise<void> {
  try {
    await openStream(
      `${BASE}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: handlers.signal,
      },
      (message) => {
        try {
          handlers.onEvent(JSON.parse(message.data) as ChatEvent);
        } catch {
          /* ignore malformed frame */
        }
      },
    );
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    handlers.onError?.(err);
  }
}

/** `GET /api/events` → `map-changed` / `proposal-created` / `refreshed` / `project-changed`. */
export interface ServerEvent {
  type: 'map-changed' | 'proposal-created' | 'refreshed' | 'project-changed';
  [key: string]: unknown;
}

export function subscribeEvents(
  onEvent: (event: ServerEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  const controller = new AbortController();
  openStream(`${BASE}/events`, { method: 'GET', signal: controller.signal }, (message) => {
    try {
      onEvent(JSON.parse(message.data) as ServerEvent);
    } catch {
      /* ignore */
    }
  }).catch((err) => {
    if (!controller.signal.aborted) onError?.(err);
  });
  return () => controller.abort();
}
