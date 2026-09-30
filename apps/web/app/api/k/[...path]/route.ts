import { apiUrl } from "@/lib/bff/auth";
import { cookieSecure } from "@/lib/bff/cookies";
import { trustedOrigins } from "@/lib/bff/origin";
import { proxyRequest } from "@/lib/bff/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxyRequest(req, path, {
    apiUrl: apiUrl(),
    secureCookies: cookieSecure(),
    trustedOrigins: trustedOrigins(),
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
