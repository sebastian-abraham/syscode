/**
 * Model-agnostic provider layer. Any OpenAI-compatible endpoint works
 * (OpenAI, Groq, OpenRouter, Together, vLLM, LM Studio, llama.cpp, Ollama's
 * OpenAI shim), plus Anthropic and native Ollama.
 *
 * Nothing in here is required for SysCode to work: with no provider configured the
 * deterministic mapper and the rule-based agent take over, and the interface says so.
 */
import type { Brain } from '../config.ts';
import type { ModelChoice } from '../types.ts';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatTurn[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderError {
  message: string;
  status?: number;
}

async function* parseSse(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      yield payload;
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
}

/** Stream a completion as plain text chunks. */
export async function* streamChat(brain: Brain, req: ChatRequest): AsyncGenerator<string> {
  if (brain.mode !== 'model' || !brain.baseUrl) throw new Error('No model is configured.');
  if (brain.provider === 'anthropic') {
    yield* streamAnthropic(brain, req);
    return;
  }
  if (brain.provider === 'ollama') {
    yield* streamOllama(brain, req);
    return;
  }
  yield* streamOpenAiCompatible(brain, req);
}

async function* streamOpenAiCompatible(brain: Brain, req: ChatRequest): AsyncGenerator<string> {
  const messages = req.system ? [{ role: 'system' as const, content: req.system }, ...req.messages] : req.messages;
  const res = await fetch(`${brain.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(brain.apiKey ? { authorization: `Bearer ${brain.apiKey}` } : {}),
      ...providerHeaders(brain),
    },
    body: JSON.stringify({
      model: brain.model ?? 'gpt-4o-mini',
      messages,
      stream: true,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens,
    }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  for await (const payload of parseSse(res)) {
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? '';
      if (delta) yield delta as string;
    } catch {
      /* keep-alive or partial frame */
    }
  }
}

/**
 * OpenCode Go's relay needs a session id on every chat call, or it answers
 * 400 MissingSessionID. The value is opaque — it only has to stay stable so the
 * upstream prompt cache stays warm, so one per process is enough.
 */
const OPENCODE_SESSION = `syscode-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

function providerHeaders(brain: Brain): Record<string, string> {
  if (brain.provider !== 'opencode-go') return {};
  return { 'x-opencode-session': OPENCODE_SESSION };
}

/**
 * opencode-go serves chat-completions for most model families, but routes a few
 * through other endpoint shapes entirely. This client only speaks chat, so those
 * are surfaced as unsupported rather than failing with an opaque 404.
 */
const OPENCODE_SHAPE_BY_PREFIX: { prefix: string; shape: 'responses' | 'messages' }[] = [
  { prefix: 'gpt-', shape: 'responses' },
  { prefix: 'grok-', shape: 'responses' },
  { prefix: 'muse-spark', shape: 'responses' },
  { prefix: 'minimax-', shape: 'messages' },
  { prefix: 'qwen', shape: 'messages' },
];

export function modelShape(provider: Brain['provider'], modelId: string): { supported: boolean; note?: string } {
  if (provider !== 'opencode-go') return { supported: true };
  const hit = OPENCODE_SHAPE_BY_PREFIX.find((p) => modelId.startsWith(p.prefix));
  if (!hit) return { supported: true };
  return {
    supported: false,
    note: hit.shape === 'responses'
      ? `${modelId} is served through the Responses API, which this client does not speak yet.`
      : `${modelId} is served through the Messages API, which this client does not speak yet.`,
  };
}

/** Ask the provider what it can actually serve, so the interface can offer real choices. */
export async function listModels(brain: Brain): Promise<ModelChoice[]> {
  if (brain.mode !== 'model' || !brain.baseUrl) return [];
  try {
    const res = await fetch(`${brain.baseUrl}/models`, {
      headers: {
        ...(brain.apiKey ? { authorization: `Bearer ${brain.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
    const ids = (json.data ?? json.models ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return ids.map((id) => ({ id, ...modelShape(brain.provider, id) }));
  } catch {
    return [];
  }
}

async function* streamAnthropic(brain: Brain, req: ChatRequest): AsyncGenerator<string> {
  const res = await fetch(`${brain.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(brain.apiKey ? { 'x-api-key': brain.apiKey } : {}),
    },
    body: JSON.stringify({
      model: brain.model ?? 'claude-3-5-sonnet-latest',
      system: req.system,
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens ?? 1500,
      temperature: req.temperature ?? 0.2,
    }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  for await (const payload of parseSse(res)) {
    try {
      const json = JSON.parse(payload);
      if (json.type === 'content_block_delta' && json.delta?.text) yield json.delta.text as string;
    } catch {
      /* ignore */
    }
  }
}

async function* streamOllama(brain: Brain, req: ChatRequest): AsyncGenerator<string> {
  const res = await fetch(`${brain.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: brain.model ?? 'llama3.1',
      messages: req.system ? [{ role: 'system', content: req.system }, ...req.messages] : req.messages,
      stream: true,
      options: { temperature: req.temperature ?? 0.2 },
    }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.message?.content) yield json.message.content as string;
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * One non-streaming completion. Used where a single short answer is wanted and streaming
 * only adds failure modes — health probes, model checks.
 */
export async function completeOnce(brain: Brain, req: ChatRequest): Promise<string> {
  if (brain.mode !== 'model' || !brain.baseUrl) throw new Error('No model is configured.');

  if (brain.provider === 'anthropic') {
    const res = await fetch(`${brain.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(brain.apiKey ? { 'x-api-key': brain.apiKey } : {}),
      },
      body: JSON.stringify({
        model: brain.model ?? 'claude-3-5-sonnet-latest',
        system: req.system,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 64,
      }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content?: { text?: string }[] };
    return (json.content ?? []).map((c) => c.text ?? '').join('');
  }

  if (brain.provider === 'ollama') {
    const res = await fetch(`${brain.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: brain.model ?? 'llama3.1',
        messages: req.system ? [{ role: 'system', content: req.system }, ...req.messages] : req.messages,
        stream: false,
      }),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? '';
  }

  const messages = req.system ? [{ role: 'system' as const, content: req.system }, ...req.messages] : req.messages;
  const res = await fetch(`${brain.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(brain.apiKey ? { authorization: `Bearer ${brain.apiKey}` } : {}),
      ...providerHeaders(brain),
    },
    body: JSON.stringify({
      model: brain.model ?? 'gpt-4o-mini',
      messages,
      stream: false,
      max_tokens: req.maxTokens ?? 64,
    }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
  const msg = json.choices?.[0]?.message ?? {};
  // some relays (deepseek on opencode-go) can answer entirely inside reasoning_content
  return msg.content?.trim() || msg.reasoning_content?.trim() || '';
}

/** Check that a configured brain actually answers. Used by the settings panel. */
export async function probeBrain(brain: Brain): Promise<{ ok: boolean; detail: string }> {
  if (brain.mode !== 'model') return { ok: false, detail: brain.note ?? 'No model configured.' };
  try {
    const out = await completeOnce(brain, {
      messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
      maxTokens: 24,
    });
    const text = out.trim().slice(0, 60);
    return text
      ? { ok: true, detail: `${brain.model ?? brain.provider} answered: ${text}` }
      : { ok: false, detail: `${brain.model ?? brain.provider} answered with an empty message.` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}
