"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { formatDateTime, formatRelative } from "@/lib/format";

type Key = Schemas["ApiKeyOut"];

/** What a key can reach (kept in step with services/api_keys.py on the API). */
const ENDPOINTS: { method: string; path: string; what: string; write?: boolean }[] = [
  { method: "GET", path: "/orgs/{org_id}/ventures", what: "Your businesses and their IDs" },
  { method: "GET", path: "/ventures/{venture_id}/leads", what: "Leads (add /{id} for one)" },
  { method: "GET", path: "/ventures/{venture_id}/invoices", what: "Invoices (add /{id} for one, /{id}/document for the PDF)" },
  { method: "GET", path: "/ventures/{venture_id}/bookings", what: "Bookings" },
  { method: "GET", path: "/ventures/{venture_id}/proposals", what: "Proposals" },
  { method: "GET", path: "/ventures/{venture_id}/approvals", what: "Drafts waiting for a yes" },
  { method: "GET", path: "/ventures/{venture_id}/automations", what: "Automations" },
  { method: "GET", path: "/ventures/{venture_id}/analytics?days=30", what: "Analytics for 7–365 days" },
  { method: "POST", path: "/ventures/{venture_id}/leads", what: "Add a lead", write: true },
  { method: "PATCH", path: "/ventures/{venture_id}/leads/{id}", what: "Update a lead", write: true },
  { method: "POST", path: "/ventures/{venture_id}/invoices", what: "Add an invoice", write: true },
  { method: "POST", path: "/ventures/{venture_id}/invoices/{id}/payment", what: "Record a payment", write: true },
  { method: "POST", path: "/ventures/{venture_id}/bookings", what: "Add a booking", write: true },
];

