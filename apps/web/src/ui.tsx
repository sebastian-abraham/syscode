import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Small, self-contained UI state: the colour theme and whether the agent panel
 * is open. It lives outside the big store because none of it is project data —
 * nothing here should touch the engine or the map.
 *
 * The theme is written to <html data-theme> so a single attribute flips every
 * token in the stylesheet. `index.html` sets the same attribute before the
 * bundle loads (see the inline script there) so a reload never flashes the
 * wrong theme.
 */

export type Theme = 'dark' | 'light';

const THEME_KEY = 'syscode.theme';
const CHAT_KEY = 'syscode.chat-open';

function prefersLight(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: light)').matches;
}

function prefersNarrow(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 1024px)').matches;
}

/** The theme to start in: an explicit choice, else the OS preference. */
export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage can be unavailable (private mode, desktop webview) — fall through */
  }
  return prefersLight() ? 'light' : 'dark';
}

/** On a narrow shell the agent panel would cover the map, so it starts closed. */
function initialChatOpen(): boolean {
  try {
    const stored = localStorage.getItem(CHAT_KEY);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    /* ignore */
  }
  return !prefersNarrow();
}

type UiValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
};

const UiContext = createContext<UiValue | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => initialTheme());
  const [chatOpen, setChatOpenState] = useState<boolean>(() => initialChatOpen());

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    // Keep native form controls, scrollbars and the canvas's own colour-scheme in step.
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, chatOpen ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  }, [chatOpen]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(() => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')), []);
  const setChatOpen = useCallback((open: boolean) => setChatOpenState(open), []);
  const toggleChat = useCallback(() => setChatOpenState((open) => !open), []);

  const value = useMemo<UiValue>(
    () => ({ theme, setTheme, toggleTheme, chatOpen, setChatOpen, toggleChat }),
    [theme, setTheme, toggleTheme, chatOpen, setChatOpen, toggleChat],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used within <UiProvider>');
  return ctx;
}
