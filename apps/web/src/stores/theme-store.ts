import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ri-theme';

function readInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be blocked; fall back to the system preference.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not being able to persist the choice is fine.
  }
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  /** 'system' follows the operating system preference. */
  setPreference: (preference: Theme | 'system') => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const theme = readInitialTheme();
  apply(theme);
  return {
    theme,
    toggle: () => {
      const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
      apply(next);
      set({ theme: next });
    },
    setPreference: (preference) => {
      const next: Theme =
        preference === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : preference;
      apply(next);
      set({ theme: next });
    },
  };
});
