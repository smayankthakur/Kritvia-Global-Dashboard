"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { rupees } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, unwrap, type Schemas } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type A = Schemas["AnalyticsOut"];
type Point = { start: string; received_paise: number; issued_paise: number; leads: number; drafts: number; approved: number };
const RANGES = [7, 30, 90, 180, 365] as const;
const ADVANCED_ONLY = new Set([180, 365]);
const AGENT: Record<string, string> = {
  inbox_assistant: "Inbox assistant", collections: "Payment reminders", lead_triage: "Lead triage", prospector: "Prospector",
  booking_reminders: "Booking reminders", reviews: "Google reviews", whatsapp_followup: "WhatsApp follow-ups",
  automation: "Automations", assistant: "Assistant", meeting_digest: "Meeting digest", kitchen_daily: "Kitchen",
  loan_verification: "Loan documents", custom: "Custom workflows",
};
const AGE: [keyof A_Ageing, string][] = [["not_due", "Not due yet"], ["d1_30", "1–30 days late"], ["d31_60", "31–60 days"], ["d61_90", "61–90 days"], ["d90_plus", "Over 90 days"]];
type A_Ageing = { not_due: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };

const tick = { fill: "var(--fg-subtle)", fontSize: 11 };
const tooltipStyle = { background: "var(--surface-solid)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg)" };
const shortRs = (paise: number) => {
  const r = paise / 100;
  return r >= 1e7 ? `₹${formatNumber(r / 1e7, 1)}Cr` : r >= 1e5 ? `₹${formatNumber(r / 1e5, 1)}L` : r >= 1e3 ? `₹${formatNumber(r / 1e3, 1)}k` : `₹${formatNumber(r, 0)}`;
};

