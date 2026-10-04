"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { accessKey, useAccess, type VentureKind } from "@/lib/access";
import { ApiError, api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { KIND_LABEL } from "@/lib/nav";
import { SLUG_RE, slugify } from "@/lib/slug";

type Venture = Schemas["VentureOut"];
const KINDS: VentureKind[] = ["software", "finance", "kitchen", "general"];

/** Owners add, rename and remove the businesses in their organisation. */
export default function BusinessesPage() {
  const { org, isOwner } = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const listKey = ["ventures", org?.id];
  const removedKey = ["ventures-removed", org?.id];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/ventures", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org),
  });
  const removed = useQuery({
    queryKey: removedKey,
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/ventures/removed", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org && isOwner),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: listKey });
    void qc.invalidateQueries({ queryKey: removedKey });
    void qc.invalidateQueries({ queryKey: accessKey });
  };

  const [toRemove, setToRemove] = useState<Venture | null>(null);
  const remove = useMutation({
    mutationFn: (v: Venture) =>
      unwrap(api.POST("/orgs/{org_id}/ventures/{venture_id}/remove", { params: { path: { org_id: org!.id, venture_id: v.id } }, body: { confirm: v.name } })),
    onSuccess: (_d, v) => {
      setToRemove(null);
      refresh();
      toast.success(`${v.name} removed`, "You can restore it for 30 days.");
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/orgs/{org_id}/ventures/{venture_id}/restore", { params: { path: { org_id: org!.id, venture_id: id } } })),
    onSuccess: () => {
      refresh();
      toast.success("Business restored", "Its agents are off and connectors need reconnecting: turn them on in its Settings.");
    },
    onError: (e) => toast.error("Could not restore", errorMessage(e)),
  });

  if (!org || list.isPending) return <SkeletonRows rows={6} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  const ventures = list.data;

  return (
    <div className="space-y-6">
      <PageHeader title="Businesses" description="Each business has its own agents, data, people and settings. Add one, rename it, or remove one you no longer run." />
      {!isOwner ? <Notice tone="info">Only an owner of this organisation can add or remove businesses.</Notice> : null}

      <Card>
        <CardHeader title="Your businesses" description={`${ventures.length} in ${org.name}`} />
        <ul className="divide-y divide-border">
          {ventures.map((v) => (
            <BusinessRow
              key={v.id}
              orgId={org.id}
              venture={v}
              canEdit={isOwner}
              canRemove={isOwner && ventures.length > 1}
              onRenamed={refresh}
              onRemove={() => setToRemove(v)}
            />
          ))}
        </ul>
      </Card>

      {isOwner ? <AddBusiness orgId={org.id} onAdded={refresh} /> : null}

      {isOwner && removed.data && removed.data.length > 0 ? (
        <Card>
          <CardHeader title="Recently removed" description="Restore a business within 30 days. After that its data is erased for good." />
          <ul className="divide-y divide-border">
            {removed.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-subtle">
                    {KIND_LABEL[r.kind as VentureKind] ?? r.kind} · removed {formatDate(r.removed_at)} · erased on {formatDate(r.erase_after)}
                  </p>
                </div>
                <Button size="sm" loading={restore.isPending && restore.variables === r.id} onClick={() => restore.mutate(r.id)} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog
        open={toRemove !== null}
        onClose={() => setToRemove(null)}
        onConfirm={() => toRemove && remove.mutate(toRemove)}
        title={`Remove ${toRemove?.name ?? "this business"}?`}
        description="Its agents stop, its connectors are disconnected and nobody can open its data. You can restore it for 30 days; after that everything in it is erased."
        confirmLabel="Remove business"
        typeToConfirm={toRemove?.name}
        loading={remove.isPending}
      />
    </div>
  );
}

function BusinessRow({
  orgId,
  venture: v,
  canEdit,
  canRemove,
  onRenamed,
  onRemove,
}: {
  orgId: string;
  venture: Venture;
  canEdit: boolean;
  canRemove: boolean;
  onRenamed: () => void;
  onRemove: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.name);
  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH("/orgs/{org_id}/ventures/{venture_id}", { params: { path: { org_id: orgId, venture_id: v.id } }, body: { name: name.trim() } })),
    onSuccess: () => {
      setEditing(false);
      onRenamed();
      toast.success("Name saved");
    },
    onError: (e) => toast.error("Could not rename", errorMessage(e)),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) rename.mutate();
          }}
        >
          <Input aria-label="Business name" className="max-w-xs" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button size="sm" variant="primary" type="submit" disabled={!name.trim() || name.trim() === v.name} loading={rename.isPending}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => {
              setName(v.name);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <Building2 className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <p className="truncate text-sm font-medium">{v.name}</p>
          <Badge tone="neutral">{KIND_LABEL[v.kind as VentureKind] ?? v.kind}</Badge>
        </div>
      )}
      {!editing ? (
        <div className="flex flex-wrap items-center gap-1">
          <Link href={`/v/${v.id}/settings`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:underline">
            Settings <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
          {canEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} icon={<Pencil className="h-3.5 w-3.5" />}>
              Rename
            </Button>
          ) : null}
          {canEdit ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!canRemove}
              title={canRemove ? undefined : "Your only business cannot be removed"}
              onClick={onRemove}
              icon={<Trash2 className="h-3.5 w-3.5" />}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function AddBusiness({ orgId, onAdded }: { orgId: string; onAdded: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<VentureKind>("general");
  const [err, setErr] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  const base = slugify(name).slice(0, 55);
  const add = useMutation({
    mutationFn: async () => {
      // The slug only has to be unique within the organisation; add a short suffix if it is taken.
      for (let i = 0; i < 4; i++) {
        const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          return await unwrap(api.POST("/orgs/{org_id}/ventures", { params: { path: { org_id: orgId } }, body: { name: name.trim(), slug, kind } }));
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
        }
      }
      throw new Error("Could not find a free short name for this business; try a different name.");
    },
    onSuccess: (d) => {
      setErr(null);
      setUpgrade(false);
      setName("");
      onAdded();
      toast.success("Business added", "Next: switch on its agents.");
      router.push(`/v/${d.id}/settings?tab=workflows`);
    },
    onError: (e) => {
      setUpgrade(e instanceof ApiError && e.status === 402);
      setErr(errorMessage(e));
    },
  });
  const valid = name.trim().length > 0 && SLUG_RE.test(base);
  return (
    <Card>
      <CardHeader title="Add a business" description="Agents, data and people stay separate from your other businesses. Your plan sets how many you can have." />
      <form
        className="grid gap-3 p-4 md:grid-cols-[2fr_1fr_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) add.mutate();
        }}
      >
        <Field label="Name" error={name.trim() && !SLUG_RE.test(base) ? "Use letters or digits in the name" : undefined}>
          <Input value={name} maxLength={120} placeholder="e.g. Truhome Finance" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as VentureKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" type="submit" disabled={!valid} loading={add.isPending} icon={<Plus className="h-4 w-4" />}>
          Add business
        </Button>
      </form>
      {err ? (
        <div className="px-4 pb-4">
          <FormError message={err} />
          {upgrade ? (
            <Link href="/billing" className="mt-1 inline-block text-sm text-accent hover:underline">
              See plans
            </Link>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
