"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, CopyPlus, Download, Pencil, Plus, Search, Trash2, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, downloadFile, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";

type C = Schemas["StaffCoupon"];
type Fields = Schemas["CouponFields"];
type Kind = Fields["kind"];
type Status = C["status"];

const KINDS: { id: Kind; label: string; hint: string }[] = [
  {
    id: "free_plan",
    label: "Plan free for a while",
    hint: "A paid plan with nothing charged, for some months or days.",
  },
  {
    id: "percent_off",
    label: "% off a paid plan",
    hint: "Applied when the business subscribes, through a Razorpay offer.",
  },
  {
    id: "trial_days",
    label: "Extra trial days",
    hint: "Lengthens the free trial; doesn't unlock a higher plan.",
  },
  {
    id: "ai_tokens",
    label: "Extra AI usage",
    hint: "More hosted-AI tokens on the monthly allowance, for some months.",
  },
];
const PLANS = { starter: "Starter", growth: "Growth", scale: "Scale" } as const;
const INDUSTRIES: Record<string, string> = {
  agency: "Agency or services",
  loans: "Loans & real estate",
  kitchen: "Restaurant or cloud kitchen",
  trade: "Exporter, importer or C&F agent",
  retail: "Shop or e-commerce",
  clinic: "Clinic, salon or local services",
  coaching: "Coaching or education",
  freelancer: "Freelancer or consultant",
  other: "Something else",
};
const STATUS: Record<Status, { label: string; tone: Tone }> = {
  open: { label: "open", tone: "success" },
  scheduled: { label: "starts later", tone: "info" },
  full: { label: "all places taken", tone: "warning" },
  ended: { label: "ended", tone: "neutral" },
  off: { label: "off", tone: "neutral" },
};

/** The same words the server uses for an offer, so the form shows exactly what customers will read. */
function offerWords(f: Draft): string {
  const plural = (n: number, w: string) => `${n.toLocaleString("en-IN")} ${w}${n === 1 ? "" : "s"}`;
  if (f.kind === "free_plan") {
    const len = f.length_unit === "months" ? plural(Number(f.months) || 0, "month") : plural(Number(f.days) || 0, "day");
    return `${PLANS[f.plan as keyof typeof PLANS] ?? "—"} plan free for ${len}`;
  }
  if (f.kind === "percent_off") {
    const which = f.plans.length ? `${f.plans.map((p) => PLANS[p as keyof typeof PLANS]).join(" or ")} plan` : "any plan";
    const when = f.periods.length === 1 ? ` (${f.periods[0]} billing)` : "";
    const cycles = Number(f.months) ? ` for the first ${plural(Number(f.months), "billing cycle")}` : "";
    return `${f.percent || "?"}% off ${which}${when}${cycles}`;
  }
  if (f.kind === "trial_days") return `${plural(Number(f.days) || 0, "extra day")} of free trial`;
  return `${(Number(f.tokens) || 0).toLocaleString("en-IN")} extra AI tokens a month for ${plural(Number(f.months) || 0, "month")}`;
}

interface Draft {
  code: string;
  kind: Kind;
  plan: string;
  length_unit: "months" | "days";
  months: string;
  days: string;
  percent: string;
  razorpay_offer_id: string;
  plans: string[];
  periods: string[];
  tokens: string;
  industries: string[];
  who: Fields["who"];
  signup_days: string;
  emails: string;
  domains: string;
  starts_at: string;
  expires_at: string;
  max_uses: string;
  note: string;
  active: boolean;
}

/** datetime-local value (the browser's time zone) <-> ISO. */
const toLocal = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

function randomCode(prefix = ""): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return `${prefix}${Array.from(buf, (n) => abc[n % abc.length]).join("")}`.slice(0, 24);
}