function label(bucket: string, d: string): string {
  if (bucket === "month") return new Date(d).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function Delta({ now, before, money, days }: { now: number; before: number; money?: boolean; days: number }) {
  if (!before && !now) return <span className="text-subtle">No activity yet</span>;
  if (!before) return <span className="text-subtle">New in the last {days} days</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const word = pct === 0 ? "Same as" : pct > 0 ? `Up ${pct}% on` : `Down ${Math.abs(pct)}% on`;
  return (
    <span className="text-subtle">
      {word} the {days} days before ({money ? rupees(before) : formatNumber(before, 0)})
    </span>
  );
}

function Tile({ title, value, sub }: { title: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <dt className="text-xs text-muted">{title}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
      <dd className="mt-1 text-xs">{sub}</dd>
    </div>
  );
}

function csv(a: A): string {
  const head = "period_start,money_received_inr,invoiced_inr,new_leads,drafts,drafts_approved";
  const rows = (a.trend as Point[]).map((t) => [t.start, (t.received_paise / 100).toFixed(2), (t.issued_paise / 100).toFixed(2), t.leads, t.drafts, t.approved].join(","));
  return [head, ...rows].join("\n");
}

function download(a: A, name: string) {
  const url = URL.createObjectURL(new Blob([csv(a)], { type: "text/csv" }));
  const el = document.createElement("a");
  el.href = url;
  el.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-analytics-${a.days}d.csv`;
  el.click();
  URL.revokeObjectURL(url);
}

function MoneyChart({ a }: { a: A }) {
  const data = a.trend as Point[];
  return (
    <figure>
      <div className="h-64 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="start" tickFormatter={(d: string) => label(a.bucket, d)} tick={tick} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={16} />
            <YAxis tickFormatter={(v: number) => shortRs(v)} tick={tick} axisLine={false} tickLine={false} width={56} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => (a.bucket === "day" ? formatDate(String(d)) : `From ${formatDate(String(d))}`)} formatter={(v, n) => [rupees(Number(v)), n]} />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--fg-muted)" }} iconType="plainline" />
            <Line type="monotone" dataKey="received_paise" name="Money received" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="issued_paise" name="Invoiced" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">
        Money received and invoiced per {a.bucket}:{" "}
        {data.map((t) => `${label(a.bucket, t.start)}: received ${rupees(t.received_paise)}, invoiced ${rupees(t.issued_paise)}`).join("; ")}
      </figcaption>
    </figure>
  );
}

function WorkChart({ a }: { a: A }) {
  const data = a.trend as Point[];
  return (
    <figure>
      <div className="h-56 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }} barGap={2}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="start" tickFormatter={(d: string) => label(a.bucket, d)} tick={tick} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={16} />
            <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} contentStyle={tooltipStyle} labelFormatter={(d) => (a.bucket === "day" ? formatDate(String(d)) : `From ${formatDate(String(d))}`)} />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--fg-muted)" }} />
            <Bar dataKey="leads" name="New leads" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={18} />
            <Bar dataKey="approved" name="Drafts approved" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">
        New leads and drafts approved per {a.bucket}: {data.map((t) => `${label(a.bucket, t.start)}: ${t.leads} leads, ${t.approved} approved`).join("; ")}
      </figcaption>
    </figure>
  );
}

/** Horizontal bars in one hue, with the value written beside each (magnitude, one series). */
function Bars({ rows, money }: { rows: { label: string; value: number }[]; money?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-muted">{r.label}</span>
          <span className="h-2.5 rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-[var(--series-1)]" style={{ width: `${Math.max(r.value ? 2 : 0, (r.value / max) * 100)}%` }} />
          </span>
          <span className="tabular-nums">{money ? rupees(r.value) : formatNumber(r.value, 0)}</span>
        </li>
      ))}
    </ul>
  );
}

function Advanced({ a }: { a: A }) {
  const adv = a.advanced as {
    funnel: Record<string, number>;
    sources: { source: string; leads: number; won: number }[];
    ageing: A_Ageing;
    agents: { agent: string; drafts: number; approved: number; edited: number; rejected: number; median_minutes: number | null }[];
    channels: { channel: string; drafts: number; approved: number }[];
    ai: { agent: string; tokens: number; calls: number }[];
    top_customers: { customer: string; received_paise: number; payments: number }[];
  };
  const f = adv.funnel;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Lead funnel" description={`Leads that came in during these ${a.days} days, by where they are now.`} />
        <div className="p-4 pt-0">
          <Bars rows={[["new", "New"], ["qualified", "Qualified"], ["proposal", "Proposal sent"], ["won", "Won"], ["lost", "Lost"]].map(([k, l]) => ({ label: l!, value: f[k!] ?? 0 }))} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Money still owed, by age" description="Open invoices today, by how late they are." />
        <div className="p-4 pt-0">
          <Bars money rows={AGE.map(([k, l]) => ({ label: l, value: adv.ageing[k] }))} />
        </div>
      </Card>
      <Card className="overflow-hidden p-0 lg:col-span-2">
        <CardHeader title="Agents" description="Drafts each agent made, what you did with them, and how long they waited for you (median)." />
        <Table label="Agents">
          <THead>
            <Tr>
              <Th>Agent</Th>
              <Th className="text-right">Drafts</Th>
              <Th className="text-right">Approved</Th>
              <Th className="text-right">Edited</Th>
              <Th className="text-right">Rejected</Th>
              <Th className="text-right">Answered in</Th>
            </Tr>
          </THead>
          <TBody>
            {adv.agents.length ? (
              adv.agents.map((r) => (
                <Tr key={r.agent}>
                  <Td>{AGENT[r.agent] ?? r.agent}</Td>
                  <Td className="text-right tabular-nums">{r.drafts}</Td>
                  <Td className="text-right tabular-nums">{r.approved}</Td>
                  <Td className="text-right tabular-nums">{r.edited}</Td>
                  <Td className="text-right tabular-nums">{r.rejected}</Td>
                  <Td className="text-right tabular-nums">{r.median_minutes == null ? "—" : r.median_minutes < 60 ? `${formatNumber(r.median_minutes, 0)} min` : `${formatNumber(r.median_minutes / 60, 1)} h`}</Td>
                </Tr>
              ))
            ) : (
              <Tr>
                <Td colSpan={6} className="text-muted">No drafts in this period.</Td>
              </Tr>
            )}
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <CardHeader title="Where leads came from" />
        <Table label="Lead sources">
          <THead>
            <Tr>
              <Th>Source</Th>
              <Th className="text-right">Leads</Th>
              <Th className="text-right">Won</Th>
            </Tr>
          </THead>
          <TBody>
            {adv.sources.map((r) => (
              <Tr key={r.source}>
                <Td className="capitalize">{r.source.replace(/_/g, " ")}</Td>
                <Td className="text-right tabular-nums">{r.leads}</Td>
                <Td className="text-right tabular-nums">{r.won}</Td>
              </Tr>
            ))}
            {!adv.sources.length ? (
              <Tr>
                <Td colSpan={3} className="text-muted">No leads in this period.</Td>
              </Tr>
            ) : null}
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <CardHeader title="Best-paying customers" description="By money received in this period." />
        <Table label="Best-paying customers">
          <THead>
            <Tr>
              <Th>Customer</Th>
              <Th className="text-right">Received</Th>
              <Th className="text-right">Payments</Th>
            </Tr>
          </THead>
          <TBody>
            {adv.top_customers.map((r) => (
              <Tr key={r.customer}>
                <Td translate="no">{r.customer}</Td>
                <Td className="text-right tabular-nums">{rupees(r.received_paise)}</Td>
                <Td className="text-right tabular-nums">{r.payments}</Td>
              </Tr>
            ))}
            {!adv.top_customers.length ? (
              <Tr>
                <Td colSpan={3} className="text-muted">No payments in this period.</Td>
              </Tr>
            ) : null}
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <CardHeader title="Drafts by channel" />
        <Table label="Drafts by channel">
          <THead>
            <Tr>
              <Th>Channel</Th>
              <Th className="text-right">Drafts</Th>
              <Th className="text-right">Approved</Th>
            </Tr>
          </THead>
          <TBody>
            {adv.channels.map((r) => (
              <Tr key={r.channel}>
                <Td className="capitalize">{r.channel === "whatsapp" ? "WhatsApp" : r.channel}</Td>
                <Td className="text-right tabular-nums">{r.drafts}</Td>
                <Td className="text-right tabular-nums">{r.approved}</Td>
              </Tr>
            ))}
            {!adv.channels.length ? (
              <Tr>
                <Td colSpan={3} className="text-muted">No drafts in this period.</Td>
              </Tr>
            ) : null}
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <CardHeader title="AI used" description="Hosted and private models, by agent." />
        <Table label="AI used">
          <THead>
            <Tr>
              <Th>Agent</Th>
              <Th className="text-right">Tokens</Th>
              <Th className="text-right">Calls</Th>
            </Tr>
          </THead>
          <TBody>
            {adv.ai.map((r) => (
              <Tr key={r.agent}>
                <Td>{AGENT[r.agent] ?? r.agent}</Td>
                <Td className="text-right tabular-nums">{formatNumber(r.tokens, 0)}</Td>
                <Td className="text-right tabular-nums">{r.calls}</Td>
              </Tr>
            ))}
            {!adv.ai.length ? (
              <Tr>
                <Td colSpan={3} className="text-muted">No AI used in this period.</Td>
              </Tr>
            ) : null}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

export default function AnalyticsPage() {
  const v = useVenture();
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ["analytics", v.id, days],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/analytics", { params: { path: { venture_id: v.id }, query: { days } } })),
  });
  const advanced = q.data?.level === "advanced";
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Analytics"
        description="How the business is doing: money, customers and what your agents did, compared with the period before."
        actions={
          q.data ? (
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => download(q.data!, v.venture_name)}>
              Export CSV
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Period">
        {RANGES.map((d) => {
          const locked = ADVANCED_ONLY.has(d) && q.data !== undefined && !advanced;
          return (
            <button
              key={d}
              type="button"
              disabled={locked}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${days === d ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-border text-muted hover:bg-surface-2"} disabled:opacity-60`}
              title={locked ? "Advanced analytics, on Growth and above" : undefined}
            >
              {locked ? <Lock className="h-3 w-3" aria-hidden /> : null}
              {d === 365 ? "12 months" : d === 180 ? "6 months" : `${d} days`}
            </button>
          );
        })}
        {q.data ? <Badge tone={advanced ? "accent" : "neutral"}>{advanced ? "Advanced analytics" : "Basic analytics"}</Badge> : null}
      </div>
      <QueryState query={q} loading={<SkeletonRows rows={6} />}>
        {(a: A) => {
          const c = a.current;
          const p = a.previous;
          const rate = c.drafts ? Math.round((c.drafts_approved / c.drafts) * 100) : null;
          return (
            <div className="space-y-4">
              <p className="text-xs text-subtle">
                {formatDate(a.start)} to {formatDate(a.end)}
              </p>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Tile title="Money received" value={rupees(c.received_paise!)} sub={<Delta now={c.received_paise!} before={p.received_paise!} money days={a.days} />} />
                <Tile title="Invoiced" value={rupees(c.issued_paise!)} sub={<Delta now={c.issued_paise!} before={p.issued_paise!} money days={a.days} />} />
                <Tile title="Still to collect (today)" value={rupees(c.outstanding_paise!)} sub={<span className={c.overdue_paise ? "text-danger" : "text-subtle"}>{rupees(c.overdue_paise!)} of it overdue</span>} />
                <Tile title="New leads" value={formatNumber(c.new_leads!, 0)} sub={<Delta now={c.new_leads!} before={p.new_leads!} days={a.days} />} />
                <Tile title="Bookings" value={formatNumber(c.bookings!, 0)} sub={<span className="text-subtle">{c.bookings_done} done · {c.no_shows} no-shows</span>} />
                <Tile title="Drafts approved" value={`${formatNumber(c.drafts_approved!, 0)} of ${formatNumber(c.drafts!, 0)}`} sub={<span className="text-subtle">{rate === null ? "No drafts yet" : `${rate}% approved · ${c.drafts_rejected} rejected`}</span>} />
              </dl>
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader title="Money in" description={`Received and invoiced, per ${a.bucket}.`} />
                  <div className="p-4 pt-0">
                    <MoneyChart a={a} />
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Leads and approved drafts" description={`Per ${a.bucket}.`} />
                  <div className="p-4 pt-0">
                    <WorkChart a={a} />
                  </div>
                </Card>
              </div>
              {a.advanced ? (
                <Advanced a={a} />
              ) : (
                <Card>
                  <CardHeader title="Advanced analytics, on Growth and above" description="Up to 12 months, the lead funnel and where leads come from, money owed by age, each agent's approvals and response time, drafts by channel, AI use and your best-paying customers." />
                  <div className="p-4 pt-0">
                    <Link href="/billing" className="text-sm text-accent hover:underline">
                      See plans
                    </Link>
                  </div>
                </Card>
              )}
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
