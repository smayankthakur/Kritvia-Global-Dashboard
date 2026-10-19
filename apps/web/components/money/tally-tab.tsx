"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Ledgers = Schemas["SyncSettings"];

/** The Tally companion: a small program on the Tally PC that syncs Tally and Kritvia every hour. */
export function TallyTab({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["tally-sync", ventureId];
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors/tally/sync", { params: { path: { venture_id: ventureId } } })) });
  const [made, setMade] = useState<Schemas["SyncKeyOut"] | null>(null);
  const [ledgers, setLedgers] = useState<Ledgers | null>(null);
  const make = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/connectors/tally/sync-key", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (k) => {
      setMade(k);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Couldn't make a key", errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (l: Ledgers) => unwrap(api.PUT("/ventures/{venture_id}/connectors/tally/ledgers", { params: { path: { venture_id: ventureId } }, body: l })),
    onSuccess: () => {
      toast.success("Ledger names saved");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Couldn't save", errorMessage(e)),
  });
  return (
    <QueryState query={q} loading={<SkeletonRows rows={3} className="p-3" />}>
      {(s: Schemas["SyncStatusOut"]) => {
        const l = ledgers ?? s.ledgers;
        const setL = (k: keyof Ledgers) => (e: { target: { value: string } }) => setLedgers({ ...l, [k]: e.target.value });
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Sync with Tally every hour"
                description="Tally has no online connection, so a small program on the PC that runs Tally does it: it sends Tally's Day Book to Kritvia and puts Kritvia's new invoices into Tally as Sales vouchers."
              />
              <CardBody className="space-y-3 text-sm">
                <p>
                  {s.has_key
                    ? s.last_sync
                      ? `Last sync ${formatRelative(s.last_sync)}.`
                      : "A sync key is set; the companion hasn't connected yet."
                    : "Not set up yet."}{" "}
                  {s.waiting_invoices ? `${s.waiting_invoices} invoice(s) are waiting to go into Tally.` : ""}
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-muted">
                  <li>In Tally: F1 Help → Settings → Connectivity → TallyPrime acts as Both, port 9000.</li>
                  <li>On that PC, install Python 3 (python.org) and download the two files below into one folder.</li>
                  <li>Make a sync key here and put the address and key in the .ini file (renamed to kritvia_tally_sync.ini).</li>
                  <li>
                    Run <code>python kritvia_tally_sync.py</code> once to try it, then add it to Windows Task Scheduler to run every hour.
                  </li>
                </ol>
                <div className="flex flex-wrap gap-2">
                  <ButtonLink href="/downloads/kritvia_tally_sync.py" download icon={<Download className="h-4 w-4" />}>
                    kritvia_tally_sync.py
                  </ButtonLink>
                  <ButtonLink href="/downloads/kritvia_tally_sync.example.ini" download icon={<Download className="h-4 w-4" />}>
                    kritvia_tally_sync.example.ini
                  </ButtonLink>
                  {canAdmin ? (
                    <Button variant="primary" loading={make.isPending} onClick={() => make.mutate()} icon={<KeyRound className="h-4 w-4" />}>
                      {s.has_key ? "Make a new sync key" : "Make a sync key"}
                    </Button>
                  ) : null}
                </div>
                {made ? (
                  <Notice tone="warning" title="Copy these now: the key is shown only once">
                    <div className="mt-2 space-y-2">
                      <CopyField label="hook_url" value={made.hook_url} />
                      <CopyField label="sync_key" value={made.key} secret />
                    </div>
                    {s.has_key ? <p className="mt-2 text-xs">The old key stopped working.</p> : null}
                  </Notice>
                ) : null}
              </CardBody>
            </Card>
            {canAdmin && s.connected ? (
              <Card>
                <CardHeader title="Tally ledger names" description="Kritvia's invoices are posted to these ledgers; they must exist in Tally with these exact names." />
                <CardBody>
                  <form
                    className="grid gap-3 sm:grid-cols-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      save.mutate(l);
                    }}
                  >
                    <Field label="Sales">
                      <Input value={l.sales_ledger ?? ""} onChange={setL("sales_ledger")} maxLength={100} />
                    </Field>
                    <Field label="CGST">
                      <Input value={l.cgst_ledger ?? ""} onChange={setL("cgst_ledger")} maxLength={100} />
                    </Field>
                    <Field label="SGST">
                      <Input value={l.sgst_ledger ?? ""} onChange={setL("sgst_ledger")} maxLength={100} />
                    </Field>
                    <Field label="IGST">
                      <Input value={l.igst_ledger ?? ""} onChange={setL("igst_ledger")} maxLength={100} />
                    </Field>
                    <Field label="Round off">
                      <Input value={l.round_off_ledger ?? ""} onChange={setL("round_off_ledger")} maxLength={100} />
                    </Field>
                    <div className="flex items-end">
                      <Button type="submit" loading={save.isPending}>
                        Save
                      </Button>
                    </div>
                  </form>
                </CardBody>
              </Card>
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}
