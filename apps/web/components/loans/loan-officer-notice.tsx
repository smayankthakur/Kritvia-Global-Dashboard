import { Lock } from "lucide-react";
import Link from "next/link";
import { Notice } from "@/components/ui/page";

export function LoanOfficerNotice({ ventureId, roles }: { ventureId: string; roles: string[] }) {
  if (roles.includes("loan_officer")) {
    return (
      <p className="mb-4 flex items-center gap-1.5 text-xs text-subtle">
        <Lock className="h-3.5 w-3.5" aria-hidden /> Loan files are restricted to the loan officer role and processed by local models only.
      </p>
    );
  }
  return (
    <Notice tone="warning" title="Loan officer role required" className="mb-4">
      Only people with the loan_officer role in this venture can see or create loan applications — this list will stay empty for
      you. An owner can add the role under{" "}
      <Link href={`/v/${ventureId}/settings`} className="font-medium underline">
        Settings → Members
      </Link>
      .
    </Notice>
  );
}

