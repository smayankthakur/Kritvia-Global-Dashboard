import { forwardAnonymous } from "@/lib/bff/auth";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return forwardAnonymous(req, "public/support");
}
