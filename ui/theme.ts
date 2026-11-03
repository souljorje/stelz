export type ThemePreference = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "stelz.ui.theme";
export const DARK_SCHEME = "(prefers-color-scheme: dark)";

export function themePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function readThemePreference(): ThemePreference {
  try { return themePreference(localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return "system"; }
}

export function applyTheme(preference: ThemePreference) {
  document.documentElement.dataset.theme = preference === "system"
    ? window.matchMedia(DARK_SCHEME).matches ? "dark" : "light"
    : preference;
}
