import { describeSchedule, SUGGESTIONS } from "@/lib/automation-suggestions";
import { claimOffer, redeem, startRequest } from "@/lib/bff/link";
import { clock, tokenFromHash } from "@/lib/link-client";

const TOKEN = "a".repeat(43);
const origin = { origin: "http://localhost:3000", host: "localhost:3000" };

function req(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", ...origin, ...extra }, body: JSON.stringify(body) });
}

describe("QR sign-in BFF", () => {
  it("keeps the new device's secret in an httpOnly cookie, never in the page", async () => {
    const fake = vi.fn(async () =>
      Response.json({ token: TOKEN, secret: "s".repeat(43), url: `https://app/link#${TOKEN}`, expires_at: "2026-10-16T10:00:00Z", match: "47" }, { status: 201 }),
    );
    const res = await startRequest(req("/api/auth/link/request", {}), fake as unknown as typeof fetch);
    expect(res.status).toBe(201);
    const body = await res.json();
    // the number this page shows (the phone picks it to say yes), never the secret
    expect(body).toEqual({ token: TOKEN, url: `https://app/link#${TOKEN}`, expires_at: "2026-10-16T10:00:00Z", match: "47" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^kv_link=s+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/auth/link");
  });

  it("claims with a valid token only", async () => {
    const fake = vi.fn(async () => Response.json({ secret: "t".repeat(43), device: "Chrome on Android", match: "62" }));
    expect((await claimOffer(req("/api/auth/link/claim", { token: "nope" }), fake as unknown as typeof fetch)).status).toBe(422);
    const res = await claimOffer(req("/api/auth/link/claim", { token: TOKEN }), fake as unknown as typeof fetch);
    expect(await res.json()).toEqual({ device: "Chrome on Android", match: "62" });
    expect(res.headers.get("set-cookie")).toMatch(/^kv_link=t+;/);
  });

  it("redeems with the cookie secret and turns tokens into session cookies", async () => {
    const calls: unknown[] = [];
    const fake = vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return calls.length === 1 ? Response.json({ status: "waiting" }, { status: 202 }) : Response.json({ access_token: "AT", expires_in: 3600, refresh_token: "RT" });
    });
    const r = () => req("/api/auth/link/redeem", { token: TOKEN }, { cookie: `kv_link=${"s".repeat(43)}` });
    expect((await redeem(r(), fake as unknown as typeof fetch)).status).toBe(202);
    const ok = await redeem(r(), fake as unknown as typeof fetch);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const cookies = ok.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("kv_at=AT");
    expect(cookies).toContain("kv_rt=RT");
    expect(calls[0]).toEqual({ token: TOKEN, secret: "s".repeat(43) });
    // without the cookie, nothing is asked of the API
    const none = await redeem(req("/api/auth/link/redeem", { token: TOKEN }), fake as unknown as typeof fetch);
    expect(none.status).toBe(410);
  });

  it("passes Cloudflare's location headers on, so the person approving sees where the device is", async () => {
    const seen: Record<string, string>[] = [];
    const fake = vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return Response.json({ token: TOKEN, secret: "s".repeat(43), url: "u", expires_at: "e", match: "11" }, { status: 201 });
    });
    await startRequest(req("/api/auth/link/request", {}, { "cf-ipcountry": "IN", "cf-ipcity": "Delhi" }), fake as unknown as typeof fetch);
    expect(seen[0]?.["cf-ipcountry"]).toBe("IN");
    expect(seen[0]?.["cf-ipcity"]).toBe("Delhi");
  });

  it("refuses other sites", async () => {
    const bad = new Request("http://localhost:3000/api/auth/link/request", { method: "POST", headers: { origin: "https://evil.example", host: "localhost:3000" } });
    expect((await startRequest(bad, vi.fn() as unknown as typeof fetch)).status).toBe(403);
  });
});

describe("QR helpers and automation suggestions", () => {
  it("reads the token after '#' only", () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash("#short")).toBeNull();
    expect(clock(161)).toBe("2:41");
  });

  it("describes schedules like the API", () => {
    expect(describeSchedule({ freq: "weekly", weekdays: [4, 0], at_time: "09:00" })).toBe("Every Monday and Friday at 9:00 AM");
    expect(describeSchedule({ freq: "daily", at_time: "19:30" })).toBe("Every day at 7:30 PM");
    expect(describeSchedule({ freq: "monthly", day_of_month: 1, at_time: "00:15" })).toBe("On day 1 of every month at 12:15 AM");
  });

  it("every suggestion is a complete, valid draft", () => {
    const ids = new Set<string>();
    for (const s of SUGGESTIONS) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      const d = s.draft;
      expect(d.name.length).toBeLessThanOrEqual(80);
      expect(d.said.length).toBeGreaterThanOrEqual(3);
      expect(d.task.length).toBeGreaterThanOrEqual(3);
      expect(d.at_time).toMatch(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
      if (d.freq === "weekly") expect(d.weekdays?.length ?? 0).toBeGreaterThan(0);
      if (d.freq === "monthly") expect(d.day_of_month).toBeGreaterThanOrEqual(1);
    }
    expect(SUGGESTIONS.length).toBeGreaterThanOrEqual(15);
  });
});
