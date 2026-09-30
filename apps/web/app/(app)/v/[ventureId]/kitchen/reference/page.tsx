"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CsvImport, type ImportEntity } from "@/components/kitchen/csv-import";
import { EntityTable, type Column } from "@/components/kitchen/entity-table";
import { RecipesEditor } from "@/components/kitchen/recipes-editor";
import { VendorItemsEditor } from "@/components/kitchen/vendor-items";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

const CODE = /^[a-z0-9_-]{1,60}$/;
const CODE_HINT = "a–z, 0–9, - or _";
const UNITS = ["kg", "g", "l", "ml", "pcs", "dozen", "pack"] as const;

const COLUMNS: Record<"dishes" | "ingredients" | "vendors", Column[]> = {
  dishes: [
    { key: "code", label: "Code", required: true, pattern: CODE, hint: CODE_HINT, mono: true },
    { key: "name", label: "Name", required: true },
    { key: "price_inr", label: "Price", type: "money", hideBelow: "sm" },
    { key: "active", label: "Active", type: "bool", hideBelow: "md" },
  ],
  ingredients: [
    { key: "code", label: "Code", required: true, pattern: CODE, hint: CODE_HINT, mono: true },
    { key: "name", label: "Name", required: true },
    { key: "unit", label: "Unit", type: "select", options: UNITS, required: true },
  ],
  vendors: [
    { key: "code", label: "Code", required: true, pattern: CODE, hint: CODE_HINT, mono: true },
    { key: "name", label: "Name", required: true },
    { key: "email", label: "Email", type: "email", hideBelow: "md", pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, hint: "Valid email" },
    { key: "phone", label: "Phone", hideBelow: "lg" },
    { key: "lead_days", label: "Lead days", type: "number", hideBelow: "lg" },
    { key: "active", label: "Active", type: "bool", hideBelow: "md" },
  ],
};

const TABS = [
  { id: "dishes", label: "Dishes", noun: "Dish" },
  { id: "ingredients", label: "Ingredients", noun: "Ingredient" },
  { id: "vendors", label: "Vendors", noun: "Vendor" },
  { id: "recipes", label: "Recipes", noun: "Recipe" },
  { id: "vendor_items", label: "Vendor items", noun: "Vendor item" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function ReferenceView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "dishes") as TabId;
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Reference data"
        description="Dishes, ingredients, recipes and vendors the daily plan works from. Keep codes stable — sales and recipes refer to them."
      />
      <Tabs
        label="Reference data"
        items={TABS.map((t) => ({ id: t.id, label: t.label }))}
        value={tab}
        onChange={(id) => router.replace(`/v/${v.id}/kitchen/reference?tab=${id}`, { scroll: false })}
        className="mb-4"
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card className="overflow-hidden">
          {tab === "recipes" ? (
            <RecipesEditor ventureId={v.id} />
          ) : tab === "vendor_items" ? (
            <VendorItemsEditor ventureId={v.id} />
          ) : (
            <EntityTable key={tab} ventureId={v.id} entity={tab} columns={COLUMNS[tab]} noun={current.noun} />
          )}
        </Card>
        <Card className="h-fit p-4">
          <CsvImport key={tab} ventureId={v.id} entity={tab as ImportEntity} label={current.label} />
        </Card>
      </div>
    </>
  );
}

export default function ReferencePage() {
  return (
    <Suspense>
      <ReferenceView />
    </Suspense>
  );
}
