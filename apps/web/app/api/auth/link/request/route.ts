import { startRequest } from "@/lib/bff/link";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return startRequest(req);
}
