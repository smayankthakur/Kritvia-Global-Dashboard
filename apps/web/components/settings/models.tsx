"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";

export function ModelSettings({ ventureId }: { ventureId: string }) {
  const [days, setDays] = useState(14);
  const tiers = useQuery({ queryKey: ["tiers"], queryFn: () => unwrap(api.GET("/tiers")), staleTime: 10 * 60_000 });
  const usage = useQuery({
    queryKey: ["usage", ventureId, days],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/usage", { params: { path: { venture_id: ventureId }, query: { days } } })),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Model tiers" description="Each capability tier falls back along its chain on rate limits. Sensitive data only ever reaches models marked local." />
        <QueryState query={tiers}>
          {(data) => (
            <ul className="divide-y divide-border">
              {data.map((t) => (
                <li key={t.tier} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                  <span className="w-32 shrink-0 font-mono text-sm font-medium">{t.tier}</span>
                  <ol className="flex flex-wrap items-center gap-1.5 text-xs">
                    {t.chain.map((c, i) => (
                      <li key={`${c.deployment}-${i}`} className="flex items-center gap-1.5">
                        {i > 0 ? <span className="text-subtle" aria-hidden>→</span> : null}
                        <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5">
                          <span className="font-mono">{c.deployment}</span>
                          <Badge tone={c.data_policy === "local" ? "success" : "warning"} className="h-4 px-1.5 text-[10px]">
                            {c.data_policy === "local" ? "local" : c.data_policy?.replace(/_/g, " ")}
                          </Badge>
                          {c.sensitive_allowed === "true" ? <span className="sr-only">(sensitive allowed)</span> : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <Card>
        <CardHeader
          title="Model usage"
          description="Calls by day, tier and model for this venture"
          actions={
            <div className="w-32">
              <label htmlFor="usage-days" className="sr-only">
                Period
              </label>
              <Select id="usage-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8">
                {[7, 14, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </Select>
            </div>
          }
        />
        <QueryState query={usage} empty={<EmptyState title="No model calls in this period" />}>
          {(data) => (
            <Table label="Model usage">
              <THead>
                <tr>
                  <Th>Day</Th>
                  <Th>Tier · model</Th>
                  <Th className="text-right">Calls</Th>
                  <Th className="hidden text-right sm:table-cell">OK</Th>
                  <Th className="hidden text-right md:table-cell">Rate-limited</Th>
                  <Th className="hidden text-right md:table-cell">Blocked</Th>
                  <Th className="hidden text-right md:table-cell">Errors</Th>
                  <Th className="hidden text-right lg:table-cell">Tokens</Th>
                  <Th className="hidden text-right lg:table-cell">Avg latency</Th>
                </tr>
              </THead>
              <TBody>
                {data.map((u, i) => (
                  <Tr key={i}>
                    <Td className="whitespace-nowrap">{formatDate(u.day)}</Td>
                    <Td>
                      <span className="font-mono text-xs">{u.tier}</span>
                      <span className="block truncate text-xs text-subtle">{u.provider_model ?? "—"}</span>
                    </Td>
                    <Td className="text-right tabular-nums">{u.calls}</Td>
                    <Td className="hidden text-right tabular-nums sm:table-cell">{u.ok}</Td>
                    <Td className={`hidden text-right tabular-nums md:table-cell ${u.rate_limited ? "text-warning" : ""}`}>{u.rate_limited}</Td>
                    <Td className="hidden text-right tabular-nums md:table-cell">{u.blocked}</Td>
                    <Td className={`hidden text-right tabular-nums md:table-cell ${u.errors ? "text-danger" : ""}`}>{u.errors}</Td>
                    <Td className="hidden text-right tabular-nums lg:table-cell">{formatNumber(u.prompt_tokens + u.completion_tokens)}</Td>
                    <Td className="hidden text-right tabular-nums lg:table-cell">{u.avg_latency_ms ? `${Math.round(u.avg_latency_ms)} ms` : "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
