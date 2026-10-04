import { useEffect, useState } from 'react';
import { useStore } from '../store.tsx';
import type { SyscodeConfig } from '../types.ts';
import ProposalCard from './ProposalCard.tsx';
import { IconAlert, IconMap, IconPlus, IconRefresh, IconSpark, IconX } from './icons.tsx';

export default function HeaderBar() {
  const { project, view, pendingProposals, refresh, busy, setAddNodeOpen } = useStore();
  const [propsOpen, setPropsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const heuristic = project?.brain.mode === 'heuristic';
  const staleCount = view?.staleCount ?? project?.stats.staleCount ?? 0;
  const pending = pendingProposals.length;

  useEffect(() => {
    if (pending === 0) setPropsOpen(false);
  }, [pending]);

  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__mark" aria-hidden="true">
          <IconMap size={13} />
        </span>
        <span className="header__title">{project?.name ?? 'SysCode'}</span>
        {project?.root && <span className="header__root">{project.root}</span>}
      </div>

      <div className="header__spacer" />

      <div className="header__group">
        <button
          type="button"
          className={`brain-badge brain-badge--${heuristic ? 'heuristic' : 'model'}`}
          onClick={() => setModelOpen(true)}
          title={
            heuristic
              ? 'This map was built by the deterministic fallback — connect a model for richer meaning'
              : 'A model produced this map'
          }
        >
          {heuristic ? <IconSpark size={12} /> : <IconSpark size={12} />}
          {heuristic
            ? 'Heuristic map'
            : `Model · ${project?.brain.model ?? project?.brain.provider ?? 'connected'}`}
        </button>

        {heuristic && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setModelOpen(true)}>
            Connect a model
          </button>
        )}

        {staleCount > 0 && (
          <span className="chip chip--stale" title={`${staleCount} node(s) whose code changed`}>
            <IconAlert size={11} />
            {staleCount} stale
          </span>
        )}
      </div>

      <div className="header__group">
        <button
          type="button"
          className="btn"
          onClick={() => void refresh()}
          disabled={busy.refresh}
          title="Re-analyze the repo and diff it against the map"
        >
          <IconRefresh size={14} className={busy.refresh ? 'spin' : undefined} />
          {busy.refresh ? 'Refreshing…' : 'Refresh'}
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn"
            onClick={() => setPropsOpen((v) => !v)}
            title="Pending design proposals"
          >
            Proposals
            <span className={`badge-count${pending === 0 ? ' badge-count--muted' : ''}`}>{pending}</span>
          </button>
          {propsOpen && pending > 0 && (
            <>
              <div className="popover-backdrop" onClick={() => setPropsOpen(false)} />
              <div className="popover">
                <div className="popover__title">Pending proposals — approve before anything changes</div>
                {pendingProposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} />
                ))}
              </div>
            </>
          )}
        </div>

        <button type="button" className="btn btn--primary" onClick={() => setAddNodeOpen(true)}>
          <IconPlus size={14} />
          Add node
        </button>
      </div>

      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}
    </header>
  );
}

function ModelDialog({ onClose }: { onClose: () => void }) {
  const { config, saveConfig, project } = useStore();
  const [provider, setProvider] = useState<SyscodeConfig['provider']>(config?.provider ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(config?.maxContextTokens ?? 24000));
  const [saving, setSaving] = useState(false);

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

  const submit = async () => {
    setSaving(true);
    const tokens = Number.parseInt(maxTokens, 10);
    await saveConfig({
      provider,
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim() || undefined,
      ...(apiKey ? { apiKey } : {}),
      maxContextTokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 24000,
    });
    setSaving(false);
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Connect a model">
        <header className="dialog__head">
          <div className="grow">
            <div className="dialog__title">Connect a model</div>
            <div className="dialog__sub">
              Currently: {project?.brain.mode ?? 'unknown'} brain. A model reads the code facts and
              writes the meaning — grouping, naming and explanations.
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
              onChange={(e) => setProvider(e.target.value as SyscodeConfig['provider'])}
            >
              <option value="none">none — keep the heuristic map</option>
              <option value="openai-compatible">openai-compatible</option>
              <option value="anthropic">anthropic</option>
              <option value="ollama">ollama (local)</option>
            </select>
          </div>

          {provider !== 'none' && provider !== 'ollama' && (
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
                Written to .syscode/config.json on this machine and never echoed back to the
                interface.
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
              <label className="form-row__label" htmlFor="model-name">
                Model
              </label>
              <input
                id="model-name"
                className="input"
                placeholder="e.g. gpt-4o-mini"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>

          <div className="form-row">
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
