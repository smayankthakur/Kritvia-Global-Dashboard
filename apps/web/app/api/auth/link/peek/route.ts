import { peek } from "@/lib/bff/link";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return peek(req);
}
