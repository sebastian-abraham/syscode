/**
 * Model-agnostic configuration. Nothing here assumes a provider; the interface,
 * the engine and the CLI all read the same resolved brain.
 *
 * Provider notes worth keeping:
 *  - opencode-go (opencode.ai/zen/go) speaks plain OpenAI chat, but requires an
 *    `x-opencode-session` header on every chat call and routes some model families
 *    through other endpoints entirely (see provider.ts).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SyscodeConfig } from './types.ts';

export interface Brain {
  mode: 'heuristic' | 'model';
  provider: SyscodeConfig['provider'];
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Why we fell back, when we did. */
  note?: string;
}

export const DEFAULT_CONFIG: SyscodeConfig = {
  provider: 'none',
  maxContextTokens: 6000,
};

export function configPath(root: string): string {
  return path.join(root, '.syscode', 'config.json');
}

/** Where SysCode keeps the list of projects the developer has opened. */
export function workspaceDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'syscode');
}

/**
 * Convenience for a machine that already runs Hermes: its credential file holds the
 * OpenCode Go key. We never copy the key anywhere, and an explicit env var still wins.
 */
function readEnvFileValue(name: string, file = path.join(homedir(), '.hermes', '.env')): string | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`).exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no such file — fine */
  }
  return undefined;
}

/** Provider assumed when the machine holds a key but nothing has been configured. */
const AUTO_PROVIDER: SyscodeConfig['provider'] = 'opencode-go';
/** Model assumed for the auto-connected provider; the model dialog can change it. */
const AUTO_MODEL = 'deepseek-v4.1-flash';

export function loadConfig(root: string): SyscodeConfig {
  let fileCfg: Partial<SyscodeConfig> = {};
  try {
    fileCfg = JSON.parse(readFileSync(configPath(root), 'utf8')) as Partial<SyscodeConfig>;
  } catch {
    /* no config yet */
  }
  const env = process.env;
  const cfg: SyscodeConfig = {
    ...DEFAULT_CONFIG,
    ...fileCfg,
  };
  if (env.SYSCODE_PROVIDER) cfg.provider = env.SYSCODE_PROVIDER as SyscodeConfig['provider'];
  if (env.SYSCODE_BASE_URL) cfg.baseUrl = env.SYSCODE_BASE_URL;
  if (env.SYSCODE_MODEL) cfg.model = env.SYSCODE_MODEL;
  if (env.SYSCODE_MAX_CONTEXT_TOKENS) cfg.maxContextTokens = Number(env.SYSCODE_MAX_CONTEXT_TOKENS) || cfg.maxContextTokens;
  if (env.SYSCODE_API_KEY) cfg.apiKey = env.SYSCODE_API_KEY;

  // A machine that already holds a provider key should not have to be told twice. With
  // nothing configured, opening as "no model connected" is a dead end that looks like a
  // broken app — especially for a packaged build, which is launched from a menu and has no
  // environment to set. An explicit choice (the project's config file, or the environment)
  // always wins; this only fills the gap.
  if (!fileCfg.provider && !env.SYSCODE_PROVIDER) {
    if (resolveBrain({ ...cfg, provider: AUTO_PROVIDER }, env).mode === 'model') {
      cfg.provider = AUTO_PROVIDER;
      if (!fileCfg.model && !env.SYSCODE_MODEL) cfg.model = AUTO_MODEL;
    }
  }
  return cfg;
}

export function saveConfig(root: string, patch: Partial<SyscodeConfig>): SyscodeConfig {
  const dir = path.join(root, '.syscode');
  mkdirSync(dir, { recursive: true });
  const next = { ...loadConfig(root), ...patch };
  writeFileSync(configPath(root), JSON.stringify(next, null, 2));
  return next;
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; envKey?: string[]; envFile?: string[] }> = {
  ollama: { baseUrl: 'http://localhost:11434' },
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    envKey: ['OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'SYSCODE_API_KEY'],
  },
  anthropic: { baseUrl: 'https://api.anthropic.com', envKey: ['ANTHROPIC_API_KEY'] },
  'opencode-go': {
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envKey: ['OPENCODE_GO_API_KEY', 'SYSCODE_API_KEY'],
    envFile: ['OPENCODE_GO_API_KEY'],
  },
};

export function providerDefaults(provider: SyscodeConfig['provider']): { baseUrl: string } | undefined {
  const d = PROVIDER_DEFAULTS[provider];
  return d ? { baseUrl: d.baseUrl } : undefined;
}

export function resolveBrain(cfg: SyscodeConfig, env: NodeJS.ProcessEnv = process.env): Brain {
  if (cfg.provider === 'none' || !cfg.provider) {
    return { mode: 'heuristic', provider: 'none', note: 'No model connected — the map is built by the deterministic mapper.' };
  }
  const defaults = PROVIDER_DEFAULTS[cfg.provider];
  if (!defaults) {
    return { mode: 'heuristic', provider: 'none', note: `Unknown provider "${cfg.provider}".` };
  }
  const baseUrl = (cfg.baseUrl || defaults.baseUrl).replace(/\/$/, '');
  let apiKey = cfg.apiKey;
  if (!apiKey && defaults.envKey) {
    for (const k of defaults.envKey) {
      if (env[k]) {
        apiKey = env[k];
        break;
      }
    }
  }
  if (!apiKey && defaults.envFile) {
    for (const k of defaults.envFile) {
      const v = readEnvFileValue(k);
      if (v) {
        apiKey = v;
        break;
      }
    }
  }
  if (!apiKey && cfg.provider !== 'ollama') {
    return { mode: 'heuristic', provider: cfg.provider, note: `Provider "${cfg.provider}" is configured but no API key is available.` };
  }
  return {
    mode: 'model',
    provider: cfg.provider,
    model: cfg.model,
    baseUrl,
    apiKey,
  };
}

export function brainInfo(brain: Brain): { mode: 'heuristic' | 'model'; provider?: string; model?: string } {
  return brain.mode === 'model'
    ? { mode: 'model', provider: brain.provider, model: brain.model ?? 'default' }
    : { mode: 'heuristic' };
}

/** The providers the interface should offer, with what each needs. */
export function providerCatalogue(): { id: SyscodeConfig['provider']; label: string; needsKey: boolean; hint: string }[] {
  return [
    { id: 'none', label: 'No model', needsKey: false, hint: 'Deterministic mapper only. Everything still works; the map is labelled as heuristic.' },
    { id: 'opencode-go', label: 'OpenCode Go', needsKey: true, hint: 'opencode.ai/zen/go — OpenAI-compatible chat. Key read from OPENCODE_GO_API_KEY.' },
    { id: 'openai-compatible', label: 'OpenAI-compatible', needsKey: true, hint: 'Any /chat/completions endpoint: OpenAI, Groq, OpenRouter, vLLM, LM Studio.' },
    { id: 'anthropic', label: 'Anthropic', needsKey: true, hint: 'Claude via the Messages API.' },
    { id: 'ollama', label: 'Ollama (local)', needsKey: false, hint: 'A model running on this machine. No key required.' },
  ];
}
