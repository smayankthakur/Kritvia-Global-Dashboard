"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { useState } from "react";
import { paiseToInput, rupees, toPaise } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, downloadFile, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatTime, istDate } from "@/lib/format";

type Staff = Schemas["StaffOut"];
type Status = "present" | "half_day" | "absent" | "leave";
const STATUS_LABEL: Record<Status, string> = { present: "Present", half_day: "Half day", absent: "Absent", leave: "Leave" };

function StaffDialog({ ventureId, staff, onClose }: { ventureId: string; staff: Staff | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: staff?.name ?? "",
    phone: staff?.phone ? `+${staff.phone}` : "",
    role: staff?.role ?? "",
    pay_kind: (staff?.pay_kind ?? "monthly") as "monthly" | "daily",
    pay: staff ? paiseToInput(staff.pay_paise) : "",
    starts_at: staff?.starts_at?.slice(0, 5) ?? "10:00",
  });
  const [err, setErr] = useState<string | null>(null);
  const body = () => ({
    name: f.name.trim(),
    phone: f.phone.trim() || null,
    role: f.role.trim() || null,
    pay_kind: f.pay_kind,
    pay_paise: f.pay.trim() ? (toPaise(f.pay) ?? 0) : 0,
    starts_at: `${f.starts_at}:00`,
  });
  const save = useMutation({
    mutationFn: () =>
      staff
        ? unwrap(api.PATCH("/ventures/{venture_id}/staff/{staff_id}", { params: { path: { venture_id: ventureId, staff_id: staff.id } }, body: body() }))
        : unwrap(api.POST("/ventures/{venture_id}/staff", { params: { path: { venture_id: ventureId } }, body: body() })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["staff", ventureId] });
      void qc.invalidateQueries({ queryKey: ["attendance", ventureId] });
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const leave = useMutation({
    mutationFn: () => unwrap(api.PATCH("/ventures/{venture_id}/staff/{staff_id}", { params: { path: { venture_id: ventureId, staff_id: staff!.id } }, body: { active: !staff!.active } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["staff", ventureId] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={staff ? staff.name : "Add someone to the team"}
      description="Their WhatsApp number lets them check in by sending IN and OUT to the business's number."
      footer={
        <>
          {staff ? (
            <Button variant="ghost" loading={leave.isPending} onClick={() => leave.mutate()}>
              {staff.active ? "Has left" : "Back on the team"}
            </Button>
          ) : null}
          <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        </Field>
        <Field label="WhatsApp number">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" placeholder="+91 98111 22233" />
        </Field>
        <Field label="Role">
          <Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} maxLength={80} />
        </Field>
        <Field label="Starts work at">
          <Input type="time" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} />
        </Field>
        <Field label="Paid">
          <Select value={f.pay_kind} onChange={(e) => setF({ ...f, pay_kind: e.target.value as "monthly" | "daily" })}>
            <option value="monthly">Per month</option>
            <option value="daily">Per day</option>
          </Select>
        </Field>
        <Field label="Pay (₹)">
          <Input value={f.pay} onChange={(e) => setF({ ...f, pay: e.target.value })} inputMode="decimal" />
        </Field>
      </div>
      <FormError message={err} />
    </Dialog>
  );
}

/** The team, who came in today, and the month added up for salaries. */
export function AttendanceTab({ ventureId, canWrite, canAdmin }: { ventureId: string; canWrite: boolean; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [day, setDay] = useState(istDate());
  const [month, setMonth] = useState(istDate().slice(0, 7));
  const [editing, setEditing] = useState<Staff | "new" | null>(null);
  const staff = useQuery({ queryKey: ["staff", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/staff", { params: { path: { venture_id: ventureId } } })) });
  const today = useQuery({
    queryKey: ["attendance", ventureId, day],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/attendance", { params: { path: { venture_id: ventureId }, query: { day } } })),
  });
  const sheet = useQuery({
    queryKey: ["attendance-sheet", ventureId, month],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/attendance/sheet", { params: { path: { venture_id: ventureId }, query: { month } } })),
  });
  const mark = useMutation({
    mutationFn: ({ staff_id, status }: { staff_id: string; status: Status }) =>
      unwrap(api.PUT("/ventures/{venture_id}/attendance", { params: { path: { venture_id: ventureId } }, body: { staff_id, day, status } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["attendance", ventureId] });
      void qc.invalidateQueries({ queryKey: ["attendance-sheet", ventureId] });
    },
    onError: (e) => toast.error("Couldn't mark it", errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      <Notice tone="info" title="How staff check in">
        Each person sends <strong>IN</strong> when they arrive and <strong>OUT</strong> when they leave, from their own WhatsApp, to the
        business&apos;s WhatsApp number. Kritvia notes the time and replies. At 12:05 you hear who hasn&apos;t come in yet.
      </Notice>
      <Card>
        <CardHeader
          title="Who came in"
          actions={
            <span className="flex items-center gap-2">
              <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" className="w-40" />
              {canAdmin ? (
                <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>
                  Add someone
                </Button>
              ) : null}
            </span>
          }
        />
        <CardBody className="p-0">
          <QueryState query={today} loading={<SkeletonRows rows={3} className="p-3" />}>
            {(d: Schemas["DayRow"][]) =>
              d.length ? (
                <ul className="divide-y divide-border">
                  {d.map((r) => {
                    const s = (staff.data ?? []).find((x) => x.id === r.staff_id);
                    return (
                      <li key={r.staff_id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                        <button type="button" className="min-w-40 text-left font-medium hover:underline" onClick={() => s && canAdmin && setEditing(s)}>
                          {r.name}
                        </button>
                        <span className="text-xs text-subtle">
                          {r.in_at ? `in ${formatTime(r.in_at)}` : "not in"}
                          {r.out_at ? ` · out ${formatTime(r.out_at)}` : ""}
                        </span>
                        {r.late ? <Badge tone="warning">late</Badge> : null}
                        {r.status ? <Badge tone={r.status === "present" ? "success" : r.status === "absent" ? "danger" : "neutral"}>{STATUS_LABEL[r.status]}</Badge> : null}
                        {canWrite ? (
                          <span className="ml-auto flex gap-1">
                            {(Object.keys(STATUS_LABEL) as Status[]).map((st) => (
                              <Button key={st} size="sm" variant={r.status === st ? "primary" : "ghost"} onClick={() => mark.mutate({ staff_id: r.staff_id, status: st })}>
                                {STATUS_LABEL[st]}
                              </Button>
                            ))}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState title="No one on the team yet" description="Add the people who work here, with their WhatsApp numbers." />
              )
            }
          </QueryState>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="The month"
          description="Monday to Saturday count as working days. The pay is an estimate for your accountant: monthly pay in proportion to the days paid for, or daily pay times the days worked."
          actions={
            <span className="flex items-center gap-2">
              <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" className="w-40" />
              {canAdmin ? (
                <Button
                  size="sm"
                  icon={<Download className="h-4 w-4" />}
                  onClick={() =>
                    void downloadFile(`/ventures/${ventureId}/attendance/sheet/file?month=${month}`, `attendance-${month}.xlsx`).catch((e) =>
                      toast.error("Couldn't download it", errorMessage(e)),
                    )
                  }
                >
                  Excel
                </Button>
              ) : null}
            </span>
          }
        />
        <CardBody className="p-0">
          <QueryState query={sheet} loading={<SkeletonRows rows={3} className="p-3" />}>
            {(rows: Schemas["SheetRow"][]) =>
              rows.length ? (
                <Table label="Attendance this month">
                  <THead>
                    <tr>
                      <Th>Name</Th>
                      <Th className="text-right">Present</Th>
                      <Th className="hidden text-right sm:table-cell">Half</Th>
                      <Th className="hidden text-right sm:table-cell">Leave</Th>
                      <Th className="text-right">Absent</Th>
                      <Th className="hidden text-right md:table-cell">Late</Th>
                      <Th className="text-right">Pay (est.)</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {rows.map((r) => (
                      <Tr key={r.staff_id}>
                        <Td>{r.name}</Td>
                        <Td className="text-right tabular-nums">{r.present}</Td>
                        <Td className="hidden text-right tabular-nums sm:table-cell">{r.half_days}</Td>
                        <Td className="hidden text-right tabular-nums sm:table-cell">{r.leave}</Td>
                        <Td className="text-right tabular-nums">{r.absent}</Td>
                        <Td className="hidden text-right tabular-nums md:table-cell">{r.late}</Td>
                        <Td className="text-right tabular-nums">{rupees(r.pay_estimate_paise)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-subtle">No one on the team yet.</p>
              )
            }
          </QueryState>
        </CardBody>
      </Card>
      {editing ? <StaffDialog ventureId={ventureId} staff={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
