"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime, titleCase } from "@/lib/format";

type ConsentIn = Schemas["kritvia_api__routers__compliance__ConsentIn"];
type Basis = NonNullable<ConsentIn["lawful_basis"]>;
type Channel = NonNullable<ConsentIn["channel"]>;
const BASES = enumValues<Basis>()("consent", "legitimate_use");
const CHANNELS = enumValues<Channel>()("web", "email", "paper", "whatsapp", "verbal");

export function Consents({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [lookup, setLookup] = useState("");
  const [applied, setApplied] = useState("");
  const q = useQuery({
    queryKey: ["consents", ventureId, applied],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/consents", { params: { path: { venture_id: ventureId }, query: { identifier: applied || undefined } } })),
  });
  const [f, setF] = useState({ identifier: "", purpose: "marketing_updates", notice_version: "v1", lawful_basis: "consent" as Basis, channel: "web" as Channel });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [withdraw, setWithdraw] = useState<Schemas["ConsentOut"] | null>(null);

  const add = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/consents", { params: { path: { venture_id: ventureId } }, body: { ...f, identifier: f.identifier.trim() } })),
    onSuccess: () => {
      toast.success("Consent recorded");
      setF((x) => ({ ...x, identifier: "" }));
      void qc.invalidateQueries({ queryKey: ["consents", ventureId] });
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });
  const wd = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/ventures/{venture_id}/consents/{consent_id}/withdraw", { params: { path: { venture_id: ventureId, consent_id: id } } })),
    onSuccess: () => {
      toast.success("Consent withdrawn");
      setWithdraw(null);
      void qc.invalidateQueries({ queryKey: ["consents", ventureId] });
    },
    onError: (e) => toast.error("Could not withdraw", errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (f.identifier.trim().length < 3) errs.identifier = "Email, phone or PAN";
    if (!/^[a-z0-9_]{2,60}$/.test(f.purpose)) errs.purpose = "lower_snake_case, e.g. loan_processing";
    if (!f.notice_version.trim()) errs.notice_version = "Required";
    setErrors(errs);
    if (!Object.keys(errs).length) add.mutate();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <form
          className="flex gap-2 border-b border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(lookup.trim());
          }}
        >
          <label htmlFor="consent-lookup" className="sr-only">
            Find by email, phone or PAN
          </label>
          <Input id="consent-lookup" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Find by email, phone or PAN" />
          <Button type="submit" icon={<Search className="h-4 w-4" />}>
            Find
          </Button>
          {applied ? (
            <Button
              variant="ghost"
              onClick={() => {
                setLookup("");
                setApplied("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
        <QueryState query={q} empty={<EmptyState icon={ShieldCheck} title={applied ? "No consents for that person" : "No consents recorded"} />}>
          {(data) => (
            <Table label="Consents">
              <THead>
                <tr>
                  <Th>Data principal</Th>
                  <Th>Purpose</Th>
                  <Th className="hidden 2xl:table-cell">Basis · channel</Th>
                  <Th className="hidden sm:table-cell">Granted</Th>
                  <Th>Status</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {data.map((c) => (
                  <Tr key={c.id}>
                    <Td className="font-mono text-[13px]">{c.principal_label}</Td>
                    <Td>
                      <span className="font-mono text-xs">{c.purpose}</span>
                      <span className="block text-xs text-subtle">notice {c.notice_version}</span>
                    </Td>
                    <Td className="hidden text-muted 2xl:table-cell">
                      {titleCase(c.lawful_basis)} · {c.channel}
                    </Td>
                    <Td className="hidden whitespace-nowrap text-muted sm:table-cell">{formatDateTime(c.granted_at)}</Td>
                    <Td>{c.withdrawn_at ? <Badge title={formatDateTime(c.withdrawn_at)}>withdrawn</Badge> : <Badge tone="success">active</Badge>}</Td>
                    <Td className="text-right">
                      {!c.withdrawn_at ? (
                        <Button size="sm" variant="ghost" onClick={() => setWithdraw(c)}>
                          Withdraw
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Record consent" description="Identifiers are stored as a keyed hash plus a masked label." />
        <form onSubmit={submit} noValidate className="space-y-3 p-4">
          <FormError message={add.isError && !Object.keys(errors).length ? errorMessage(add.error) : null} />
          <Field label="Email, phone or PAN" error={errors.identifier} required>
            <Input value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Purpose" error={errors.purpose} required>
            <Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value.toLowerCase() })} className="font-mono text-[13px]" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Notice version" error={errors.notice_version} required>
              <Input value={f.notice_version} onChange={(e) => setF({ ...f, notice_version: e.target.value })} maxLength={40} />
            </Field>
            <Field label="Channel">
              <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as Channel })}>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {titleCase(c)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Lawful basis">
            <Select value={f.lawful_basis} onChange={(e) => setF({ ...f, lawful_basis: e.target.value as Basis })}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {titleCase(b)}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" loading={add.isPending} className="w-full">
            Record consent
          </Button>
        </form>
      </Card>
      <ConfirmDialog
        open={Boolean(withdraw)}
        onClose={() => setWithdraw(null)}
        onConfirm={() => withdraw && wd.mutate(withdraw.id)}
        loading={wd.isPending}
        title="Withdraw consent?"
        description={withdraw ? `Processing of ${withdraw.principal_label}'s data for ${withdraw.purpose} must stop. The record is kept as evidence.` : undefined}
        confirmLabel="Withdraw"
      />
    </div>
  );
}
