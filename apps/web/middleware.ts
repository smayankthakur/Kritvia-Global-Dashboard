import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/bff/cookies";
import { buildCsp, makeNonce } from "@/lib/csp";

const PUBLIC_PAGES = ["/welcome", "/login", "/register", "/forgot", "/terms", "/privacy", "/security", "/help", "/status"];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PAGES.includes(pathname) ||
    pathname.startsWith("/upload/") ||
    pathname.startsWith("/n/") ||
    pathname.startsWith("/api/")
  );
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(ACCESS_COOKIE)?.value || req.cookies.get(REFRESH_COOKIE)?.value);

  if (pathname === "/" && !hasSession) {
    // Logged-out visitors see the public landing page at the root URL.
    const url = req.nextUrl.clone();
    url.pathname = "/welcome";
    return withCsp(req, url);
  }
  if (!isPublicPath(pathname) && !hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (pathname.startsWith("/api/")) return NextResponse.next();

  return withCsp(req);
}

function withCsp(req: NextRequest, rewriteTo?: URL) {
  const nonce = makeNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = rewriteTo
    ? NextResponse.rewrite(rewriteTo, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|opengraph-image|manifest.webmanifest|sw.js|icons/|google4106eb9b04d0c769.html).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
