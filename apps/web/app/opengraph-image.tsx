import { ImageResponse } from "next/og";

export const alt = "Kritvia — AI agents for Indian businesses that draft; you approve";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The share preview for WhatsApp, LinkedIn and X: brand, promise, and the approval idea. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #0a0f1c 0%, #0f1e3d 60%, #1e3a8a 100%)",
          color: "#f4f5fb",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              background: "#2563eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 44,
              fontWeight: 700,
            }}
          >
            K
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 40, fontWeight: 700 }}>Kritvia</div>
            <div style={{ fontSize: 24, color: "#a8adc7" }}>AI Business OS</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 62, fontWeight: 700, lineHeight: 1.1, maxWidth: 980 }}>
            AI agents for your business that draft. You approve.
          </div>
          <div style={{ fontSize: 30, color: "#c9cce0", maxWidth: 980 }}>
            Inbox replies, priced proposals and document checks in Hindi, Hinglish or English. Nothing is sent without your yes.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#a8adc7" }}>
          <div>Free to start · Starter Rs 2,499 a month</div>
          <div>Data stored in India</div>
        </div>
      </div>
    ),
    size,
  );
}
