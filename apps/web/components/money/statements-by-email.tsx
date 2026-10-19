"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Field, Input, Switch } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";

/** Bank statement emails read by themselves: from the business's Gmail, or forwarded to its Kritvia address. */
export function StatementsByEmail({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const settings = useQuery({
    queryKey: ["cash-settings", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/cash/settings", { params: { path: { venture_id: ventureId } } })),
  });
  const forwarding = useQuery({
    queryKey: ["email-forwarding", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors/email-forwarding", { params: { path: { venture_id: ventureId } } })),
  });
  const save = useMutation({
    mutationFn: (body: { statements_by_email?: boolean; statement_password?: string }) =>
      unwrap(
        api.PUT("/ventures/{venture_id}/cash/settings", {
          params: { path: { venture_id: ventureId } },
          body: { ...body, clear_alert: false, clear_balance: false },
        }),
      ),
    onSuccess: (d) => {
      qc.setQueryData(["cash-settings", ventureId], d);
      setPassword("");
    },
    onError: (e) => toast.error("Couldn't save it", errorMessage(e)),
  });
  const s = settings.data;
  const on = s?.statements_by_email ?? true;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-subtle" aria-hidden /> Statements by email
          </span>
        }
        description="When your bank emails the monthly statement, Kritvia reads it by itself, matches it and tells you. Nothing is recorded until you confirm."
        actions={<Badge tone={on ? "success" : "neutral"}>{on ? "on" : "off"}</Badge>}
      />
      <div className="space-y-3 p-4 text-sm">
        <div className="flex items-center gap-3">
          <Switch checked={on} disabled={!s || save.isPending} onChange={(v) => save.mutate({ statements_by_email: v })} label="Read statement emails from my bank" />
          <span aria-hidden className="text-sm">
            Read statement emails from my bank
          </span>
        </div>
        {forwarding.data ? (
          <>
            <p className="text-muted">
              With Gmail connected, nothing else is needed. Otherwise forward your bank&apos;s statement emails to this business&apos;s Kritvia address:
            </p>
            <CopyField label="Forward statements to" value={forwarding.data.address} />
          </>
        ) : (
          <p className="text-muted">
            Kritvia reads them from your connected Gmail, or from mail forwarded to this business&apos;s Kritvia address (
            <Link className="text-accent underline underline-offset-2" href={`/v/${ventureId}/settings?tab=connectors`}>
              Settings → Connectors
            </Link>
            ). Only emails from Indian banks&apos; own addresses count.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Statement PDF password"
            hint={
              s?.has_statement_password
                ? "Saved (it is never shown again). Type a new one to replace it."
                : "Most banks lock e-statements with a password, e.g. your customer ID. Kept encrypted; only used to open your statements."
            }
            className="w-72"
          >
            <Input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={64}
              disabled={!canAdmin}
              placeholder={s?.has_statement_password ? "••••••••" : ""}
            />
          </Field>
          <Button size="sm" disabled={!canAdmin || !password.trim()} loading={save.isPending} onClick={() => save.mutate({ statement_password: password })}>
            Save
          </Button>
          {s?.has_statement_password && canAdmin ? (
            <Button size="sm" variant="ghost" onClick={() => save.mutate({ statement_password: "" })}>
              Remove
            </Button>
          ) : null}
        </div>
        {!canAdmin ? <p className="text-xs text-subtle">Only the business&apos;s admins can set the password.</p> : null}
        <p className="text-xs text-subtle">
          A statement forwarded by email can&apos;t be checked for who really sent it, so its matches are never recorded all at once: confirm each against
          your bank.
        </p>
      </div>
    </Card>
  );
}
