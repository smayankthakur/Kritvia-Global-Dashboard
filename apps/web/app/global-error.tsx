"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * The last line of defence: shown when the root layout itself fails (app/error.tsx only covers the pages
 * inside it). It replaces the whole document, so it brings its own <html> and <body> and leans on nothing
 * that could be what broke — no providers, no data, no icons library; inline styles back up the CSS.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en-IN">
      <body>
        <main
          id="main"
          className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center"
          style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 16, fontFamily: "system-ui, sans-serif", textAlign: "center" }}
        >
          <p className="text-sm font-semibold tracking-wider text-accent uppercase" style={{ margin: 0, letterSpacing: "0.08em" }}>
            Kritvia
          </p>
          <h1 className="text-lg font-semibold text-fg" style={{ margin: 0, fontSize: 20 }}>
            Something went wrong
          </h1>
          <p className="max-w-md text-sm text-muted" style={{ margin: 0, maxWidth: 420 }}>
            Kritvia couldn&apos;t load this page. Your data is safe; try again, or go back to the start.
            {error.digest ? ` Reference: ${error.digest}` : ""}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
              style={{ padding: "8px 16px", borderRadius: 8, border: 0, cursor: "pointer" }}
            >
              Try again
            </button>
            {/* A full page load (not a client-side link), because the app shell is what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="rounded-md border px-4 py-2 text-sm font-medium text-fg" style={{ padding: "8px 16px", borderRadius: 8 }}>
              Go to the start
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
