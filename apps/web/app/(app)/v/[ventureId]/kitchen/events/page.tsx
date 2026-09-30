"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage, unwrap } from "@/lib/api";
import { formatDate, formatNumber, istDate } from "@/lib/format";
import { useVenture } from "@/lib/venture";

interface EventRow {
  id: string;
  event_date: string;
  name: string;
  multiplier: string | number | null;
  note: string | null;
}

export default function EventsPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["kitchen", v.id, "events"];
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/events", { params: { path: { venture_id: v.id } } })) });
  const [f, setF] = useState({ event_date: istDate(1), name: "", multiplier: "", note: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toDelete, setToDelete] = useState<EventRow | null>(null);

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/kitchen/events", {
          params: { path: { venture_id: v.id } },
          body: { event_date: f.event_date, name: f.name.trim(), multiplier: f.multiplier.trim() || null, note: f.note.trim() || null },
        }),
      ),
    onSuccess: () => {
      toast.success("Event added");
      setF({ event_date: f.event_date, name: "", multiplier: "", note: "" });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/kitchen/events/{event_id}", { params: { path: { venture_id: v.id, event_id: id } } })),
    onSuccess: () => {
      toast.success("Event removed");
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.event_date)) errs.event_date = "Pick a date";
    if (!f.name.trim()) errs.name = "Name the event";
    if (f.multiplier.trim()) {
      const m = Number(f.multiplier);
      if (!(m >= 0.2 && m <= 3)) errs.multiplier = "Between 0.2 and 3";
    }
    setErrors(errs);
    if (!Object.keys(errs).length) add.mutate();
  };

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Events"
        description="Festivals, matches, rain, holidays. Give a multiplier, or leave it blank and the forecasting agent estimates the impact."
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <QueryState query={q} empty={<EmptyState icon={CalendarDays} title="No upcoming events" description="Add Diwali, an IPL final or a long weekend to adjust tomorrow's forecast." />}>
            {(data) => (
              <Table label="Events">
                <THead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Event</Th>
                    <Th className="text-right">Multiplier</Th>
                    <Th>
                      <span className="sr-only">Remove</span>
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {(data as unknown as EventRow[]).map((ev) => (
                    <Tr key={ev.id}>
                      <Td className={`whitespace-nowrap ${ev.event_date < istDate(0) ? "text-subtle" : ""}`}>{formatDate(ev.event_date)}</Td>
                      <Td>
                        <span className="font-medium">{ev.name}</span>
                        {ev.note ? <span className="block text-xs text-subtle">{ev.note}</span> : null}
                      </Td>
                      <Td className="text-right">{ev.multiplier === null ? <Badge tone="info">model estimates</Badge> : <span className="tabular-nums">×{formatNumber(ev.multiplier)}</span>}</Td>
                      <Td className="text-right">
                        <Button variant="ghost" size="icon" aria-label={`Remove ${ev.name}`} onClick={() => setToDelete(ev)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </QueryState>
        </Card>
        <Card className="h-fit">
          <CardHeader title="Add event" />
          <form onSubmit={submit} noValidate className="space-y-3 p-4">
            <FormError message={add.isError && !(add.error instanceof ApiError && Object.keys(add.error.fieldErrors).length) ? errorMessage(add.error) : null} />
            <Field label="Date" error={errors.event_date} required>
              <Input type="date" value={f.event_date} onChange={(e) => setF({ ...f, event_date: e.target.value })} />
            </Field>
            <Field label="Event" error={errors.name} required>
              <Input value={f.name} maxLength={200} placeholder="Diwali" onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Demand multiplier" error={errors.multiplier} hint="1.3 = 30% more orders. Blank = let the model estimate">
              <Input inputMode="decimal" value={f.multiplier} placeholder="1.3" onChange={(e) => setF({ ...f, multiplier: e.target.value })} />
            </Field>
            <Field label="Note" error={errors.note}>
              <Input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />
            </Field>
            <Button type="submit" variant="primary" loading={add.isPending} className="w-full">
              Add event
            </Button>
          </form>
        </Card>
      </div>
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        loading={del.isPending}
        title="Remove event?"
        description={toDelete ? `${toDelete.name} on ${formatDate(toDelete.event_date)} will no longer adjust the forecast.` : undefined}
        confirmLabel="Remove"
      />
    </>
  );
}
