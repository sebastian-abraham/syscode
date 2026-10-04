import { useStore } from '../store.tsx';
import { IconX } from './icons.tsx';

export default function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className={`toast toast--${t.level}`} key={t.id}>
          <span className="toast__dot" />
          <span className="grow">{t.text}</span>
          <button
            type="button"
            className="close-x"
            style={{ width: 20, height: 20 }}
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
