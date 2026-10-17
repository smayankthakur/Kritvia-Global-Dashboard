"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, Search, Ship } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CURRENCIES, FILE_KINDS, INCOTERMS, MODES, fileKind, money, stageTone, type FileKind } from "@/lib/trade";
import { useVenture } from "@/lib/venture";

type Row = Schemas["ShipmentRow"];
const LEVEL_TONE = { urgent: "danger", soon: "warning", info: "info" } as const;

function NewFile({ open, onClose, ventureId, roles, currency }: { open: boolean; onClose: () => void; ventureId: string; roles: string[]; currency: string }) {
  const router = useRouter();
  const kinds = (Object.keys(FILE_KINDS) as FileKind[]).filter((k) => !roles.length || roles.includes(FILE_KINDS[k].role));
  const [kind, setKind] = useState<FileKind>(kinds[0] ?? "export");
  const [f, setF] = useState({ party_name: "", party_country: "", party_email: "", party_phone: "", reference: "", incoterm: "", mode: "sea", port_loading: "", port_discharge: "", etd: "", eta: "", currency: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const fk = FILE_KINDS[kind];
  const make = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/shipments", {
          params: { path: { venture_id: ventureId } },
          body: {
            direction: fk.direction,
            for_client: fk.for_client,
            party_name: f.party_name.trim(),
            party_country: f.party_country.trim() || null,
            party_email: f.party_email.trim() || null,
            party_phone: f.party_phone.trim() || null,
            reference: f.reference.trim() || null,
            incoterm: (f.incoterm || null) as Schemas["ShipmentIn"]["incoterm"],
            mode: f.mode as Schemas["ShipmentIn"]["mode"],
            port_loading: f.port_loading.trim() || null,
            port_discharge: f.port_discharge.trim() || null,
            etd: f.etd || null,
            eta: f.eta || null,
            currency: f.currency || currency,
          },
        }),
      ),
    onSuccess: (s) => router.push(`/v/${ventureId}/shipments/${s.id}`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.party_name.trim()) make.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="New shipment file" description="It gets the next number and a document checklist for its kind." size="lg">
      <form onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Kind of file</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.map((k) => (
              <label key={k} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${kind === k ? "border-accent bg-accent-soft" : "border-border"}`}>
                <input type="radio" name="kind" className="mt-0.5 accent-[var(--accent)]" checked={kind === k} onChange={() => setKind(k)} />
                <span>
                  <span className="block font-medium">{FILE_KINDS[k].label}</span>
                  <span className="block text-xs text-subtle">{FILE_KINDS[k].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={fk.party} required>
            <Input value={f.party_name} onChange={set("party_name")} maxLength={160} autoFocus />
          </Field>
          <Field label="Country" hint="Two letters, e.g. AE, US, DE">
            <Input value={f.party_country} onChange={set("party_country")} maxLength={2} autoCapitalize="characters" />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.party_email} onChange={set("party_email")} maxLength={254} />
          </Field>
          <Field label="Phone / WhatsApp" hint="With country code, e.g. +971 50 123 4567">
            <Input value={f.party_phone} onChange={set("party_phone")} maxLength={24} />
          </Field>
          <Field label={fk.for_client ? "Client's reference" : fk.direction === "export" ? "Buyer's PO / reference" : "Our PO / reference"}>
            <Input value={f.reference} onChange={set("reference")} maxLength={80} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Incoterm">
              <Select value={f.incoterm} onChange={set("incoterm")}>
                <option value="">—</option>
                {INCOTERMS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Mode">
              <Select value={f.mode} onChange={set("mode")}>
                {Object.entries(MODES).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Port / airport of loading">
            <Input value={f.port_loading} onChange={set("port_loading")} maxLength={80} placeholder={fk.direction === "export" ? "Nhava Sheva (INNSA1)" : "Shanghai"} />
          </Field>
          <Field label="Port / airport of discharge">
            <Input value={f.port_discharge} onChange={set("port_discharge")} maxLength={80} placeholder={fk.direction === "export" ? "Jebel Ali" : "Mundra (INMUN1)"} />
          </Field>
          <Field label="ETD (sailing)">
            <Input type="date" value={f.etd} onChange={set("etd")} />
          </Field>
          <Field label="ETA (arrival)">
            <Input type="date" value={f.eta} onChange={set("eta")} />
          </Field>
          <Field label="Currency" hint="Of the invoice value">
            <Select value={f.currency || currency} onChange={set("currency")}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        <FormError message={make.isError ? errorMessage(make.error) : null} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={make.isPending} disabled={!f.party_name.trim()}>
            Open the file
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function ShipmentsPage() {
  const v = useVenture();
  const [show, setShow] = useState<"open" | "closed" | "all">("open");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ["shipments", v.id, show, q],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/shipments", { params: { path: { venture_id: v.id }, query: { show, q: q.trim() || undefined } } })),
  });
  const profile = useQuery({
    queryKey: ["trade-profile", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/trade-profile", { params: { path: { venture_id: v.id } } })),
  });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Shipments"
        description="One file per consignment: documents, dates, money and updates to the buyer, supplier or client, in one place."
        actions={
          <>
            <ButtonLink href={`/v/${v.id}/trade-profile`}>Trade profile</ButtonLink>
            {list.data?.can_edit ? (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                New file
              </Button>
            ) : null}
          </>
        }
      />
      {profile.data && !profile.data.configured ? (
        <Notice tone="info" className="mb-4" title="Add your trade profile">
          Your IEC, address, AD code, LUT and bank details go on every export invoice and packing list.{" "}
          <Link href={`/v/${v.id}/trade-profile`} className="font-medium underline">
            Set it up
          </Link>
        </Notice>
      ) : null}
      {list.data?.profile_alert ? (
        <Notice tone={list.data.profile_alert.level === "urgent" ? "danger" : list.data.profile_alert.level === "soon" ? "warning" : "info"} className="mb-4">
          {list.data.profile_alert.text}
        </Notice>
      ) : null}
      {list.data?.attention.length ? (
        <Card className="mb-6 overflow-hidden p-0">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden /> Needs attention
              </span>
            }
            description="From each file's cut-off, sailing and arrival dates, LC, payments and checklist. The Shipment watch agent sends this list every morning."
          />
          <ul className="divide-y divide-border">
            {list.data.attention.slice(0, 12).map((a, i) => (
              <li key={`${a.shipment_id}-${i}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <Badge tone={LEVEL_TONE[a.level]}>{a.level === "urgent" ? "Urgent" : a.level === "soon" ? "Soon" : "Note"}</Badge>
                <Link href={`/v/${v.id}/shipments/${a.shipment_id}`} className="font-medium hover:underline">
                  {a.number}
                </Link>
                <span className="text-muted">{a.party_name}:</span>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
          <Tabs
            label="Which files"
            value={show}
            onChange={(x) => setShow(x as typeof show)}
            items={[
              { id: "open", label: "Open" },
              { id: "closed", label: "Closed" },
              { id: "all", label: "All" },
            ]}
          />
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="File, party, BL, container…" aria-label="Search shipments" />
          </div>
        </div>
        <QueryState query={list} loading={<SkeletonRows rows={4} className="p-3" />}>
          {(d) =>
            d.items.length ? (
              <Table label="Shipment files">
                <THead>
                  <Tr>
                    <Th>File</Th>
                    <Th>Party</Th>
                    <Th>Stage</Th>
                    <Th>Route</Th>
                    <Th>ETD / ETA</Th>
                    <Th>Documents</Th>
                    <Th className="text-right">Value</Th>
                  </Tr>
                </THead>
                <TBody>
                  {d.items.map((s: Row) => (
                    <Tr key={s.id} interactive>
                      <Td>
                        <Link href={`/v/${v.id}/shipments/${s.id}`} className="font-medium hover:underline">
                          {s.number}
                        </Link>
                        <span className="block text-xs text-subtle">{FILE_KINDS[fileKind(s.direction, s.for_client)].label}</span>
                      </Td>
                      <Td>
                        {s.party_name}
                        {s.party_country ? <span className="ml-1 text-xs text-subtle">{s.party_country}</span> : null}
                        {s.reference ? <span className="block text-xs text-subtle">Ref. {s.reference}</span> : null}
                      </Td>
                      <Td>
                        <Badge tone={stageTone(s.stage)}>{s.stage_label}</Badge>
                        {s.alerts.some((a) => a.level === "urgent") ? <Badge tone="danger" className="ml-1">!</Badge> : null}
                      </Td>
                      <Td className="text-muted">
                        {s.port_loading || "—"} → {s.port_discharge || "—"}
                        <span className="block text-xs text-subtle">
                          {MODES[s.mode]}
                          {s.incoterm ? ` · ${s.incoterm}` : ""}
                        </span>
                      </Td>
                      <Td className="text-muted">
                        {s.etd ? formatDate(s.etd) : "—"}
                        <span className="block">{s.eta ? formatDate(s.eta) : "—"}</span>
                      </Td>
                      <Td>{s.docs_needed ? <Badge tone="warning">{s.docs_needed} needed</Badge> : <Badge tone="success">All in</Badge>}</Td>
                      <Td className="text-right tabular-nums">{s.value_minor ? money(s.value_minor, s.currency) : "—"}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState
                icon={Ship}
                title={q ? "No files match" : show === "open" ? "No open shipment files" : "No files here"}
                description={d.can_edit && !q ? "Open a file for each export, import or C&F job: it tracks documents, dates, money and updates." : undefined}
                action={
                  d.can_edit && !q ? (
                    <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                      New file
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        </QueryState>
      </Card>
      {adding ? (
        <NewFile open onClose={() => setAdding(false)} ventureId={v.id} roles={list.data?.roles ?? []} currency={profile.data?.configured ? profile.data.default_currency : "USD"} />
      ) : null}
    </>
  );
}
