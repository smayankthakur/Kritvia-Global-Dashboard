import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke of patch 0066's features (analytics, API keys, custom workflows, SSO settings and sign-in,
 * pricing) against a real API on :8000 and `next start` on :3000. The plan is set with psql on the
 * test database (E2E_ADMIN_DSN), so this runs only where that database is reachable.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:8000";
// The API's own database (as postgres), e.g. postgresql://postgres:postgres@localhost/kritvia_e2e. Without it
// these tests are skipped: guessing the database set the plan on the wrong one and failed confusingly.
const ADMIN_DSN = process.env.E2E_ADMIN_DSN ?? "";
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

test.describe.serial("Scale and Enterprise features", () => {
  test.skip(!ADMIN_DSN, "set E2E_ADMIN_DSN to the API's database (the plan is set there with psql)");
  let page: Page;
  let venture = "";
  let org = "";

  test.beforeAll(async ({ browser, request }) => {
    const suffix = Date.now().toString(36);
    const email = `scale-${suffix}@example.com`;
    const reg = await request.post(`${API}/auth/register`, { data: { email, full_name: "Mayank Thakur", password: "correct horse battery" } });
    expect(reg.ok()).toBeTruthy();
    const tok = await reg.json();
    const h = { Authorization: `Bearer ${tok.access_token}` };
    const me = await (await request.get(`${API}/auth/me`, { headers: h })).json();
    await request.post(`${API}/auth/me/terms`, { headers: h, data: { version: me.terms_current, adult: true } });
    org = (await (await request.post(`${API}/orgs`, { headers: h, data: { name: "Scale Co", slug: `sc-${suffix}` } })).json()).id;
    venture = (await (await request.post(`${API}/orgs/${org}/ventures`, { headers: h, data: { name: "Clean Co", slug: `cc-${suffix}` } })).json()).id;
    await request.put(`${API}/ventures/${venture}/settings`, { headers: h, data: { kind: "general", business_name: "Clean Co", city: "Delhi" } });
    for (const [n, days, paid] of [["Ravi", 40, true], ["Neha", 5, false], ["Asha", 12, true]] as const) {
      const due = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const inv = await (await request.post(`${API}/ventures/${venture}/invoices`, { headers: h, data: { customer_name: n, customer_email: `${n.toLowerCase()}@example.com`, amount_paise: 450000, due_on: due } })).json();
      if (paid) await request.post(`${API}/ventures/${venture}/invoices/${inv.id}/payment`, { headers: h, data: { amount_paise: 450000 } });
      await request.post(`${API}/ventures/${venture}/leads`, { headers: h, data: { name: `${n} lead`, email: `${n.toLowerCase()}.lead@example.com`, source: "website" } });
    }
    execFileSync("psql", [ADMIN_DSN, "-qc", `INSERT INTO org_plans (org_id, plan) VALUES ('${org}', 'enterprise') ON CONFLICT (org_id) DO UPDATE SET plan = 'enterprise'`]);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
    await ctx.addCookies([
      { name: "kv_at", value: tok.access_token, url: "http://localhost:3000" },
      { name: "kv_rt", value: tok.refresh_token, url: "http://localhost:3000" },
    ]);
    page = await ctx.newPage();
  });

  test("pricing lists the features as included, with nothing coming soon", async () => {
    await page.goto("/welcome#pricing");
    await expect(page.getByText("API access for your website and tools").first()).toBeVisible();
    await expect(page.getByText(/Single sign-on \(SSO\) with your identity provider/).first()).toBeVisible();
    await expect(page.getByText("Coming soon", { exact: false })).toHaveCount(0);
    await shot(page, "30-pricing");
  });

  test("analytics shows advanced breakdowns", async () => {
    await page.goto(`/v/${venture}/analytics`);
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
    await page.getByRole("button", { name: "12 months" }).click();
    await shot(page, "31-analytics");
  });

  test("API keys: make one, see it once, revoke it", async () => {
    await page.goto("/developers");
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
    await page.getByLabel("Name").fill("Website form");
    await page.getByLabel("Access").selectOption("write");
    await page.getByRole("button", { name: "Make a key" }).click();
    const code = page.locator("code", { hasText: "kvk_" });
    await expect(code).toBeVisible();
    const key = (await code.textContent())!.trim();
    const r = await page.request.get(`${API}/ventures/${venture}/leads`, { headers: { Authorization: `Bearer ${key}` } });
    expect(r.status()).toBe(200);
    await shot(page, "32-api-keys");
    await page.getByRole("button", { name: "I've saved it" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke now" }).click();
    await expect(page.getByText(/Revoked/)).toBeVisible();
    expect((await page.request.get(`${API}/ventures/${venture}/leads`, { headers: { Authorization: `Bearer ${key}` } })).status()).toBe(401);
  });

  test("custom workflows: pick an idea and save it", async () => {
    await page.goto(`/v/${venture}/automations`);
    await page.getByRole("button", { name: "New workflow" }).click();
    await page.getByRole("button", { name: "Gentle payment nudge" }).click();
    await page.getByRole("button", { name: "Save workflow" }).click();
    await expect(page.getByText("An invoice is 3 day(s) overdue · email to the customer", { exact: false })).toBeVisible();
    await page.getByText("Custom workflows", { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, "33-custom-workflows");
  });

  test("single sign-on settings and the SSO sign-in form", async () => {
    await page.goto("/sso");
    await expect(page.getByRole("heading", { name: "Single sign-on" })).toBeVisible();
    await expect(page.getByText("/api/oauth/sso/callback")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Require single sign-on" })).toBeDisabled();
    await shot(page, "34-sso-settings");
    const ctx = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 } });
    const anon = await ctx.newPage();
    await anon.goto("/login");
    await anon.getByRole("button", { name: "Sign in with SSO" }).click();
    await anon.getByLabel("Work email").fill("someone@nosso.example");
    await anon.getByRole("button", { name: "Continue with SSO" }).click();
    await expect(anon.getByText("Single sign-on isn't set up for this email's domain", { exact: false })).toBeVisible();
    await shot(anon, "35-login-sso");
    await anon.goto("/login?sso=no_account");
    await expect(anon.getByText("Ask your organisation's owner to invite you", { exact: false })).toBeVisible();
    await ctx.close();
  });
});
