"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatINR, formatNumber } from "@/lib/format";
import { ImportResult } from "./csv-import";
import { useRefData } from "./entity-table";

type VendorItem = Schemas["VendorItem"];
interface Form {
  vendor_code: string;
  ingredient_code: string;
  sku: string;
  pack_size: string;
  price_per_pack: string;
  min_order_packs: string;
  preferred: boolean;
}
const blank: Form = { vendor_code: "", ingredient_code: "", sku: "", pack_size: "", price_per_pack: "", min_order_packs: "1", preferred: true };

export function VendorItemsEditor({ ventureId }: { ventureId: string }) {
  const q = useQuery({
    queryKey: ["kitchen", ventureId, "vendor-items"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/vendor-items", { params: { path: { venture_id: ventureId } } })),
  });
  const vendors = useRefData(ventureId, "vendors");
  const ingredients = useRefData(ventureId, "ingredients");
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Schemas["ImportOut"] | null>(null);

  const save = useMutation({
    mutationFn: (item: VendorItem) => unwrap(api.PUT("/ventures/{venture_id}/kitchen/vendor-items", { params: { path: { venture_id: ventureId } }, body: { items: [item] } })),
    onSuccess: (out) => {
      setResult(out.errors.length ? out : null);
      if (!out.errors.length) {
        toast.success("Vendor item saved");
        setForm(null);
      }
      void qc.invalidateQueries({ queryKey: ["kitchen", ventureId, "vendor-items"] });
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });

  const submit = () => {
    if (!form) return;
    const errs: Record<string, string> = {};
    if (!form.vendor_code) errs.vendor_code = "Choose a vendor";
    if (!form.ingredient_code) errs.ingredient_code = "Choose an ingredient";
    if (!(Number(form.pack_size) > 0)) errs.pack_size = "> 0";
    if (!(Number(form.price_per_pack) >= 0) || form.price_per_pack === "") errs.price_per_pack = "₹ amount";
    if (!(Number.isInteger(Number(form.min_order_packs)) && Number(form.min_order_packs) >= 1)) errs.min_order_packs = "≥ 1";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      vendor_code: form.vendor_code,
      ingredient_code: form.ingredient_code,
      sku: form.sku.trim() || null,
      pack_size: form.pack_size,
      price_per_pack: form.price_per_pack,
      min_order_packs: Number(form.min_order_packs),
      preferred: form.preferred,
    });
  };

  const vList = (vendors.data ?? []) as { code: string; name: string }[];
  const iList = (ingredients.data ?? []) as { code: string; name: string; unit: string }[];

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <p className="text-xs text-subtle">Which vendor supplies each ingredient, in what pack and at what price. Preferred items are ordered first.</p>
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm(blank)} disabled={Boolean(form)}>
          Add item
        </Button>
      </div>
      {form ? (
        <div className="grid gap-3 border-b border-border bg-accent-soft/20 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Vendor" error={errors.vendor_code} required>
            <Select value={form.vendor_code} onChange={(e) => setForm({ ...form, vendor_code: e.target.value })}>
              <option value="">Choose…</option>
              {vList.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ingredient" error={errors.ingredient_code} required>
            <Select value={form.ingredient_code} onChange={(e) => setForm({ ...form, ingredient_code: e.target.value })}>
              <option value="">Choose…</option>
              {iList.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.name} ({x.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SKU">
            <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} maxLength={80} />
          </Field>
          <Field label="Pack size" error={errors.pack_size} hint={iList.find((i) => i.code === form.ingredient_code)?.unit} required>
            <Input inputMode="decimal" value={form.pack_size} onChange={(e) => setForm({ ...form, pack_size: e.target.value })} />
          </Field>
          <Field label="Price per pack (₹)" error={errors.price_per_pack} required>
            <Input inputMode="decimal" value={form.price_per_pack} onChange={(e) => setForm({ ...form, price_per_pack: e.target.value })} />
          </Field>
          <Field label="Minimum packs" error={errors.min_order_packs}>
            <Input inputMode="numeric" value={form.min_order_packs} onChange={(e) => setForm({ ...form, min_order_packs: e.target.value })} />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox label="Preferred" checked={form.preferred} onChange={(e) => setForm({ ...form, preferred: e.target.checked })} />
          </div>
          <div className="flex items-end justify-end gap-2">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={submit}>
              Save
            </Button>
          </div>
        </div>
      ) : null}
      {result ? (
        <div className="p-3">
          <ImportResult result={result} />
        </div>
      ) : null}
      <QueryState query={q} empty={<EmptyState title="No vendor items" description="Add vendors and ingredients, then link them here or import a CSV." />}>
        {(data) => (
          <Table label="Vendor items">
            <THead>
              <tr>
                <Th>Ingredient</Th>
                <Th>Vendor</Th>
                <Th className="hidden sm:table-cell">SKU</Th>
                <Th className="text-right">Pack</Th>
                <Th className="text-right">Price / pack</Th>
                <Th className="hidden text-right md:table-cell">Min packs</Th>
                <Th className="hidden md:table-cell">Preferred</Th>
                <Th>
                  <span className="sr-only">Edit</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {(data as Record<string, string | number | boolean | null>[]).map((r) => (
                <Tr key={`${r.vendor_code}-${r.ingredient_code}`}>
                  <Td className="font-mono text-[13px]">{String(r.ingredient_code)}</Td>
                  <Td className="font-mono text-[13px]">{String(r.vendor_code)}</Td>
                  <Td className="hidden text-muted sm:table-cell">{r.sku ? String(r.sku) : "—"}</Td>
                  <Td className="text-right whitespace-nowrap tabular-nums">
                    {formatNumber(r.pack_size as string)} {String(r.unit ?? "")}
                  </Td>
                  <Td className="text-right whitespace-nowrap tabular-nums">{formatINR(r.price_per_pack as string)}</Td>
                  <Td className="hidden text-right tabular-nums md:table-cell">{String(r.min_order_packs)}</Td>
                  <Td className="hidden md:table-cell">{r.preferred ? <Badge tone="success">preferred</Badge> : <Badge>backup</Badge>}</Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${r.ingredient_code} from ${r.vendor_code}`}
                      icon={<Pencil className="h-3.5 w-3.5" />}
                      disabled={Boolean(form)}
                      onClick={() =>
                        setForm({
                          vendor_code: String(r.vendor_code),
                          ingredient_code: String(r.ingredient_code),
                          sku: r.sku ? String(r.sku) : "",
                          pack_size: String(Number(r.pack_size)),
                          price_per_pack: String(Number(r.price_per_pack)),
                          min_order_packs: String(r.min_order_packs ?? 1),
                          preferred: Boolean(r.preferred),
                        })
                      }
                    />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </QueryState>
    </div>
  );
}
