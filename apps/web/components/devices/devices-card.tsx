"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { SkeletonRows, QueryState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { InstallApp } from "./install-app";
import { OpenOnPhone } from "./open-on-phone";

const key = ["me", "sessions"] as const;
const PHONE = /Android|iPhone|iPad/;

/** Your account: open Kritvia on your phone with a QR, install it as an app, and see/sign out devices. */
export function DevicesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/auth/sessions")) });
  const end = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/auth/sessions/{family_id}", { params: { path: { family_id: id } } })),
    onSuccess: () => {
      toast.success("Signed out", "That device is signed out now.");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Couldn't sign it out", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Your phone and other devices"
        description="Scan a QR code to open Kritvia on your phone without typing a password, then add it to your home screen."
        actions={<OpenOnPhone />}
      />
      <div className="space-y-3 p-4 pt-0">
        <InstallApp />
        <QueryState query={q} loading={<SkeletonRows rows={2} />}>
          {(rows: Schemas["SessionOut"][]) => (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {rows.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {PHONE.test(s.device) ? <Smartphone className="h-4 w-4 shrink-0 text-subtle" aria-hidden /> : <Laptop className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {s.device}
                        {s.this_device ? <Badge tone="accent">this device</Badge> : null}
                      </p>
                      <p className="text-xs text-muted">
                        Signed in {formatRelative(s.signed_in_at)} · last active {formatRelative(s.last_seen_at)}
                      </p>
                    </div>
                  </div>
                  {s.this_device ? null : (
                    <Button size="sm" variant="ghost" loading={end.isPending && end.variables === s.id} onClick={() => end.mutate(s.id)}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </div>
    </Card>
  );
}
