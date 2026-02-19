"use client";

import { useTheme } from "../lib/theme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="kv-theme-btn kv-topbar-icon-btn"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light theme" : "Dark theme"}
    >
      {isDark ? (
        <svg viewBox="0 0 24 24" className="kv-icon" aria-hidden>
          <path
            fill="currentColor"
            d="M6.76 4.84l-1.8-1.79L3.55 4.46l1.79 1.8l1.42-1.42Zm10.45-1.8l-1.79 1.8l1.42 1.42l1.8-1.79l-1.43-1.43ZM12 4h1V1h-2v3h1Zm7 9h3v-2h-3v2ZM4 11H1v2h3v-2Zm14.24 8.76l1.79 1.8l1.43-1.43l-1.8-1.79l-1.42 1.42ZM4.96 18.24l-1.79 1.79l1.43 1.43l1.79-1.8l-1.43-1.42ZM12 20h-1v3h2v-3h-1Zm0-14a6 6 0 1 0 0 12a6 6 0 0 0 0-12Z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="kv-icon" aria-hidden>
          <path
            fill="currentColor"
            d="M21 12.79A9 9 0 0 1 11.21 3a1 1 0 0 0-1.17-1A10 10 0 1 0 22 13.96a1 1 0 0 0-1-1.17Z"
          />
        </svg>
      )}
    </button>
  );
}
