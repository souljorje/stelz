import { applyTheme, readThemePreference } from "./theme";

// This small, same-origin script runs before the page can paint.
applyTheme(readThemePreference());
