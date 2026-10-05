"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MapPin, MessageCircle, Phone, Star } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { KeyValue } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { EMAIL_RE } from "@/lib/auth-client";
import { formatDateTime, formatRelative } from "@/lib/format";

type Lead = Schemas["LeadOut"];
type Action = Schemas["LeadOutreachIn"]["action"];

const ACTION_DONE: Record<Action, string> = {
  whatsapp_sent: "Marked as sent; the next follow-up is scheduled",
  replied: "Follow-ups stopped. Answer them from your phone or the Inbox",
  called: "Call logged",
  skip: "This message is skipped; follow-ups paused",
  resume: "Follow-ups restart at the next daily run",
  opt_out: "They won't be contacted again",
};

/** How the Prospector's outreach to this business stands, and what the owner can do next. */
export function outreachState(l: Lead): { label: string; tone: "accent" | "success" | "warning" | "neutral" | "danger" } {
  if (l.opted_out_at) return { label: "Opted out", tone: "danger" };
  if (l.replied_at) return { label: "Replied", tone: "success" };
  if (l.outreach_draft) return { label: "WhatsApp ready to send", tone: "warning" };
  if (l.next_touch_at) return { label: `Next message ${formatRelative(l.next_touch_at)}`, tone: "accent" };
  if (l.outreach_step) return { label: "Sequence finished", tone: "neutral" };
  return { label: "Not contacted", tone: "neutral" };
}

export const PLACEHOLDER_NAME = "Business on Google Maps";

/** The name to show: the business's own (saved after they replied), else Google Maps' live one. */
export function leadName(l: Lead): string {
  if (l.source === "prospector" && l.name === PLACEHOLDER_NAME) return l.place?.name ?? "Google Maps listing";
  return l.name;
}