function draftOf(c?: C, copy = false): Draft {
  return {
    code: c && !copy ? c.code : copy && c ? `${c.code.slice(0, 18)}-2` : "",
    kind: c?.kind ?? "free_plan",
    plan: c?.plan ?? "growth",
    length_unit: c?.days && c.kind === "free_plan" ? "days" : "months",
    months: c?.months ? String(c.months) : c ? "" : "1",
    days: c?.days ? String(c.days) : "",
    percent: c?.percent ? String(c.percent) : "",
    razorpay_offer_id: c?.razorpay_offer_id ?? "",
    plans: c?.plans ?? [],
    periods: c?.periods ?? [],
    tokens: c?.tokens ? String(c.tokens) : "",
    industries: c?.industries ?? [],
    who: c?.who ?? "new",
    signup_days: c?.signup_days ? String(c.signup_days) : "",
    emails: (c?.emails ?? []).join("\n"),
    domains: (c?.domains ?? []).join(", "),
    starts_at: copy ? "" : toLocal(c?.starts_at),
    expires_at: copy ? "" : toLocal(c?.expires_at),
    max_uses: String(c?.max_uses ?? 100),
    note: c?.note ?? "",
    active: c?.active ?? true,
  };
}

function bodyOf(f: Draft): Fields {
  const n = (v: string) => (v.trim() ? Number(v) : null);
  return {
    kind: f.kind,
    plan: f.kind === "free_plan" ? (f.plan as Fields["plan"]) : null,
    months: f.kind === "free_plan" ? (f.length_unit === "months" ? n(f.months) : null) : f.kind === "trial_days" ? null : n(f.months),
    days: f.kind === "trial_days" || (f.kind === "free_plan" && f.length_unit === "days") ? n(f.days) : null,
    percent: f.kind === "percent_off" ? n(f.percent) : null,
    razorpay_offer_id: f.kind === "percent_off" ? f.razorpay_offer_id.trim() || null : null,
    plans: f.kind === "percent_off" ? (f.plans as Fields["plans"]) : [],
    periods: f.kind === "percent_off" ? (f.periods as Fields["periods"]) : [],
    tokens: f.kind === "ai_tokens" ? n(f.tokens) : null,
    industries: f.industries as Fields["industries"],
    who: f.who,
    signup_days: f.who === "new" ? n(f.signup_days) : null,
    emails: f.emails.split(/[\s,;]+/).filter(Boolean),
    domains: f.domains.split(/[\s,;]+/).filter(Boolean),
    starts_at: fromLocal(f.starts_at),
    expires_at: fromLocal(f.expires_at),
    max_uses: Number(f.max_uses) || 1,
    note: f.note.trim() || null,
    active: f.active,
  };
}

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function CouponForm({ initial, editing, used, onClose }: { initial: Draft; editing: string | null; used: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Draft>(initial);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      editing
        ? unwrap(
            api.PUT("/staff/coupons/{code}", {
              params: { path: { code: editing } },
              body: bodyOf(f),
            }),
          )
        : unwrap(
            api.POST("/staff/coupons", {
              body: { ...bodyOf(f), code: f.code.trim().toUpperCase() },
            }),
          ),
    onSuccess: (rows) => {
      qc.setQueryData(["staff", "coupons"], rows);
      toast.success(editing ? "Coupon saved" : `${f.code.trim().toUpperCase()} created`, offerWords(f));
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const locked = used; // the offer itself is fixed once someone used the code
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={editing ? `Edit ${editing}` : "New coupon"}
      description="Choose what it gives, who can use it and when. Customers see the offer in exactly these words."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!editing && f.code.trim().length < 3} onClick={() => save.mutate()}>
            {editing ? "Save" : "Create coupon"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Notice tone="info" title="Customers will read">
          <strong>{f.code.trim().toUpperCase() || "CODE"}</strong>: {offerWords(f)}
        </Notice>
        {locked ? (
          <p className="text-sm text-muted">This code has been used, so what it gives can&apos;t change. Who can use it, the dates and the places still can.</p>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2" aria-label="Code and note">
          <Field label="Code" required hint="3–24 letters, numbers or hyphens. Not case-sensitive.">
            <div className="flex gap-2">
              <Input
                value={f.code}
                disabled={Boolean(editing)}
                onChange={(e) =>
                  set(
                    "code",
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9-]/g, "")
                      .slice(0, 24),
                  )
                }
                placeholder="DIWALI25"
              />
              {!editing ? (
                <Button type="button" variant="ghost" icon={<Wand2 className="h-4 w-4" />} onClick={() => set("code", randomCode())}>
                  Generate
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Note for the team" hint="Only Kritvia's team sees this">
            <Input value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={200} placeholder="e.g. Diwali offer for cloud kitchens" />
          </Field>
        </section>

        <fieldset className="space-y-3" disabled={locked}>
          <legend className="mb-1 text-sm font-semibold">What it gives</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {KINDS.map((k) => (
              <label
                key={k.id}
                className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${f.kind === k.id ? "border-accent bg-accent-soft" : "border-border"}`}
              >
                <input
                  type="radio"
                  name="kind"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={f.kind === k.id}
                  onChange={() => setF((x) => ({ ...x, kind: k.id, months: k.id === "percent_off" ? "" : x.months || "1" }))}
                />
                <span>
                  <span className="font-medium">{k.label}</span>
                  <span className="block text-xs text-muted">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {f.kind === "free_plan" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Plan">
                <Select value={f.plan} onChange={(e) => set("plan", e.target.value)}>
                  {Object.entries(PLANS).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="For">
                <Input
                  type="number"
                  min={1}
                  max={f.length_unit === "months" ? 12 : 365}
                  value={f.length_unit === "months" ? f.months : f.days}
                  onChange={(e) => set(f.length_unit === "months" ? "months" : "days", e.target.value)}
                />
              </Field>
              <Field label="Unit">
                <Select
                  value={f.length_unit}
                  onChange={(e) => {
                    const u = e.target.value as Draft["length_unit"];
                    setF((x) => ({
                      ...x,
                      length_unit: u,
                      [u]: x[x.length_unit],
                    })); // the number carries over
                  }}
                >
                  <option value="months">months</option>
                  <option value="days">days</option>
                </Select>
              </Field>
            </div>
          ) : null}
          {f.kind === "percent_off" ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Percent off">
                  <Input type="number" min={1} max={100} value={f.percent} onChange={(e) => set("percent", e.target.value)} />
                </Field>
                <Field label="Razorpay offer ID" hint="Razorpay → Offers → the matching offer (offer_…)">
                  <Input value={f.razorpay_offer_id} onChange={(e) => set("razorpay_offer_id", e.target.value.trim())} placeholder="offer_ABC123xyz" />
                </Field>
                <Field label="Billing cycles (optional)" hint="As set on the Razorpay offer">
                  <Input type="number" min={1} max={12} value={f.months} onChange={(e) => set("months", e.target.value)} />
                </Field>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <span className="text-sm text-muted">Plans (none ticked = any):</span>
                {Object.entries(PLANS).map(([id, name]) => (
                  <Checkbox key={id} label={name} checked={f.plans.includes(id)} onChange={() => set("plans", toggle(f.plans, id))} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <span className="text-sm text-muted">Billing (none ticked = both):</span>
                <Checkbox label="Monthly" checked={f.periods.includes("monthly")} onChange={() => set("periods", toggle(f.periods, "monthly"))} />
                <Checkbox label="Annual" checked={f.periods.includes("annual")} onChange={() => set("periods", toggle(f.periods, "annual"))} />
              </div>
              <p className="text-xs text-subtle">
                Create the offer once in the Razorpay dashboard with the same percent and cycles; Razorpay applies it to the charges and Kritvia accepts the
                lower amount only for subscriptions made with this coupon.
              </p>
            </div>
          ) : null}
          {f.kind === "trial_days" ? (
            <Field label="Extra trial days" className="sm:w-48">
              <Input type="number" min={1} max={365} value={f.days} onChange={(e) => set("days", e.target.value)} />
            </Field>
          ) : null}
          {f.kind === "ai_tokens" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Extra tokens a month">
                <Input type="number" min={1000} step={1000} value={f.tokens} onChange={(e) => set("tokens", e.target.value)} />
              </Field>
              <Field label="For how many months">
                <Input type="number" min={1} max={12} value={f.months} onChange={(e) => set("months", e.target.value)} />
              </Field>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">Who can use it</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Businesses">
              <Select value={f.who} onChange={(e) => set("who", e.target.value as Draft["who"])}>
                <option value="new">New businesses only</option>
                <option value="unpaid">Businesses not on a paid plan</option>
                <option value="anyone">Any business, paying ones too</option>
              </Select>
            </Field>
            {f.who === "new" ? (
              <Field label="Used within (days of signing up, optional)">
                <Input type="number" min={1} max={365} value={f.signup_days} onChange={(e) => set("signup_days", e.target.value)} />
              </Field>
            ) : (
              <p className="self-end text-xs text-subtle">
                {f.who === "anyone" && (f.kind === "free_plan" || f.kind === "trial_days")
                  ? "A free plan or trial days never apply to a business that already pays."
                  : f.who === "anyone" && f.kind === "percent_off"
                    ? "A paying business gets the discount on its next subscription."
                    : ""}
              </p>
            )}
          </div>
          <div>
            <p className="mb-2 text-sm text-muted">Industries (none ticked = every industry)</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {Object.entries(INDUSTRIES).map(([id, name]) => (
                <Checkbox key={id} label={name} checked={f.industries.includes(id)} onChange={() => set("industries", toggle(f.industries, id))} />
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Only these people (optional)" hint="Emails, one per line. Makes the code private.">
              <Textarea rows={3} value={f.emails} onChange={(e) => set("emails", e.target.value)} placeholder="owner@kitchen.in" />
            </Field>
            <Field label="Or anyone with these email domains (optional)" hint="Comma-separated, e.g. mehta.in, acme.co.in">
              <Input value={f.domains} onChange={(e) => set("domains", e.target.value)} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-4">
          <legend className="mb-1 text-sm font-semibold sm:col-span-4">When and how many</legend>
          <Field label="Starts (optional)">
            <Input type="datetime-local" value={f.starts_at} onChange={(e) => set("starts_at", e.target.value)} />
          </Field>
          <Field label="Expires (optional)">
            <Input type="datetime-local" value={f.expires_at} onChange={(e) => set("expires_at", e.target.value)} />
          </Field>
          <Field label="Places" hint="Businesses that can use it">
            <Input type="number" min={1} max={100000} value={f.max_uses} onChange={(e) => set("max_uses", e.target.value)} />
          </Field>
          <div className="flex items-end gap-2 pb-2">
            <Switch checked={f.active} onChange={(v) => set("active", v)} label="Can be used" />
            <span aria-hidden className="text-sm">
              Can be used
            </span>
          </div>
        </fieldset>
        <FormError message={err} />
      </div>
    </Dialog>
  );
}

/** Kritvia's team: create and manage coupons of every kind, and see who used them. */
export default function StaffCouponsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["staff", "coupons"] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/staff/coupons")),
  });
  const [tab, setTab] = useState<"all" | Status>("all");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<{
    initial: Draft;
    editing: string | null;
    used: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<C | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const flip = useMutation({
    mutationFn: (c: C) =>
      unwrap(
        api.PATCH("/staff/coupons/{code}", {
          params: { path: { code: c.code } },
          body: { active: !c.active },
        }),
      ),
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (c: C) =>
      unwrap(
        api.DELETE("/staff/coupons/{code}", {
          params: { path: { code: c.code } },
        }),
      ),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: key });
      toast.success("Coupon deleted");
    },
    onError: (e) => toast.error("Couldn't delete it", errorMessage(e)),
  });
  const link = (code: string) => `${window.location.origin}/register?coupon=${code}`;
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter(
      (c) =>
        (tab === "all" || c.status === tab) &&
        (!s || c.code.toLowerCase().includes(s) || (c.note ?? "").toLowerCase().includes(s) || c.offer.toLowerCase().includes(s)),
    );
  }, [q.data, tab, search]);
  const counts = (s: Status) => (q.data ?? []).filter((c) => c.status === s).length;
  return (
    <>
      <PageHeader
        title="Coupons"
        description="Free plan time, a percentage off, extra trial days or extra AI usage: for new or existing businesses, chosen industries and plans, or a private list of people."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ initial: draftOf(), editing: null, used: false })}>
            New coupon
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Coupons by status"
          value={tab}
          onChange={(t) => setTab(t as typeof tab)}
          items={[
            { id: "all", label: `All (${q.data?.length ?? 0})` },
            { id: "open", label: `Open (${counts("open")})` },
            { id: "scheduled", label: `Starts later (${counts("scheduled")})` },
            { id: "full", label: `Full (${counts("full")})` },
            { id: "ended", label: `Ended (${counts("ended")})` },
            { id: "off", label: `Off (${counts("off")})` },
          ]}
        />
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" aria-hidden />
          <Input
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, offer or note"
            aria-label="Search coupons"
          />
        </div>
      </div>
      <QueryState query={q} loading={<SkeletonRows rows={3} />}>
        {() =>
          rows.length ? (
            <div className="space-y-4">
              {rows.map((c) => (
                <Card key={c.code}>
                  <CardHeader
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{c.code}</span>
                        <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                        {c.emails?.length || c.domains?.length ? <Badge tone="neutral">private</Badge> : null}
                      </span>
                    }
                    description={
                      <span className="block space-y-0.5">
                        <span className="block font-medium text-fg">{c.offer}</span>
                        <span className="block">{c.conditions.join(" · ")}</span>
                        <span className="block">
                          {c.uses} of {c.max_uses} used · {c.starts_at ? `from ${formatDateTime(c.starts_at)}` : "from now"}
                          {c.expires_at ? ` to ${formatDateTime(c.expires_at)}` : ", no end date"}
                          {c.note ? ` · ${c.note}` : ""}
                        </span>
                      </span>
                    }
                    actions={
                      <div className="flex flex-wrap items-center gap-1">
                        <Switch checked={c.active} onChange={() => flip.mutate(c)} label={`${c.code} can be used`} />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Copy className="h-4 w-4" />}
                          onClick={() => void navigator.clipboard.writeText(link(c.code)).then(() => toast.success("Sign-up link copied", link(c.code)))}
                        >
                          Link
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Pencil className="h-4 w-4" />}
                          onClick={() =>
                            setForm({
                              initial: draftOf(c),
                              editing: c.code,
                              used: c.uses > 0,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<CopyPlus className="h-4 w-4" />}
                          onClick={() =>
                            setForm({
                              initial: draftOf(c, true),
                              editing: null,
                              used: false,
                            })
                          }
                        >
                          Duplicate
                        </Button>
                        {c.uses ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Download className="h-4 w-4" />}
                            onClick={() =>
                              void downloadFile(`/staff/coupons/${c.code}/uses.csv`, `coupon-${c.code}-uses.csv`).catch((e) =>
                                toast.error("Couldn't download", errorMessage(e)),
                              )
                            }
                          >
                            CSV
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(c)}>
                            Delete
                          </Button>
                        )}
                      </div>
                    }
                  />
                  <div className="h-1.5 bg-surface-2" aria-hidden>
                    <div
                      className="h-full bg-accent"
                      style={{
                        width: `${Math.min(100, (c.uses / c.max_uses) * 100)}%`,
                      }}
                    />
                  </div>
                  {c.used_by.length ? (
                    <details open={open === c.code} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open ? c.code : null)}>
                      <summary className="cursor-pointer px-4 py-2 text-sm text-muted">Used by {c.used_by.length}</summary>
                      <Table label={`Who used ${c.code}`}>
                        <THead>
                          <tr>
                            <Th>Organisation</Th>
                            <Th>Owner</Th>
                            <Th>Used</Th>
                            <Th>{c.kind === "percent_off" ? "Valid until" : "Ends"}</Th>
                            <Th>Now pays</Th>
                          </tr>
                        </THead>
                        <TBody>
                          {c.used_by.map((u) => (
                            <Tr key={u.org_id}>
                              <Td>{u.org_name ?? "—"}</Td>
                              <Td>{u.owner_email ?? "—"}</Td>
                              <Td>{formatDate(u.redeemed_at)}</Td>
                              <Td>{u.used_at ? `paid with it ${formatDate(u.used_at)}` : formatDate(u.ends_at)}</Td>
                              <Td>{u.paid_plan ? <Badge tone="success">{u.paid_plan}</Badge> : "—"}</Td>
                            </Tr>
                          ))}
                        </TBody>
                      </Table>
                    </details>
                  ) : (
                    <p className="px-4 py-3 text-sm text-subtle">Not used yet. Share the sign-up link, or people enter the code under Plan &amp; billing.</p>
                  )}
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState title="No coupons here" description="Create one with New coupon, or try another tab." />
          )
        }
      </QueryState>
      {form ? <CouponForm initial={form.initial} editing={form.editing} used={form.used} onClose={() => setForm(null)} /> : null}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        title={`Delete ${deleting?.code ?? ""}?`}
        description="Nobody has used it yet, so nothing else changes. A used code can only be switched off."
        confirmLabel="Delete"
        loading={del.isPending}
      />
    </>
  );
}
