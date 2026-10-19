import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke of phase 5 (patch 0091) against a real API on :8000 and `next start` on :3000: the Cash ahead tab,
 * statements by email on the Bank tab, and the Ads tab with an uploaded Meta report.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:8000";
const SHOTS = path.resolve(process.cwd(), "e2e/screenshots");
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.screenshot({ path: path.join(SHOTS, `${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}-mobile.png`), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.describe.serial("Grow and plan ahead", () => {
  let page: Page;
  let venture = "";

  test.beforeAll(async ({ browser, request }) => {
    const suffix = Date.now().toString(36);
    const reg = await request.post(`${API}/auth/register`, { data: { email: `cash-${suffix}@example.com`, full_name: "Mayank Thakur", password: "correct horse battery" } });
    expect(reg.ok()).toBeTruthy();
    const tok = await reg.json();
    const h = { Authorization: `Bearer ${tok.access_token}` };
    const me = await (await request.get(`${API}/auth/me`, { headers: h })).json();
    await request.post(`${API}/auth/me/terms`, { headers: h, data: { version: me.terms_current, adult: true } });
    const org = (await (await request.post(`${API}/orgs`, { headers: h, data: { name: "Mehta Sweets", slug: `ms-${suffix}` } })).json()).id;
    venture = (await (await request.post(`${API}/orgs/${org}/ventures`, { headers: h, data: { name: "Mehta Sweets", slug: `mehta-${suffix}` } })).json()).id;
    await request.put(`${API}/ventures/${venture}/settings`, { headers: h, data: { kind: "general", business_name: "Mehta Sweets", city: "Delhi" } });
    for (const [n, amt, due] of [
      ["Asha Caterers", 4500000, 6],
      ["Kapoor Events", 2800000, 20],
      ["Gupta Wedding Planners", 6200000, 40],
    ] as const) {
      await request.post(`${API}/ventures/${venture}/invoices`, { headers: h, data: { customer_name: n, amount_paise: amt, due_on: day(due) } });
    }
    await request.post(`${API}/ventures/${venture}/bills`, { headers: h, data: { vendor: "Shree Dairy", amount_paise: 3800000, due_on: day(3) } });
    await request.post(`${API}/ventures/${venture}/bills`, { headers: h, data: { vendor: "Landlord", amount_paise: 6000000, due_on: day(13) } });
    await request.post(`${API}/ventures/${venture}/staff`, { headers: h, data: { name: "Ramesh", pay_kind: "monthly", pay_paise: 1800000 } });
    await request.put(`${API}/ventures/${venture}/cash/settings`, { headers: h, data: { balance_paise: 5000000, monthly_fixed_paise: 1200000, alert_below_paise: 2500000, clear_alert: false, clear_balance: false } });
    const meta = `Campaign name,Reporting starts,Reporting ends,Amount spent (INR),Impressions,Link clicks,Results\nDiwali Mithai Boxes,${day(-20)},${day(-1)},"8,400.00",120000,1900,31\nBrand Reels,${day(-20)},${day(-1)},3600,210000,420,\n`;
    const up = await request.post(`${API}/ventures/${venture}/ads/reports`, { headers: h, multipart: { file: { name: "meta.csv", mimeType: "text/csv", buffer: Buffer.from(meta) } } });
    expect(up.ok()).toBeTruthy();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
    await ctx.addCookies([
      { name: "kv_at", value: tok.access_token, url: "http://localhost:3000" },
      { name: "kv_rt", value: tok.refresh_token, url: "http://localhost:3000" },
    ]);
    page = await ctx.newPage();
  });

  test("cash ahead", async () => {
    await page.goto(`/v/${venture}/money`);
    await expect(page.getByRole("heading", { name: "Money" })).toBeVisible();
    await expect(page.getByText("Next 30 days")).toBeVisible();
    await expect(page.getByRole("img", { name: /Expected balance at the end of each/ })).toBeVisible();
    await expect(page.getByText(/A tight week/)).toBeVisible();
    await shot(page, "50-cash-ahead");
  });

  test("statements by email", async () => {
    await page.goto(`/v/${venture}/money?tab=bank`);
    await expect(page.getByText("Statements by email")).toBeVisible();
    await page.getByLabel("Statement PDF password").fill("CUST1234");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Saved \(it is never shown again\)/)).toBeVisible();
    await shot(page, "51-statements-by-email");
  });

  test("ads", async () => {
    await page.goto(`/v/${venture}/marketing?tab=ads`);
    await expect(page.locator("p", { hasText: "Facebook / Instagram (Meta)" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Diwali Mithai Boxes/ })).toBeVisible();
    await expect(page.getByText("Tag your ad links")).toBeVisible();
    await shot(page, "52-ads");
  });
});
