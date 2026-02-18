"use client";

import { FormEvent, useMemo, useState } from "react";

type ComponentOption = {
  key: string;
  name: string;
};

type Props = {
  components: ComponentOption[];
  orgSlug: string;
  privateToken?: string;
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export function StatusSubscribeCard({ components, orgSlug, privateToken }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"email" | "webhook">("email");
  const [email, setEmail] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const sortedComponents = useMemo(
    () => [...components].sort((a, b) => a.name.localeCompare(b.name)),
    [components]
  );

  const toggleComponent = (key: string) => {
    setSelectedComponents((prev) =>
      prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key]
    );
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const query = privateToken ? `?token=${encodeURIComponent(privateToken)}` : "";
      const response = await fetch(`${API_BASE}/status/o/${encodeURIComponent(orgSlug)}/subscribe${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: mode === "email" ? email.trim() : undefined,
          webhookUrl: mode === "webhook" ? webhookUrl.trim() : undefined,
          componentKeys: selectedComponents
        })
      });

      const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
      if (!response.ok) {
        setMessage(payload.error?.message ?? "Subscription failed. Please try again.");
        return;
      }

      setMessage(payload.message ?? "Subscription request received.");
      setEmail("");
      setWebhookUrl("");
      setSelectedComponents([]);
    } catch {
      setMessage("Subscription failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="kv-card" style={{ marginBottom: "12px" }}>
      <div className="kv-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 className="kv-section-title" style={{ margin: 0 }}>Status Updates</h2>
          <p className="kv-subtitle" style={{ margin: "6px 0 0" }}>
            Subscribe for incident notifications via email or webhook.
          </p>
        </div>
        <button className="kv-button kv-button-secondary" type="button" onClick={() => setOpen((prev) => !prev)}>
          {open ? "Hide" : "Subscribe"}
        </button>
      </div>

      {open ? (
        <form onSubmit={onSubmit} style={{ marginTop: "12px" }}>
          <div className="kv-row" style={{ gap: "8px", marginBottom: "8px" }}>
            <button
              type="button"
              className={`kv-button ${mode === "email" ? "kv-button-primary" : "kv-button-secondary"}`}
              onClick={() => setMode("email")}
            >
              Email
            </button>
            <button
              type="button"
              className={`kv-button ${mode === "webhook" ? "kv-button-primary" : "kv-button-secondary"}`}
              onClick={() => setMode("webhook")}
            >
              Webhook
            </button>
          </div>

          {mode === "email" ? (
            <label style={{ display: "block", marginBottom: "8px" }}>
              <span className="kv-subtitle">Email</span>
              <input
                className="kv-input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
              />
            </label>
          ) : (
            <label style={{ display: "block", marginBottom: "8px" }}>
              <span className="kv-subtitle">Webhook URL</span>
              <input
                className="kv-input"
                type="url"
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
                placeholder="https://example.com/status-webhook"
                required
              />
            </label>
          )}

          <div style={{ marginBottom: "10px" }}>
            <p className="kv-subtitle" style={{ marginBottom: "6px" }}>Components (optional)</p>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "6px" }}>
              {sortedComponents.map((component) => (
                <label key={component.key} className="kv-badge" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedComponents.includes(component.key)}
                    onChange={() => toggleComponent(component.key)}
                    style={{ marginRight: "6px" }}
                  />
                  {component.name}
                </label>
              ))}
            </div>
          </div>

          <button className="kv-button kv-button-primary" type="submit" disabled={submitting}>
            {submitting ? "Subscribing..." : "Subscribe"}
          </button>
          {message ? <p style={{ marginTop: "10px" }}>{message}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
