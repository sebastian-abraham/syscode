import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './store.tsx';
import HeaderBar from './components/HeaderBar.tsx';
import Canvas from './components/Canvas.tsx';
import Inspector from './components/Inspector.tsx';
import ChatPanel from './components/ChatPanel.tsx';
import RefreshDialog from './components/RefreshDialog.tsx';
import AddNodeDialog from './components/AddNodeDialog.tsx';
import RefineDialog from './components/RefineDialog.tsx';
import StartScreen from './components/StartScreen.tsx';
import Toasts from './components/Toasts.tsx';
import { IconMap } from './components/icons.tsx';

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const {
    status,
    screen,
    error,
    init,
    view,
    selected,
    refreshReport,
    addNodeOpen,
    setAddNodeOpen,
    closeRefreshReport,
    climbOut,
    clearSelection,
  } = useStore();

  // Esc climbs out of the current level (or closes a dialog first). Dialogs and
  // the inline connect form handle their own Esc in the capture phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (refreshReport) {
        closeRefreshReport();
        return;
      }
      if (addNodeOpen) {
        setAddNodeOpen(false);
        return;
      }
      if (view && !view.root) {
        void climbOut();
        return;
      }
      if (selected) clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    refreshReport,
    addNodeOpen,
    view,
    selected,
    closeRefreshReport,
    setAddNodeOpen,
    climbOut,
    clearSelection,
  ]);

  if (status === 'loading') return <Splash />;
  if (status === 'waiting') return <Waiting message={error} onRetry={init} />;

  // No project chosen yet: the app opens on the picker, like an editor.
  if (screen === 'start' || !view) {
    return (
      <>
        <StartScreen />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app">
      <HeaderBar />
      <div className="workspace">
        <Canvas />
        <Inspector />
        <ChatPanel />
      </div>
      <Toasts />
      <RefreshDialog />
      <AddNodeDialog />
      <RefineDialog />
    </div>
  );
}

function Splash() {
  return (
    <div className="splash">
      <div className="splash__inner">
        <div className="splash__brand">
          <IconMap size={18} />
          SysCode
        </div>
        <div className="splash__title">Connecting to the engine…</div>
        <div className="splash__text">Loading the living design map.</div>
        <span className="splash__spinner" />
      </div>
    </div>
  );
}

/// In the desktop shell the app can start the engine itself, so a failed start is
/// recoverable here: it reports what went wrong, and on success moves the window onto
/// the engine's own origin (which is what makes the API calls same-origin).
function DesktopStartEngine({ onStarted }: { onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const desktop = Boolean((window as unknown as { __SYSCODE_DESKTOP__?: boolean }).__SYSCODE_DESKTOP__);
  const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__
    ?.core?.invoke;
  if (!desktop || !invoke) return null;

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      const message = await invoke('start_engine', { project: null, port: null });
      setNote(String(message));
      // Move onto the engine's own origin: the embedded page lives on tauri://localhost,
      // which the engine's API does not answer cross-origin.
      const base = (window as unknown as { __SYSCODE_API_BASE__?: string }).__SYSCODE_API_BASE__;
      if (base) {
        window.location.replace(base);
        return;
      }
      onStarted();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="splash__desktop">
      <button type="button" className="btn btn--primary" onClick={() => void start()} disabled={busy}>
        {busy ? 'Starting the engine…' : 'Start the engine'}
      </button>
      {note ? <div className="splash__note">{note}</div> : null}
    </div>
  );
}

function Waiting({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  const desktop = Boolean((window as unknown as { __SYSCODE_DESKTOP__?: boolean }).__SYSCODE_DESKTOP__);
  return (
    <div className="splash">
      <div className="splash__inner">
        <div className="splash__brand">
          <IconMap size={18} />
          SysCode
        </div>
        <div className="splash__title">Waiting for the SysCode engine on :4317</div>
        <div className="splash__text">
          {message ? <>{message}. </> : null}
          {desktop ? (
            <>The engine was not reachable, but this app can start one.</>
          ) : (
            <>
              Start the engine in your project directory, then retry:
              <br />
              <span className="splash__code">npm run serve</span>
            </>
          )}
        </div>
        <DesktopStartEngine onStarted={onRetry} />
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Retry connection
        </button>
      </div>
    </div>
  );
}
