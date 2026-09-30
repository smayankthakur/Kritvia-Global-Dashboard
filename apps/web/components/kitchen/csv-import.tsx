"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileDrop } from "@/components/ui/file-drop";
import { Notice } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, saveBlob, unwrap, type Paths, type Schemas } from "@/lib/api";

export type ImportEntity = Paths["/ventures/{venture_id}/kitchen/import/{entity}"]["post"]["parameters"]["path"]["entity"];

export const CSV_TEMPLATES: Record<ImportEntity | "sales", string> = {
  dishes: "code,name,price_inr,active\npaneer_tikka,Paneer Tikka,249,true\n",
  ingredients: "code,name,unit\npaneer,Paneer,kg\n",
  vendors: "code,name,email,phone,lead_days,active\nfresh_dairy,Fresh Dairy Co,orders@freshdairy.example,9800000000,1,true\n",
  recipes: "dish_code,ingredient_code,qty_per_portion,wastage_pct\npaneer_tikka,paneer,0.15,5\n",
  vendor_items: "vendor_code,ingredient_code,sku,pack_size,price_per_pack,min_order_packs\nfresh_dairy,paneer,PN-1KG,1,380,1\n",
  sales: "date,dish,qty,channel,revenue\n2026-09-29,paneer_tikka,42,swiggy,10458\n",
};

export function downloadTemplate(entity: ImportEntity | "sales") {
  saveBlob(new Blob([CSV_TEMPLATES[entity]], { type: "text/csv" }), `kritvia-${entity}-template.csv`);
}

export function ImportResult({ result }: { result: Schemas["ImportOut"] | null }) {
  if (!result) return null;
  return (
    <Notice tone={result.errors.length ? "warning" : "success"} title={`${result.upserted} row(s) saved`}>
      {result.errors.length ? (
        <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-4 text-xs">
          {result.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : (
        "No errors."
      )}
    </Notice>
  );
}

export function CsvImport({ ventureId, entity, label }: { ventureId: string; entity: ImportEntity; label: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<Schemas["ImportOut"] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/kitchen/import/{entity}", {
          params: { path: { venture_id: ventureId, entity } },
          body: multipart<Schemas["Body_import_csv_ventures__venture_id__kitchen_import__entity__post"]>({ file: files[0]! }),
        }),
      ),
    onSuccess: (out) => {
      setResult(out);
      setFiles([]);
      toast.success(`Imported ${label.toLowerCase()}`, `${out.upserted} row(s) saved${out.errors.length ? `, ${out.errors.length} error(s)` : ""}`);
      void qc.invalidateQueries({ queryKey: ["kitchen", ventureId] });
    },
    onError: (e) => toast.error("Import failed", errorMessage(e)),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Import {label.toLowerCase()} from CSV</h3>
        <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadTemplate(entity)}>
          CSV template
        </Button>
      </div>
      <FileDrop files={files} onChange={setFiles} accept=".csv,text/csv" label="Choose a CSV file" hint="Existing codes are updated; new codes are added" />
      <Button icon={<Upload className="h-4 w-4" />} disabled={!files.length} loading={m.isPending} onClick={() => m.mutate()}>
        Import
      </Button>
      <ImportResult result={result} />
    </div>
  );
}
