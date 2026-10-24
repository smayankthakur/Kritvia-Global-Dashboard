"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { amountProblem, paiseToInput, rupees, toPaise } from "@/components/invoices/money";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

type Settings = Schemas["BookingSettings"];
type Spans = Record<string, string[][]>;

/** A typed time made tidy: "9" → "09:00", "930" → "09:30", "18.30" → "18:30", "7pm" → "19:00". Null when it isn't a time. */
export function normalizeTime(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return "";
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Why these opening hours can't be saved, or null. A day with no times is closed. */
export function hoursProblem(h: Spans): string | null {
  for (const d of DAYS) {
    for (const span of h[d] ?? []) {
      const [o = "", c = ""] = span;
      if (!o && !c) continue;
      const on = normalizeTime(o);
      const cl = normalizeTime(c);
      if (!on || !cl) return `${DAY_NAME[d]}: write both times as HH:MM, e.g. 10:00 and 19:00.`;
      if (on >= cl) return `${DAY_NAME[d]}: the closing time must be after the opening time.`;
    }
  }
  return null;
}

/** Opening hours, one row a day: typed times, an optional second span for a lunch break, and "Same as Monday". */
function HoursEditor({ hours, onChange, disabled }: { hours: Spans; onChange: (h: Spans) => void; disabled: boolean }) {
  const set = (day: string, i: number, j: number, v: string) => {
    const spans = [...(hours[day] ?? [])].map((x) => [...x]);
    while (spans.length <= i) spans.push(["", ""]);
    spans[i]![j] = v;
    onChange({ ...hours, [day]: spans });
  };
  const tidy = (day: string, i: number, j: number, v: string) => {
    const n = normalizeTime(v);
    if (n !== null && n !== v) set(day, i, j, n);
  };
  const copyMonday = (day: string) => onChange({ ...hours, [day]: (hours.mon ?? []).map((x) => [...x]) });
  const cols = "sm:grid-cols-[6.5rem_repeat(4,minmax(0,5.5rem))_auto]";
  const box = "h-9 w-full min-w-0 tabular-nums";
  return (
    <div className="space-y-2">
      <div className={`hidden gap-2 text-xs font-medium text-subtle sm:grid ${cols}`} aria-hidden>
        <span>Day</span>
        <span>Opens</span>
        <span>Closes</span>
        <span>After a break</span>
        <span>Closes</span>
        <span />
      </div>
      {DAYS.map((d) => {
        const spans = hours[d] ?? [];
        const field = (i: number, j: number, label: string, ph: string) => (
          <label className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] text-subtle sm:sr-only">{label}</span>
            <Input
              className={box}
              inputMode="numeric"
              placeholder={ph}
              maxLength={7}
              aria-label={`${DAY_NAME[d]}: ${label}`}
              value={spans[i]?.[j] ?? ""}
              onChange={(e) => set(d, i, j, e.target.value)}
              onBlur={(e) => tidy(d, i, j, e.target.value)}
              disabled={disabled}
            />
          </label>
        );
        return (
          <div key={d} className={`grid grid-cols-2 items-end gap-2 text-sm sm:items-center ${cols}`}>
            <span className="col-span-2 font-medium sm:col-span-1">{DAY_NAME[d]}</span>
            {field(0, 0, "Opens", "10:00")}
            {field(0, 1, "Closes", "19:00")}
            {field(1, 0, "After a break", "—")}
            {field(1, 1, "Closes", "—")}
            {d !== "mon" && !disabled ? (
              <Button size="sm" variant="ghost" className="col-span-2 justify-self-start sm:col-span-1" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyMonday(d)}>
                Same as Monday
              </Button>
            ) : (
              <span className="hidden sm:block" />
            )}
          </div>
        );
      })}
      <p className="text-xs text-subtle">Type times like 10:00 or 7pm. Leave a day empty when you&apos;re closed. Use the second pair for a lunch break.</p>
    </div>
  );
}

type NumKey = "capacity" | "notice_hours" | "days_ahead";
const NUMS: Record<NumKey, { label: string; hint?: string; min: number; max: number }> = {
  capacity: { label: "At the same time", hint: "Chairs, rooms or staff", min: 1, max: 50 },
  notice_hours: { label: "Notice needed (hours)", min: 0, max: 168 },
  days_ahead: { label: "Book up to (days ahead)", min: 1, max: 90 },
};

/** The whole number typed in a booking setting, or why it can't be saved. */
export function numberProblem(k: NumKey, value: string): number | string {
  const { min, max, label } = NUMS[k];
  if (!/^\d+$/.test(value.trim())) return `${label}: write a number from ${min} to ${max}.`;
  const n = Number(value);
  return n < min || n > max ? `${label}: write a number from ${min} to ${max}.` : n;
}

