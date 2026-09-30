"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Switch, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime, formatPercent } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Trust = Schemas["TrustOut"];

function Progress({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / Math.max(1, max)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-label="Consecutive clean approvals"
      >
        <div className={`h-full ${pct >= 100 ? "bg-success" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs whitespace-nowrap text-muted tabular-nums">
        {value}/{max}
      </span>
    </div>
  );
}

export default function TrustPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["trust", v.id];
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/trust", { params: { path: { venture_id: v.id } } })) });
  const [target, setTarget] = useState<{ row: Trust; next: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const set = useMutation({
    mutationFn: ({ row, next }: { row: Trust; next: boolean }) =>
      unwrap(
        api.POST("/ventures/{venture_id}/trust/{agent}/{action}", {
          params: { path: { venture_id: v.id, agent: row.agent, action: row.action } },
          body: { auto_run: next, reason: reason.trim() },
        }),
      ),
    onSuccess: (rows) => {
      qc.setQueryData(key, rows);
      toast.success(target?.next ? "Auto-run enabled" : "Auto-run disabled");
      setTarget(null);
      setReason("");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) setErr(`Not earned yet: ${e.detail}`);
      else setErr(errorMessage(e));
    },
  });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Earned autonomy"
        description="An agent may run an action without asking only after a streak of approvals you didn't need to edit; any edit or rejection resets the streak."
      />
      <Card>
        <QueryState
          query={q}
          empty={<EmptyState icon={Sparkles} title="No track record yet" description="Rows appear once humans start deciding an agent's drafts in the inbox." />}
        >
          {(data) => (
            <Table label="Agent trust">
              <THead>
                <tr>
                  <Th>Agent · action</Th>
                  <Th className="hidden text-right md:table-cell">Approved</Th>
                  <Th className="hidden text-right md:table-cell">Edited</Th>
                  <Th className="hidden text-right md:table-cell">Rejected</Th>
                  <Th className="hidden text-right lg:table-cell">Auto-run</Th>
                  <Th>Clean streak</Th>
                  <Th className="hidden text-right sm:table-cell">Approval rate</Th>
                  <Th className="text-right">Auto-run</Th>
                </tr>
              </THead>
              <TBody>
                {data.map((t) => (
                  <Tr key={`${t.agent}/${t.action}`}>
                    <Td>
                      <span className="font-medium">{t.agent}</span>
                      <span className="block font-mono text-xs text-subtle">{t.action}</span>
                    </Td>
                    <Td className="hidden text-right tabular-nums md:table-cell">{t.approved_clean}</Td>
                    <Td className="hidden text-right tabular-nums md:table-cell">{t.edited}</Td>
                    <Td className="hidden text-right tabular-nums md:table-cell">{t.rejected}</Td>
                    <Td className="hidden text-right tabular-nums lg:table-cell">{t.auto_executed}</Td>
                    <Td>
                      <Progress value={t.consecutive_clean} max={t.threshold} />
                      {t.eligible && !t.auto_run ? <Badge tone="success" className="mt-1">eligible</Badge> : null}
                    </Td>
                    <Td className="hidden text-right tabular-nums sm:table-cell">{formatPercent(t.approval_rate)}</Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {t.auto_run && t.promoted_at ? <span className="hidden text-xs text-subtle xl:inline">since {formatDateTime(t.promoted_at)}</span> : null}
                        <Switch
                          checked={t.auto_run}
                          label={`Auto-run ${t.agent} ${t.action}`}
                          onChange={(next) => {
                            setErr(null);
                            setReason("");
                            setTarget({ row: t, next });
                          }}
                        />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
      <Dialog
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target?.next ? "Let this agent act without asking?" : "Require approval again?"}
        description={
          target
            ? target.next
              ? `${target.row.agent} will execute ${target.row.action} directly. Every execution is still audited, and any later rejection demotes it.`
              : `${target.row.agent}'s ${target.row.action} drafts will go back to the inbox.`
            : undefined
        }
        size="md"
        footer={
          <>
            <Button onClick={() => setTarget(null)}>Cancel</Button>
            <Button
              variant={target?.next ? "primary" : "danger"}
              loading={set.isPending}
              onClick={() => {
                if (reason.trim().length < 3) {
                  setErr("Give a reason (at least 3 characters) — it is written to the audit log");
                  return;
                }
                if (target) set.mutate(target);
              }}
            >
              {target?.next ? "Enable auto-run" : "Disable auto-run"}
            </Button>
          </>
        }
      >
        {target && target.next && !target.row.eligible ? (
          <Notice tone="warning" className="mb-3">
            This agent has {target.row.consecutive_clean} of {target.row.threshold} clean approvals. The server will refuse until the streak is earned.
          </Notice>
        ) : null}
        <FormError message={err} />
        <Field label="Reason" required className="mt-3">
          <Textarea rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 40 clean proposal emails in a row; reviewed samples." />
        </Field>
      </Dialog>
    </>
  );
}
