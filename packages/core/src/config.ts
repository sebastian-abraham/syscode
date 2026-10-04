/**
 * Model-agnostic configuration. Nothing here assumes a provider; the interface,
 * the engine and the CLI all read the same resolved brain.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  return cfg;
}

export function saveConfig(root: string, patch: Partial<SyscodeConfig>): SyscodeConfig {
  const dir = path.join(root, '.syscode');
  mkdirSync(dir, { recursive: true });
  const next = { ...loadConfig(root), ...patch };
  writeFileSync(configPath(root), JSON.stringify(next, null, 2));
  return next;
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; envKey?: string[] }> = {
  ollama: { baseUrl: 'http://localhost:11434' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', envKey: ['OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'SYSCODE_API_KEY'] },
  anthropic: { baseUrl: 'https://api.anthropic.com', envKey: ['ANTHROPIC_API_KEY'] },
};

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
