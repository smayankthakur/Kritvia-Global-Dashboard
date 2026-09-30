"use client";

import { useEffect, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { SearchX } from "lucide-react";
import { useAccess, useRouteVenture } from "@/lib/access";

export default function VentureLayout({ children }: { children: ReactNode }) {
  const venture = useRouteVenture();
  const { rememberVenture } = useAccess();
  const id = venture?.venture_id;
  useEffect(() => {
    if (id) rememberVenture(id);
  }, [id, rememberVenture]);

  if (!venture) {
    return (
      <EmptyState
        icon={SearchX}
        title="Venture not found, or you don't have access"
        description="Each venture is a hard data boundary. Ask an owner for a grant if you need to see this one."
        action={<ButtonLink href="/">Back to dashboard</ButtonLink>}
      />
    );
  }
  return <>{children}</>;
}
