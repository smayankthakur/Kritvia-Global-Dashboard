import Link from "next/link";
import { cookies } from "next/headers";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

type PublicIncidentPayload = {
  slug: string | null;
  title: string;
  severity: string;
  status: string;
  summary: string | null;
  updates: Array<{ ts: string; message: string }>;
  componentKeys: string[];
  createdAt: string;
  updatedAt: string;
};

type IncidentLoadResult =
  | { kind: "ok"; payload: PublicIncidentPayload }
  | { kind: "auth_required" }
  | { kind: "error" };

async function loadIncident(
  orgSlug: string,
  slug: string,
  token?: string,
  sessionCookie?: string
): Promise<IncidentLoadResult> {
  try {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const response = await fetch(
      `${API_BASE}/status/o/${encodeURIComponent(orgSlug)}/incidents/${encodeURIComponent(slug)}${query}`,
      {
        cache: "no-store",
        headers: sessionCookie ? { Cookie: `kritviya_status_session=${sessionCookie}` } : undefined
      }
    );
    if (response.status === 401) {
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      if (body.error?.code === "STATUS_AUTH_REQUIRED") {
        return { kind: "auth_required" };
      }
    }
    if (!response.ok) {
      return { kind: "error" };
    }
    return { kind: "ok", payload: (await response.json()) as PublicIncidentPayload };
  } catch {
    return { kind: "error" };
  }
}

export default async function OrgPublicIncidentPage({
  params,
  searchParams
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { orgSlug, slug } = await params;
  const { token } = await searchParams;
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("kritviya_status_session")?.value;
  const result = await loadIncident(orgSlug, slug, token, sessionCookie);
  const incident = result.kind === "ok" ? result.payload : null;

  return (
    <main className="kv-main" style={{ maxWidth: "860px", margin: "0 auto" }}>
      <Link href={token ? `/status/o/${orgSlug}?token=${encodeURIComponent(token)}` : `/status/o/${orgSlug}`}>
        Back to status
      </Link>
      {result.kind === "auth_required" ? (
        <div className="kv-card" style={{ marginTop: "12px" }}>
          <h1 style={{ marginTop: 0 }}>Login Required</h1>
          <p>This incident page requires secure status login.</p>
          <Link href={`/status/o/${orgSlug}/login?returnTo=${encodeURIComponent(`/status/o/${orgSlug}/incidents/${slug}`)}`}>
            Go to login
          </Link>
        </div>
      ) : !incident ? (
        <div className="kv-card" style={{ marginTop: "12px" }}>
          <h1 style={{ marginTop: 0 }}>Incident not found</h1>
        </div>
      ) : (
        <>
          <div className="kv-card" style={{ marginTop: "12px" }}>
            <h1 style={{ marginTop: 0 }}>{incident.title}</h1>
            <div className="kv-row" style={{ gap: "8px" }}>
              <span className="kv-badge">{incident.severity}</span>
              <span className="kv-badge">{incident.status}</span>
            </div>
            <p style={{ marginBottom: 0 }}>{incident.summary ?? "No public summary."}</p>
          </div>

          <div className="kv-card" style={{ marginTop: "12px" }}>
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Affected Components
            </h2>
            {incident.componentKeys.length === 0 ? (
              <p style={{ margin: 0 }}>Not specified.</p>
            ) : (
              <div className="kv-row" style={{ gap: "8px", flexWrap: "wrap" }}>
                {incident.componentKeys.map((key) => (
                  <span className="kv-pill" key={key}>
                    {key}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="kv-card" style={{ marginTop: "12px" }}>
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Public Updates
            </h2>
            {incident.updates.length === 0 ? (
              <p style={{ margin: 0 }}>No updates posted yet.</p>
            ) : (
              <ul>
                {incident.updates.map((entry) => (
                  <li key={`${entry.ts}-${entry.message}`}>
                    <strong>{new Date(entry.ts).toLocaleString()}</strong> - {entry.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </main>
  );
}
