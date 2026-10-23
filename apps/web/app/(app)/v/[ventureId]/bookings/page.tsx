"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, MessageCircle, Plus } from "lucide-react";
import { useState } from "react";
import { BookingSetup } from "@/components/bookings/booking-setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate, formatTime } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Booking = Schemas["BookingOut"];

const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", telegram: "Telegram", email: "Email", manual: "By hand" };
const STATUS: Record<string, string> = { done: "Done", no_show: "Didn't come", cancelled: "Cancelled", confirmed: "Booked" };

function AddBooking({ ventureId, onClose }: { ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const services = useQuery({
    queryKey: ["booking-services", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/booking-services", { params: { path: { venture_id: ventureId } } })),
  });
  const [serviceId, setServiceId] = useState("");
  const sid = serviceId || services.data?.[0]?.id || "";
  const slots = useQuery({
    queryKey: ["booking-slots", ventureId, sid],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/booking-slots", { params: { path: { venture_id: ventureId }, query: { service_id: sid, days: 14 } } })),
    enabled: Boolean(sid),
  });
  const [slot, setSlot] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const book = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/bookings", {
          params: { path: { venture_id: ventureId } },
          body: { service_id: sid, starts_at: slot || slots.data?.slots[0] || "", customer_name: name.trim(), phone: phone.trim() || null, outside_hours: false },
        }),
      ),
    onSuccess: (b) => {
      toast.success("Booked", `${b.customer_name}, ${formatDate(b.starts_at)} ${formatTime(b.starts_at)}`);
      void qc.invalidateQueries({ queryKey: ["bookings", ventureId] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a booking"
      description="For a phone call or a walk-in. Chats book themselves when you approve the reply."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={book.isPending} disabled={!name.trim() || !slots.data?.slots.length} onClick={() => book.mutate()}>
            Book
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Service">
          <Select value={sid} onChange={(e) => { setServiceId(e.target.value); setSlot(""); }}>
            {(services.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {`${s.name} (${s.minutes} min)`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Time">
          <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
            {(slots.data?.slots ?? []).map((t) => (
              <option key={t} value={t}>
                {formatDate(t)} · {formatTime(t)}
              </option>
            ))}
          </Select>
        </Field>
        {slots.data && !slots.data.slots.length ? <p className="text-sm text-muted">No free times in the next two weeks.</p> : null}
        <Field label="Customer" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
        </Field>
        <Field label="WhatsApp number (for the reminder)">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="+91 98111 22233" maxLength={24} />
        </Field>
        <FormError message={error} />
      </div>
    </Dialog>
  );
}

function Row({ b, ventureId, canWrite }: { b: Booking; ventureId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const set = useMutation({
    mutationFn: (status: "done" | "no_show" | "cancelled" | "confirmed") =>
      unwrap(api.PATCH("/ventures/{venture_id}/bookings/{booking_id}", { params: { path: { venture_id: ventureId, booking_id: b.id } }, body: { status } })),
    onSuccess: (_d, status) => {
      setConfirmCancel(false);
      void qc.invalidateQueries({ queryKey: ["bookings", ventureId] });
      if (status === "confirmed") return toast.success("Booking is back on");
      const undo = { label: "Undo", onClick: () => set.mutate("confirmed") };
      if (status === "done") toast.success("Marked done", "If the service has a price, an invoice draft is waiting on Invoices.", undo);
      else if (status === "no_show") toast.success(`${b.customer_name} marked as didn't come`, undefined, undo);
      else toast.success("Booking cancelled", "The customer isn't told by Kritvia; let them know.", undo);
    },
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-medium">
          {formatTime(b.starts_at)} · {b.customer_name}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {b.service_name}
          <span>· {CHANNEL[b.channel] ?? b.channel}</span>
          {b.from_chat ? (
            <Badge tone="info">
              <MessageCircle className="mr-1 h-3 w-3" aria-hidden /> booked in chat
            </Badge>
          ) : null}
          {b.in_calendar ? <Badge>in calendar</Badge> : null}
          {b.reminded_at ? <Badge tone="success">reminded</Badge> : null}
          {b.status !== "confirmed" ? <Badge tone="neutral">{STATUS[b.status] ?? b.status}</Badge> : null}
        </p>
      </div>
      {canWrite && b.status === "confirmed" ? (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" loading={set.isPending && set.variables === "done"} onClick={() => set.mutate("done")}>
            Done
          </Button>
          <Button size="sm" variant="ghost" loading={set.isPending && set.variables === "no_show"} onClick={() => set.mutate("no_show")}>
            Didn&apos;t come
          </Button>
          <Button size="sm" variant="ghost" className="ml-2 text-danger" onClick={() => setConfirmCancel(true)}>
            Cancel booking
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => set.mutate("cancelled")}
        loading={set.isPending}
        title={`Cancel ${b.customer_name}'s booking?`}
        description={`${formatTime(b.starts_at)}, ${b.service_name}. The time becomes free for others. You can undo it.`}
        confirmLabel="Cancel booking"
        cancelLabel="Keep it"
      />
    </li>
  );
}

export default function BookingsPage() {
  const v = useVenture();
  const canWrite = v.access === "write";
  const [tab, setTab] = useState<"upcoming" | "setup">("upcoming");
  const [adding, setAdding] = useState(false);
  const settings = useQuery({
    queryKey: ["booking-settings", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/booking-settings", { params: { path: { venture_id: v.id } } })),
  });
  const list = useQuery({
    queryKey: ["bookings", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/bookings", { params: { path: { venture_id: v.id }, query: { days: 30 } } })),
    refetchInterval: 30_000,
  });
  const configured = settings.data?.configured;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Bookings"
        description="Customers book in WhatsApp, Telegram or email: Kritvia offers your free times, and the booking is made when you approve the reply."
        actions={
          canWrite && configured ? (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add booking
            </Button>
          ) : undefined
        }
      />
      {settings.data && !configured ? (
        <Notice tone="info" title="Set up bookings">
          Add your opening hours and what can be booked below. The Inbox assistant then offers free times in chats.
        </Notice>
      ) : null}
      <Tabs
        label="Bookings"
        value={configured ? tab : "setup"}
        onChange={(t) => setTab(t as "upcoming" | "setup")}
        items={[
          { id: "upcoming", label: "Upcoming" },
          { id: "setup", label: "Hours & services" },
        ]}
      />
      {configured && tab === "upcoming" ? (
        <Card className="overflow-hidden p-0">
          <QueryState query={list} loading={<SkeletonRows rows={4} className="p-3" />}>
            {(rows: Booking[]) =>
              rows.length ? (
                <div>
                  {Object.entries(
                    rows.reduce<Record<string, Booking[]>>((acc, b) => {
                      const day = formatDate(b.starts_at);
                      (acc[day] ??= []).push(b);
                      return acc;
                    }, {}),
                  ).map(([day, items]) => (
                    <section key={day} aria-label={day}>
                      <h2 className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-xs font-semibold tracking-wide text-subtle uppercase">
                        <CalendarCheck className="h-3.5 w-3.5" aria-hidden /> {day}
                      </h2>
                      <ul className="divide-y divide-border">
                        {items.map((b) => (
                          <Row key={b.id} b={b} ventureId={v.id} canWrite={canWrite} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState title="No bookings coming up" description="When a customer books in a chat and you approve the reply, it appears here." />
              )
            }
          </QueryState>
        </Card>
      ) : (
        <BookingSetup ventureId={v.id} />
      )}
      {adding ? <AddBooking ventureId={v.id} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
