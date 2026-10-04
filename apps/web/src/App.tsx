import { useEffect } from 'react';
import { StoreProvider, useStore } from './store.tsx';
import HeaderBar from './components/HeaderBar.tsx';
import Canvas from './components/Canvas.tsx';
import Inspector from './components/Inspector.tsx';
import ChatPanel from './components/ChatPanel.tsx';
import RefreshDialog from './components/RefreshDialog.tsx';
import AddNodeDialog from './components/AddNodeDialog.tsx';
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

function Waiting({ message, onRetry }: { message: string | null; onRetry: () => void }) {
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
          Start the engine in your project directory, then retry:
          <br />
          <span className="splash__code">npm run serve</span>
        </div>
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Retry connection
        </button>
      </div>
    </div>
  );
}