/** Every typed time as HH:MM (times that don't read are left for hoursProblem to report). */
export function tidyHours(h: Spans): Spans {
  const out: Spans = {};
  for (const [d, spans] of Object.entries(h)) out[d] = spans.map((sp) => sp.map((t) => normalizeTime(t) ?? t));
  return out;
}

export function cleanSpans(h: Spans): Spans {
  const out: Spans = {};
  for (const [d, spans] of Object.entries(h)) {
    const ok = spans.filter((s) => s[0] && s[1]);
    if (ok.length) out[d] = ok;
  }
  return out;
}

export function BookingSetup({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sKey = ["booking-settings", ventureId] as const;
  const svKey = ["booking-services", ventureId] as const;
  const settings = useQuery({ queryKey: sKey, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/booking-settings", { params: { path: { venture_id: ventureId } } })) });
  const services = useQuery({ queryKey: svKey, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/booking-services", { params: { path: { venture_id: ventureId } } })) });
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [svc, setSvc] = useState({ name: "", minutes: "30", price: "" });
  // Number boxes keep what is typed (an emptied box stays empty until the next digit) and are checked on Save.
  const [raw, setRaw] = useState<Partial<Record<NumKey, string>>>({});
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const save = useMutation({
    mutationFn: (b: Settings) => unwrap(api.PUT("/ventures/{venture_id}/booking-settings", { params: { path: { venture_id: ventureId } }, body: b })),
    onSuccess: (d) => {
      qc.setQueryData(sKey, d);
      setForm(null);
      setRaw({});
      setError(null);
      toast.success("Booking hours saved");
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/booking-services", {
          params: { path: { venture_id: ventureId } },
          body: { name: svc.name.trim(), minutes: Number(svc.minutes), price_paise: svc.price.trim() ? toPaise(svc.price) : null },
        }),
      ),
    onSuccess: () => {
      setSvc({ name: "", minutes: "30", price: "" });
      void qc.invalidateQueries({ queryKey: svKey });
    },
    onError: (e) => toast.error("Couldn't add the service", errorMessage(e)),
  });
  const [editing, setEditing] = useState<{ id: string; name: string; minutes: string; price: string } | null>(null);
  const edit = useMutation({
    mutationFn: (e: { id: string; name: string; minutes: string; price: string }) =>
      unwrap(
        api.PATCH("/ventures/{venture_id}/booking-services/{service_id}", {
          params: { path: { venture_id: ventureId, service_id: e.id } },
          body: { name: e.name.trim(), minutes: Number(e.minutes), price_paise: e.price.trim() ? toPaise(e.price) : null },
        }),
      ),
    onSuccess: () => {
      setEditing(null);
      toast.success("Service saved");
      void qc.invalidateQueries({ queryKey: svKey });
    },
    onError: (e) => toast.error("Couldn't save the service", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/booking-services/{service_id}", { params: { path: { venture_id: ventureId, service_id: id } } })),
    onSuccess: () => {
      setRemoving(null);
      toast.success("Service removed");
      void qc.invalidateQueries({ queryKey: svKey });
    },
    onError: (e) => toast.error("Couldn't remove it", errorMessage(e)),
  });
  const priceError = amountProblem(svc.price);

  if (!settings.data) return null;
  const d = settings.data;
  const f: Settings = form ?? { enabled: d.configured ? d.enabled : true, hours: d.hours, slot_minutes: d.slot_minutes, notice_hours: d.notice_hours, days_ahead: d.days_ahead, capacity: d.capacity, use_calendar: d.use_calendar };
  const ro = !d.can_edit;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="When customers can book" description="Kritvia offers only these times, minus bookings and anything busy on your Google Calendar." />
        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const nums: Partial<Settings> = {};
            for (const k of Object.keys(NUMS) as NumKey[]) {
              const n = numberProblem(k, raw[k] ?? String(f[k]));
              if (typeof n === "string") return setError(n);
              nums[k] = n;
            }
            const hp = hoursProblem(f.hours as Spans);
            if (hp) return setError(hp);
            save.mutate({ ...f, ...nums, hours: cleanSpans(tidyHours(f.hours as Spans)) });
          }}
        >
          <HoursEditor hours={f.hours as Spans} onChange={(h) => setForm({ ...f, hours: h })} disabled={ro} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Start times every">
              <Select value={String(f.slot_minutes)} onChange={(e) => setForm({ ...f, slot_minutes: Number(e.target.value) as Settings["slot_minutes"] })} disabled={ro}>
                {[10, 15, 20, 30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </Select>
            </Field>
            {(Object.keys(NUMS) as NumKey[]).map((k) => {
              const value = raw[k] ?? String(f[k]);
              const problem = numberProblem(k, value);
              return (
                <Field key={k} label={NUMS[k].label} hint={NUMS[k].hint} error={typeof problem === "string" ? problem : null}>
                  <Input
                    inputMode="numeric"
                    value={value}
                    onChange={(e) => {
                      setRaw({ ...raw, [k]: e.target.value.replace(/[^\d]/g, "") });
                      setForm({ ...f });
                    }}
                    disabled={ro}
                  />
                </Field>
              );
            })}
          </div>
          <Checkbox checked={f.use_calendar} onChange={(e) => setForm({ ...f, use_calendar: e.target.checked })} label="Check my Google Calendar and add bookings to it" disabled={ro} />
          <Checkbox checked={f.enabled} onChange={(e) => setForm({ ...f, enabled: e.target.checked })} label="Take bookings in chats and email" disabled={ro} />
          <FormError message={error} />
          <Button type="submit" variant="primary" disabled={ro || !form} loading={save.isPending}>
            Save
          </Button>
        </form>
      </Card>
      <Card>
        <CardHeader title="What can be booked" description="Name, how long it takes, and the price customers are told (optional)." />
        <div className="space-y-3 p-4">
          <ul className="divide-y divide-border">
            {(services.data ?? []).map((s) =>
              editing?.id === s.id ? (
                <li key={s.id} className="py-2">
                  <form
                    className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_5.5rem_6rem_auto_auto]"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editing.name.trim() && !amountProblem(editing.price)) edit.mutate(editing);
                    }}
                  >
                    <Field label="Service" className="col-span-2 sm:col-span-1">
                      <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={80} autoFocus />
                    </Field>
                    <Field label="Minutes">
                      <Input type="number" min={5} max={600} value={editing.minutes} onChange={(e) => setEditing({ ...editing, minutes: e.target.value })} />
                    </Field>
                    <Field label="Price (₹)" error={amountProblem(editing.price)}>
                      <Input value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} inputMode="decimal" />
                    </Field>
                    <Button type="submit" variant="primary" loading={edit.isPending} disabled={Boolean(amountProblem(editing.price)) || !editing.name.trim()}>
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </form>
                </li>
              ) : (
                <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium">{s.name}</span> · {s.minutes} min{s.price_paise ? ` · ${rupees(s.price_paise)}` : ""}
                  </span>
                  {!ro ? (
                    <span className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${s.name}`}
                        icon={<Pencil className="h-4 w-4" />}
                        onClick={() => setEditing({ id: s.id, name: s.name, minutes: String(s.minutes), price: s.price_paise ? paiseToInput(s.price_paise) : "" })}
                      />
                      <Button variant="ghost" size="icon" aria-label={`Remove ${s.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemoving({ id: s.id, name: s.name })} />
                    </span>
                  ) : null}
                </li>
              ),
            )}
            {services.data && !services.data.length ? <li className="py-2 text-sm text-muted">No services yet.</li> : null}
          </ul>
          {!ro ? (
            <form
              className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_5.5rem_6rem_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (svc.name.trim() && !priceError) add.mutate();
              }}
            >
              <Field label="Service" className="col-span-2 sm:col-span-1">
                <Input value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} maxLength={80} placeholder="Haircut" />
              </Field>
              <Field label="Minutes">
                <Input type="number" min={5} max={600} value={svc.minutes} onChange={(e) => setSvc({ ...svc, minutes: e.target.value })} />
              </Field>
              <Field label="Price (₹)" error={priceError}>
                <Input value={svc.price} onChange={(e) => setSvc({ ...svc, price: e.target.value })} inputMode="decimal" placeholder={paiseToInput(40000)} />
              </Field>
              <Button type="submit" className="col-span-2 sm:col-span-1" icon={<Plus className="h-4 w-4" />} loading={add.isPending} disabled={Boolean(priceError)}>
                Add
              </Button>
            </form>
          ) : null}
          <ConfirmDialog
            open={removing !== null}
            onClose={() => setRemoving(null)}
            onConfirm={() => removing && remove.mutate(removing.id)}
            loading={remove.isPending}
            title={removing ? `Remove ${removing.name}?` : ""}
            description="Customers can't book it any more. Bookings already made stay."
            confirmLabel="Remove"
          />
        </div>
      </Card>
    </div>
  );
}
