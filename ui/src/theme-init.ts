import { applyTheme, readThemePreference } from "./theme.ts";

// This small, same-origin script runs before the page can paint.
applyTheme(readThemePreference());
