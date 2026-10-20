import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke of the App store (patch 0095) against a real API on :8000 and `next start` on :3000: Popular apps,
 * the connect dialog (sign-in or token), adding by address and as a web app, and a GitHub link that isn't one.
 * The user is on STAFF_EMAILS, so "Apps to review" opens too. No outside site is reached.
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

test.describe.serial("App store", () => {
  let page: Page;
  let venture = "";

  test.beforeAll(async ({ browser, request }) => {
    const suffix = Date.now().toString(36);
    const email = process.env.E2E_STAFF_EMAIL ?? `apps-${suffix}@example.com`;
    const reg = await request.post(`${API}/auth/register`, { data: { email, full_name: "Mayank Thakur", password: "correct horse battery" } });
    expect(reg.ok()).toBeTruthy();
    const tok = await reg.json();
    const h = { Authorization: `Bearer ${tok.access_token}` };
    const me = await (await request.get(`${API}/auth/me`, { headers: h })).json();
    await request.post(`${API}/auth/me/terms`, { headers: h, data: { version: me.terms_current, adult: true } });
    const org = (await (await request.post(`${API}/orgs`, { headers: h, data: { name: "Mehta Sweets", slug: `ms-${suffix}` } })).json()).id;
    venture = (await (await request.post(`${API}/orgs/${org}/ventures`, { headers: h, data: { name: "Mehta Sweets", slug: `mehta-${suffix}` } })).json()).id;
    await request.put(`${API}/ventures/${venture}/settings`, { headers: h, data: { kind: "general", business_name: "Mehta Sweets", city: "Delhi" } });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
    await ctx.addCookies([
      { name: "kv_at", value: tok.access_token, url: "http://localhost:3000" },
      { name: "kv_rt", value: tok.refresh_token, url: "http://localhost:3000" },
    ]);
    page = await ctx.newPage();
  });

  test("popular apps and the connect dialog", async () => {
    await page.goto(`/v/${venture}/apps`);
    await expect(page.getByRole("heading", { name: "App store" })).toBeVisible();
    await expect(page.getByText("No apps yet")).toBeVisible();
    await page.getByRole("tab", { name: "Popular" }).click();
    const notion = page.getByRole("button", { name: "Connect Notion" });
    await expect(notion).toBeVisible();
    await shot(page, "app-store-popular");
    await notion.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Sign in to Notion" })).toBeVisible();
    await expect(dialog.getByLabel("Short name")).toHaveValue("notion");
    await page.keyboard.press("Escape");
  });

  test("adding by address and as a web app explains what's wrong", async () => {
    await page.getByRole("tab", { name: "By address" }).click();
    await page.getByLabel("Short name").fill("crm");
    await page.getByLabel("MCP server address").fill("http://not-https.example/mcp");
    await page.getByLabel("How it connects").selectOption("bearer");
    await page.getByLabel("Token or API key").fill("abc");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText(/must start with https/)).toBeVisible();
    await page.getByRole("tab", { name: "Web app (API)" }).click();
    await expect(page.getByLabel("OpenAPI description address")).toBeVisible();
    await shot(page, "app-store-web-app");
    await page.getByRole("tab", { name: "From GitHub" }).click();
    await page.getByLabel("GitHub project").fill("https://gitlab.com/someone/thing");
    await page.getByRole("button", { name: "Look at it" }).click();
    await expect(page.getByText(/paste a link like https:\/\/github.com/)).toBeVisible();
  });

  test("the assistant points to the App store", async () => {
    await page.goto(`/v/${venture}/assistant`);
    await page.getByRole("link", { name: "Open the App store" }).click();
    await expect(page).toHaveURL(new RegExp(`/v/${venture}/apps`));
  });

  test("Kritvia's team reviews apps", async () => {
    test.skip(!process.env.E2E_STAFF_EMAIL, "needs STAFF_EMAILS");
    await page.goto("/staff/apps");
    await expect(page.getByRole("heading", { name: "Apps to review" })).toBeVisible();
    await shot(page, "staff-apps");
  });
});
