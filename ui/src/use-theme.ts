import { useCallback, useEffect, useState } from "react";
import { applyTheme, DARK_SCHEME, readThemePreference, THEME_STORAGE_KEY, themePreference } from "./theme.ts";
import type { ThemePreference } from "./theme.ts";

export function useTheme() {
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => {
    applyTheme(preference);
    const media = window.matchMedia(DARK_SCHEME);
    const followSystem = () => { if (preference === "system") applyTheme(preference); };
    const followStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      const next = readThemePreference();
      applyTheme(next);
      setPreference(next);
    };
    media.addEventListener("change", followSystem);
    window.addEventListener("storage", followStorage);
    return () => {
      media.removeEventListener("change", followSystem);
      window.removeEventListener("storage", followStorage);
    };
  }, [preference]);
  const change = useCallback((value: ThemePreference) => {
    const next = themePreference(value);
    applyTheme(next);
    setPreference(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
  }, []);
  return { preference, change };
}
