"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ChoiceCards } from "@/components/ui/choice-cards";
import { Notice, PageHeader } from "@/components/ui/page";
import { SkeletonRows } from "@/components/ui/states";
import { WhatsAppTokenForm } from "@/components/whatsapp/token-form";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { loadFacebookSdk, runSignup, type SignupMode } from "@/lib/meta-signup";
import { useVenture } from "@/lib/venture";

type Connected = Schemas["WhatsAppConnectOut"];

const MODES: { id: SignupMode; title: string; text: string }[] = [
  {
    id: "business_app",
    title: "The number on my WhatsApp Business app",
    text: "Keeps working in the app on your phone. You scan a QR code in the app to finish.",
  },
  {
    id: "new_number",
    title: "A new number",
    text: "A number not on any WhatsApp app yet. Meta checks it with a code by SMS or call.",
  },
];

/** "Connect WhatsApp": the owner logs in with Facebook in Meta's own window and picks their number.
 * The one page allowed to run Meta's signup (its CSP and COOP admit Meta; see lib/csp.ts). Opened
 * with a full page load from Settings → Connectors and the WhatsApp page. */
export default function WhatsAppConnectPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  const [stage, setStage] = useState<"idle" | "window" | "saving">("idle");
  const [done, setDone] = useState<Connected | null>(null);
  const [mode, setMode] = useState<SignupMode>("business_app");
  const cfg = useQuery({
    queryKey: ["whatsapp-signup", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors/whatsapp/signup", { params: { path: { venture_id: v.id } } })),
  });
  const current = useQuery({
    queryKey: ["connectors", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors", { params: { path: { venture_id: v.id } } })),
  });
  const wa = current.data?.find((c) => c.provider === "whatsapp" && c.status === "active");
  // Load Facebook's script as soon as the page knows it can, so the tap opens Meta's window at once;
  // a window opened after a wait is blocked as a pop-up on phones.
  useEffect(() => {
    if (cfg.data?.ready) void loadFacebookSdk(cfg.data).catch(() => undefined);
  }, [cfg.data]);

  const connect = useMutation({
    mutationFn: async () => {
      const c = cfg.data!;
      setStage("window");
      await loadFacebookSdk(c);
      const r = await runSignup(c, mode);
      setStage("saving");
      return unwrap(
        api.POST("/ventures/{venture_id}/connectors/whatsapp/signup", {
          params: { path: { venture_id: v.id } },
          body: { code: r.code, waba_id: r.wabaId, phone_number_id: r.phoneNumberId, business_app: r.businessApp },
        }),
      );
    },
    onSuccess: (out) => finished(out),
    onSettled: () => setStage("idle"),
  });
  const finished = (out: Connected) => {
    setDone(out);
    void qc.invalidateQueries({ queryKey: ["connectors", v.id] });
    void qc.invalidateQueries({ queryKey: ["whatsapp", v.id] });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        eyebrow={v.venture_name}
        title="Connect WhatsApp"
        description="Customers message your business number on WhatsApp; Kritvia drafts each reply and sends it once you approve."
      />
      {!canAdmin ? <Notice tone="warning">Only the business&apos;s admins can connect WhatsApp.</Notice> : null}

      {done ? (
        <Card>
          <div className="space-y-3 p-5">
            <p className="flex items-center gap-2 text-lg font-semibold">
              <CheckCircle2 className="h-5 w-5 text-success" aria-hidden /> WhatsApp is connected
            </p>
            <p className="text-sm text-muted">
              {done.display_phone_number ?? "Your number"}
              {done.verified_name ? ` (${done.verified_name})` : ""} is ready. New customer messages will show up on the WhatsApp page with a reply
              drafted for you.
            </p>
            <div className="flex flex-wrap gap-2">
              <ButtonLink href={`/v/${v.id}/whatsapp`} variant="primary">
                Open WhatsApp chats
              </ButtonLink>
              <ButtonLink href={`/v/${v.id}/settings?tab=connectors`}>Back to settings</ButtonLink>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-subtle" aria-hidden /> Your WhatsApp Business number
              </span>
            }
            description={wa ? `Connected: ${wa.account_email ?? "a number"}. Connect again to switch to another number.` : "Takes about 2 minutes."}
          />
          <div className="space-y-4 p-4">
            {cfg.isPending ? <SkeletonRows rows={2} /> : null}
            {cfg.data && !cfg.data.ready ? (
              <Notice tone="warning" title="Not switched on yet">
                WhatsApp sign-up isn&apos;t set up on this Kritvia server yet. Please ask Kritvia support to switch it on.
              </Notice>
            ) : null}
            {cfg.data?.ready ? (
              <>
                <ChoiceCards
                  label="Which number?"
                  options={MODES}
                  value={mode}
                  onChange={(o) => setMode(o.id)}
                  className="grid gap-2 sm:grid-cols-2"
                  cardClassName={(checked) =>
                    `rounded-lg border p-3 text-left transition-[border-color,background-color] duration-150 ${
                      checked ? "border-accent bg-accent/5 ring-1 ring-accent" : "border-border hover:border-border-strong hover:bg-surface-2"
                    }`
                  }
                  render={(o, checked) => (
                    <span className="block text-left">
                      <span className={`block text-sm font-medium ${checked ? "text-fg" : "text-muted"}`}>{o.title}</span>
                      <span className="mt-0.5 block text-xs text-subtle">{o.text}</span>
                    </span>
                  )}
                />
                <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                  <li>Click the button and log in with Facebook in the window that opens.</li>
                  {mode === "business_app" ? (
                    <li>
                      Choose your business, then open the <strong>WhatsApp Business app</strong> on your phone and scan the QR code Meta shows. Your chats
                      stay on the phone; new ones also arrive here.
                    </li>
                  ) : (
                    <li>Choose your business and add the new number. Meta sends a code by SMS or call to check it.</li>
                  )}
                </ol>
                {connect.isError ? <Notice tone="danger">{errorMessage(connect.error)}</Notice> : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    icon={<MessageCircle className="h-4 w-4" />}
                    loading={connect.isPending}
                    disabled={!canAdmin}
                    onClick={() => connect.mutate()}
                  >
                    {wa ? "Connect again" : "Connect WhatsApp"}
                  </Button>
                  <span className="text-sm text-muted" role="status">
                    {stage === "window" ? "Finish the steps in the Facebook window…" : stage === "saving" ? "Setting up your number…" : ""}
                  </span>
                </div>
                <p className="text-xs text-subtle">
                  Meta charges for some WhatsApp messages; replies within 24 hours of a customer&apos;s message are free. Meta may ask you to add a payment
                  method in WhatsApp Manager.
                </p>
              </>
            ) : null}
            <details className="rounded-md border border-border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Advanced: connect with a token</summary>
              <div className="pt-3">
                {canAdmin ? <WhatsAppTokenForm ventureId={v.id} onDone={finished} /> : null}
              </div>
            </details>
          </div>
        </Card>
      )}
    </div>
  );
}
