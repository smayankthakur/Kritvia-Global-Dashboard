"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { rupees } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { StatementsByEmail } from "./statements-by-email";

type State = "suggested" | "unmatched" | "confirmed" | "ignored";
type Line = Schemas["LineOut"];

function Amount({ paise }: { paise: number }) {
  return (
    <span className={`font-semibold tabular-nums ${paise > 0 ? "text-success" : ""}`}>
      {paise > 0 ? "+" : "−"}
      {rupees(Math.abs(paise))}
    </span>
  );
}

/** Upload a bank statement; Kritvia matches credits to invoices and debits to bills, and a person confirms. */
export function BankTab({ ventureId, canWrite, canAdmin }: { ventureId: string; canWrite: boolean; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [state, setState] = useState<State>("suggested");
  const lines = useQuery({
    queryKey: ["bank-lines", ventureId, state],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/bank/lines", { params: { path: { venture_id: ventureId }, query: { state } } })),
  });
  const statements = useQuery({
    queryKey: ["bank-statements", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/bank/statements", { params: { path: { venture_id: ventureId } } })),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["bank-lines", ventureId] });
    void qc.invalidateQueries({ queryKey: ["bank-statements", ventureId] });
    void qc.invalidateQueries({ queryKey: ["invoices", ventureId] });
    void qc.invalidateQueries({ queryKey: ["bills", ventureId] });
  };
  const upload = useMutation({
    mutationFn: (file: File) =>
      unwrap(
        api.POST("/ventures/{venture_id}/bank/statements", {
          params: { path: { venture_id: ventureId } },
          body: multipart<Schemas["Body_upload_statement_ventures__venture_id__bank_statements_post"]>({
            file,
            account_label: label.trim() || null,
          }),
        }),
      ),
    onSuccess: (u) => {
      toast.success(
        `${u.new_lines} new line${u.new_lines === 1 ? "" : "s"} read`,
        `${u.sure} sure match${u.sure === 1 ? "" : "es"}, ${u.likely} likely${u.already_seen ? `; ${u.already_seen} were already here` : ""}`,
      );
      setState("suggested");
      refresh();
    },
    onError: (e) => toast.error("Couldn't read the statement", errorMessage(e)),
  });
  const confirmSure = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/bank/confirm-sure", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (r) => {
      toast.success(`${r.confirmed} payment${r.confirmed === 1 ? "" : "s"} recorded`, `${r.paid_invoices} invoice(s), ${r.paid_bills} bill(s)`);
      refresh();
    },
    onError: (e) => toast.error("Couldn't record them", errorMessage(e)),
  });
  const act = useMutation({
    mutationFn: ({ line, what }: { line: Line; what: "confirm" | "ignore" | "reset" }) =>
      what === "confirm"
        ? unwrap(
            api.POST("/ventures/{venture_id}/bank/lines/{line_id}/confirm", {
              params: { path: { venture_id: ventureId, line_id: line.id } },
              body: {},
            }),
          )
        : what === "ignore"
          ? unwrap(api.POST("/ventures/{venture_id}/bank/lines/{line_id}/ignore", { params: { path: { venture_id: ventureId, line_id: line.id } } }))
          : unwrap(api.POST("/ventures/{venture_id}/bank/lines/{line_id}/reset", { params: { path: { venture_id: ventureId, line_id: line.id } } })),
    onSuccess: () => refresh(),
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  const [matching, setMatching] = useState<Line | null>(null);
  const [takeBack, setTakeBack] = useState<Line | null>(null);
  const counts = lines.data?.counts ?? {};
  const last = statements.data?.[0];

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Card className="space-y-3 p-4">
          <p className="text-sm text-muted">
            Download the statement from your netbanking as CSV or Excel (best) or PDF, and upload it here. Kritvia matches each credit to an
            unpaid invoice and each debit to a supplier bill. Nothing is recorded until you confirm. Uploading an overlapping period again is
            safe: lines already here are skipped.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Account (optional)" className="w-56">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. HDFC current" maxLength={80} />
            </Field>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              aria-label="Bank statement file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
            <Button variant="primary" loading={upload.isPending} onClick={() => fileRef.current?.click()} icon={<FileUp className="h-4 w-4" />}>
              Upload a statement
            </Button>
          </div>
          {last ? (
            <p className="text-xs text-subtle">
              {`Last statement${last.source === "email" ? ` (by email from ${last.sender ?? "the bank"})` : ""}: ${last.account_label ? `${last.account_label}, ` : ""}${
                last.period_from ? `${formatDate(last.period_from)} to ${formatDate(last.period_to)}` : "no dates"
              } (${last.lines} lines)`}
            </p>
          ) : null}
        </Card>
      ) : null}
      {canWrite ? <StatementsByEmail ventureId={ventureId} canAdmin={canAdmin} /> : null}
      {lines.data && lines.data.sure > 0 && canWrite ? (
        <Notice tone="success" title={`${lines.data.sure} sure match${lines.data.sure === 1 ? "" : "es"}`}>
          The amount is exactly what is owed and the narration names the customer, supplier, invoice number or UPI reference.
          <div className="mt-2">
            <Button size="sm" variant="primary" loading={confirmSure.isPending} onClick={() => confirmSure.mutate()} icon={<CheckCheck className="h-4 w-4" />}>
              Record all {lines.data.sure}
            </Button>
          </div>
        </Notice>
      ) : null}
      <Card className="p-4">
        <StatGrid>
          <Stat label="Matched, waiting for you" value={counts.suggested ?? 0} />
          <Stat label="Not matched" value={counts.unmatched ?? 0} />
          <Stat label="Recorded" value={counts.confirmed ?? 0} tone="success" />
        </StatGrid>
      </Card>
      <Tabs
        label="Statement lines"
        value={state}
        onChange={(s) => setState(s as State)}
        items={[
          { id: "suggested", label: "Matched" },
          { id: "unmatched", label: "Not matched" },
          { id: "confirmed", label: "Recorded" },
          { id: "ignored", label: "Ignored" },
        ]}
      />
      <Card className="overflow-hidden p-0">
        <QueryState query={lines} loading={<SkeletonRows rows={4} className="p-3" />}>
          {(d: Schemas["LinesOut"]) =>
            d.lines.length ? (
              <ul className="divide-y divide-border" aria-label="Statement lines">
                {d.lines.map((l) => (
                  <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3">
                    <span className="min-w-0 truncate text-sm" title={l.narration}>
                      {l.narration}
                    </span>
                    <Amount paise={l.amount_paise} />
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                      <span>{formatDate(l.line_date)}</span>
                      {l.match ? (
                        <span>
                          → {l.match.kind === "invoice" ? "Invoice" : "Bill"} {l.match.number ? `${l.match.number}, ` : ""}
                          {l.match.party} ({rupees(l.match.balance_paise)} {l.state === "confirmed" ? "left" : "owed"})
                        </span>
                      ) : null}
                      {l.match?.confidence && l.state === "suggested" ? (
                        <Badge tone={l.match.confidence === "sure" ? "success" : "warning"}>{l.match.confidence}</Badge>
                      ) : null}
                      {l.unverified && l.state !== "confirmed" ? (
                        <Badge tone="warning" title="This came in a forwarded statement email, which Kritvia can't verify">
                          check with your bank
                        </Badge>
                      ) : null}
                    </span>
                    {canWrite ? (
                      <span className="flex justify-end gap-1">
                        {l.state === "suggested" ? (
                          <Button size="sm" variant="primary" onClick={() => act.mutate({ line: l, what: "confirm" })}>
                            Record
                          </Button>
                        ) : null}
                        {l.state === "suggested" || l.state === "unmatched" ? (
                          <>
                            <Button size="sm" variant={l.state === "unmatched" ? "primary" : "ghost"} onClick={() => setMatching(l)}>
                              {l.state === "unmatched" ? "Match to…" : "Another…"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => act.mutate({ line: l, what: "ignore" })}>
                              Ignore
                            </Button>
                          </>
                        ) : null}
                        {l.state === "confirmed" ? (
                          <Button size="sm" variant="ghost" onClick={() => setTakeBack(l)}>
                            Take back
                          </Button>
                        ) : null}
                        {l.state === "ignored" ? (
                          <Button size="sm" variant="ghost" onClick={() => act.mutate({ line: l, what: "reset" })}>
                            Bring back
                          </Button>
                        ) : null}
                      </span>
                    ) : (
                      <span />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title={state === "suggested" ? "Nothing waiting" : "No lines here"}
                description={
                  state === "suggested"
                    ? "Upload a statement, or add the invoices and bills it pays and press Match again on the Not matched tab."
                    : "Try another tab."
                }
              />
            )
          }
        </QueryState>
      </Card>
      {matching ? (
        <MatchDialog
          ventureId={ventureId}
          line={matching}
          onClose={() => setMatching(null)}
          onDone={() => {
            setMatching(null);
            refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={takeBack !== null}
        onClose={() => setTakeBack(null)}
        onConfirm={() =>
          takeBack &&
          act.mutate(
            { line: takeBack, what: "reset" },
            {
              onSuccess: () => {
                setTakeBack(null);
                toast.success("Taken back", "The payment is off the invoice or bill, and the line can be matched again.");
              },
            },
          )
        }
        loading={act.isPending}
        title="Take back this payment?"
        description={
          takeBack?.match
            ? `${rupees(Math.abs(takeBack.amount_paise))} comes off ${takeBack.match.kind === "invoice" ? "invoice" : "bill"} ${takeBack.match.number ?? ""} (${takeBack.match.party}), which is owed again. The line goes back to Not matched.`
            : "The payment comes off the invoice or bill, and the line goes back to Not matched."
        }
        confirmLabel="Take it back"
      />
      {state === "unmatched" && canWrite && (counts.unmatched ?? 0) > 0 ? (
        <RematchButton ventureId={ventureId} onDone={refresh} />
      ) : null}
    </div>
  );
}

function RematchButton({ ventureId, onDone }: { ventureId: string; onDone: () => void }) {
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/bank/rematch", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (r) => {
      toast.success(`${r.sure} sure, ${r.likely} likely`);
      onDone();
    },
    onError: (e) => toast.error("Couldn't match", errorMessage(e)),
  });
  return (
    <Button variant="ghost" loading={m.isPending} onClick={() => m.mutate()}>
      Match again (after adding invoices or bills)
    </Button>
  );
}

/** Point a line at the invoice (a credit) or bill (a debit) it really pays, when the narration didn't say. */
function MatchDialog({ ventureId, line, onClose, onDone }: { ventureId: string; line: Line; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const credit = line.amount_paise > 0;
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = useQuery({
    queryKey: ["bank-match-options", ventureId, credit],
    queryFn: async () =>
      credit
        ? (await unwrap(api.GET("/ventures/{venture_id}/invoices", { params: { path: { venture_id: ventureId }, query: { show: "open" } } }))).invoices.map(
            (i) => ({ id: i.id, label: `${i.customer_name}${i.number ? ` · ${i.number}` : ""} · ${rupees(i.balance_paise)} owed` }),
          )
        : (await unwrap(api.GET("/ventures/{venture_id}/bills", { params: { path: { venture_id: ventureId }, query: { show: "open" } } }))).bills.map((b) => ({
            id: b.id,
            label: `${b.vendor}${b.number ? ` · ${b.number}` : ""} · ${rupees(b.balance_paise)} to pay`,
          })),
  });
  const record = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/bank/lines/{line_id}/confirm", {
          params: { path: { venture_id: ventureId, line_id: line.id } },
          body: { match_kind: credit ? "invoice" : "bill", match_id: choice },
        }),
      ),
    onSuccess: () => {
      toast.success("Recorded", credit ? "The payment is on the invoice." : "The payment is on the bill.");
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={credit ? "Which invoice does this pay?" : "Which bill does this pay?"}
      description={`${formatDate(line.line_date)} · ${rupees(Math.abs(line.amount_paise))} · ${line.narration}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!choice} loading={record.isPending} onClick={() => record.mutate()}>
            Record
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <QueryState query={options} loading={<SkeletonRows rows={2} />}>
          {(opts: { id: string; label: string }[]) =>
            opts.length ? (
              <Field label={credit ? "Open invoice" : "Open bill"}>
                <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
                  <option value="">Choose…</option>
                  {opts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <EmptyState
                title={credit ? "No open invoices" : "No open bills"}
                description={credit ? "Add the invoice on Invoices first, then match the line." : "Add the bill on the Bills tab first, then match the line."}
              />
            )
          }
        </QueryState>
        <FormError message={error} />
      </div>
    </Dialog>
  );
}
