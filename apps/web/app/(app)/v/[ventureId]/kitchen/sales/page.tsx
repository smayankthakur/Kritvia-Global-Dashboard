"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Save, TrendingUp, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { downloadTemplate, ImportResult } from "@/components/kitchen/csv-import";
import { useRefData } from "@/components/kitchen/entity-table";
import { SalesChart, type DayPoint } from "@/components/kitchen/sales-chart";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { FileDrop } from "@/components/ui/file-drop";
import { PageHeader } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatINR, formatNumber, formatRelative } from "@/lib/format";
import { useVenture } from "@/lib/venture";

interface SaleRow {
  sale_date: string;
  dish_code: string;
  name: string;
  qty: number | string;
  revenue_inr: number | string | null;
}

function SalesUpload({ ventureId }: { ventureId: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<Schemas["ImportOut"] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/kitchen/sales/csv", {
          params: { path: { venture_id: ventureId } },
          body: multipart<Schemas["Body_upload_sales_ventures__venture_id__kitchen_sales_csv_post"]>({ file: files[0]! }),
        }),
      ),
    onSuccess: (out) => {
      setResult(out);
      setFiles([]);
      toast.success("Sales imported", `${out.upserted} row(s)`);
      void qc.invalidateQueries({ queryKey: ["kitchen", ventureId, "sales"] });
    },
    onError: (e) => toast.error("Sales import failed", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Upload sales"
        description="Swiggy/Zomato exports or our template: date, dish (code or name), qty[, channel, revenue]"
        actions={
          <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadTemplate("sales")}>
            Template
          </Button>
        }
      />
      <div className="space-y-3 p-4">
        <FileDrop files={files} onChange={setFiles} accept=".csv,text/csv" label="Choose a sales CSV" />
        <Button variant="primary" icon={<Upload className="h-4 w-4" />} disabled={!files.length} loading={m.isPending} onClick={() => m.mutate()}>
          Upload sales
        </Button>
        <ImportResult result={result} />
      </div>
    </Card>
  );
}

