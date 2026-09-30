"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { accessKey, useAccess } from "@/lib/access";
import { EMAIL_RE } from "@/lib/auth-client";
import { formatDate, titleCase } from "@/lib/format";

const VENTURE_ROLES = [
  "venture_admin",
  "operator",
  "approver",
  "viewer",
  "kitchen_manager",
  "loan_officer",
] as const;

function AddMember({
  orgId,
  ventureId,
  ventures,
}: {
  orgId: string;
  ventureId: string;
  ventures: { id: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ email: "", role: "approver", scope: ventureId });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/orgs/{org_id}/members", {
          params: { path: { org_id: orgId } },
          body: {
            user_email: f.email.trim(),
            role: f.role,
            venture_id: f.role === "org_owner" ? null : f.scope,
          },
        }),
      ),
    onSuccess: () => {
      toast.success("Member added");
      setF((x) => ({ ...x, email: "" }));
      void qc.invalidateQueries({ queryKey: ["members", orgId] });
      void qc.invalidateQueries({ queryKey: accessKey });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 404)
        setErrors({
          email: "Not in the organisation yet — send them an invitation below",
        });
      else if (e instanceof ApiError && e.status === 409)
        setErrors({ email: "They already have this role" });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!EMAIL_RE.test(f.email.trim())) errs.email = "Enter a valid email";
    setErrors(errs);
    if (!Object.keys(errs).length) m.mutate();
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_11rem_11rem_auto] sm:items-start"
    >
      <Field label="Email" error={errors.email}>
        <Input
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          placeholder="colleague@company.in"
        />
      </Field>
      <Field label="Role">
        <Select
          value={f.role}
          onChange={(e) => setF({ ...f, role: e.target.value })}
        >
          {VENTURE_ROLES.map((r) => (
            <option key={r} value={r}>
              {titleCase(r)}
            </option>
          ))}
          <option value="org_owner">Org owner</option>
        </Select>
      </Field>
      <Field label="Venture">
        <Select
          value={f.role === "org_owner" ? "" : f.scope}
          disabled={f.role === "org_owner"}
          onChange={(e) => setF({ ...f, scope: e.target.value })}
        >
          {f.role === "org_owner" ? (
            <option value="">Whole organisation</option>
          ) : null}
          {ventures.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="sm:pt-[1.625rem]">
        <Button
          type="submit"
          variant="primary"
          loading={m.isPending}
          icon={<UserPlus className="h-4 w-4" />}
          className="w-full"
        >
          Add
        </Button>
      </div>
      {m.isError && !Object.keys(errors).length ? (
        <div className="sm:col-span-4">
          <FormError message={errorMessage(m.error)} />
        </div>
      ) : null}
    </form>
  );
}

