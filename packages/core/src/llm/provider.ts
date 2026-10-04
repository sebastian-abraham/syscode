/**
 * Model-agnostic provider layer. Any OpenAI-compatible endpoint works
 * (OpenAI, Groq, OpenRouter, Together, vLLM, LM Studio, llama.cpp, Ollama's
 * OpenAI shim), plus Anthropic and native Ollama.
 *
 * Nothing in here is required for SysCode to work: with no provider configured the
 * deterministic mapper and the rule-based agent take over, and the interface says so.
 */
import type { Brain } from '../config.ts';

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

/** Check that a configured brain actually answers. Used by the settings panel. */
export async function probeBrain(brain: Brain): Promise<{ ok: boolean; detail: string }> {
  if (brain.mode !== 'model') return { ok: false, detail: brain.note ?? 'No model configured.' };
  try {
    let out = '';
    for await (const chunk of streamChat(brain, {
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 12,
    })) {
      out += chunk;
      if (out.length > 20) break;
    }
    return { ok: true, detail: `Model answered: ${out.trim().slice(0, 40) || '(empty)'}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}
