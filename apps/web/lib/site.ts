/** The public address of the web app, for canonical links, the sitemap and share previews. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://app.sitelytc.com").replace(/\/+$/, "");

/** Pages anyone may read and search engines may index. "/" serves the landing page to visitors. */
export const INDEXABLE = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/register", priority: 0.8, changeFrequency: "monthly" },
  { path: "/security", priority: 0.6, changeFrequency: "monthly" },
  { path: "/help", priority: 0.6, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.4, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.4, changeFrequency: "yearly" },
  { path: "/status", priority: 0.3, changeFrequency: "daily" },
] as const;

/** Signed-in areas and one-off links: never crawled. */
export const PRIVATE_PREFIXES = ["/api/", "/v/", "/upload/", "/invite", "/onboarding", "/account", "/inbox", "/settings", "/audit", "/billing"];

export const INDEX = { index: true, follow: true } as const;

const OG_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: "Kritvia — AI agents that draft; you approve" };

/** Share-preview metadata for WhatsApp, LinkedIn and X (a page's openGraph replaces the layout's whole). */
export function share(title?: string, description?: string, path?: string) {
  return {
    openGraph: { siteName: "Kritvia", locale: "en_IN", type: "website" as const, title, description, url: path, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image" as const, title, description, images: [OG_IMAGE.url] },
  };
}