export function ProspectPanel({ lead: listLead, ventureId }: { lead: Lead; ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Google lets Kritvia keep only the place ID, so the details are looked up live when the lead opens.
  const live = useQuery({
    queryKey: ["lead", ventureId, listLead.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/leads/{lead_id}", { params: { path: { venture_id: ventureId, lead_id: listLead.id } } })),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const lead = live.data ?? listLead;
  const place = live.data?.place ?? null;
  const [email, setEmail] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [contact, setContact] = useState<{ name: string; phone: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["leads", ventureId] });
    void qc.invalidateQueries({ queryKey: ["lead", ventureId, listLead.id] });
  };
  const act = useMutation({
    mutationFn: (action: Action) =>
      unwrap(api.POST("/ventures/{venture_id}/leads/{lead_id}/outreach", { params: { path: { venture_id: ventureId, lead_id: lead.id } }, body: { action } })),
    onSuccess: (_, action) => {
      toast.success(ACTION_DONE[action]);
      refresh();
    },
    onError: (e) => toast.error("Could not update", errorMessage(e)),
  });
  const patch = useMutation({
    mutationFn: (body: Schemas["LeadPatch"]) =>
      unwrap(api.PATCH("/ventures/{venture_id}/leads/{lead_id}", { params: { path: { venture_id: ventureId, lead_id: lead.id } }, body })),
    onSuccess: (_, body) => {
      toast.success(body.email ? "Email saved" : "Details saved", body.email ? "The Prospector writes to them by email from the next message." : undefined);
      setEmail("");
      setContact(null);
      refresh();
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });
  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    const v = email.trim();
    if (!EMAIL_RE.test(v)) return setEmailErr("Enter a valid email address");
    setEmailErr(null);
    patch.mutate({ email: v });
  };
  const state = outreachState(lead);
  const closed = Boolean(lead.opted_out_at);
  const phone = lead.phone ?? place?.phone ?? null;
  const tel = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : null;
  const unnamed = lead.name === PLACEHOLDER_NAME;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface-2 p-4" aria-label="Prospect">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Found on Google Maps</h3>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      {live.isPending ? (
        <p className="text-sm text-subtle">Looking the business up on Google Maps…</p>
      ) : live.data?.place_error ? (
        <p className="text-sm text-muted">Couldn&apos;t load the details from Google Maps right now ({live.data.place_error}).</p>
      ) : null}
      {place ? (
        <KeyValue
          items={[
            ["Name", place.name],
            ["Type", place.category ?? "—"],
            [
              "Rating",
              place.rating != null ? (
                <span className="inline-flex items-center gap-1">
                  <Star className="h-3.5 w-3.5 text-warning" aria-hidden /> {String(place.rating)} ({place.review_count ?? 0} reviews)
                </span>
              ) : (
                "—"
              ),
            ],
            ["Phone", place.phone ?? "—"],
            ["Address", place.address ?? "—"],
            ["Online today", place.website ? <span className="break-all">{place.website}</span> : "No website"],
          ]}
        />
      ) : null}
      <KeyValue
        items={[
          ["Search", lead.place_search ?? "—"],
          ["Messages sent", `${lead.outreach_step ?? 0}${lead.last_touch_at ? ` · last ${formatDateTime(lead.last_touch_at)} by ${lead.last_touch_channel}` : ""}`],
        ]}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {place?.maps_url ? (
          <a href={place.maps_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline">
            <MapPin className="h-3.5 w-3.5" aria-hidden /> Open in Google Maps
            <ExternalLink className="h-3 w-3" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        {place ? <span className="text-xs text-subtle">Business details: Google Maps</span> : null}
      </div>

      {lead.outreach_draft && !closed ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">WhatsApp message ready</p>
          <p className="rounded-md border border-border bg-surface p-3 text-sm whitespace-pre-wrap">{lead.outreach_draft}</p>
          <div className="flex flex-wrap gap-2">
            {lead.whatsapp_link ? (
              <a href={lead.whatsapp_link} target="_blank" rel="noreferrer" className={buttonClass("primary")}>
                <MessageCircle className="h-4 w-4" aria-hidden /> Open in WhatsApp
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
            <Button loading={act.isPending && act.variables === "whatsapp_sent"} onClick={() => act.mutate("whatsapp_sent")}>
              I sent it
            </Button>
            <Button variant="ghost" loading={act.isPending && act.variables === "skip"} onClick={() => act.mutate("skip")}>
              Skip
            </Button>
          </div>
          <p className="text-xs text-subtle">WhatsApp opens with the message filled in. Send it from your phone or WhatsApp Web, then tap “I sent it” so the follow-up is scheduled.</p>
        </div>
      ) : null}

      {!closed ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {tel ? (
            <a href={tel} className={buttonClass("secondary")}>
              <Phone className="h-4 w-4" aria-hidden /> Call {phone}
            </a>
          ) : null}
          <Button loading={act.isPending && act.variables === "called"} onClick={() => act.mutate("called")}>
            Log a call
          </Button>
          {!lead.replied_at ? (
            <Button loading={act.isPending && act.variables === "replied"} onClick={() => act.mutate("replied")}>
              They replied
            </Button>
          ) : null}
          {!lead.replied_at && !lead.next_touch_at && !lead.outreach_draft ? (
            <Button loading={act.isPending && act.variables === "resume"} onClick={() => act.mutate("resume")}>
              Restart follow-ups
            </Button>
          ) : null}
          <Button variant="ghost" className="ml-auto" loading={act.isPending && act.variables === "opt_out"} onClick={() => act.mutate("opt_out")}>
            They asked us to stop
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted">They asked not to be contacted{lead.opted_out_at ? ` (${formatDateTime(lead.opted_out_at)})` : ""}. The Prospector will never write to them again.</p>
      )}

      {lead.replied_at && unnamed && !closed ? (
        contact ? (
          <form
            className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (contact.name.trim()) patch.mutate({ name: contact.name.trim(), phone: contact.phone.trim() || null });
            }}
          >
            <Field label="Their name">
              <Input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} maxLength={200} />
            </Field>
            <Field label="Their number">
              <Input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} maxLength={30} inputMode="tel" />
            </Field>
            <Button type="submit" loading={patch.isPending} disabled={!contact.name.trim()}>
              Save
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
            <span className="text-muted">They replied. Save the name and number they gave you to keep them as a normal lead.</span>
            <Button size="sm" onClick={() => setContact({ name: place?.name ?? "", phone: place?.phone ?? "" })}>
              Save their details
            </Button>
          </div>
        )
      ) : null}

      {!lead.email && !closed ? (
        <form onSubmit={submitEmail} className="flex flex-wrap items-end gap-2" noValidate>
          <Field label="Found their email?" hint="The Prospector emails them from then on." error={emailErr ?? undefined} className="min-w-0 flex-1">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" autoComplete="off" />
          </Field>
          <Button type="submit" loading={patch.isPending}>
            Save email
          </Button>
        </form>
      ) : null}
    </section>
  );
}
