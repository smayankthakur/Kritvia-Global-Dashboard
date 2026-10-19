"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Search, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BusinessProfileCard } from "@/components/marketing/business-profile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyButton, CopyField } from "@/components/ui/copy";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { useVenture } from "@/lib/venture";

type Data = Schemas["ReviewsOut"];

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex" role="img" aria-label={`${n} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-4 w-4 ${i <= n ? "fill-warning text-warning" : "text-border-strong"}`} aria-hidden />
      ))}
    </span>
  );
}

function FindListing({ ventureId, onPicked }: { ventureId: string; onPicked: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Schemas["PlaceHit"][] | null>(null);
  const find = useMutation({
    mutationFn: () => unwrap(api.GET("/ventures/{venture_id}/reviews/find-place", { params: { path: { venture_id: ventureId }, query: { q: q.trim() } } })),
    onSuccess: setHits,
    onError: (e) => toast.error("Couldn't search Google Maps", errorMessage(e)),
  });
  const pick = useMutation({
    mutationFn: (place_id: string) =>
      unwrap(api.PUT("/ventures/{venture_id}/review-settings", { params: { path: { venture_id: ventureId } }, body: { place_id, ask_after_booking: true, ask_after_payment: true } })),
    onSuccess: onPicked,
    onError: (e) => toast.error("Couldn't save", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader title="Find your business on Google Maps" description="Type its name and area as customers would search for it." />
      <form
        className="flex gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 3) find.mutate();
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Glow Salon FC Road Pune" maxLength={200} aria-label="Business name and area" />
        <Button type="submit" icon={<Search className="h-4 w-4" />} loading={find.isPending}>
          Search
        </Button>
      </form>
      {hits ? (
        <ul className="divide-y divide-border border-t border-border">
          {hits.map((h) => (
            <li key={h.place_id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                <span className="font-medium">{h.name}</span>
                <span className="block text-xs text-muted">
                  {h.address ?? ""} {h.rating ? `· ${h.rating}★ (${h.count ?? 0})` : ""}
                </span>
              </span>
              <Button size="sm" variant="primary" loading={pick.isPending} onClick={() => pick.mutate(h.place_id)}>
                This is us
              </Button>
            </li>
          ))}
          {!hits.length ? <li className="px-4 py-3 text-sm text-muted">Nothing found; try the name with the area.</li> : null}
        </ul>
      ) : null}
    </Card>
  );
}

function ReplyBox({ ventureId, review, mapsUrl }: { ventureId: string; review: Schemas["ReviewOut"]; mapsUrl: string | null | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(review.reply?.draft ?? "");
  const patch = useMutation({
    mutationFn: (b: Schemas["ReplyPatch"]) =>
      unwrap(api.PATCH("/ventures/{venture_id}/review-replies/{reply_id}", { params: { path: { venture_id: ventureId, reply_id: review.reply!.id } }, body: b })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reviews", ventureId] }),
  });
  const post = useMutation({
    mutationFn: async () => {
      if (text.trim() !== review.reply!.draft)
        await unwrap(api.PATCH("/ventures/{venture_id}/review-replies/{reply_id}", { params: { path: { venture_id: ventureId, reply_id: review.reply!.id } }, body: { draft: text.trim() } }));
      return unwrap(api.POST("/ventures/{venture_id}/review-replies/{reply_id}/post", { params: { path: { venture_id: ventureId, reply_id: review.reply!.id } } }));
    },
    onSuccess: () => {
      toast.success("Reply posted on Google");
      void qc.invalidateQueries({ queryKey: ["reviews", ventureId] });
    },
    onError: (e) => toast.error("Google didn't take it", errorMessage(e)),
  });
  if (!review.reply) return <p className="text-xs text-subtle">A reply is drafted at the agent&apos;s next daily run.</p>;
  if (review.reply.status !== "drafted") return <Badge tone={review.reply.status === "posted" ? "success" : "neutral"}>{review.reply.status === "posted" ? "replied on Google" : "no reply needed"}</Badge>;
  return (
    <div className="space-y-2">
      <Field label="Suggested reply (edit, copy, then post it in Google)">
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {review.reply.can_post ? (
          <Button size="sm" variant="primary" loading={post.isPending} disabled={!text.trim()} onClick={() => post.mutate()}>
            Post on Google
          </Button>
        ) : null}
        <CopyButton value={text} label="Copy reply" />
        {mapsUrl ? (
          <a className="inline-flex items-center gap-1 text-sm font-medium text-accent underline underline-offset-2" href={mapsUrl} target="_blank" rel="noreferrer">
            Reply on Google <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => patch.mutate({ draft: text.trim() || undefined, status: "posted" })}>
          I posted it
        </Button>
        <Button size="sm" variant="ghost" onClick={() => patch.mutate({ status: "dismissed" })}>
          No reply needed
        </Button>
      </div>
    </div>
  );
}

export default function ReviewsPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["reviews", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/reviews", { params: { path: { venture_id: v.id } } })),
  });
  const save = useMutation({
    mutationFn: (b: Schemas["ReviewSettings"]) => unwrap(api.PUT("/ventures/{venture_id}/review-settings", { params: { path: { venture_id: v.id } }, body: b })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reviews", v.id] }),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Google reviews"
        description="Ask happy customers for a review, and get a reply drafted for every new one. With your Google Business Profile linked, replies are posted on Google after your yes."
      />
      <QueryState query={q} loading={<SkeletonRows rows={4} />}>
        {(d: Data) => (
          <>
            {!d.agent_on ? (
              <Notice tone="info" title="The Google reviews agent is off">
                Switch it on on the{" "}
                <Link href={`/v/${v.id}/agents`} className="font-medium underline underline-offset-2">
                  Agents page
                </Link>{" "}
                so it checks your reviews and asks customers every day.
              </Notice>
            ) : null}
            {d.problem ? <Notice tone="warning" title="Google Maps can't be read">{d.problem}</Notice> : null}
            <BusinessProfileCard ventureId={v.id} access={d.business_access} listing={d.business_profile ?? null} canAdmin={d.can_edit} />
            {!d.settings.place_id ? (
              d.can_edit ? <FindListing ventureId={v.id} onPicked={() => void qc.invalidateQueries({ queryKey: ["reviews", v.id] })} /> : <EmptyState title="No Google listing chosen" description="An admin chooses it here." />
            ) : (
              <>
                {d.place ? (
                  <Card className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="text-lg font-semibold">{d.place.name}</p>
                        <p className="flex items-center gap-2 text-sm text-muted">
                          {d.place.rating ? <Stars n={Math.round(d.place.rating)} /> : null}
                          {d.place.rating ?? "—"} from {d.place.count ?? 0} reviews
                        </p>
                      </div>
                      <CopyField className="min-w-64 flex-1" label="Your review link (share it anywhere)" value={d.place.write_review_url} />
                    </div>
                    {d.can_edit ? (
                      <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3">
                        <Checkbox checked={d.settings.ask_after_booking} onChange={(e) => save.mutate({ ...d.settings, ask_after_booking: e.target.checked })} label="Ask after a booking is marked done" />
                        <Checkbox checked={d.settings.ask_after_payment} onChange={(e) => save.mutate({ ...d.settings, ask_after_payment: e.target.checked })} label="Ask after an invoice is paid" />
                      </div>
                    ) : null}
                  </Card>
                ) : null}
                <Card className="overflow-hidden p-0">
                  <CardHeader title="Latest reviews" description="The reviews Google shows first (up to five), read live from Google Maps." />
                  {d.reviews.length ? (
                    <ul className="divide-y divide-border">
                      {d.reviews.map((r, i) => (
                        <li key={i} className="space-y-2 px-4 py-4">
                          <p className="flex flex-wrap items-center gap-2 text-sm">
                            <Stars n={r.rating} /> <span className="font-medium">{r.author}</span> <span className="text-xs text-subtle">{r.when}</span>
                          </p>
                          {r.text ? <p className="text-sm whitespace-pre-line">{r.text}</p> : null}
                          <ReplyBox ventureId={v.id} review={r} mapsUrl={d.place?.maps_url} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title="No reviews to show" description="Share your review link with happy customers." />
                  )}
                </Card>
              </>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
