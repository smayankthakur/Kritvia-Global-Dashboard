import Link from "next/link";

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

async function loadIncident(slug: string): Promise<PublicIncidentPayload | null> {
  try {
    const response = await fetch(`${API_BASE}/status/incidents/${slug}`, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as PublicIncidentPayload;
  } catch {
    return null;
  }
}

export default async function PublicIncidentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const incident = await loadIncident(slug);

  return (
    <main className="kv-main" style={{ maxWidth: "860px", margin: "0 auto" }}>
      <Link href="/status">Back to status</Link>
      {!incident ? (
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
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>Affected Components</h2>
            {incident.componentKeys.length === 0 ? (
              <p style={{ margin: 0 }}>Not specified.</p>
            ) : (
              <div className="kv-row" style={{ gap: "8px", flexWrap: "wrap" }}>
                {incident.componentKeys.map((key) => (
                  <span className="kv-pill" key={key}>{key}</span>
                ))}
              </div>
            )}
          </div>

          <div className="kv-card" style={{ marginTop: "12px" }}>
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>Public Updates</h2>
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
