"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy";
import { Field, FormError, Input, Switch } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { formatRelative } from "@/lib/format";

type S = Schemas["SsoOut"];

const PROVIDERS: [string, string][] = [
  ["Google Workspace", "https://accounts.google.com"],
  ["Microsoft Entra ID", "https://login.microsoftonline.com/<tenant ID>/v2.0"],
  ["Okta", "https://<your-org>.okta.com"],
  ["Zoho, Keycloak, Auth0, OneLogin…", "the issuer URL from the provider's OpenID Connect settings"],
];

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-subtle">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs break-all text-fg">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function Settings({ orgId, s }: { orgId: string; s: S }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState(s.domain ?? "");
  const [issuer, setIssuer] = useState(s.issuer ?? "");
  const [clientId, setClientId] = useState(s.client_id ?? "");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(s.configured ? s.enabled : true);
  const [enforce, setEnforce] = useState(s.enforce);
  const [saved, setSaved] = useState(false);
  useEffect(() => setEnforce(s.enforce), [s.enforce]);
  const set = (d: S) => qc.setQueryData(["sso", orgId], d);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/orgs/{org_id}/sso", {
          params: { path: { org_id: orgId } },
          body: { domain: domain.trim().toLowerCase(), issuer: issuer.trim(), client_id: clientId.trim(), client_secret: secret.trim() || null, enabled, enforce },
        }),
      ),
    onSuccess: (d) => {
      set(d);
      setSecret("");
      setSaved(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate();
  };
  const ready = domain.trim() && issuer.trim() && clientId.trim() && (s.configured || secret.trim());
  return (
    <form onSubmit={submit} className="space-y-4">
      <FormError message={save.isError ? errorMessage(save.error) : null} />
      {saved ? <Notice tone="success">Saved.</Notice> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email domain" hint="Everyone whose email ends with this signs in through your provider" required>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.in" autoCapitalize="none" />
        </Field>
        <Field label="Issuer URL" hint="From your identity provider's OpenID Connect settings" required>
          <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://login.microsoftonline.com/…/v2.0" autoCapitalize="none" />
        </Field>
        <Field label="Client ID" required>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Client secret" hint={s.configured ? "Saved and encrypted. Leave empty to keep it." : "Stored encrypted; never shown again"} required={!s.configured}>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <div className="space-y-3 rounded-lg border border-border p-3">
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Single sign-on is on</span>
            <span className="block text-xs text-subtle">People on the domain can choose &quot;Sign in with SSO&quot;.</span>
          </span>
          <Switch checked={enabled} onChange={setEnabled} label="Single sign-on is on" />
        </label>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Require single sign-on</span>
            <span className="block text-xs text-subtle">
              People on the domain can then sign in only through your provider (no passwords, email codes or Google). Available after an owner has signed in through SSO, so a wrong
              setting can&apos;t lock everyone out. People already signed in stay signed in until their session ends.
            </span>
          </span>
          <Switch checked={enforce} onChange={setEnforce} label="Require single sign-on" disabled={!s.owner_tested && !s.enforce} />
        </label>
      </div>
      <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
        {s.configured ? "Save changes" : "Save"}
      </Button>
    </form>
  );
}

export default function SsoPage() {
  const { org, isOwner } = useAccess();
  const qc = useQueryClient();
  const [sure, setSure] = useState(false);
  const q = useQuery({
    queryKey: ["sso", org?.id],
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/sso", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org && isOwner),
  });
  const verify = useMutation({
    mutationFn: () => unwrap(api.POST("/orgs/{org_id}/sso/verify", { params: { path: { org_id: org!.id } } })),
    onSuccess: (d) => qc.setQueryData(["sso", org?.id], d),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/orgs/{org_id}/sso", { params: { path: { org_id: org!.id } } })),
    onSuccess: () => {
      setSure(false);
      void qc.invalidateQueries({ queryKey: ["sso", org?.id] });
    },
  });

  if (!isOwner) {
    return (
      <>
        <PageHeader eyebrow={org?.name} title="Single sign-on" />
        <EmptyState icon={Lock} title="Only owners set up single sign-on" description="Ask your organisation's owner." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={org?.name}
        title="Single sign-on"
        description="Your team signs in to Kritvia with your company's own accounts (Google Workspace, Microsoft Entra ID, Okta or any OpenID Connect provider). When someone leaves, switching off their company account also closes Kritvia."
      />
      <QueryState query={q} loading={<SkeletonRows rows={5} />}>
        {(s) =>
          !s.available ? (
            <Card>
              <CardHeader title="Single sign-on is on the Enterprise plan" description="With it: SSO for your email domain, an option to require it, and everything in Scale." />
              <CardBody>
                <Link href="/billing" className="text-sm text-accent hover:underline">
                  See plans or talk to us
                </Link>
              </CardBody>
            </Card>
          ) : (
            <div className="space-y-6">
              <Card>
                <CardHeader
                  title="1. Register Kritvia with your identity provider"
                  description="Make a web app (OpenID Connect, authorization code) in your provider and give it this redirect URL. Ask for the openid, email and profile scopes."
                />
                <CardBody className="space-y-3">
                  <Copyable label="Redirect URL" value={s.redirect_uri} />
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted">Where to find the issuer URL</summary>
                    <ul className="mt-2 space-y-1 text-xs text-subtle">
                      {PROVIDERS.map(([p, v]) => (
                        <li key={p}>
                          <span className="font-medium text-fg">{p}:</span> <code className="font-mono">{v}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="2. Your provider's details"
                  description={
                    <>
                      Single sign-on follows{" "}
                      <Link href="/terms" className="text-accent hover:underline">
                        Terms 4.6
                      </Link>
                      : your provider decides who can sign in for your domain.
                    </>
                  }
                />
                <CardBody>
                  <Settings key={`${s.domain}-${s.issuer}-${s.client_id}`} orgId={org!.id} s={s} />
                </CardBody>
              </Card>

              {s.configured ? (
                <Card>
                  <CardHeader
                    title="3. Prove you own the domain"
                    description="Add this TXT record where your domain's DNS is managed (GoDaddy, Cloudflare, Hostinger…), then check it. Kritvia uses SSO for the domain only after this."
                    actions={
                      s.verified ? (
                        <Badge tone="success">
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                          Proved
                        </Badge>
                      ) : (
                        <Button size="sm" variant="primary" loading={verify.isPending} onClick={() => verify.mutate()}>
                          Check the record
                        </Button>
                      )
                    }
                  />
                  <CardBody className="space-y-3">
                    {verify.isError ? <FormError message={errorMessage(verify.error)} /> : null}
                    <Copyable label="Name (host)" value={s.txt_name ?? ""} />
                    <Copyable label="Value" value={s.txt_value ?? ""} />
                  </CardBody>
                </Card>
              ) : null}

              {s.configured ? (
                <Card>
                  <CardHeader
                    title="4. Try it"
                    description={`Sign out, choose "Sign in with SSO" and use your ${s.domain} email. People need a Kritvia account or an invitation first: invite them from Businesses.`}
                  />
                  <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2 text-muted">
                      <ShieldCheck className="h-4 w-4" aria-hidden />
                      {s.last_signin_at ? `Last SSO sign-in ${formatRelative(s.last_signin_at)}` : "Nobody has signed in through SSO yet."}
                      {s.enforce ? <Badge tone="warning">Required</Badge> : null}
                    </span>
                    {sure ? (
                      <span className="flex items-center gap-2">
                        <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                          Remove single sign-on
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
                          Keep it
                        </Button>
                      </span>
                    ) : (
                      <Button size="sm" onClick={() => setSure(true)}>
                        Remove…
                      </Button>
                    )}
                  </CardBody>
                </Card>
              ) : null}
            </div>
          )
        }
      </QueryState>
    </>
  );
}
