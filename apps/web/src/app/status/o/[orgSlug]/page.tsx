import Link from "next/link";
import { cookies } from "next/headers";
import { StatusSubscribeCard } from "../../subscribe-card";
import { StatusAuthActions } from "./status-auth-actions";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

type StatusPayload = {
  org: {
    slug: string;
    name: string;
    logoUrl: string | null;
    accentColor: string | null;
    footerText: string | null;
    visibility: string;
  };
  overallStatus: string;
  components: Array<{
    key: string;
    name: string;
    description: string | null;
    status: string;
    uptime24h: number;
    uptime7d: number;
    updatedAt: string;
  }>;
  activeIncidents: Array<{
    slug: string | null;
    title: string;
    severity: string;
    status: string;
    summary: string | null;
    updatedAt: string;
  }>;
};

type StatusLoadResult =
  | { kind: "ok"; payload: StatusPayload }
  | { kind: "auth_required" }
  | { kind: "error" };

async function loadStatus(orgSlug: string, token?: string, sessionCookie?: string): Promise<StatusLoadResult> {
  try {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const response = await fetch(`${API_BASE}/status/o/${encodeURIComponent(orgSlug)}${query}`, {
      cache: "no-store",
      headers: sessionCookie ? { Cookie: `kritviya_status_session=${sessionCookie}` } : undefined
    });
    if (response.status === 401) {
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      if (body.error?.code === "STATUS_AUTH_REQUIRED") {
        return { kind: "auth_required" };
      }
    }
    if (!response.ok) {
      return { kind: "error" };
    }
    return { kind: "ok", payload: (await response.json()) as StatusPayload };
  } catch {
    return { kind: "error" };
  }
}

export default async function OrgPublicStatusPage({
  params,
  searchParams
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { orgSlug } = await params;
  const { token } = await searchParams;
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("kritviya_status_session")?.value;
  const result = await loadStatus(orgSlug, token, sessionCookie);
  const payload = result.kind === "ok" ? result.payload : null;

  const accentColor = payload?.org.accentColor ?? "#c8a66a";

  return (
    <main className="kv-main" style={{ maxWidth: "1040px", margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, color: accentColor }}>{payload?.org.name ?? "Status"}</h1>
      <p className="kv-subtitle" style={{ marginBottom: "16px" }}>
        Live platform health and active incidents
      </p>

      <StatusAuthActions orgSlug={orgSlug} authRequired={result.kind === "auth_required"} authenticated={Boolean(payload)} />

      {result.kind === "auth_required" ? null : !payload ? (
        <div className="kv-card">
          <p style={{ margin: 0 }}>Status page is unavailable or access token is invalid.</p>
        </div>
      ) : (
        <>
          <StatusSubscribeCard
            components={payload.components.map((component) => ({
              key: component.key,
              name: component.name
            }))}
            orgSlug={payload.org.slug}
            privateToken={token}
          />

          <div className="kv-card" style={{ marginBottom: "12px" }}>
            <p style={{ margin: 0 }}>Overall status</p>
            <h2 className="kv-section-title" style={{ marginTop: "8px", color: accentColor }}>
              {payload.overallStatus}
            </h2>
          </div>

          <section className="kv-grid-2" style={{ marginBottom: "12px" }}>
            {payload.components.map((component) => (
              <article key={component.key} className="kv-card">
                <div className="kv-row" style={{ justifyContent: "space-between" }}>
                  <h3 style={{ margin: 0 }}>{component.name}</h3>
                  <span className="kv-badge">{component.status}</span>
                </div>
                <p className="kv-subtitle">{component.description ?? "-"}</p>
                <p style={{ margin: 0 }}>Uptime 24h: {component.uptime24h}%</p>
                <p style={{ margin: 0 }}>Uptime 7d: {component.uptime7d}%</p>
              </article>
            ))}
          </section>

          <section className="kv-card">
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Active Public Incidents
            </h2>
            {payload.activeIncidents.length === 0 ? (
              <p style={{ margin: 0 }}>No active incidents.</p>
            ) : (
              <div className="kv-stack">
                {payload.activeIncidents.map((incident) => (
                  <article key={`${incident.slug}-${incident.updatedAt}`} className="kv-action-item">
                    <div className="kv-row" style={{ justifyContent: "space-between" }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>{incident.title}</p>
                      <span className="kv-badge">{incident.severity}</span>
                    </div>
                    <p style={{ margin: "6px 0" }}>{incident.summary ?? "No public summary."}</p>
                    {incident.slug ? (
                      <Link
                        href={
                          token
                            ? `/status/o/${payload.org.slug}/incidents/${incident.slug}?token=${encodeURIComponent(token)}`
                            : `/status/o/${payload.org.slug}/incidents/${incident.slug}`
                        }
                      >
                        View details
                      </Link>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
          {payload.org.footerText ? (
            <p className="kv-subtitle" style={{ marginTop: "16px", textAlign: "center" }}>
              {payload.org.footerText}
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
