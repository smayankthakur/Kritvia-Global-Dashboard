"use client";

import { useTheme } from "../lib/theme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button type="button" onClick={toggleTheme} className="kv-theme-btn" aria-label="Toggle theme">
      {isDark ? "☀️ Light" : "🌙 Dark"}
    </button>
  );
}