function StockCard({ ventureId }: { ventureId: string }) {
  const stock = useQuery({
    queryKey: ["kitchen", ventureId, "stock"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/stock", { params: { path: { venture_id: ventureId } } })),
  });
  const ingredients = useRefData(ventureId, "ingredients");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Schemas["ImportOut"] | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (body: Schemas["StockIn"]) => unwrap(api.POST("/ventures/{venture_id}/kitchen/stock", { params: { path: { venture_id: ventureId } }, body })),
    onSuccess: (out) => {
      setResult(out);
      setCounts({});
      toast.success("Stock count recorded", `${out.upserted} ingredient(s)`);
      void qc.invalidateQueries({ queryKey: ["kitchen", ventureId, "stock"] });
    },
    onError: (e) => toast.error("Could not save stock", errorMessage(e)),
  });
  const submit = () => {
    const bad = new Set<string>();
    const entries = Object.entries(counts).filter(([, v]) => v.trim() !== "");
    for (const [k, v] of entries) if (!(Number(v) >= 0)) bad.add(k);
    setInvalid(bad);
    if (bad.size || !entries.length) return;
    save.mutate({ counts: entries.map(([ingredient_code, qty]) => ({ ingredient_code, qty: qty.trim() })) });
  };
  const rows = (stock.data ?? []) as { ingredient_code: string; name: string; unit: string; qty: string | number | null; counted_at: string | null }[];

  return (
    <Card>
      <CardHeader
        title="Stock count"
        description="Enter what's on hand now; blanks are left unchanged"
        actions={
          <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={save.isPending} onClick={submit} disabled={!Object.values(counts).some((v) => v.trim())}>
            Save count
          </Button>
        }
      />
      {result?.errors.length ? (
        <div className="p-3">
          <ImportResult result={result} />
        </div>
      ) : null}
      {stock.isPending || ingredients.isPending ? (
        <SkeletonRows />
      ) : stock.isError ? (
        <ErrorState error={stock.error} />
      ) : !rows.length ? (
        <EmptyState title="No ingredients yet" description="Add ingredients under Reference data to count stock." />
      ) : (
        <Table label="Current stock">
          <THead>
            <tr>
              <Th>Ingredient</Th>
              <Th className="text-right">On hand</Th>
              <Th className="hidden sm:table-cell">Counted</Th>
              <Th className="w-32">New count</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.ingredient_code}>
                <Td>
                  {r.name} <span className="font-mono text-xs text-subtle">{r.ingredient_code}</span>
                </Td>
                <Td className="text-right whitespace-nowrap tabular-nums">{r.qty === null ? <span className="text-subtle">—</span> : `${formatNumber(r.qty)} ${r.unit}`}</Td>
                <Td className="hidden text-muted sm:table-cell">{r.counted_at ? formatRelative(r.counted_at) : "never"}</Td>
                <Td>
                  <label className="sr-only" htmlFor={`stock-${r.ingredient_code}`}>
                    New count for {r.name} in {r.unit}
                  </label>
                  <Input
                    id={`stock-${r.ingredient_code}`}
                    inputMode="decimal"
                    placeholder={r.unit}
                    value={counts[r.ingredient_code] ?? ""}
                    aria-invalid={invalid.has(r.ingredient_code) || undefined}
                    onChange={(e) => setCounts((c) => ({ ...c, [r.ingredient_code]: e.target.value }))}
                    className="h-8"
                  />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

export default function SalesPage() {
  const v = useVenture();
  const sales = useQuery({
    queryKey: ["kitchen", v.id, "sales"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/sales", { params: { path: { venture_id: v.id }, query: { days: 30 } } })),
  });
  const series = useMemo<DayPoint[]>(() => {
    const byDay = new Map<string, DayPoint>();
    for (const r of (sales.data ?? []) as unknown as SaleRow[]) {
      const d = byDay.get(r.sale_date) ?? { day: r.sale_date, qty: 0, revenue: 0 };
      d.qty += Number(r.qty) || 0;
      d.revenue += Number(r.revenue_inr) || 0;
      byDay.set(r.sale_date, d);
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [sales.data]);
  const topDishes = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of (sales.data ?? []) as unknown as SaleRow[]) m.set(r.name, (m.get(r.name) ?? 0) + Number(r.qty));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [sales.data]);
  const totalQty = series.reduce((a, d) => a + d.qty, 0);
  const totalRev = series.reduce((a, d) => a + d.revenue, 0);

  return (
    <>
      <PageHeader eyebrow={v.venture_name} title="Sales & stock" description="Sales history drives the forecast; the latest stock count is subtracted before ordering." />
      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Last 30 days" description="Portions sold per day" />
            <QueryState query={sales} empty={<EmptyState icon={TrendingUp} title="No sales yet" description="Upload a sales CSV to see the trend and enable forecasting." />}>
              {() => (
                <div className="p-4">
                  <StatGrid className="mb-4 sm:grid-cols-3">
                    <Stat label="Portions" value={formatNumber(totalQty, 0)} />
                    <Stat label="Revenue" value={formatINR(totalRev, { whole: true })} />
                    <Stat label="Days with sales" value={series.length} />
                  </StatGrid>
                  <SalesChart data={series} />
                  {topDishes.length ? (
                    <div className="mt-4 border-t border-border pt-3">
                      <p className="mb-2 text-xs font-medium text-subtle">Top dishes</p>
                      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {topDishes.map(([name, q]) => (
                          <li key={name}>
                            {name} <span className="text-subtle tabular-nums">{formatNumber(q, 0)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </QueryState>
          </Card>
          <StockCard ventureId={v.id} />
        </div>
        <SalesUpload ventureId={v.id} />
      </div>
    </>
  );
}
