import { exchangeCredentials } from "@/lib/bff/auth";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return exchangeCredentials(req, "email/verify");
}
