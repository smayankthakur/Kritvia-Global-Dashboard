"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, Paperclip, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { rupees, toPaise, paiseToInput } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, downloadFile, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { CURRENCIES, DOC_STATUS, INCOTERMS, MODES, TERMS, kg, minorToInput, money, partyLabel, toMinor } from "@/lib/trade";

export type Shipment = Schemas["ShipmentOut"];
type Patch = Schemas["ShipmentPatch"];
type UploadBody = Schemas["Body_upload_document_ventures__venture_id__documents_post"];

export function useShipmentSave(ventureId: string, id: string) {
  const qc = useQueryClient();
  return (s: Shipment) => qc.setQueryData(["shipment", ventureId, id], s);
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">{title}</h3>
      {children}
    </div>
  );
}

const TEXT_FIELDS = ["party_name", "party_country", "party_email", "party_phone", "party_address", "other_party", "reference",
  "incoterm", "incoterm_place", "mode", "port_loading", "port_discharge", "final_destination", "carrier", "vessel", "booking_no",
  "containers", "bl_no", "bl_date", "customs_no", "customs_date", "etd", "eta", "shipped_on", "arrived_on", "notes"] as const;
type TF = (typeof TEXT_FIELDS)[number];

function localInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Party, route, vessel, BL, customs and dates: one form, saved together. */
export function DetailsForm({ s, ventureId }: { s: Shipment; ventureId: string }) {
  const save = useShipmentSave(ventureId, s.id);
  const toast = useToast();
  const init = () => ({ ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, (s[k] as string | null) ?? ""])), cutoff_at: localInput(s.cutoff_at) }) as Record<TF | "cutoff_at", string>;
  const [f, setF] = useState(init);
  const set = (k: TF | "cutoff_at") => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const k of TEXT_FIELDS) {
        const now = f[k].trim();
        const was = ((s[k] as string | null) ?? "").trim();
        if (now !== was) body[k] = now === "" ? null : k === "party_country" ? now.toUpperCase() : now;
      }
      if (f.cutoff_at !== localInput(s.cutoff_at)) body.cutoff_at = f.cutoff_at ? new Date(f.cutoff_at).toISOString() : null;
      return unwrap(api.PATCH("/ventures/{venture_id}/shipments/{shipment_id}", { params: { path: { venture_id: ventureId, shipment_id: s.id } }, body: body as Patch }));
    },
    onSuccess: (d) => {
      save(d);
      toast.success("Saved");
    },
  });
  const ro = !s.can_edit;
  const sea = s.mode !== "air" && f.mode !== "air";
  const exp = s.direction === "export";
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset disabled={ro} className="space-y-6">
        <Section title={partyLabel(s.direction, s.for_client)}>
          <Grid>
            <Field label="Name" required>
              <Input value={f.party_name} onChange={set("party_name")} maxLength={160} />
            </Field>
            <Field label="Country (2 letters)">
              <Input value={f.party_country} onChange={set("party_country")} maxLength={2} />
            </Field>
            <Field label="Reference / PO">
              <Input value={f.reference} onChange={set("reference")} maxLength={80} />
            </Field>
            <Field label="Email">
              <Input type="email" value={f.party_email} onChange={set("party_email")} maxLength={254} />
            </Field>
            <Field label="Phone / WhatsApp">
              <Input value={f.party_phone} onChange={set("party_phone")} maxLength={24} />
            </Field>
            <Field label={exp ? "Consignee / notify party" : s.for_client ? "Buyer or seller" : "Consignee"}>
              <Input value={f.other_party} onChange={set("other_party")} maxLength={300} />
            </Field>
          </Grid>
          <Field label="Address">
            <Textarea rows={2} value={f.party_address} onChange={set("party_address")} maxLength={400} />
          </Field>
        </Section>
        <Section title="Shipping">
          <Grid>
            <Field label="Incoterm">
              <Select value={f.incoterm} onChange={set("incoterm")}>
                <option value="">—</option>
                {INCOTERMS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Incoterm place">
              <Input value={f.incoterm_place} onChange={set("incoterm_place")} maxLength={80} placeholder="e.g. Jebel Ali" />
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
            <Field label="Port of loading">
              <Input value={f.port_loading} onChange={set("port_loading")} maxLength={80} />
            </Field>
            <Field label="Port of discharge">
              <Input value={f.port_discharge} onChange={set("port_discharge")} maxLength={80} />
            </Field>
            <Field label="Final destination">
              <Input value={f.final_destination} onChange={set("final_destination")} maxLength={80} />
            </Field>
            <Field label={sea ? "Shipping line / forwarder" : "Airline / forwarder"}>
              <Input value={f.carrier} onChange={set("carrier")} maxLength={80} />
            </Field>
            <Field label={sea ? "Vessel and voyage" : "Flight"}>
              <Input value={f.vessel} onChange={set("vessel")} maxLength={80} />
            </Field>
            <Field label="Booking no.">
              <Input value={f.booking_no} onChange={set("booking_no")} maxLength={40} />
            </Field>
            <Field label="Container no(s)." className="sm:col-span-2 lg:col-span-1">
              <Input value={f.containers} onChange={set("containers")} maxLength={400} placeholder="MSCU1234567, …" />
            </Field>
            <Field label={sea ? "BL no." : "AWB no."}>
              <Input value={f.bl_no} onChange={set("bl_no")} maxLength={40} />
            </Field>
            <Field label={sea ? "BL date" : "AWB date"}>
              <Input type="date" value={f.bl_date} onChange={set("bl_date")} />
            </Field>
            <Field label={exp ? "Shipping bill no." : "Bill of entry no."}>
              <Input value={f.customs_no} onChange={set("customs_no")} maxLength={40} />
            </Field>
            <Field label={exp ? "Shipping bill date" : "Bill of entry date"}>
              <Input type="date" value={f.customs_date} onChange={set("customs_date")} />
            </Field>
          </Grid>
        </Section>
        <Section title="Dates">
          <Grid>
            <Field label="Cut-off (documents / gate-in)">
              <Input type="datetime-local" value={f.cutoff_at} onChange={set("cutoff_at")} />
            </Field>
            <Field label="ETD">
              <Input type="date" value={f.etd} onChange={set("etd")} />
            </Field>
            <Field label="ETA">
              <Input type="date" value={f.eta} onChange={set("eta")} />
            </Field>
            <Field label="Shipped on" hint="Set when you mark it shipped">
              <Input type="date" value={f.shipped_on} onChange={set("shipped_on")} />
            </Field>
            <Field label="Arrived on" hint="Set when you mark it arrived">
              <Input type="date" value={f.arrived_on} onChange={set("arrived_on")} />
            </Field>
          </Grid>
        </Section>
        <Field label="Notes">
          <Textarea rows={3} value={f.notes} onChange={set("notes")} maxLength={4000} />
        </Field>
      </fieldset>
      <FormError message={m.isError ? errorMessage(m.error) : null} />
      {ro ? null : (
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={m.isPending}>
            Save details
          </Button>
          <Button variant="ghost" onClick={() => setF(init())}>
            Undo changes
          </Button>
        </div>
      )}
    </form>
  );
}

