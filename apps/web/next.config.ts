import path from "node:path";
import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/** Headers for every response. The page Content-Security-Policy carries a per-request
 * nonce, so it is set in middleware.ts (see lib/csp.ts); API/BFF responses get a
 * deny-everything policy here because they never render HTML. */
const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  // The monorepo root, so the standalone trace includes workspace packages.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  // The app uses no next/image, so the image optimiser (/_next/image) is switched off: one less
  // public endpoint, and the one Next.js security advisories keep landing in.
  images: { unoptimized: true },
  async headers() {
    return [
      { source: "/:path*", headers: baseHeaders },
      // Meta's signup popup must be able to report back to the page that opened it, so only the
      // "Connect WhatsApp" page allows popups to keep their opener; every other page isolates fully.
      { source: "/:path((?!v/[^/]+/whatsapp-connect$).*)", headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }] },
      { source: "/v/:id/whatsapp-connect", headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] },
      {
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
