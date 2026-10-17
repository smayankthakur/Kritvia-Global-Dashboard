import { apiUrl } from "@/lib/bff/auth";
import { cookieSecure } from "@/lib/bff/cookies";
import { completeSso } from "@/lib/bff/oauth";
import { trustedOrigins } from "@/lib/bff/origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return completeSso(req, { apiUrl: apiUrl(), secureCookies: cookieSecure(), trustedOrigins: trustedOrigins() });
}
