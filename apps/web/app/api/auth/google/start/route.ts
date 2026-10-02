import { apiUrl } from "@/lib/bff/auth";
import { cookieSecure } from "@/lib/bff/cookies";
import { startGoogleSignin } from "@/lib/bff/oauth";
import { trustedOrigins } from "@/lib/bff/origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return startGoogleSignin(req, { apiUrl: apiUrl(), secureCookies: cookieSecure(), trustedOrigins: trustedOrigins() });
}
