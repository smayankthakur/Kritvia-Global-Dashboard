"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { ImportResult } from "./csv-import";
import { useRefData } from "./entity-table";

interface Line {
  ingredient_code: string;
  qty_per_portion: string;
  wastage_pct: string;
}

export function RecipesEditor({ ventureId }: { ventureId: string }) {
  const dishes = useRefData(ventureId, "dishes");
  const ingredients = useRefData(ventureId, "ingredients");
  const recipes = useQuery({
    queryKey: ["kitchen", ventureId, "recipes"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/recipes", { params: { path: { venture_id: ventureId } } })),
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [dish, setDish] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ upserted: number; errors: string[] } | null>(null);

  const dishList = useMemo(() => (dishes.data ?? []) as { code: string; name: string }[], [dishes.data]);
  const ingList = useMemo(() => (ingredients.data ?? []) as { code: string; name: string; unit: string }[], [ingredients.data]);
  const unitOf = (code: string) => ingList.find((i) => i.code === code)?.unit ?? "";

  useEffect(() => {
    if (!dish && dishList.length) setDish(dishList[0]!.code);
  }, [dish, dishList]);

  useEffect(() => {
    const r = (recipes.data as Record<string, { ingredient_code: string; qty_per_portion: string | number; wastage_pct: string | number }[]> | undefined)?.[dish] ?? [];
    setLines(r.map((l) => ({ ingredient_code: l.ingredient_code, qty_per_portion: String(Number(l.qty_per_portion)), wastage_pct: String(Number(l.wastage_pct)) })));
    setErrors({});
    setResult(null);
  }, [dish, recipes.data]);

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/kitchen/recipes", {
          params: { path: { venture_id: ventureId } },
          body: { recipes: { [dish]: lines.map((l) => ({ ingredient_code: l.ingredient_code, qty_per_portion: l.qty_per_portion, wastage_pct: l.wastage_pct || "0" })) } },
        }),
      ),
    onSuccess: (out) => {
      setResult(out);
      if (!out.errors.length) toast.success("Recipe saved");
      void qc.invalidateQueries({ queryKey: ["kitchen", ventureId, "recipes"] });
    },
    onError: (e) => toast.error("Could not save recipe", errorMessage(e)),
  });

  const submit = () => {
    const errs: Record<string, string> = {};
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (!l.ingredient_code) errs[`${i}.ing`] = "Choose";
      else if (seen.has(l.ingredient_code)) errs[`${i}.ing`] = "Duplicate";
      seen.add(l.ingredient_code);
      if (!(Number(l.qty_per_portion) > 0)) errs[`${i}.qty`] = "> 0";
      const w = Number(l.wastage_pct || 0);
      if (!(w >= 0 && w <= 100)) errs[`${i}.w`] = "0–100";
    });
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  if (dishes.isPending || recipes.isPending) return <SkeletonRows />;
  if (dishes.isError) return <ErrorState error={dishes.error} />;
  if (recipes.isError) return <ErrorState error={recipes.error} />;
  if (!dishList.length) return <EmptyState title="Add dishes first" description="Recipes map each dish to ingredient quantities per portion." />;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Dish" className="w-64">
          <Select value={dish} onChange={(e) => setDish(e.target.value)}>
            {dishList.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name} ({d.code})
              </option>
            ))}
          </Select>
        </Field>
        <p className="pb-2 text-xs text-subtle">Saving replaces this dish&apos;s recipe.</p>
      </div>
      {!ingList.length ? <p className="text-sm text-subtle">Add ingredients first.</p> : null}
      <div className="space-y-2">
        <div className="hidden grid-cols-[1fr_9rem_8rem_2.25rem] gap-2 text-xs font-medium text-subtle uppercase sm:grid">
          <span>Ingredient</span>
          <span>Qty / portion</span>
          <span>Wastage %</span>
          <span />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_9rem_8rem_2.25rem]">
            <Field label="Ingredient" srLabel error={errors[`${i}.ing`]} className="col-span-2 sm:col-span-1">
              <Select value={l.ingredient_code} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ingredient_code: e.target.value } : x)))}>
                <option value="">Choose ingredient…</option>
                {ingList.map((g) => (
                  <option key={g.code} value={g.code}>
                    {g.name} ({g.unit})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quantity per portion" srLabel error={errors[`${i}.qty`]} hint={unitOf(l.ingredient_code) || undefined}>
              <Input inputMode="decimal" value={l.qty_per_portion} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty_per_portion: e.target.value } : x)))} />
            </Field>
            <Field label="Wastage percent" srLabel error={errors[`${i}.w`]}>
              <Input inputMode="decimal" value={l.wastage_pct} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, wastage_pct: e.target.value } : x)))} />
            </Field>
            <Button variant="ghost" size="icon" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {!lines.length ? <p className="text-sm text-subtle">No recipe yet for this dish.</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setLines((ls) => [...ls, { ingredient_code: "", qty_per_portion: "", wastage_pct: "0" }])}>
          Add ingredient
        </Button>
        <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={submit} disabled={!dish}>
          Save recipe
        </Button>
      </div>
      <ImportResult result={result} />
    </div>
  );
}
