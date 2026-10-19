"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Lightbulb, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { rupees } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Summary = Schemas["AdSummaryOut"];
const SOURCE_WORDS: Record<string, string> = {
  meta: "Facebook / Instagram ads",
  google: "Google ads",
  webhook: "Website form",
  email: "Email",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  phone: "Phone calls",
  indiamart: "IndiaMART",
  prospector: "Prospector",
  manual: "Added by hand",
};

/** Ad spend from uploaded reports, set against the leads and sales each campaign brought. Kritvia never spends. */
export function AdsTab({ ventureId, canWrite, canAdmin }: { ventureId: string; canWrite: boolean; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [days, setDays] = useState(30);
  const [platform, setPlatform] = useState<"" | "meta" | "google" | "other">("");
  const [period, setPeriod] = useState({ from: "", to: "" });
  const [advice, setAdvice] = useState<string[] | null>(null);
  const summary = useQuery({
    queryKey: ["ads-summary", ventureId, days],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/ads/summary", { params: { path: { venture_id: ventureId }, query: { days } } })),
  });
  const reports = useQuery({
    queryKey: ["ads-reports", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/ads/reports", { params: { path: { venture_id: ventureId } } })),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ads-summary", ventureId] });
    void qc.invalidateQueries({ queryKey: ["ads-reports", ventureId] });
  };
  const upload = useMutation({
    mutationFn: (file: File) =>
      unwrap(
        api.POST("/ventures/{venture_id}/ads/reports", {
          params: { path: { venture_id: ventureId } },
          body: multipart<Schemas["Body_upload_report_ventures__venture_id__ads_reports_post"]>({
            file,
            platform: platform || null,
            period_from: period.from || null,
            period_to: period.to || null,
          }),
        }),
      ),
    onSuccess: (r) => {
      toast.success("Report read", `${r.rows} campaign row${r.rows === 1 ? "" : "s"}, ${rupees(r.spend_paise)} spent`);
      setAdvice(null);
      refresh();
    },
    onError: (e) => toast.error("Couldn't read the report", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/ads/reports/{report_id}", { params: { path: { venture_id: ventureId, report_id: id } } })),
    onSuccess: () => refresh(),
    onError: (e) => toast.error("Couldn't remove it", errorMessage(e)),
  });
  const ask = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/ads/advice", { params: { path: { venture_id: ventureId }, query: { days } } })),
    onSuccess: (r) => setAdvice(r.points),
    onError: (e) => toast.error("Couldn't get advice", errorMessage(e)),
  });
  const formUrl = "https://yoursite.in/contact?utm_source=facebook&utm_medium=paid_social&utm_campaign=diwali_sale";
  return (
    <div className="space-y-4">
      <Notice tone="info" title="Kritvia reads your ads; it never spends or changes them">
        Export the campaign report from Meta Ads Manager (Export → CSV or Excel) or Google Ads (Campaigns → Download) and upload it here. Website-form leads
        that came from an ad are matched by the link&apos;s UTM tags, or Google&apos;s and Meta&apos;s click ids.
      </Notice>
      {canWrite ? (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From" className="w-48">
              <Select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
                <option value="">Work it out</option>
                <option value="meta">Facebook / Instagram (Meta)</option>
                <option value="google">Google Ads</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Period from (if the report has no dates)" className="w-56">
              <Input type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
            </Field>
            <Field label="to" className="w-40">
              <Input type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
            </Field>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              aria-label="Ad report file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
            <Button variant="primary" loading={upload.isPending} onClick={() => fileRef.current?.click()} icon={<FileUp className="h-4 w-4" />}>
              Upload a report
            </Button>
          </div>
          {(reports.data ?? []).length ? (
            <ul className="space-y-1 text-xs text-subtle" aria-label="Uploaded ad reports">
              {(reports.data ?? []).slice(0, 5).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {r.platform === "meta" ? "Meta" : r.platform === "google" ? "Google" : "Other"} · {r.file_name ?? "report"} ·{" "}
                    {r.period_from ? `${formatDate(r.period_from)} to ${formatDate(r.period_to)}` : ""} · {rupees(r.spend_paise)}
                  </span>
                  {canAdmin ? (
                    <Button size="sm" variant="ghost" aria-label={`Remove ${r.file_name ?? "report"}`} onClick={() => remove.mutate(r.id)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </Select>
        </div>
        <Button variant="ghost" loading={ask.isPending} disabled={!summary.data?.campaigns.length} onClick={() => ask.mutate()} icon={<Lightbulb className="h-4 w-4" />}>
          What should I change?
        </Button>
      </div>
      {advice ? (
        <Notice tone="success" title="Suggestions from these numbers">
          <ul className="list-disc space-y-1 pl-5">
            {advice.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">You make any change in Ads Manager or Google Ads; Kritvia doesn&apos;t touch your ad accounts.</p>
        </Notice>
      ) : null}
      <QueryState query={summary} loading={<SkeletonRows rows={4} />}>
        {(s: Summary) => (
          <>
            {s.platforms.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {s.platforms.map((p) => (
                  <Card key={p.platform} className="p-4">
                    <p className="mb-3 font-medium">{p.words}</p>
                    <StatGrid>
                      <Stat label="Spent" value={rupees(p.spend_paise)} />
                      <Stat label="Leads" value={p.leads} hint={p.untagged_leads ? `${p.untagged_leads} without a campaign name` : undefined} />
                      <Stat label="Per lead" value={p.cost_per_lead_paise != null ? rupees(p.cost_per_lead_paise) : "—"} />
                      <Stat label="Per sale" value={p.cost_per_won_paise != null ? rupees(p.cost_per_won_paise) : "—"} hint={`${p.won} won`} />
                    </StatGrid>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState title="No ad spend yet" description="Upload a campaign report from Meta Ads Manager or Google Ads." />
            )}
            {s.campaigns.length ? (
              <Card className="overflow-hidden p-0">
                <CardHeader title="Campaigns" description={`Since ${formatDate(s.since)}. Spend covering part of the period is counted for the days inside it.`} />
                <Table label="Ad campaigns">
                  <THead>
                    <tr>
                      <Th>Campaign</Th>
                      <Th className="text-right">Spent</Th>
                      <Th className="hidden text-right sm:table-cell">Clicks</Th>
                      <Th className="hidden text-right md:table-cell">Platform results</Th>
                      <Th className="text-right">Leads</Th>
                      <Th className="text-right">Won</Th>
                      <Th className="text-right">Per lead</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {s.campaigns.map((c) => (
                      <Tr key={`${c.platform}-${c.campaign}`}>
                        <Td>
                          {c.campaign} <Badge tone="neutral">{c.platform === "meta" ? "Meta" : c.platform === "google" ? "Google" : "other"}</Badge>
                        </Td>
                        <Td className="text-right tabular-nums">{rupees(c.spend_paise)}</Td>
                        <Td className="hidden text-right tabular-nums sm:table-cell">{c.clicks ?? "—"}</Td>
                        <Td className="hidden text-right tabular-nums md:table-cell">{c.results ?? "—"}</Td>
                        <Td className="text-right tabular-nums">{c.leads}</Td>
                        <Td className="text-right tabular-nums">{c.won}</Td>
                        <Td className="text-right tabular-nums">{c.cost_per_lead_paise != null ? rupees(c.cost_per_lead_paise) : "—"}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </Card>
            ) : null}
            {s.sources.length ? (
              <Card>
                <CardHeader title="Where all your leads came from" description="Every source, ads or not, in the same period." />
                <CardBody>
                  <ul className="grid gap-1 text-sm sm:grid-cols-2">
                    {s.sources.map((x) => (
                      <li key={x.source} className="flex justify-between gap-2">
                        <span>{SOURCE_WORDS[x.source] ?? x.source}</span>
                        <span className="tabular-nums text-muted">
                          {x.leads} lead{x.leads === 1 ? "" : "s"}, {x.won} won
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ) : null}
            {!s.tracking ? (
              <Card className="space-y-2 p-4 text-sm">
                <p className="font-medium">Tag your ad links so Kritvia knows which ad brought each lead</p>
                <p className="text-muted">
                  Add UTM tags to the link in each ad, and send them with your website form to Kritvia (the form webhook accepts utm_source, utm_medium,
                  utm_campaign, gclid and fbclid). For example:
                </p>
                <CopyField label="Example ad link" value={formUrl} />
              </Card>
            ) : null}
          </>
        )}
      </QueryState>
    </div>
  );
}