function Invitations({
  orgId,
  ventureId,
  ventures,
}: {
  orgId: string;
  ventureId: string;
  ventures: { id: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["invitations", orgId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/orgs/{org_id}/invitations", {
          params: { path: { org_id: orgId } },
        }),
      ),
  });
  const [f, setF] = useState({
    email: "",
    role: "operator" as Schemas["InvitationIn"]["role"],
    venture: ventureId,
    days: 7,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<
    Schemas["InvitationCreatedOut"] | null
  >(null);
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/orgs/{org_id}/invitations", {
          params: { path: { org_id: orgId } },
          body: {
            email: f.email.trim(),
            role: f.role,
            venture_id: f.venture,
            days: f.days,
          },
        }),
      ),
    onSuccess: (out) => {
      setCreated(out);
      setF((x) => ({ ...x, email: "" }));
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/orgs/{org_id}/invitations/{invitation_id}", {
          params: { path: { org_id: orgId, invitation_id: id } },
        }),
      ),
    onSuccess: () => {
      toast.success("Invitation revoked");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Could not revoke", errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!EMAIL_RE.test(f.email.trim())) errs.email = "Enter a valid email";
    setErrors(errs);
    if (!Object.keys(errs).length) add.mutate();
  };
  const status = (i: Schemas["InvitationOut"]) =>
    i.accepted_at ? (
      <Badge tone="success">Accepted</Badge>
    ) : i.revoked_at ? (
      <Badge tone="neutral">Revoked</Badge>
    ) : new Date(i.expires_at) < new Date() ? (
      <Badge tone="warning">Expired</Badge>
    ) : (
      <Badge tone="info">Pending</Badge>
    );
  return (
    <Card>
      <CardHeader
        title="Invite someone new"
        description="New people join through a one-time link you send them yourself. They must sign in with the invited email to accept."
      />
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-start"
      >
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            placeholder="new.hire@company.in"
          />
        </Field>
        <Field label="Role">
          <Select
            value={f.role}
            onChange={(e) =>
              setF({
                ...f,
                role: e.target.value as Schemas["InvitationIn"]["role"],
              })
            }
          >
            {VENTURE_ROLES.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Venture">
          <Select
            value={f.venture}
            onChange={(e) => setF({ ...f, venture: e.target.value })}
          >
            {ventures.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:pt-[1.625rem]">
          <Button
            type="submit"
            variant="primary"
            loading={add.isPending}
            icon={<UserPlus className="h-4 w-4" />}
            className="w-full"
          >
            Create link
          </Button>
        </div>
        {add.isError ? (
          <div className="sm:col-span-4">
            <FormError message={errorMessage(add.error)} />
          </div>
        ) : null}
        {created ? (
          <div className="space-y-2 sm:col-span-4">
            <Notice tone="success">
              Send this link to the invitee (it is shown only once and expires{" "}
              {formatDate(created.expires_at)}).
            </Notice>
            <CopyField value={created.url} label="Invitation link" />
          </div>
        ) : null}
      </form>
      <QueryState query={q} empty={<EmptyState title="No invitations yet" />}>
        {(data) => (
          <Table label="Invitations">
            <THead>
              <tr>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th className="hidden sm:table-cell">Venture</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Revoke</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {data.map((i) => (
                <Tr key={i.id}>
                  <Td className="max-w-[14rem] truncate">{i.email}</Td>
                  <Td>{titleCase(i.role)}</Td>
                  <Td className="hidden text-muted sm:table-cell">
                    {ventures.find((v) => v.id === i.venture_id)?.name ?? "—"}
                  </Td>
                  <Td>{status(i)}</Td>
                  <Td className="text-right">
                    {!i.accepted_at && !i.revoked_at ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Revoke invitation for ${i.email}`}
                        onClick={() => revoke.mutate(i.id)}
                      >
                        <Trash2 className="h-4 w-4" />
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
  );
}

function Grants({
  orgId,
  ventures,
}: {
  orgId: string;
  ventures: { id: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["grants", orgId],
    queryFn: () =>
      unwrap(
        api.GET("/orgs/{org_id}/grants", {
          params: { path: { org_id: orgId } },
        }),
      ),
  });
  const [f, setF] = useState({
    email: "",
    venture: ventures[0]?.id ?? "",
    access: "read" as Schemas["GrantIn"]["access"],
    reason: "",
    expires: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revoke, setRevoke] = useState<Schemas["GrantOut"] | null>(null);
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/orgs/{org_id}/grants", {
          params: { path: { org_id: orgId } },
          body: {
            user_email: f.email.trim(),
            venture_id: f.venture,
            access: f.access,
            reason: f.reason.trim(),
            expires_at: f.expires ? `${f.expires}T23:59:59+05:30` : null,
          },
        }),
      ),
    onSuccess: () => {
      toast.success("Access granted");
      setF((x) => ({ ...x, email: "", reason: "", expires: "" }));
      void qc.invalidateQueries({ queryKey: ["grants", orgId] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 404)
        setErrors({ email: "No account with this email" });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/orgs/{org_id}/grants/{grant_id}", {
          params: { path: { org_id: orgId, grant_id: id } },
        }),
      ),
    onSuccess: () => {
      toast.success("Grant revoked");
      setRevoke(null);
      void qc.invalidateQueries({ queryKey: ["grants", orgId] });
    },
    onError: (e) => toast.error("Could not revoke", errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!EMAIL_RE.test(f.email.trim())) errs.email = "Enter a valid email";
    if (f.reason.trim().length < 3) errs.reason = "Why do they need access?";
    if (!f.venture) errs.venture = "Choose a venture";
    setErrors(errs);
    if (!Object.keys(errs).length) add.mutate();
  };
  const name = (id: string) =>
    ventures.find((x) => x.id === id)?.name ?? id.slice(0, 8);
  return (
    <Card>
      <CardHeader
        title="Cross-venture grants"
        description="Explicit, expiring, audited access to a venture's data — the only way across a venture boundary."
      />
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 lg:grid-cols-[1fr_10rem_7rem_1fr_9rem_auto] lg:items-start"
      >
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </Field>
        <Field label="Venture" error={errors.venture}>
          <Select
            value={f.venture}
            onChange={(e) => setF({ ...f, venture: e.target.value })}
          >
            {ventures.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Access">
          <Select
            value={f.access}
            onChange={(e) =>
              setF({ ...f, access: e.target.value as "read" | "write" })
            }
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </Select>
        </Field>
        <Field label="Reason" error={errors.reason}>
          <Input
            value={f.reason}
            maxLength={300}
            onChange={(e) => setF({ ...f, reason: e.target.value })}
            placeholder="Quarterly audit"
          />
        </Field>
        <Field label="Expires">
          <Input
            type="date"
            value={f.expires}
            onChange={(e) => setF({ ...f, expires: e.target.value })}
          />
        </Field>
        <div className="lg:pt-[1.625rem]">
          <Button
            type="submit"
            variant="primary"
            loading={add.isPending}
            className="w-full"
          >
            Grant
          </Button>
        </div>
      </form>
      <QueryState
        query={q}
        empty={
          <EmptyState
            title="No grants"
            description="Owners see every venture through their own grants."
          />
        }
      >
        {(data) => (
          <Table label="Grants">
            <THead>
              <tr>
                <Th>Person</Th>
                <Th>Venture</Th>
                <Th>Access</Th>
                <Th className="hidden md:table-cell">Reason</Th>
                <Th className="hidden sm:table-cell">Expires</Th>
                <Th>
                  <span className="sr-only">Revoke</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {data.map((g) => (
                <Tr key={g.id}>
                  <Td className="max-w-[14rem] truncate">{g.email}</Td>
                  <Td>{name(g.venture_id)}</Td>
                  <Td>
                    <Badge tone={g.access === "write" ? "warning" : "neutral"}>
                      {g.access}
                    </Badge>
                  </Td>
                  <Td className="hidden max-w-[16rem] truncate text-muted md:table-cell">
                    {g.reason}
                  </Td>
                  <Td className="hidden whitespace-nowrap text-muted sm:table-cell">
                    {g.expires_at ? formatDate(g.expires_at) : "never"}
                  </Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevoke(g)}
                    >
                      Revoke
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </QueryState>
      <ConfirmDialog
        open={Boolean(revoke)}
        onClose={() => setRevoke(null)}
        onConfirm={() => revoke && del.mutate(revoke.id)}
        loading={del.isPending}
        title="Revoke access?"
        description={
          revoke
            ? `${revoke.email} loses ${revoke.access} access to ${name(revoke.venture_id)} immediately.`
            : undefined
        }
        confirmLabel="Revoke"
      />
    </Card>
  );
}

export function MemberSettings({ ventureId }: { ventureId: string }) {
  const { org, ventures, isOwner } = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const orgId = org?.id ?? "";
  const q = useQuery({
    queryKey: ["members", orgId],
    queryFn: () =>
      unwrap(
        api.GET("/orgs/{org_id}/members", {
          params: { path: { org_id: orgId } },
        }),
      ),
    enabled: Boolean(orgId),
  });
  const [removing, setRemoving] = useState<Schemas["MemberOut"] | null>(null);
  const del = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/orgs/{org_id}/members/{membership_id}", {
          params: { path: { org_id: orgId, membership_id: id } },
        }),
      ),
    onSuccess: () => {
      toast.success("Role removed");
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ["members", orgId] });
      void qc.invalidateQueries({ queryKey: accessKey });
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });
  const vs = ventures.map((x) => ({ id: x.venture_id, name: x.venture_name }));
  const vName = (id: string | null) =>
    id
      ? (vs.find((x) => x.id === id)?.name ?? "other venture")
      : "Organisation";

  return (
    <div className="space-y-4">
      {!isOwner ? (
        <Notice tone="info">
          Members and grants are managed by organisation owners.
        </Notice>
      ) : null}
      <Card>
        <CardHeader
          title={`Members of ${org?.name ?? "the organisation"}`}
          description="Roles are per venture; people see only the ventures they hold a role in or are granted. Add roles to existing members here; invite new people below."
        />
        {isOwner ? (
          <AddMember orgId={orgId} ventureId={ventureId} ventures={vs} />
        ) : null}
        <QueryState query={q} empty={<EmptyState title="No members" />}>
          {(data) => (
            <Table label="Members">
              <THead>
                <tr>
                  <Th>Person</Th>
                  <Th>Role</Th>
                  <Th className="hidden sm:table-cell">Scope</Th>
                  <Th>
                    <span className="sr-only">Remove</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {data.map((m) => (
                  <Tr key={m.id}>
                    <Td className="max-w-[16rem]">
                      <span className="block truncate font-medium">
                        {m.full_name}
                      </span>
                      <span className="block truncate text-xs text-subtle">
                        {m.email}
                      </span>
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          m.is_service
                            ? "neutral"
                            : m.role === "org_owner"
                              ? "accent"
                              : "info"
                        }
                      >
                        {titleCase(m.role)}
                      </Badge>
                      {m.is_service ? (
                        <span className="ml-1.5 text-xs text-subtle">
                          agent runtime
                        </span>
                      ) : null}
                    </Td>
                    <Td className="hidden text-muted sm:table-cell">
                      {vName(m.venture_id)}
                    </Td>
                    <Td className="text-right">
                      {isOwner && !m.is_service ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${m.role} from ${m.email}`}
                          onClick={() => setRemoving(m)}
                        >
                          <Trash2 className="h-4 w-4" />
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
      {isOwner ? (
        <Invitations orgId={orgId} ventureId={ventureId} ventures={vs} />
      ) : null}
      {isOwner ? <Grants orgId={orgId} ventures={vs} /> : null}
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && del.mutate(removing.id)}
        loading={del.isPending}
        title="Remove this role?"
        description={
          removing
            ? `${removing.email} loses the ${titleCase(removing.role)} role in ${vName(removing.venture_id)}.`
            : undefined
        }
        confirmLabel="Remove role"
      />
    </div>
  );
}
