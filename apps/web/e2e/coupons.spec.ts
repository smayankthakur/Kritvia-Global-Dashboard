import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Kritvia team → Coupons: create a coupon of each important kind from the form, edit, duplicate.
 * Needs the API started with STAFF_EMAILS=<E2E_STAFF_EMAIL>.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:8000";
const STAFF = process.env.E2E_STAFF_EMAIL ?? "";
const SHOTS = path.resolve(process.cwd(), "e2e/screenshots");
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string, mobile = true) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.screenshot({
    path: path.join(SHOTS, `${name}-desktop.png`),
    fullPage: true,
  });
  if (!mobile) return;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(SHOTS, `${name}-mobile.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe.serial("Staff coupons", () => {
  test.skip(!STAFF, "set E2E_STAFF_EMAIL (and STAFF_EMAILS on the API)");
  let page: Page;
  const suffix = Date.now().toString(36).toUpperCase();

  test.beforeAll(async ({ browser, request }) => {
    const reg = await request.post(`${API}/auth/register`, {
      data: {
        email: STAFF,
        full_name: "Mayank Thakur",
        password: "correct horse battery",
      },
    });
    expect(reg.ok()).toBeTruthy();
    const tok = await reg.json();
    const h = { Authorization: `Bearer ${tok.access_token}` };
    const me = await (await request.get(`${API}/auth/me`, { headers: h })).json();
    await request.post(`${API}/auth/me/terms`, {
      headers: h,
      data: { version: me.terms_current, adult: true },
    });
    await request.post(`${API}/orgs`, {
      headers: h,
      data: { name: "Kritvia Team", slug: `kt-${suffix.toLowerCase()}` },
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
    });
    await ctx.addCookies([
      { name: "kv_at", value: tok.access_token, url: "http://localhost:3000" },
      { name: "kv_rt", value: tok.refresh_token, url: "http://localhost:3000" },
    ]);
    page = await ctx.newPage();
  });

  test("create a kitchen-only free plan coupon", async () => {
    await page.goto("/staff/coupons");
    await expect(page.getByRole("heading", { name: "Coupons" })).toBeVisible();
    await page.getByRole("button", { name: "New coupon" }).click();
    await page.getByLabel("Code", { exact: true }).fill(`KITCHEN${suffix}`);
    await page.getByLabel("Plan", { exact: true }).selectOption("growth");
    await page.getByLabel("For", { exact: true }).fill("45");
    await page.getByLabel("Unit").selectOption("days");
    await page.getByLabel("Restaurant or cloud kitchen").check();
    await page.getByLabel("Used within (days of signing up, optional)").fill("14");
    await page.getByLabel("Places").fill("25");
    await expect(page.getByText("Growth plan free for 45 days")).toBeVisible();
    await shot(page, "60-coupon-form", false);
    await page.getByRole("button", { name: "Create coupon" }).click();
    await expect(page.getByText(`KITCHEN${suffix}`, { exact: true })).toBeVisible();
  });

  test("create a percent-off coupon", async () => {
    await page.getByRole("button", { name: "New coupon" }).click();
    await page.getByLabel("Code", { exact: true }).fill(`SAVE${suffix}`);
    await page.getByText("% off a paid plan").click();
    await page.getByLabel("Percent off").fill("20");
    await page.getByLabel("Razorpay offer ID").fill("offer_GROWTH20x");
    await page.getByLabel("Growth").check();
    await page.getByLabel("Annual").check();
    await page.getByLabel("Businesses").selectOption("anyone");
    await expect(page.getByText("20% off Growth plan (annual billing)")).toBeVisible();
    await page.getByRole("button", { name: "Create coupon" }).click();
    await expect(page.getByText(`SAVE${suffix}`, { exact: true })).toBeVisible();
    await page.getByLabel("Search coupons").fill(suffix);
    await shot(page, "61-coupons-list");
  });
});
