import { logout } from "@/lib/bff/auth";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return logout(req);
}
