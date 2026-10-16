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

const SLACK_MESSAGES: Record<string, [ok: boolean, title: string, detail: string]> = {
  connected: [true, "Kritvia is in your Slack", "Drafts that need your yes now come to you in Slack. Teammates can link theirs from Your account."],
  denied: [false, "Slack was not added", "Permission was not granted."],
  invalid_state: [false, "Adding Slack expired", "The link was too old or tampered with. Please try again."],
  exchange_failed: [false, "Adding Slack failed", "Slack did not finish. Please try again."],
  forbidden: [false, "Not allowed", "Only a business admin or owner can add Kritvia to Slack."],
};

/** The Google and Slack OAuth callbacks land here (?google|slack=<result>&venture=<id>): toast, then go to that venture's settings. */
function ConnectorsCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { venture } = useAccess();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const slack = params.get("slack");
    const msg = slack !== null ? SLACK_MESSAGES[slack] : MESSAGES[params.get("google") ?? ""];
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
