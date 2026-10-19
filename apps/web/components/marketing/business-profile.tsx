"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { csrfHeaders } from "@/lib/bff/csrf";

/** Google connected with Business Profile access, and the listing chosen: review replies and posts then go to Google. */
export function BusinessProfileCard({
  ventureId,
  access,
  listing,
  canAdmin,
}: {
  ventureId: string;
  access: boolean;
  listing: string | null;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [choose, setChoose] = useState(false);
  const [picked, setPicked] = useState("");
  const locations = useQuery({
    queryKey: ["gbp-locations", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/business-profile/locations", { params: { path: { venture_id: ventureId } } })),
    enabled: choose && access,
    retry: false,
  });
  const connect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/oauth/google/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ venture_id: ventureId, business_profile: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; detail?: string };
      if (!res.ok || !body.url) throw new Error(body.detail ?? `HTTP ${res.status}`);
      return body.url;
    },
    onSuccess: (url) => window.location.assign(url),
    onError: (e) => toast.error("Can't connect Google", errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (name: string | null) => {
      const loc = locations.data?.find((l) => l.name === name);
      return unwrap(
        api.PUT("/ventures/{venture_id}/business-profile", {
          params: { path: { venture_id: ventureId } },
          body: { name, title: loc ? loc.title : null },
        }),
      );
    },
    onSuccess: () => {
      toast.success("Google listing saved");
      setChoose(false);
      void qc.invalidateQueries({ queryKey: ["social", ventureId] });
      void qc.invalidateQueries({ queryKey: ["reviews", ventureId] });
    },
    onError: (e) => toast.error("Couldn't save", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Store className="h-4 w-4 text-subtle" aria-hidden /> Google Business Profile
          </span>
        }
        description={
          listing
            ? `Replies to reviews and posts go to ${listing}, after your yes.`
            : "Link your Google listing so Kritvia can post review replies and updates there, after your yes."
        }
      />
      <CardBody className="space-y-3">
        {!access ? (
          canAdmin ? (
            <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate()}>
              Connect Google with Business Profile
            </Button>
          ) : (
            <p className="text-sm text-subtle">An admin can connect it.</p>
          )
        ) : canAdmin ? (
          choose ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Your listing" className="min-w-64">
                <Select value={picked} onChange={(e) => setPicked(e.target.value)} disabled={locations.isLoading}>
                  <option value="">{locations.isLoading ? "Reading your listings…" : "Choose…"}</option>
                  {(locations.data ?? []).map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.title}
                      {l.address ? ` (${l.address})` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" disabled={!picked} loading={save.isPending} onClick={() => save.mutate(picked)}>
                Use this listing
              </Button>
              <Button variant="ghost" onClick={() => setChoose(false)}>
                Cancel
              </Button>
              <FormError message={locations.error ? errorMessage(locations.error) : null} />
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setChoose(true)}>{listing ? "Change the listing" : "Choose your listing"}</Button>
              {listing ? (
                <Button variant="ghost" loading={save.isPending} onClick={() => save.mutate(null)}>
                  Unlink
                </Button>
              ) : null}
            </div>
          )
        ) : null}
        <p className="text-xs text-subtle">Google approves Kritvia for Business Profile once; until then replies stay drafts you copy into Google.</p>
      </CardBody>
    </Card>
  );
}
