"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { TimeField } from "@/components/ui/time-field";

const OPEN_PRESETS = ["09:00", "10:00", "11:00", "14:00"];
const CLOSE_PRESETS = ["13:00", "18:00", "20:00", "21:00"];
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { paiseToInput, rupees, toPaise } from "@/components/invoices/money";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

type Settings = Schemas["BookingSettings"];
type Spans = Record<string, string[][]>;

/** Opening hours as two optional spans a day ("10:00–13:00" and "14:00–19:00"); an empty first span is closed. */
function HoursEditor({ hours, onChange, disabled }: { hours: Spans; onChange: (h: Spans) => void; disabled: boolean }) {
  const set = (day: string, i: number, j: number, v: string) => {
    const spans = [...(hours[day] ?? [])].map((s) => [...s]);
    while (spans.length <= i) spans.push(["", ""]);
    spans[i]![j] = v;
    onChange({ ...hours, [day]: spans });
  };
  return (
    <div className="space-y-2">
      {DAYS.map((d) => {
        const spans = hours[d] ?? [];
        return (
          <div key={d} className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-sm sm:grid-cols-[6.5rem_1fr_1fr]">
            <span className="font-medium">{DAY_NAME[d]}</span>
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-1">
                <TimeField className="min-w-0 flex-1" clearable step={15} presets={OPEN_PRESETS} placeholder="Opens" aria-label={`${DAY_NAME[d]} ${i ? "second" : "first"} span opens`} value={spans[i]?.[0] ?? ""} onChange={(v) => set(d, i, 0, v)} disabled={disabled} />
                <span aria-hidden>–</span>
                <TimeField className="min-w-0 flex-1" clearable step={15} presets={CLOSE_PRESETS} placeholder="Closes" aria-label={`${DAY_NAME[d]} ${i ? "second" : "first"} span closes`} value={spans[i]?.[1] ?? ""} onChange={(v) => set(d, i, 1, v)} disabled={disabled} />
              </div>
            ))}
          </div>
        );
      })}
      <p className="text-xs text-subtle">Leave a day empty when you&apos;re closed. Use the second span for a lunch break.</p>
    </div>
  );
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

  const save = useMutation({
    mutationFn: (b: Settings) => unwrap(api.PUT("/ventures/{venture_id}/booking-settings", { params: { path: { venture_id: ventureId } }, body: b })),
    onSuccess: (d) => {
      qc.setQueryData(sKey, d);
      setForm(null);
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
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/booking-services/{service_id}", { params: { path: { venture_id: ventureId, service_id: id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: svKey }),
  });

  if (!settings.data) return null;
  const d = settings.data;
  const f: Settings = form ?? { enabled: d.configured ? d.enabled : true, hours: d.hours, slot_minutes: d.slot_minutes, notice_hours: d.notice_hours, days_ahead: d.days_ahead, capacity: d.capacity, use_calendar: d.use_calendar };
  const ro = !d.can_edit;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="When customers can book" description="Kritvia offers only these times, minus bookings and anything busy on your Google Calendar." />
        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ ...f, hours: cleanSpans(f.hours as Spans) });
          }}
        >
          <HoursEditor hours={f.hours as Spans} onChange={(h) => setForm({ ...f, hours: h })} disabled={ro} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start times every">
              <Select value={String(f.slot_minutes)} onChange={(e) => setForm({ ...f, slot_minutes: Number(e.target.value) as Settings["slot_minutes"] })} disabled={ro}>
                {[10, 15, 20, 30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="At the same time" hint="Chairs, rooms or staff">
              <Input type="number" min={1} max={50} value={f.capacity} onChange={(e) => setForm({ ...f, capacity: Number(e.target.value) || 1 })} disabled={ro} />
            </Field>
            <Field label="Notice needed (hours)">
              <Input type="number" min={0} max={168} value={f.notice_hours} onChange={(e) => setForm({ ...f, notice_hours: Number(e.target.value) || 0 })} disabled={ro} />
            </Field>
            <Field label="Book up to (days ahead)">
              <Input type="number" min={1} max={90} value={f.days_ahead} onChange={(e) => setForm({ ...f, days_ahead: Number(e.target.value) || 14 })} disabled={ro} />
            </Field>
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
            {(services.data ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">{s.name}</span> · {s.minutes} min{s.price_paise ? ` · ${rupees(s.price_paise)}` : ""}
                </span>
                {!ro ? (
                  <Button variant="ghost" size="icon" aria-label={`Remove ${s.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => remove.mutate(s.id)} />
                ) : null}
              </li>
            ))}
            {services.data && !services.data.length ? <li className="py-2 text-sm text-muted">No services yet.</li> : null}
          </ul>
          {!ro ? (
            <form
              className="grid grid-cols-[1fr_5.5rem_6rem_auto] items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (svc.name.trim()) add.mutate();
              }}
            >
              <Field label="Service">
                <Input value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} maxLength={80} placeholder="Haircut" />
              </Field>
              <Field label="Minutes">
                <Input type="number" min={5} max={600} value={svc.minutes} onChange={(e) => setSvc({ ...svc, minutes: e.target.value })} />
              </Field>
              <Field label="Price (₹)">
                <Input value={svc.price} onChange={(e) => setSvc({ ...svc, price: e.target.value })} inputMode="decimal" placeholder={paiseToInput(40000)} />
              </Field>
              <Button type="submit" icon={<Plus className="h-4 w-4" />} loading={add.isPending}>
                Add
              </Button>
            </form>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