type LineDraft = { description: string; hs_code: string; qty: string; unit: string; price: string };
type PackDraft = { marks: string; kind: string; count: string; contents: string; net_kg: string; gross_kg: string; dimensions: string };

/** Invoice lines (in the file's currency) and the packing list. */
export function LinesAndPacking({ s, ventureId }: { s: Shipment; ventureId: string }) {
  const save = useShipmentSave(ventureId, s.id);
  const toast = useToast();
  const ro = !s.can_edit;
  const [currency, setCurrency] = useState(s.currency);
  const [lines, setLines] = useState<LineDraft[]>(() =>
    s.items.map((i) => ({ description: i.description, hs_code: i.hs_code ?? "", qty: String(i.qty), unit: i.unit ?? "", price: minorToInput(i.unit_price_minor, s.currency) })),
  );
  const [packs, setPacks] = useState<PackDraft[]>(() =>
    s.packages.map((p) => ({ marks: p.marks ?? "", kind: p.kind, count: String(p.count), contents: p.contents ?? "", net_kg: p.net_kg ? String(p.net_kg) : "", gross_kg: p.gross_kg ? String(p.gross_kg) : "", dimensions: p.dimensions ?? "" })),
  );
  const [extra, setExtra] = useState({ freight: minorToInput(s.freight_minor, s.currency), insurance: minorToInput(s.insurance_minor, s.currency), value: s.items.length ? "" : minorToInput(s.value_minor, s.currency) });
  const bad = lines.find((l) => !l.description.trim() || !(Number(l.qty) > 0) || toMinor(l.price || "0", currency) === null || (l.hs_code && !/^\d{4,10}$/.test(l.hs_code)));
  const total = lines.reduce((t, l) => t + Math.round(Number(l.qty || 0) * (toMinor(l.price || "0", currency) ?? 0)), 0);
  const saveLines = useMutation({
    mutationFn: async () => {
      if (currency !== s.currency || extra.freight !== minorToInput(s.freight_minor, s.currency) || extra.insurance !== minorToInput(s.insurance_minor, s.currency) || (!lines.length && extra.value)) {
        await unwrap(
          api.PATCH("/ventures/{venture_id}/shipments/{shipment_id}", {
            params: { path: { venture_id: ventureId, shipment_id: s.id } },
            body: {
              currency,
              freight_minor: toMinor(extra.freight || "0", currency) ?? 0,
              insurance_minor: toMinor(extra.insurance || "0", currency) ?? 0,
              ...(lines.length ? {} : { value_minor: toMinor(extra.value || "0", currency) ?? 0 }),
            },
          }),
        );
      }
      return unwrap(
        api.PUT("/ventures/{venture_id}/shipments/{shipment_id}/items", {
          params: { path: { venture_id: ventureId, shipment_id: s.id } },
          body: lines.map((l) => ({ description: l.description.trim(), hs_code: l.hs_code.trim() || null, qty: l.qty, unit: l.unit.trim() || null, unit_price_minor: toMinor(l.price || "0", currency) ?? 0 })),
        }),
      );
    },
    onSuccess: (d) => {
      save(d);
      toast.success("Lines saved", `Invoice value ${money(d.value_minor, d.currency)}`);
    },
  });
  const badPack = packs.find((p) => !p.kind.trim() || !(Number(p.count) >= 1));
  const savePacks = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/shipments/{shipment_id}/packages", {
          params: { path: { venture_id: ventureId, shipment_id: s.id } },
          body: packs.map((p) => ({ marks: p.marks.trim() || null, kind: p.kind.trim(), count: Number(p.count), contents: p.contents.trim() || null, net_kg: p.net_kg || null, gross_kg: p.gross_kg || null, dimensions: p.dimensions.trim() || null })),
        }),
      ),
    onSuccess: (d) => {
      save(d);
      toast.success("Packing list saved");
    },
  });
  const sum = (k: "net_kg" | "gross_kg") => packs.reduce((t, p) => t + (Number(p[k]) || 0), 0);
  const pieces = packs.reduce((t, p) => t + (Number(p.count) || 0), 0);
  const upd = <T,>(arr: T[], setArr: (x: T[]) => void, i: number, k: keyof T) => (e: { target: { value: string } }) => setArr(arr.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Invoice lines" description="Prices in the file's currency. The invoice value is the total of the lines." />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Currency" className="w-32">
              <Select value={currency} disabled={ro} onChange={(e) => setCurrency(e.target.value)}>
                {[...new Set([s.currency, ...CURRENCIES])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label="Freight" className="w-36">
              <Input inputMode="decimal" disabled={ro} value={extra.freight} onChange={(e) => setExtra({ ...extra, freight: e.target.value })} />
            </Field>
            <Field label="Insurance" className="w-36">
              <Input inputMode="decimal" disabled={ro} value={extra.insurance} onChange={(e) => setExtra({ ...extra, insurance: e.target.value })} />
            </Field>
            {!lines.length ? (
              <Field label="Value (no lines)" hint="Or add lines below" className="w-40">
                <Input inputMode="decimal" disabled={ro} value={extra.value} onChange={(e) => setExtra({ ...extra, value: e.target.value })} />
              </Field>
            ) : null}
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(12rem,3fr)_7rem_6rem_5rem_8rem_auto]">
                <Input aria-label={`Line ${i + 1} description`} placeholder="Description" value={l.description} disabled={ro} onChange={upd(lines, setLines, i, "description")} className="col-span-2 sm:col-span-1" />
                <Input aria-label={`Line ${i + 1} HS code`} placeholder="HS code" inputMode="numeric" value={l.hs_code} disabled={ro} onChange={upd(lines, setLines, i, "hs_code")} />
                <Input aria-label={`Line ${i + 1} quantity`} placeholder="Qty" inputMode="decimal" value={l.qty} disabled={ro} onChange={upd(lines, setLines, i, "qty")} />
                <Input aria-label={`Line ${i + 1} unit`} placeholder="Unit" value={l.unit} disabled={ro} onChange={upd(lines, setLines, i, "unit")} />
                <Input aria-label={`Line ${i + 1} unit price`} placeholder="Unit price" inputMode="decimal" value={l.price} disabled={ro} onChange={upd(lines, setLines, i, "price")} />
                {ro ? null : <Button size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setLines(lines.filter((_, j) => j !== i))} />}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {ro ? <span /> : (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { description: "", hs_code: "", qty: "", unit: "", price: "" }])}>
                Add line
              </Button>
            )}
            <p className="text-sm">
              Total <strong className="tabular-nums">{money(lines.length ? total : toMinor(extra.value || "0", currency) ?? 0, currency)}</strong>
            </p>
          </div>
          <FormError message={saveLines.isError ? errorMessage(saveLines.error) : bad && lines.length ? "Each line needs a description, a quantity, a price and (if given) a 4–10 digit HS code" : null} />
          {ro ? null : (
            <Button variant="primary" loading={saveLines.isPending} disabled={Boolean(bad)} onClick={() => saveLines.mutate()}>
              Save lines
            </Button>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Packing list" description="Marks, packages, contents and weights, as printed on the packing list." />
        <CardBody className="space-y-3">
          {packs.map((p, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[8rem_7rem_5rem_minmax(8rem,2fr)_6rem_6rem_7rem_auto]">
              <Input aria-label={`Row ${i + 1} marks`} placeholder="Marks & nos." value={p.marks} disabled={ro} onChange={upd(packs, setPacks, i, "marks")} />
              <Input aria-label={`Row ${i + 1} kind of package`} placeholder="Cartons" value={p.kind} disabled={ro} onChange={upd(packs, setPacks, i, "kind")} />
              <Input aria-label={`Row ${i + 1} number of packages`} placeholder="No." inputMode="numeric" value={p.count} disabled={ro} onChange={upd(packs, setPacks, i, "count")} />
              <Input aria-label={`Row ${i + 1} contents`} placeholder="Contents" value={p.contents} disabled={ro} onChange={upd(packs, setPacks, i, "contents")} />
              <Input aria-label={`Row ${i + 1} net kg`} placeholder="Net kg" inputMode="decimal" value={p.net_kg} disabled={ro} onChange={upd(packs, setPacks, i, "net_kg")} />
              <Input aria-label={`Row ${i + 1} gross kg`} placeholder="Gross kg" inputMode="decimal" value={p.gross_kg} disabled={ro} onChange={upd(packs, setPacks, i, "gross_kg")} />
              <Input aria-label={`Row ${i + 1} dimensions`} placeholder="L×W×H cm" value={p.dimensions} disabled={ro} onChange={upd(packs, setPacks, i, "dimensions")} />
              {ro ? null : <Button size="icon" variant="ghost" aria-label={`Remove row ${i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setPacks(packs.filter((_, j) => j !== i))} />}
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {ro ? <span /> : (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setPacks([...packs, { marks: "", kind: "Cartons", count: "", contents: "", net_kg: "", gross_kg: "", dimensions: "" }])}>
                Add row
              </Button>
            )}
            <p className="text-sm text-muted">
              {pieces} package(s) · net {kg(sum("net_kg"))} · gross {kg(sum("gross_kg"))}
            </p>
          </div>
          <FormError message={savePacks.isError ? errorMessage(savePacks.error) : badPack ? "Each row needs the kind and number of packages" : null} />
          {ro ? null : (
            <Button variant="primary" loading={savePacks.isPending} disabled={Boolean(badPack)} onClick={() => savePacks.mutate()}>
              Save packing list
            </Button>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/** The document checklist: status, number and date, and the file itself (kept in business memory). */
export function DocsChecklist({ s, ventureId }: { s: Shipment; ventureId: string }) {
  const save = useShipmentSave(ventureId, s.id);
  const toast = useToast();
  const ro = !s.can_edit;
  const [adding, setAdding] = useState("");
  const [custom, setCustom] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const base = { params: { path: { venture_id: ventureId, shipment_id: s.id } } };
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["DocPatch"] }) =>
      unwrap(api.PATCH("/ventures/{venture_id}/shipments/{shipment_id}/docs/{doc_id}", { params: { path: { venture_id: ventureId, shipment_id: s.id, doc_id: id } }, body })),
    onSuccess: save,
    onError: (e) => toast.error("Couldn't save", errorMessage(e)),
  });
  const add = useMutation({
    mutationFn: (body: Schemas["DocIn"]) => unwrap(api.POST("/ventures/{venture_id}/shipments/{shipment_id}/docs", { ...base, body })),
    onSuccess: (d) => {
      save(d);
      setAdding("");
      setCustom("");
    },
    onError: (e) => toast.error("Couldn't add it", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/shipments/{shipment_id}/docs/{doc_id}", { params: { path: { venture_id: ventureId, shipment_id: s.id, doc_id: id } } })),
    onSuccess: save,
  });
  const upload = useMutation({
    mutationFn: async ({ id, file, name }: { id: string; file: File; name: string }) => {
      const r = await unwrap(
        api.POST("/ventures/{venture_id}/documents", {
          params: { path: { venture_id: ventureId } },
          body: multipart<UploadBody>({ file, title: `${s.number} – ${name}`, kind: "upload", restricted_to: null, sensitive: false, extract: false }),
        }),
      );
      return unwrap(api.PATCH("/ventures/{venture_id}/shipments/{shipment_id}/docs/{doc_id}", { params: { path: { venture_id: ventureId, shipment_id: s.id, doc_id: id } }, body: { document_id: r.document_id } }));
    },
    onSuccess: (d) => {
      save(d);
      toast.success("File attached");
    },
    onError: (e) => toast.error("Couldn't upload it", errorMessage(e)),
  });
  const stageName = Object.fromEntries(s.stages.map((x) => [x.code, x.label]));
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader title="Document checklist" description="Mark each document as it comes in. Attached files are kept in this business's memory, so the assistant can find them." />
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const d = s.docs.find((x) => x.id === uploadFor);
          if (file && d) upload.mutate({ id: d.id, file, name: d.name });
          e.target.value = "";
        }}
      />
      <ul className="divide-y divide-border">
        {s.docs.map((d) => (
          <li key={d.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(12rem,2fr)_8rem_minmax(8rem,1fr)_9rem_auto] sm:items-center">
            <div className="min-w-0">
              <p className="text-sm font-medium">{d.name}</p>
              {d.needed_by ? <p className="text-xs text-subtle">Needed by: {stageName[d.needed_by] ?? d.needed_by}</p> : null}
            </div>
            <Select aria-label={`${d.name} status`} value={d.status} disabled={ro} onChange={(e) => patch.mutate({ id: d.id, body: { status: e.target.value as Schemas["DocPatch"]["status"] } })}>
              {Object.entries(DOC_STATUS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
            <Input
              aria-label={`${d.name} number`}
              placeholder="Number"
              defaultValue={d.ref_no ?? ""}
              disabled={ro}
              maxLength={60}
              onBlur={(e) => e.target.value.trim() !== (d.ref_no ?? "") && patch.mutate({ id: d.id, body: { ref_no: e.target.value.trim() || null } })}
            />
            <Input
              aria-label={`${d.name} date`}
              type="date"
              defaultValue={d.ref_date ?? ""}
              disabled={ro}
              onBlur={(e) => e.target.value !== (d.ref_date ?? "") && patch.mutate({ id: d.id, body: { ref_date: e.target.value || null } })}
            />
            <div className="flex items-center gap-1">
              {d.document_id ? (
                <Button size="sm" variant="ghost" icon={<Eye className="h-4 w-4" />} onClick={() => void downloadFile(`/ventures/${ventureId}/documents/${d.document_id}/raw`, d.name)}>
                  File
                </Button>
              ) : null}
              {ro ? null : (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Attach a file for ${d.name}`}
                    loading={upload.isPending && uploadFor === d.id}
                    icon={<Paperclip className="h-4 w-4" />}
                    onClick={() => {
                      setUploadFor(d.id);
                      fileRef.current?.click();
                    }}
                  />
                  <Button size="icon" variant="ghost" aria-label={`Remove ${d.name} from the list`} icon={<Trash2 className="h-4 w-4" />} onClick={() => remove.mutate(d.id)} />
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {ro ? null : (
        <div className="flex flex-wrap items-end gap-2 border-t border-border p-4">
          <Field label="Add a document" className="w-64">
            <Select value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose…</option>
              {s.extra_docs.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.label}
                </option>
              ))}
              <option value="__custom">Something else…</option>
            </Select>
          </Field>
          {adding === "__custom" ? (
            <Field label="Its name" className="w-64">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={80} placeholder="e.g. Halal certificate" />
            </Field>
          ) : null}
          <Button
            variant="primary"
            loading={add.isPending}
            disabled={!adding || (adding === "__custom" && !custom.trim())}
            onClick={() => add.mutate(adding === "__custom" ? { name: custom.trim() } : { code: adding })}
          >
            Add
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Payment terms, LC, money received or paid, realisation; a C&F job's fee and bill. */
export function MoneyForm({ s, ventureId }: { s: Shipment; ventureId: string }) {
  const save = useShipmentSave(ventureId, s.id);
  const toast = useToast();
  const ro = !s.can_edit;
  const exp = s.direction === "export" && !s.for_client;
  const init = () => ({
    payment_terms: s.payment_terms ?? "",
    payment_days: s.payment_days === null || s.payment_days === undefined ? "" : String(s.payment_days),
    lc_no: s.lc_no ?? "",
    lc_expiry: s.lc_expiry ?? "",
    lc_last_shipment: s.lc_last_shipment ?? "",
    received: minorToInput(s.received_minor, s.currency),
    realise_by: s.realise_by ?? "",
    realised_on: s.realised_on ?? "",
    brc_no: s.brc_no ?? "",
    duty: paiseToInput(s.duty_paise),
    fee: paiseToInput(s.fee_paise),
    reimb: paiseToInput(s.reimbursable_paise),
    lut: s.lut,
  });
  const [f, setF] = useState(init);
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const inr = (v: string) => (v.trim() ? toPaise(v) : null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/ventures/{venture_id}/shipments/{shipment_id}", {
          params: { path: { venture_id: ventureId, shipment_id: s.id } },
          body: {
            payment_terms: (f.payment_terms || null) as Patch["payment_terms"],
            payment_days: f.payment_days === "" ? null : Number(f.payment_days),
            lc_no: f.lc_no.trim() || null,
            lc_expiry: f.lc_expiry || null,
            lc_last_shipment: f.lc_last_shipment || null,
            received_minor: toMinor(f.received || "0", s.currency) ?? 0,
            realise_by: f.realise_by || null,
            realised_on: f.realised_on || null,
            brc_no: f.brc_no.trim() || null,
            duty_paise: inr(f.duty),
            fee_paise: inr(f.fee),
            reimbursable_paise: inr(f.reimb),
            lut: f.lut,
          },
        }),
      ),
    onSuccess: (d) => {
      save(d);
      toast.success("Saved");
    },
  });
  const bill = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/shipments/{shipment_id}/bill", { params: { path: { venture_id: ventureId, shipment_id: s.id } } })),
    onSuccess: async (b) => {
      toast.success("Bill made", `${rupees(b.amount_paise)}: it's on the Invoices page, and payment reminders follow it.`);
      save(await unwrap(api.GET("/ventures/{venture_id}/shipments/{shipment_id}", { params: { path: { venture_id: ventureId, shipment_id: s.id } } })));
    },
    onError: (e) => toast.error("Couldn't bill it", errorMessage(e)),
  });
  const owed = s.value_minor - s.received_minor;
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset disabled={ro} className="space-y-6">
        {!s.for_client ? (
          <Section title={exp ? "Getting paid" : "Paying the supplier"}>
            <Grid>
              <Field label="Payment terms">
                <Select value={f.payment_terms} onChange={set("payment_terms")}>
                  <option value="">—</option>
                  {Object.entries(TERMS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Days (credit / usance)">
                <Input inputMode="numeric" value={f.payment_days} onChange={set("payment_days")} />
              </Field>
              <Field label={`${exp ? "Received" : "Paid"} so far (${s.currency})`} hint={`Invoice value ${money(s.value_minor, s.currency)}${owed > 0 && s.received_minor ? `; ${money(owed, s.currency)} to go` : ""}`}>
                <Input inputMode="decimal" value={f.received} onChange={set("received")} />
              </Field>
            </Grid>
            {f.payment_terms === "lc" ? (
              <Grid>
                <Field label="LC no.">
                  <Input value={f.lc_no} onChange={set("lc_no")} maxLength={40} />
                </Field>
                <Field label="LC latest shipment date">
                  <Input type="date" value={f.lc_last_shipment} onChange={set("lc_last_shipment")} />
                </Field>
                <Field label="LC expiry">
                  <Input type="date" value={f.lc_expiry} onChange={set("lc_expiry")} />
                </Field>
              </Grid>
            ) : null}
            {exp ? (
              <Grid>
                <Field label="Realise proceeds by" hint="Shipment date plus the months on your trade profile (RBI rule)">
                  <Input type="date" value={f.realise_by} onChange={set("realise_by")} />
                </Field>
                <Field label="Realised on">
                  <Input type="date" value={f.realised_on} onChange={set("realised_on")} />
                </Field>
                <Field label="BRC / eBRC no.">
                  <Input value={f.brc_no} onChange={set("brc_no")} maxLength={40} />
                </Field>
              </Grid>
            ) : null}
            {exp ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-[var(--accent)]" checked={f.lut} onChange={(e) => setF({ ...f, lut: e.target.checked })} />
                Export under LUT without paying IGST (printed on the invoice)
              </label>
            ) : (
              <Grid>
                <Field label="Customs duty paid (₹)">
                  <Input inputMode="decimal" value={f.duty} onChange={set("duty")} />
                </Field>
              </Grid>
            )}
          </Section>
        ) : (
          <Section title="Job charges (₹)">
            <Grid>
              <Field label="Agency fee">
                <Input inputMode="decimal" value={f.fee} onChange={set("fee")} />
              </Field>
              <Field label="Reimbursable costs" hint="Duty, port, CFS, shipping line charges paid for the client">
                <Input inputMode="decimal" value={f.reimb} onChange={set("reimb")} />
              </Field>
              {s.direction === "import" ? (
                <Field label="Customs duty (₹)">
                  <Input inputMode="decimal" value={f.duty} onChange={set("duty")} />
                </Field>
              ) : null}
            </Grid>
          </Section>
        )}
      </fieldset>
      <FormError message={m.isError ? errorMessage(m.error) : null} />
      {ro ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={m.isPending}>
            Save
          </Button>
          {s.for_client ? (
            s.invoice_id ? (
              <Badge tone="success">Billed</Badge>
            ) : (
              <Button loading={bill.isPending} disabled={!(s.fee_paise || s.reimbursable_paise)} onClick={() => bill.mutate()} title="Save the charges first">
                Bill the client
              </Button>
            )
          ) : null}
        </div>
      )}
    </form>
  );
}

export function Timeline({ s, ventureId }: { s: Shipment; ventureId: string }) {
  const save = useShipmentSave(ventureId, s.id);
  const [note, setNote] = useState("");
  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/shipments/{shipment_id}/notes", { params: { path: { venture_id: ventureId, shipment_id: s.id } }, body: { text: note.trim() } })),
    onSuccess: (d) => {
      save(d);
      setNote("");
    },
  });
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader title="Timeline" description="Stage changes, payments, documents, updates sent and notes." />
      {s.can_edit ? (
        <form
          className="flex gap-2 border-b border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) add.mutate();
          }}
        >
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note, e.g. Shipping line confirmed the booking" aria-label="Note" />
          <Button type="submit" loading={add.isPending} disabled={!note.trim()}>
            Add
          </Button>
        </form>
      ) : null}
      <ul className="divide-y divide-border">
        {s.events.map((e, i) => (
          <li key={i} className="px-4 py-2.5 text-sm">
            <p>{e.text}</p>
            <p className="text-xs text-subtle">
              {formatDateTime(e.at)}
              {e.by ? ` · ${e.by}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
