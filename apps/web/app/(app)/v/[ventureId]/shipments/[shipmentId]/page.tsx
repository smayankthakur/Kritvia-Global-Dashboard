"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FileText, Package, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { DetailsForm, DocsChecklist, LinesAndPacking, MoneyForm, Timeline, type Shipment } from "@/components/trade/shipment-parts";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Select, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { FILE_KINDS, fileKind, money, partyLabel, stageTone } from "@/lib/trade";
import { useVenture } from "@/lib/venture";

const TONE = { urgent: "danger", soon: "warning", info: "info" } as const;

function Stages({ s, ventureId }: { s: Shipment; ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const move = useMutation({
    mutationFn: (stage: string) =>
      unwrap(api.PATCH("/ventures/{venture_id}/shipments/{shipment_id}", { params: { path: { venture_id: ventureId, shipment_id: s.id } }, body: { stage: stage as NonNullable<Schemas["ShipmentPatch"]["stage"]> } })),
    onSuccess: (d) => {
      qc.setQueryData(["shipment", ventureId, s.id], d);
      toast.success(`Moved to ${d.stage_label}`);
    },
    onError: (e) => toast.error("Couldn't move it", errorMessage(e)),
  });
  const flow = s.stages.filter((x) => x.code !== "cancelled");
  const at = flow.findIndex((x) => x.code === s.stage);
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Stages">
      {flow.map((x, i) => {
        const done = at >= 0 && i < at;
        const now = x.code === s.stage;
        return (
          <li key={x.code}>
            <button
              type="button"
              disabled={!s.can_edit || now || move.isPending}
              onClick={() => move.mutate(x.code)}
              aria-current={now ? "step" : undefined}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors ${
                now ? "border-accent bg-accent text-white" : done ? "border-success/40 bg-success-soft text-success-fg" : "border-border text-muted hover:bg-surface-2"
              } disabled:cursor-default`}
            >
              {done ? <Check className="h-3 w-3" aria-hidden /> : null}
              {x.label}
            </button>
          </li>
        );
      })}
      {s.can_edit && s.stage !== "cancelled" ? (
        <li>
          <button type="button" className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-subtle hover:bg-surface-2" onClick={() => move.mutate("cancelled")}>
            Cancel file
          </button>
        </li>
      ) : null}
    </ol>
  );
}

function SendUpdate({ s, ventureId, onClose }: { s: Shipment; ventureId: string; onClose: () => void }) {
  const toast = useToast();
  const [channel, setChannel] = useState<"email" | "whatsapp">(s.party_email ? "email" : "whatsapp");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/shipments/{shipment_id}/update", { params: { path: { venture_id: ventureId, shipment_id: s.id } }, body: { channel, note: note.trim() } })),
    onSuccess: () => {
      toast.success("Update drafted", "It waits for a yes in Approvals before it goes out.");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send an update to ${s.party_name}`}
      description={`Written from the file: ${s.stage_label.toLowerCase()}, vessel, BL, containers and dates. Nothing goes out until someone approves it.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={m.isPending} disabled={channel === "email" ? !s.party_email : !s.party_phone} onClick={() => m.mutate()}>
            Draft the update
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Send by" hint={channel === "whatsapp" ? "WhatsApp only reaches people who wrote to you in the last 24 hours." : undefined}>
          <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option value="email" disabled={!s.party_email}>
              Email {s.party_email ? `(${s.party_email})` : "(no address on the file)"}
            </option>
            <option value="whatsapp" disabled={!s.party_phone}>
              WhatsApp {s.party_phone ? `(${s.party_phone})` : "(no number on the file)"}
            </option>
          </Select>
        </Field>
        <Field label="Add a line (optional)">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} placeholder="e.g. Original documents couriered today by DHL 1234567890." />
        </Field>
        <FormError message={m.isError ? errorMessage(m.error) : null} />
      </div>
    </Dialog>
  );
}

export default function ShipmentPage() {
  const v = useVenture();
  const router = useRouter();
  const toast = useToast();
  const { shipmentId } = useParams<{ shipmentId: string }>();
  const [tab, setTab] = useState("details");
  const [updating, setUpdating] = useState(false);
  const [sure, setSure] = useState(false);
  const q = useQuery({
    queryKey: ["shipment", v.id, shipmentId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/shipments/{shipment_id}", { params: { path: { venture_id: v.id, shipment_id: shipmentId } } })),
  });
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/shipments/{shipment_id}", { params: { path: { venture_id: v.id, shipment_id: shipmentId } } })),
    onSuccess: () => {
      toast.success("File deleted");
      router.push(`/v/${v.id}/shipments`);
    },
    onError: (e) => toast.error("Couldn't delete it", errorMessage(e)),
  });

  return (
    <QueryState query={q} loading={<SkeletonRows rows={6} />}>
      {(s) => (
        <>
          <Link href={`/v/${v.id}/shipments`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Shipments
          </Link>
          <PageHeader
            eyebrow={FILE_KINDS[fileKind(s.direction, s.for_client)].label}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {s.number} <Badge tone={stageTone(s.stage)}>{s.stage_label}</Badge>
              </span>
            }
            description={`${partyLabel(s.direction, s.for_client)}: ${s.party_name}${s.party_country ? ` (${s.party_country})` : ""}${s.reference ? ` · Ref. ${s.reference}` : ""}${s.value_minor ? ` · ${money(s.value_minor, s.currency)}` : ""}${s.last_update_at ? ` · last update sent ${formatRelative(s.last_update_at)}` : ""}`}
            actions={
              <>
                {s.direction === "export" && !s.for_client ? (
                  <>
                    <ButtonLink href={`/print/shipment/${v.id}/${s.id}?doc=invoice`} target="_blank" icon={<FileText className="h-4 w-4" />}>
                      Export invoice
                    </ButtonLink>
                    <ButtonLink href={`/print/shipment/${v.id}/${s.id}?doc=packing`} target="_blank" icon={<Package className="h-4 w-4" />}>
                      Packing list
                    </ButtonLink>
                  </>
                ) : null}
                {s.can_edit ? (
                  <Button variant="primary" icon={<Send className="h-4 w-4" />} onClick={() => setUpdating(true)}>
                    Send update
                  </Button>
                ) : null}
              </>
            }
          />
          <Card className="mb-4 p-3">
            <Stages s={s} ventureId={v.id} />
          </Card>
          {s.alerts.length ? (
            <div className="mb-4 space-y-2">
              {s.alerts.map((a, i) => (
                <Notice key={i} tone={TONE[a.level] === "danger" ? "danger" : TONE[a.level] === "warning" ? "warning" : "info"}>
                  {a.text}
                </Notice>
              ))}
            </div>
          ) : null}
          <Tabs
            label="Shipment file"
            value={tab}
            onChange={setTab}
            className="mb-4"
            items={[
              { id: "details", label: "Details" },
              ...(s.for_client ? [] : [{ id: "lines", label: "Lines & packing" }]),
              { id: "docs", label: "Documents", count: s.docs_needed || undefined },
              { id: "money", label: s.for_client ? "Charges" : "Money" },
              { id: "timeline", label: "Timeline" },
            ]}
          />
          {tab === "details" ? <DetailsForm key={s.updated_at} s={s} ventureId={v.id} /> : null}
          {tab === "lines" ? <LinesAndPacking s={s} ventureId={v.id} /> : null}
          {tab === "docs" ? <DocsChecklist s={s} ventureId={v.id} /> : null}
          {tab === "money" ? <MoneyForm key={s.updated_at} s={s} ventureId={v.id} /> : null}
          {tab === "timeline" ? <Timeline s={s} ventureId={v.id} /> : null}
          {v.can_admin || v.is_owner ? (
            <div className="mt-8 flex justify-end">
              {sure ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
                    Delete this file for good
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
                    Keep it
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setSure(true)}>
                  Delete file…
                </Button>
              )}
            </div>
          ) : null}
          {updating ? <SendUpdate s={s} ventureId={v.id} onClose={() => setUpdating(false)} /> : null}
        </>
      )}
    </QueryState>
  );
}
