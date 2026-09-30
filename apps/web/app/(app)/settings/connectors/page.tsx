"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { FullPageLoader } from "@/components/shell/gate";
import { useToast } from "@/components/ui/toast";
import { useAccess } from "@/lib/access";

const MESSAGES: Record<string, [ok: boolean, title: string, detail: string]> = {
  connected: [true, "Google connected", "Gmail, Calendar and Drive are now available to this venture's agents."],
  denied: [false, "Google connection cancelled", "Permission was not granted."],
  invalid_state: [false, "Google connection expired", "The sign-in link was too old or tampered with. Please try again."],
  exchange_failed: [false, "Google connection failed", "Google did not return a usable token. Please try again."],
  forbidden: [false, "Not allowed", "Only a venture admin or owner can connect Google."],
};

/** The Google OAuth callback lands here (?google=<result>&venture=<id>): toast, then go to that venture's settings. */
function ConnectorsCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { venture } = useAccess();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const result = params.get("google") ?? "";
    const msg = MESSAGES[result];
    if (msg) (msg[0] ? toast.success : toast.error)(msg[1], msg[2]);
    const target = params.get("venture") ?? venture?.venture_id;
    router.replace(target ? `/v/${target}/settings?tab=connectors` : "/");
  }, [params, router, toast, venture]);

  return <FullPageLoader label="Finishing connection" />;
}

export default function ConnectorsCallbackPage() {
  return (
    <Suspense>
      <ConnectorsCallback />
    </Suspense>
  );
}
