import Link from "next/link";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

type StatusPayload = {
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

async function loadStatus(): Promise<StatusPayload | null> {
  try {
    const response = await fetch(`${API_BASE}/status`, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as StatusPayload;
  } catch {
    return null;
  }
}

export default async function PublicStatusPage() {
  const payload = await loadStatus();

  return (
    <main className="kv-main" style={{ maxWidth: "1040px", margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Kritviya Status</h1>
      <p className="kv-subtitle" style={{ marginBottom: "16px" }}>Live platform health and active incidents</p>

      {!payload ? (
        <div className="kv-card">
          <p style={{ margin: 0 }}>Status page is temporarily unavailable.</p>
        </div>
      ) : (
        <>
          <div className="kv-card" style={{ marginBottom: "12px" }}>
            <p style={{ margin: 0 }}>Overall status</p>
            <h2 className="kv-section-title" style={{ marginTop: "8px" }}>{payload.overallStatus}</h2>
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
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>Active Public Incidents</h2>
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
                      <Link href={`/status/incidents/${incident.slug}`}>View details</Link>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
