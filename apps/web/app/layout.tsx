import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { THEME_COOKIE } from "@/lib/bff/cookies";
import { SITE_URL, share } from "@/lib/site";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Kritvia";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${APP_NAME} — AI Business OS`, template: `%s · ${APP_NAME}` },
  description: "Command center for Kritvia, the AI Business Operating System.",
  // Signed-in pages stay out of search; public pages opt in with INDEX (lib/site.ts).
  robots: { index: false, follow: false },
  ...share(),
  icons: { icon: "/icon.svg", apple: "/icons/apple-touch-icon.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: APP_NAME },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f1c" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  const cls = theme === "dark" ? "dark" : theme === "light" ? "light" : undefined;
  return (
    <html lang="en-IN" className={cls} suppressHydrationWarning>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
