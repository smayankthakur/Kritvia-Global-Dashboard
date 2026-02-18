import { NextRequest, NextResponse } from "next/server";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/status/o/")) {
    return NextResponse.next();
  }

  const host = request.headers.get("host");
  if (!host) {
    return NextResponse.next();
  }

  try {
    const response = await fetch(`${API_BASE}/status/resolve-domain?host=${encodeURIComponent(host)}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      return NextResponse.next();
    }
    const payload = (await response.json()) as { orgSlug?: string | null };
    if (!payload.orgSlug) {
      return NextResponse.next();
    }

    let rewritePath = `/status/o/${payload.orgSlug}`;
    const suffix = pathname.replace(/^\/status\/?/, "");
    if (suffix.startsWith("incidents/")) {
      rewritePath = `/status/o/${payload.orgSlug}/${suffix}`;
    }
    if (suffix.length > 0 && !suffix.startsWith("incidents/")) {
      rewritePath = `/status/o/${payload.orgSlug}`;
    }

    const url = new URL(`${rewritePath}${search}`, request.url);
    return NextResponse.rewrite(url);
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/status", "/status/:path*"]
};
