import { redeem } from "@/lib/bff/link";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return redeem(req);
}