function NewKey({ orgId, onMade }: { orgId: string; onMade: (k: Schemas["NewApiKeyOut"]) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const make = useMutation({
    mutationFn: () => unwrap(api.POST("/orgs/{org_id}/api-keys", { params: { path: { org_id: orgId } }, body: { name: name.trim(), scope } })),
    onSuccess: (k) => {
      setName("");
      onMade(k);
      void qc.invalidateQueries({ queryKey: ["api-keys", orgId] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) make.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 p-4">
      <Field label="Name" hint="Where it's used, e.g. Website form or Zapier" className="min-w-[14rem] flex-1">
        <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Website form" />
      </Field>
      <Field label="Access" className="w-44">
        <Select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
          <option value="read">Read only</option>
          <option value="write">Read and add</option>
        </Select>
      </Field>
      <Button type="submit" variant="primary" icon={<Plus className="h-4 w-4" />} loading={make.isPending} disabled={!name.trim()}>
        Make a key
      </Button>
      {make.isError ? (
        <div className="basis-full">
          <FormError message={errorMessage(make.error)} />
        </div>
      ) : null}
    </form>
  );
}

function Revoke({ orgId, k }: { orgId: string; k: Key }) {
  const qc = useQueryClient();
  const [sure, setSure] = useState(false);
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE("/orgs/{org_id}/api-keys/{key_id}", { params: { path: { org_id: orgId, key_id: k.id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["api-keys", orgId] }),
  });
  if (k.revoked_at) return <span className="text-xs text-subtle">Revoked {formatRelative(k.revoked_at)}</span>;
  return sure ? (
    <span className="flex items-center gap-2">
      <Button size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>
        Revoke now
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
        Keep
      </Button>
    </span>
  ) : (
    <Button size="sm" onClick={() => setSure(true)}>
      Revoke
    </Button>
  );
}

export default function DevelopersPage() {
  const { org, isOwner } = useAccess();
  const [made, setMade] = useState<Schemas["NewApiKeyOut"] | null>(null);
  const q = useQuery({
    queryKey: ["api-keys", org?.id],
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/api-keys", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org && isOwner),
  });

  if (!isOwner) {
    return (
      <>
        <PageHeader eyebrow={org?.name} title="API keys" />
        <EmptyState icon={Lock} title="Only owners manage API keys" description="Ask your organisation's owner." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={org?.name}
        title="API keys"
        description="Let your own website, spreadsheet or tools add leads, invoices and bookings, and read your numbers. Each key works only for this organisation and only on the endpoints listed below."
      />
      <QueryState query={q} loading={<SkeletonRows rows={4} />}>
        {(d) => (
          <div className="space-y-6">
            {!d.available ? (
              <Card>
                <CardHeader title="API access is on the Scale and Enterprise plans" description="Connect your website forms, your accounting tools or Zapier and Make to Kritvia." />
                <CardBody>
                  <Link href="/billing" className="text-sm text-accent hover:underline">
                    See plans
                  </Link>
                </CardBody>
              </Card>
            ) : (
              <Card>
                <CardHeader
                  title="Make a key"
                  description={
                    <>
                      A read-only key can only look. A read-and-add key can also add leads, invoices, payments and bookings. No key can delete anything. Keys follow{" "}
                      <Link href="/terms" className="text-accent hover:underline">
                        Terms 4.7
                      </Link>
                      : keep them secret, and everything done with one counts as done by you.
                    </>
                  }
                />
                <NewKey orgId={org!.id} onMade={setMade} />
              </Card>
            )}

            {made ? (
              <Notice tone="success" title={`Your new key "${made.name}"`}>
                <p className="mb-2">Copy it now and keep it somewhere safe: Kritvia shows it only this once.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs break-all text-fg">{made.key}</code>
                  <CopyButton value={made.key} label="Copy key" />
                  <Button size="sm" variant="ghost" onClick={() => setMade(null)}>
                    I&apos;ve saved it
                  </Button>
                </div>
              </Notice>
            ) : null}

            <Card>
              <CardHeader title="Your keys" description="Revoking a key stops it at once. Keys stop working if the plan no longer includes API access." />
              {d.keys.length ? (
                <Table label="API keys">
                  <THead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Key</Th>
                      <Th>Access</Th>
                      <Th>Made</Th>
                      <Th>Last used</Th>
                      <Th />
                    </Tr>
                  </THead>
                  <TBody>
                    {d.keys.map((k) => (
                      <Tr key={k.id}>
                        <Td className="font-medium">{k.name}</Td>
                        <Td className="font-mono text-xs text-muted">{k.prefix}…</Td>
                        <Td>
                          <Badge tone={k.scope === "write" ? "warning" : "neutral"}>{k.scope === "write" ? "Read and add" : "Read only"}</Badge>
                        </Td>
                        <Td className="text-muted">{formatDateTime(k.created_at)}</Td>
                        <Td className="text-muted">{k.last_used_at ? formatRelative(k.last_used_at) : "Never"}</Td>
                        <Td className="text-right">
                          <Revoke orgId={org!.id} k={k} />
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <EmptyState icon={KeyRound} title="No keys yet" description={d.available ? "Make one above." : "Keys come with the Scale plan."} />
              )}
            </Card>

            <Card>
              <CardHeader title="How to use a key" description="Send it in the Authorization header. Up to 120 requests a minute per key; amounts are in paise." />
              <CardBody className="space-y-4">
                <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed text-fg">
                  {`curl ${d.base_url}/ventures/{venture_id}/leads \\\n  -H "Authorization: Bearer kvk_…"\n\ncurl -X POST ${d.base_url}/ventures/{venture_id}/leads \\\n  -H "Authorization: Bearer kvk_…" -H "Content-Type: application/json" \\\n  -d '{"name": "Neha Sharma", "email": "neha@example.com", "source": "website"}'`}
                </pre>
                <Table label="Endpoints a key can use">
                  <THead>
                    <Tr>
                      <Th>Method</Th>
                      <Th>Path</Th>
                      <Th>What it does</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {ENDPOINTS.map((e) => (
                      <Tr key={e.method + e.path}>
                        <Td>
                          <Badge tone={e.write ? "warning" : "info"}>{e.method}</Badge>
                        </Td>
                        <Td className="font-mono text-xs">{e.path}</Td>
                        <Td className="text-muted">
                          {e.what}
                          {e.write ? " (read-and-add keys)" : ""}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
                <p className="text-xs text-subtle">
                  Answers: 401 the key is wrong or revoked, 402 the plan doesn&apos;t include API access, 403 this key can&apos;t use that endpoint, 404 not found in this organisation, 429 slow down.
                </p>
              </CardBody>
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}
