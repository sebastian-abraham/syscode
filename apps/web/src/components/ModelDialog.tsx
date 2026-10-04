import { useEffect, useState } from 'react';
import { useStore } from '../store.tsx';
import type { SyscodeConfig } from '../types.ts';
import type { ProbeResult } from '../api.ts';
import { IconCheck, IconX } from './icons.tsx';

/**
 * Connecting a model, for real. The provider list, the models the provider actually
 * serves and the probe result all come from the engine — nothing here claims a
 * connection the engine has not verified.
 */
export default function ModelDialog({ onClose }: { onClose: () => void }) {
  const { config, saveConfig, providers, models, loadModels, probeModel, busy, project } = useStore();

  const [provider, setProvider] = useState<SyscodeConfig['provider']>(config?.provider ?? 'opencode-go');
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(config?.maxContextTokens ?? 24000));
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const meta = providers.find((p) => p.id === provider);
  const supported = models.filter((m) => m.supported);
  const unsupported = models.filter((m) => !m.supported);
  const tokens = Number.parseInt(maxTokens, 10);
  const effectiveTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 24000;

  const patch: Partial<SyscodeConfig> = {
    provider,
    baseUrl: baseUrl.trim() || undefined,
    model: model.trim() || undefined,
    maxContextTokens: effectiveTokens,
    ...(apiKey ? { apiKey } : {}),
  };

  const dirty =
    provider !== (config?.provider ?? 'none') ||
    (baseUrl.trim() || '') !== (config?.baseUrl ?? '') ||
    (model.trim() || '') !== (config?.model ?? '') ||
    effectiveTokens !== (config?.maxContextTokens ?? 24000) ||
    apiKey.length > 0;

  const runTest = async () => {
    // The engine probes the connection it actually holds, so apply the form first
    // (quietly) — otherwise a green result would describe a different config.
    if (dirty) await saveConfig(patch, { silent: true });
    const res = await probeModel();
    if (res) setProbe(res);
  };

  const submit = async () => {
    setSaving(true);
    await saveConfig(patch);
    setSaving(false);
    onClose();
  };

  const currentModelUnsupported = model && !supported.some((m) => m.id === model);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Connect a model">
        <header className="dialog__head">
          <div className="grow">
            <div className="dialog__title">Connect a model</div>
            <div className="dialog__sub">
              {project?.brain.mode === 'model'
                ? `Connected: ${project.brain.provider ?? 'provider'} · ${project.brain.model ?? 'default'}.`
                : 'No model connected — the map is built by the deterministic mapper.'}{' '}
              A model reads the code facts and writes the meaning: grouping, naming and explanations.
            </div>
          </div>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">
            <IconX size={15} />
          </button>
        </header>

        <div className="dialog__body">
          <div className="form-row">
            <label className="form-row__label" htmlFor="model-provider">
              Provider
            </label>
            <select
              id="model-provider"
              className="select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as SyscodeConfig['provider']);
                setProbe(null);
              }}
            >
              {providers.length === 0 && <option value={provider}>{provider}</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {meta?.hint && <div className="form-row__help">{meta.hint}</div>}
          </div>

          {meta?.needsKey && (
            <div className="form-row">
              <label className="form-row__label" htmlFor="model-key">
                API key
              </label>
              <input
                id="model-key"
                className="input"
                type="password"
                autoComplete="off"
                placeholder={config?.apiKey ? 'stored — type to replace' : 'sk-…'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <div className="form-row__help">
                Written to .syscode/config.json on this machine and never echoed back to the interface.
              </div>
            </div>
          )}

          <div className="form-row">
            <label className="form-row__label" htmlFor="model-name">
              Model
            </label>
            {supported.length > 0 || currentModelUnsupported ? (
              <select
                id="model-name"
                className="select"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setProbe(null);
                }}
              >
                <option value="">— provider default —</option>
                {supported.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
                {currentModelUnsupported && (
                  <option value={model}>{model} (not supported by this client)</option>
                )}
              </select>
            ) : (
              <input
                id="model-name"
                className="input"
                placeholder="e.g. gpt-4o-mini"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
            <div className="form-row__help">
              {busy.models
                ? 'Asking the provider which models it serves…'
                : supported.length > 0
                  ? `${supported.length} model(s) this provider serves and this client can speak.`
                  : 'No model list available — connect a provider or type a model id.'}
            </div>
          </div>

          {unsupported.length > 0 && (
            <div className="form-row">
              <div className="form-row__label">Shown, but not selectable</div>
              <div className="model-unavailable">
                {unsupported.map((m) => (
                  <div className="model-unavailable__row" key={m.id}>
                    <span className="model-unavailable__id mono">{m.id}</span>
                    {m.note && <span className="model-unavailable__note">{m.note}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="form-row grow">
              <label className="form-row__label" htmlFor="model-base">
                Base URL
              </label>
              <input
                id="model-base"
                className="input"
                placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://api…'}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="form-row grow">
              <label className="form-row__label" htmlFor="model-budget">
                Context budget (tokens)
              </label>
              <input
                id="model-budget"
                className="input"
                inputMode="numeric"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>

          <div className="probe-box">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void runTest()}
              disabled={busy.probe || busy.models}
            >
              {busy.probe ? 'Testing…' : 'Test connection'}
            </button>
            <div className="probe-box__result">
              {probe ? (
                <span className={probe.ok ? 'probe-ok' : 'probe-fail'}>
                  {probe.ok ? <IconCheck size={12} /> : <IconX size={12} />}
                  {probe.detail}
                </span>
              ) : (
                <span className="faint">
                  {dirty ? 'Tests the saved connection — unsaved changes are applied first.' : 'Make the provider answer, so “connected” is never a claim without evidence.'}
                </span>
              )}
            </div>
          </div>
        </div>

        <footer className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
