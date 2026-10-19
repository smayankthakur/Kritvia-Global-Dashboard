"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BusinessProfileCard } from "@/components/marketing/business-profile";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const STATUS: Record<Schemas["PostOut"]["status"], { label: string; tone: Tone }> = {
  drafted: { label: "waiting for your yes", tone: "warning" },
  posted: { label: "posted", tone: "success" },
  partly_posted: { label: "posted in part", tone: "warning" },
  failed: { label: "not posted", tone: "danger" },
  dismissed: { label: "not posted (your no)", tone: "neutral" },
};

function FacebookCard({ ventureId, page, canAdmin }: { ventureId: string; page: string | null; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pageId, setPageId] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ["social", ventureId] });
  const connect = useMutation({
    mutationFn: () =>
      unwrap(api.PUT("/ventures/{venture_id}/connectors/facebook", { params: { path: { venture_id: ventureId } }, body: { page_id: pageId.trim(), page_token: token.trim() } })),
    onSuccess: (r) => {
      toast.success(`Connected ${r.page_name}`);
      setToken("");
      setErr(null);
      done();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/connectors/facebook", { params: { path: { venture_id: ventureId } } })),
    onSuccess: done,
  });
  return (
    <Card>
      <CardHeader title="Facebook Page" description={page ? `Posts go to ${page}, after your yes.` : "Connect your business's Facebook Page so posts can go there."} />
      <CardBody className="space-y-3">
        {page ? (
          canAdmin ? (
            <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
              Disconnect
            </Button>
          ) : null
        ) : canAdmin ? (
          <form
            className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              connect.mutate();
            }}
          >
            <Field label="Page ID" hint="Page → About → Page transparency">
              <Input value={pageId} onChange={(e) => setPageId(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={30} />
            </Field>
            <Field label="Page access token" hint="Meta Business Suite, with pages_manage_posts. Kept encrypted; never shown again.">
              <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} maxLength={1000} />
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" loading={connect.isPending} disabled={pageId.length < 5 || token.trim().length < 20}>
                Connect
              </Button>
            </div>
            <div className="sm:col-span-3">
              <FormError message={err} />
            </div>
          </form>
        ) : (
          <p className="text-sm text-subtle">An admin can connect it.</p>
        )}
      </CardBody>
    </Card>
  );
}

/** Where posts go, and the posts the Social agent wrote. */
export function SocialTab({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["social", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/social", { params: { path: { venture_id: ventureId } } })) });
  const now = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/social/draft-now", { params: { path: { venture_id: ventureId } } })),
    onSuccess: () => {
      toast.success("Post drafted", "It waits for your yes on the board.");
      void qc.invalidateQueries({ queryKey: ["social", ventureId] });
    },
    onError: (e) => toast.error("Couldn't write a post", errorMessage(e)),
  });
  return (
    <QueryState query={q} loading={<SkeletonRows rows={4} />}>
      {(d: Schemas["SocialOut"]) => (
        <div className="space-y-4">
          {!d.agent_on ? (
            <Notice tone="info" title="The Social posts agent is off">
              Switch on{" "}
              <Link href={`/v/${ventureId}/agents`} className="font-medium underline underline-offset-2">
                Social posts
              </Link>{" "}
              on the Agents page: on the days you choose it writes one post from your business and your offers, for your yes.
            </Notice>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <BusinessProfileCard ventureId={ventureId} access={d.google_business_access} listing={d.google_listing ?? null} canAdmin={canAdmin} />
            <FacebookCard ventureId={ventureId} page={d.facebook_page ?? null} canAdmin={canAdmin} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Posts</h2>
            <Button
              icon={<Megaphone className="h-4 w-4" />}
              loading={now.isPending}
              disabled={!Object.keys(d.channels).length}
              onClick={() => now.mutate()}
            >
              Write a post now
            </Button>
          </div>
          <Card className="overflow-hidden p-0">
            {d.posts.length ? (
              <ul className="divide-y divide-border" aria-label="Posts">
                {d.posts.map((p) => (
                  <li key={p.id} className="space-y-1 px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                      <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                      <span>{p.channels.map((c) => (c === "google" ? "Google" : "Facebook")).join(" + ")}</span>
                      <span>· {formatDateTime(p.posted_at ?? p.created_at)}</span>
                    </p>
                    <p className="text-sm whitespace-pre-line">{p.body}</p>
                    {Object.entries(p.results)
                      .filter(([, r]) => r && typeof r === "object" && "error" in (r as object))
                      .map(([ch, r]) => (
                        <p key={ch} className="text-xs text-danger">
                          {ch === "google" ? "Google" : "Facebook"}: {String((r as { error?: string }).error ?? "")}
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No posts yet" description="Connect where to post, switch the agent on, or press Write a post now." />
            )}
          </Card>
        </div>
      )}
    </QueryState>
  );
}
