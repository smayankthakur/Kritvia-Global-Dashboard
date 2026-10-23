"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { amountProblem, paiseToInput, rupees, toPaiseOrZero, toPaiseSigned } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Forecast = Schemas["CashForecastOut"];
type Week = Schemas["CashWeekOut"];

/** Week-by-week closing balance: one bar per week from a zero baseline, the warning level as a dashed line. */
function WeeksChart({ weeks, floor, hasOpening }: { weeks: Week[]; floor: number | null; hasOpening: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const values = weeks.map((w) => w.closing_paise);
  const hi = Math.max(0, floor ?? 0, ...values);
  const lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const y = (v: number) => pad.t + ((hi - v) / span) * (H - pad.t - pad.b);
  const step = (W - pad.l - pad.r) / weeks.length;
  const bw = Math.max(6, step - 6);
  const shown = hover != null ? weeks[hover] : null;
  return (
    <figure className="space-y-2">
      <div className="min-h-5 text-xs text-muted" aria-live="polite">
        {shown
          ? `Week of ${formatDate(shown.start)}: ${rupees(shown.in_paise)} in, ${rupees(shown.out_paise)} out, ${hasOpening ? "ending near" : "running total"} ${rupees(shown.closing_paise)}`
          : "Point at a week to see its numbers."}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto max-h-64 w-full" role="img" aria-label="Expected balance at the end of each of the next 13 weeks">
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} />
        {floor != null && floor > 0 ? (
          <line x1={pad.l} x2={W - pad.r} y1={y(floor)} y2={y(floor)} stroke="var(--warning)" strokeWidth={1.5} strokeDasharray="5 4" />
        ) : null}
        {weeks.map((w, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          const top = Math.min(y(w.closing_paise), y(0));
          const h = Math.max(2, Math.abs(y(w.closing_paise) - y(0)));
          const low = floor != null ? w.closing_paise < floor : w.closing_paise < 0;
          const r = Math.min(4, bw / 2, h / 2);
          const up = w.closing_paise >= 0;
          // rounded at the data end, square at the baseline
          const d = up
            ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`
            : `M${x},${top} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + bw - r} Q${x + bw},${top + h} ${x + bw},${top + h - r} V${top} Z`;
          return (
            <g key={w.start} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent" />
              <path d={d} fill={low ? "var(--warning)" : "var(--accent)"} opacity={hover == null || hover === i ? 1 : 0.55} />
              {i % 2 === 0 ? (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize="8" fill="var(--fg-subtle)">
                  {new Date(w.start).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-subtle">
        {hasOpening ? "Expected balance at the end of each week." : "Running total of money in minus money out, week by week."}
        {floor != null && floor > 0 ? ` The dashed line is your warning level (${rupees(floor)}); weeks below it are amber.` : ""}
      </figcaption>
    </figure>
  );
}

function SettingsForm({ ventureId, canWrite }: { ventureId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["cash-settings", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/cash/settings", { params: { path: { venture_id: ventureId } } })),
  });
  const [f, setF] = useState<{ balance: string; on: string; fixed: string; alert: string } | null>(null);
  const s = q.data;
  const v = f ?? {
    balance: s?.balance_paise != null ? paiseToInput(s.balance_paise) : "",
    on: s?.balance_on ?? "",
    fixed: s ? paiseToInput(s.monthly_fixed_paise) : "",
    alert: s?.alert_below_paise != null ? paiseToInput(s.alert_below_paise) : "",
  };
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/cash/settings", {
          params: { path: { venture_id: ventureId } },
          body: {
            balance_paise: v.balance.trim() ? toPaiseSigned(v.balance) : null,
            balance_on: v.balance.trim() ? v.on || null : null,
            clear_balance: !v.balance.trim(),
            monthly_fixed_paise: v.fixed.trim() ? (toPaiseOrZero(v.fixed) ?? 0) : 0,
            alert_below_paise: v.alert.trim() ? toPaiseOrZero(v.alert) : null,
            clear_alert: !v.alert.trim(),
          },
        }),
      ),
    onSuccess: (d) => {
      qc.setQueryData(["cash-settings", ventureId], d);
      void qc.invalidateQueries({ queryKey: ["cash-forecast", ventureId] });
      setF(null);
      toast.success("Saved");
    },
    onError: (e) => toast.error("Couldn't save it", errorMessage(e)),
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setF({ ...v, [k]: e.target.value });
  // Nothing typed is ever saved as ₹0 behind the owner's back: a field that isn't an amount says why.
  const errors = {
    balance: amountProblem(v.balance, { zero: true, negative: true }),
    fixed: amountProblem(v.fixed, { zero: true }),
    alert: amountProblem(v.alert, { zero: true }),
  };
  const invalid = Boolean(errors.balance || errors.fixed || errors.alert);
  return (
    <Card>
      <CardHeader
        title="What Kritvia can't see"
        description="The latest bank statement's balance is used by itself; type one here if you haven't uploaded a statement lately. Salaries come from People → Attendance."
      />
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Bank balance (₹)" hint="Below zero for an overdraft, e.g. -50000" error={errors.balance ?? undefined}>
            <Input value={v.balance} onChange={set("balance")} inputMode="decimal" disabled={!canWrite} />
          </Field>
          <Field label="On">
            <Input type="date" value={v.on} onChange={set("on")} disabled={!canWrite} />
          </Field>
          <Field label="Other fixed costs a month (₹)" hint="Rent, EMIs, subscriptions; not salaries" error={errors.fixed ?? undefined}>
            <Input value={v.fixed} onChange={set("fixed")} inputMode="decimal" disabled={!canWrite} />
          </Field>
          <Field label="Warn me below (₹)" error={errors.alert ?? undefined}>
            <Input value={v.alert} onChange={set("alert")} inputMode="decimal" disabled={!canWrite} />
          </Field>
        </div>
        {canWrite ? (
          <Button className="mt-3" size="sm" variant="primary" disabled={!f || invalid} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}

/** The cash position for the next thirteen weeks, from invoices, bills, salaries and fixed costs. */
export function CashTab({ ventureId, canWrite }: { ventureId: string; canWrite: boolean }) {
  const q = useQuery({
    queryKey: ["cash-forecast", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/cash/forecast", { params: { path: { venture_id: ventureId } } })),
  });
  return (
    <div className="space-y-4">
      <QueryState query={q} loading={<SkeletonRows rows={4} />}>
        {(f: Forecast) => {
          const h = Object.fromEntries(f.horizons.map((x) => [x.days, x]));
          const opening = f.opening_paise != null;
          return (
            <>
              {f.below_alert ? (
                <Notice tone="warning" title={`A tight week: ${formatDate(f.lowest_week)}`}>
                  {f.alert_below_paise != null
                    ? `The balance is expected to dip to ${rupees(f.lowest_paise)}, below your ${rupees(f.alert_below_paise)}. Chasing the biggest dues before then would help.`
                    : `The balance is expected to dip to ${rupees(f.lowest_paise)}. Chasing the biggest dues before then would help.`}
                </Notice>
              ) : null}
              <Card className="p-4">
                <p className="mb-3 text-sm text-muted">
                  {opening
                    ? `Starting from ${rupees(f.opening_paise ?? 0)} (${f.opening_from === "statement" ? "your last statement" : "as typed"}, ${formatDate(f.opening_on)}).`
                    : "No bank balance yet: these are the net flows only. Upload a statement or type the balance below."}
                </p>
                <StatGrid>
                  {[30, 60, 90].map((d) => (
                    <Stat
                      key={d}
                      label={`Next ${d} days`}
                      value={opening ? rupees(h[d].closing_paise) : rupees(h[d].in_paise - h[d].out_paise)}
                      hint={`${rupees(h[d].in_paise)} in · ${rupees(h[d].out_paise)} out`}
                    />
                  ))}
                </StatGrid>
              </Card>
              <Card>
                <CardHeader
                  title="The next 13 weeks"
                  description={
                    f.usual_late_days
                      ? `Invoices are expected when each customer usually pays (on average ${f.usual_late_days} days after the due date).`
                      : "Invoices are expected on their due dates; once customers pay late, Kritvia allows for it."
                  }
                />
                <CardBody>
                  <WeeksChart weeks={f.weeks} floor={f.alert_below_paise ?? (opening ? 0 : null)} hasOpening={opening} />
                </CardBody>
                <details className="border-t border-border">
                  <summary className="cursor-pointer px-4 py-2 text-sm text-muted">Show as a table</summary>
                  <Table label="Cash by week">
                    <THead>
                      <tr>
                        <Th>Week of</Th>
                        <Th className="text-right">In</Th>
                        <Th className="text-right">Out</Th>
                        <Th className="text-right">{opening ? "Balance" : "Running total"}</Th>
                      </tr>
                    </THead>
                    <TBody>
                      {f.weeks.map((w) => (
                        <Tr key={w.start}>
                          <Td>{formatDate(w.start)}</Td>
                          <Td className="text-right tabular-nums">{rupees(w.in_paise)}</Td>
                          <Td className="text-right tabular-nums">{rupees(w.out_paise)}</Td>
                          <Td className="text-right tabular-nums">
                            {rupees(w.closing_paise)}{" "}
                            {f.alert_below_paise != null && w.closing_paise < f.alert_below_paise ? <Badge tone="warning">low</Badge> : null}
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </details>
              </Card>
              {f.notes.length || f.salaries_paise ? (
                <ul className="list-disc space-y-1 pl-5 text-xs text-subtle">
                  {f.salaries_paise ? <li>{`Salaries of ${rupees(f.salaries_paise)} a month are counted on the 1st.`}</li> : null}
                  {f.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                  <li>A forecast from your invoices, bills and salaries, not a promise. Every Monday morning the owners get this as a note.</li>
                </ul>
              ) : null}
            </>
          );
        }}
      </QueryState>
      <SettingsForm ventureId={ventureId} canWrite={canWrite} />
    </div>
  );
}
