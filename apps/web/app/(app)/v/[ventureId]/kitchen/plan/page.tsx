"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChefHat, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, formatINR, formatNumber, istDate } from "@/lib/format";
import { useVenture } from "@/lib/venture";

interface Forecast {
  dish_code: string;
  name: string;
  model_qty: number | string | null;
  lo: number | string | null;
  hi: number | string | null;
  method: string | null;
  mape_backtest: number | string | null;
  event_multiplier: number | string | null;
  final_qty: number | string | null;
}
interface PoLine {
  ingredient?: string;
  sku?: string | null;
  packs?: number;
  pack_size?: number | string;
  unit?: string;
  price_per_pack?: number | string;
  line_total?: number | string;
}
interface Po {
  id: string;
  po_number: string;
  vendor: string;
  vendor_email: string | null;
  lines: PoLine[];
  total_inr: number | string;
  status: string;
  sent_at: string | null;
  approval_id: string | null;
}
interface Prep {
  dishes?: { dish: string; portions: number }[];
  ingredients?: { ingredient: string; required: number; on_hand: number; unit: string }[];
}

function AccuracyCard({ ventureId }: { ventureId: string }) {
  const q = useQuery({
    queryKey: ["kitchen", ventureId, "accuracy"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/accuracy", { params: { path: { venture_id: ventureId }, query: { days: 14 } } })),
  });
  return (
    <Card className="h-fit">
      <CardHeader title="Forecast accuracy" description="Last 14 days: latest forecast vs actual sales (MAPE — lower is better)" />
      {q.isPending ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : (
        <div className="p-4">
          <StatGrid className="sm:grid-cols-2">
            <Stat
              label="Overall MAPE"
              value={q.data.overall_mape === null ? "—" : `${q.data.overall_mape}%`}
              tone={q.data.overall_mape !== null && q.data.overall_mape > 30 ? "warning" : undefined}
            />
            <Stat label="Dishes measured" value={q.data.dishes.length} />
          </StatGrid>
          {q.data.dishes.length ? (
            <ul className="mt-4 space-y-1.5 text-sm">
              {(q.data.dishes as { dish_code: string; name: string; mape: number; days: number }[]).slice(0, 8).map((d) => (
                <li key={d.dish_code} className="flex items-center justify-between gap-2">
                  <span className="truncate">{d.name}</span>
                  <span className="shrink-0 text-muted tabular-nums">
                    {d.mape}% <span className="text-xs text-subtle">({d.days} d)</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-subtle">Needs a few days of forecasts and sales to measure.</p>
          )}
        </div>
      )}
    </Card>
  );
}

export default function KitchenPlanPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(() => istDate(1));
  const [runId, setRunId] = useState<string | null>(null);
  const plan = useQuery({
    queryKey: ["kitchen", v.id, "plan", date],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/plan", { params: { path: { venture_id: v.id }, query: { target_date: date } } })),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/kitchen/run", { params: { path: { venture_id: v.id } }, body: { target_date: date } })),
    onSuccess: (out) => {
      setRunId(out.run_id);
      toast.success("Planning run started", "Forecast, prep list and purchase orders will appear here.");
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["kitchen", v.id, "plan", date] }), 4000);
    },
    onError: (e) => toast.error("Could not start the plan", errorMessage(e)),
  });

  const data = plan.data;
  const forecasts = (data?.forecasts ?? []) as unknown as Forecast[];
  const prep = (data?.prep ?? null) as Prep | null;
  const pos = (data?.purchase_orders ?? []) as unknown as Po[];
  const portions = forecasts.reduce((a, f) => a + Number(f.final_qty ?? 0), 0);
  const poTotal = pos.reduce((a, p) => a + Number(p.total_inr ?? 0), 0);

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Daily plan"
        description="Runs nightly at the scheduled time (IST): forecast per dish → ingredients via recipes → stock → one purchase order per vendor, each needing a kitchen manager's approval."
        actions={
          <>
            <div className="w-40">
              <label htmlFor="plan-date" className="sr-only">
                Plan date
              </label>
              <Input id="plan-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={run.isPending} onClick={() => run.mutate()}>
              Run plan now
            </Button>
          </>
        }
      />
      {runId ? (
        <Notice tone="info" className="mb-4">
          Planning run started.{" "}
          <Link href={`/v/${v.id}/runs/${runId}`} className="font-medium underline">
            Follow it
          </Link>{" "}
          — refresh this page when it completes.
        </Notice>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {plan.isPending ? (
            <Card>
              <SkeletonRows rows={8} />
            </Card>
          ) : plan.isError ? (
            <Card>
              <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
            </Card>
          ) : !data?.run_id ? (
            <Card>
              <EmptyState
                icon={ChefHat}
                title={`No plan for ${formatDate(date)} yet`}
                description="Plans are created by the nightly run. Make sure dishes, recipes, vendors and recent sales are in place, then run it now."
                action={
                  <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>
                    Run plan now
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              <Card className="p-4">
                <StatGrid className="sm:grid-cols-3">
                  <Stat label="Portions forecast" value={formatNumber(portions, 0)} hint={formatDate(data.target_date)} />
                  <Stat label="Purchase orders" value={pos.length} hint={`${pos.filter((p) => p.status === "sent").length} sent`} />
                  <Stat label="PO value" value={formatINR(poTotal, { whole: true })} />
                </StatGrid>
                {data.narrative ? <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed whitespace-pre-wrap text-muted">{data.narrative}</p> : null}
                <p className="mt-3 text-xs">
                  <Link href={`/v/${v.id}/runs/${data.run_id}`} className="text-accent hover:underline">
                    View planning run →
                  </Link>
                </p>
              </Card>
              <Card>
                <CardHeader title="Forecast" description="Model quantity, its range, backtest error and any event adjustment" />
                <Table label="Forecast">
                  <THead>
                    <tr>
                      <Th>Dish</Th>
                      <Th className="text-right">Model</Th>
                      <Th className="hidden text-right sm:table-cell">Range</Th>
                      <Th className="hidden md:table-cell">Method</Th>
                      <Th className="hidden text-right md:table-cell">MAPE</Th>
                      <Th className="hidden text-right sm:table-cell">Event ×</Th>
                      <Th className="text-right">Final</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {forecasts.map((f) => (
                      <Tr key={f.dish_code}>
                        <Td className="font-medium">{f.name}</Td>
                        <Td className="text-right tabular-nums">{formatNumber(f.model_qty, 1)}</Td>
                        <Td className="hidden text-right whitespace-nowrap text-muted tabular-nums sm:table-cell">
                          {formatNumber(f.lo, 0)}–{formatNumber(f.hi, 0)}
                        </Td>
                        <Td className="hidden text-muted md:table-cell">{f.method ?? "—"}</Td>
                        <Td className="hidden text-right text-muted tabular-nums md:table-cell">{f.mape_backtest === null ? "—" : `${formatNumber(f.mape_backtest, 1)}%`}</Td>
                        <Td className="hidden text-right tabular-nums sm:table-cell">
                          {Number(f.event_multiplier ?? 1) !== 1 ? <Badge tone="info">×{formatNumber(f.event_multiplier)}</Badge> : <span className="text-subtle">1</span>}
                        </Td>
                        <Td className="text-right font-semibold tabular-nums">{formatNumber(f.final_qty, 0)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </Card>
              {prep ? (
                <Card>
                  <CardHeader title="Prep list" />
                  <div className="grid gap-6 p-4 md:grid-cols-2">
                    <div>
                      <h3 className="mb-2 text-xs font-semibold text-subtle uppercase">Dishes</h3>
                      <ul className="space-y-1 text-sm">
                        {(prep.dishes ?? []).map((d) => (
                          <li key={d.dish} className="flex justify-between gap-2">
                            <span>{d.dish}</span>
                            <span className="font-medium tabular-nums">{formatNumber(d.portions, 0)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3 className="mb-2 text-xs font-semibold text-subtle uppercase">Ingredients (required / on hand)</h3>
                      <ul className="space-y-1 text-sm">
                        {(prep.ingredients ?? []).map((i) => (
                          <li key={i.ingredient} className="flex justify-between gap-2">
                            <span>{i.ingredient}</span>
                            <span className="tabular-nums">
                              <span className={Number(i.on_hand) < Number(i.required) ? "font-medium text-warning" : ""}>{formatNumber(i.required)}</span>
                              <span className="text-subtle"> / {formatNumber(i.on_hand)} {i.unit}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </Card>
              ) : null}
              <Card>
                <CardHeader title="Purchase orders" description="Each is emailed to the vendor only after a kitchen manager approves it" />
                {pos.length ? (
                  <div className="divide-y divide-border">
                    {pos.map((p) => (
                      <section key={p.id} className="p-4" aria-label={p.po_number}>
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold">{p.po_number}</span>
                          <StatusBadge status={p.status} />
                          <span className="text-sm text-muted">
                            {p.vendor}
                            {p.vendor_email ? ` · ${p.vendor_email}` : ""}
                          </span>
                          <span className="ml-auto font-semibold tabular-nums">{formatINR(p.total_inr)}</span>
                        </div>
                        <Table label={`Lines of ${p.po_number}`}>
                          <THead>
                            <tr>
                              <Th>Item</Th>
                              <Th className="text-right">Packs</Th>
                              <Th className="hidden text-right sm:table-cell">Pack</Th>
                              <Th className="hidden text-right sm:table-cell">Rate</Th>
                              <Th className="text-right">Amount</Th>
                            </tr>
                          </THead>
                          <TBody>
                            {p.lines.map((l, i) => (
                              <Tr key={i}>
                                <Td>
                                  {l.ingredient}
                                  {l.sku ? <span className="ml-1 text-xs text-subtle">{l.sku}</span> : null}
                                </Td>
                                <Td className="text-right tabular-nums">{l.packs}</Td>
                                <Td className="hidden text-right whitespace-nowrap text-muted sm:table-cell">
                                  {formatNumber(l.pack_size)} {l.unit}
                                </Td>
                                <Td className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{formatINR(l.price_per_pack)}</Td>
                                <Td className="text-right whitespace-nowrap tabular-nums">{formatINR(l.line_total)}</Td>
                              </Tr>
                            ))}
                          </TBody>
                        </Table>
                        <p className="mt-2 text-xs text-subtle">
                          {p.sent_at ? `Sent ${formatDateTime(p.sent_at)}` : p.approval_id && p.status !== "sent" ? (
                            <Link href={`/inbox?id=${p.approval_id}`} className="text-accent hover:underline">
                              Review in inbox →
                            </Link>
                          ) : (
                            "Not sent"
                          )}
                        </p>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="px-4 py-4 text-sm text-subtle">No purchase orders — stock covers the forecast, or no vendor items are configured.</p>
                )}
              </Card>
            </>
          )}
        </div>
        <AccuracyCard ventureId={v.id} />
      </div>
    </>
  );
}
