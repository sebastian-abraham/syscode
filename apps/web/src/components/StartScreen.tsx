import { useState } from 'react';
import { useStore } from '../store.tsx';
import ModelDialog from './ModelDialog.tsx';
import { IconFolder, IconMap, IconPlus, IconSpark, IconX } from './icons.tsx';

/**
 * The app outside a project. Like an editor it opens here when no project is chosen:
 * recent projects, opening a folder, creating one, and connecting a model.
 */
export default function StartScreen() {
  const { workspace, defaultParentDir, busy, openProject, createProject, forgetProject, resumeCurrent, pickDirectory } =
    useStore();

  const [folderMode, setFolderMode] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [newTemplate, setNewTemplate] = useState<'typescript' | 'empty'>('typescript');
  const [createError, setCreateError] = useState<string | null>(null);

  const [modelOpen, setModelOpen] = useState(false);

  const current = workspace?.current ?? null;
  const recent = workspace?.recent ?? [];
  const parent = newParent || defaultParentDir;
  const brain = current?.brain;

  const beginOpenFolder = async () => {
    setOpenError(null);
    const picked = await pickDirectory();
    if (picked) {
      const res = await openProject(picked);
      if (!res.ok) setOpenError(res.error);
      return;
    }
    // No native picker in the browser — ask for the path instead of guessing one.
    setFolderMode(true);
  };

  const submitFolder = async () => {
    setOpenError(null);
    const res = await openProject(folderPath);
    if (!res.ok) setOpenError(res.error);
  };

  const submitNew = async () => {
    setCreateError(null);
    if (!newName.trim()) {
      setCreateError('Give the project a name.');
      return;
    }
    const res = await createProject({ name: newName.trim(), parentDir: parent.trim() || undefined, template: newTemplate });
    if (!res.ok) setCreateError(res.error);
  };

  const openRecent = async (path: string) => {
    setOpenError(null);
    const res = await openProject(path);
    if (!res.ok) setOpenError(res.error);
  };

  return (
    <div className="start">
      <div className="start__inner">
        <div className="start__brand">
          <span className="header__mark" aria-hidden="true">
            <IconMap size={14} />
          </span>
          <span className="start__brand-name">SysCode</span>
        </div>
        <p className="start__lead">
          An AI agent works on the software; a zoomable map of the system keeps you oriented. Open a
          project to see its map, or create one and let it grow.
        </p>

        <div className="start__grid">
          <section className="start__col">
            <div className="start__heading">Start</div>

            <button
              type="button"
              className="start-action"
              onClick={() => void beginOpenFolder()}
              disabled={busy.workspace}
            >
              <IconFolder size={15} />
              <span>
                <span className="start-action__title">Open a folder…</span>
                <span className="start-action__sub">Point SysCode at an existing project</span>
              </span>
            </button>

            <button type="button" className="start-action" onClick={() => setNewOpen((v) => !v)}>
              <IconPlus size={15} />
              <span>
                <span className="start-action__title">New project…</span>
                <span className="start-action__sub">Scaffold a project and start the map</span>
              </span>
            </button>

            {folderMode && (
              <div className="start-form">
                <label className="form-row__label" htmlFor="start-folder">
                  Folder to open
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    id="start-folder"
                    className="input grow"
                    placeholder="/absolute/path/to/project"
                    value={folderPath}
                    autoFocus
                    onChange={(e) => setFolderPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitFolder();
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void submitFolder()}
                    disabled={busy.workspace || !folderPath.trim()}
                  >
                    {busy.workspace ? 'Opening…' : 'Open'}
                  </button>
                </div>
                <div className="form-row__help">
                  The native folder picker is not available here, so type the path — SysCode never guesses one.
                </div>
                {openError && <div className="form-error">{openError}</div>}
              </div>
            )}

            {newOpen && (
              <div className="start-form">
                <div className="form-row">
                  <label className="form-row__label" htmlFor="start-name">
                    Project name
                  </label>
                  <input
                    id="start-name"
                    className="input"
                    placeholder="my-project"
                    value={newName}
                    autoFocus
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitNew();
                    }}
                  />
                </div>
                <div className="form-row">
                  <label className="form-row__label" htmlFor="start-parent">
                    Parent directory
                  </label>
                  <input
                    id="start-parent"
                    className="input"
                    placeholder={defaultParentDir || '/path/to/parent'}
                    value={newParent}
                    onChange={(e) => setNewParent(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  {defaultParentDir && <div className="form-row__help">Default: {defaultParentDir}</div>}
                </div>
                <div className="form-row">
                  <label className="form-row__label" htmlFor="start-template">
                    Template
                  </label>
                  <select
                    id="start-template"
                    className="select"
                    value={newTemplate}
                    onChange={(e) => setNewTemplate(e.target.value as 'typescript' | 'empty')}
                  >
                    <option value="typescript">typescript</option>
                    <option value="empty">empty</option>
                  </select>
                </div>
                {createError && <div className="form-error">{createError}</div>}
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <button type="button" className="btn btn--ghost" onClick={() => setNewOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void submitNew()}
                    disabled={busy.workspace || !newName.trim()}
                  >
                    {busy.workspace ? 'Creating…' : 'Create project'}
                  </button>
                </div>
              </div>
            )}

            {!folderMode && !newOpen && openError && <div className="form-error">{openError}</div>}

            <div className="start-model">
              <div className="start-model__row">
                <span className={`brain-badge brain-badge--${brain?.mode === 'model' ? 'model' : 'heuristic'}`}>
                  <IconSpark size={12} />
                  {brain?.mode === 'model' ? `Model · ${brain.model ?? brain.provider ?? 'connected'}` : 'No model connected'}
                </span>
                <button type="button" className="btn btn--sm" onClick={() => setModelOpen(true)}>
                  {brain?.mode === 'model' ? 'Change / test' : 'Connect a model'}
                </button>
              </div>
              <div className="start-model__hint">
                {brain?.mode === 'model'
                  ? 'The model names and explains the map; you can test the connection before trusting it.'
                  : 'Without a model the map is built by the deterministic mapper — everything still works.'}
              </div>
            </div>
          </section>

          <section className="start__col start__col--recents">
            <div className="start__heading">Recent projects</div>

            {current && (
              <div className="recent recent--current">
                <div className="recent__body">
                  <div className="recent__name">
                    {current.name}
                    <span className="recent__tag">open now</span>
                  </div>
                  <div className="recent__path mono">{current.root}</div>
                </div>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => void resumeCurrent()}
                  disabled={busy.workspace}
                >
                  {busy.workspace ? 'Opening…' : 'Open'}
                </button>
              </div>
            )}

            {recent.length === 0 ? (
              <div className="start__empty">
                SysCode is a living design map: an AI agent works on the software while a zoomable map
                of the system keeps you oriented. Open an existing folder or create a new project to
                begin — the map grows as you and the agent design the system.
              </div>
            ) : (
              recent.map((p) => (
                <div className={`recent${p.missing ? ' recent--missing' : ''}`} key={p.path}>
                  <button
                    type="button"
                    className="recent__body recent__body--button"
                    onClick={() => !p.missing && void openRecent(p.path)}
                    disabled={p.missing || busy.workspace}
                    title={p.missing ? 'This directory is gone' : `Open ${p.path}`}
                  >
                    <div className="recent__name">
                      {p.name}
                      {p.missing && <span className="recent__tag recent__tag--missing">missing</span>}
                    </div>
                    <div className="recent__path mono">{p.path}</div>
                  </button>
                  <button
                    type="button"
                    className="close-x"
                    style={{ width: 22, height: 22 }}
                    title="Remove from the list"
                    aria-label="Remove from the list"
                    onClick={() => void forgetProject(p.path)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))
            )}
          </section>
        </div>
      </div>

      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}
    </div>
  );
}
