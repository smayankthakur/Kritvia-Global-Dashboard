import { llmsTxt } from "@/lib/llms";

export const dynamic = "force-static";

/** GET /llms.txt — see lib/llms.ts. */
export function GET(): Response {
  return new Response(llmsTxt(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
