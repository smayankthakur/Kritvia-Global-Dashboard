import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke of shipment files (patch 0067) against a real API on :8000 and `next start` on :3000:
 * trade profile, a new export file, lines, packing list, checklist, stages, the printed export
 * invoice and packing list, a status update, and billing a C&F job.
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

test.describe.serial("Trade: shipment files", () => {
  let page: Page;
  let venture = "";
  let job = "";

  test.beforeAll(async ({ browser, request }) => {
    const suffix = Date.now().toString(36);
    const reg = await request.post(`${API}/auth/register`, { data: { email: `trade-${suffix}@example.com`, full_name: "Mayank Thakur", password: "correct horse battery" } });
    expect(reg.ok()).toBeTruthy();
    const tok = await reg.json();
    const h = { Authorization: `Bearer ${tok.access_token}` };
    const me = await (await request.get(`${API}/auth/me`, { headers: h })).json();
    await request.post(`${API}/auth/me/terms`, { headers: h, data: { version: me.terms_current, adult: true } });
    const org = (await (await request.post(`${API}/orgs`, { headers: h, data: { name: "Spice Route Exports", slug: `sr-${suffix}` } })).json()).id;
    venture = (await (await request.post(`${API}/orgs/${org}/ventures`, { headers: h, data: { name: "Spice Route", slug: `spice-${suffix}` } })).json()).id;
    await request.put(`${API}/ventures/${venture}/settings`, { headers: h, data: { kind: "trade", business_name: "Spice Route", city: "Delhi" } });
    job = (await (await request.post(`${API}/ventures/${venture}/shipments`, { headers: h, data: { direction: "import", for_client: true, party_name: "Mehta Traders", party_email: "accounts@mehta.example", fee_paise: 750000, reimbursable_paise: 4250000 } })).json()).id;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
    await ctx.addCookies([
      { name: "kv_at", value: tok.access_token, url: "http://localhost:3000" },
      { name: "kv_rt", value: tok.refresh_token, url: "http://localhost:3000" },
    ]);
    page = await ctx.newPage();
  });

  test("trade profile", async () => {
    await page.goto(`/v/${venture}/trade-profile`);
    await expect(page.getByRole("heading", { name: "Trade profile" })).toBeVisible();
    await page.getByLabel("C&F / customs broker").check();
    await page.getByLabel("Legal name").fill("Spice Route Exports Pvt Ltd");
    await page.getByLabel("IEC (Importer-Exporter Code)").fill("ABCDE1234F");
    await page.getByLabel("Address").fill("B-12, Okhla Industrial Area Phase 2, New Delhi 110020");
    await page.getByLabel("AD code").fill("0510005");
    await page.getByLabel("Bank details").fill("HDFC Bank, Okhla. A/c 50200012345678. SWIFT HDFCINBB. IFSC HDFC0000123");
    await page.getByLabel("LUT ARN").fill("AD0704260012345");
    await page.getByRole("button", { name: "Save trade profile" }).click();
    await expect(page.getByText("Trade profile saved")).toBeVisible();
    await shot(page, "40-trade-profile");
  });

  test("a new export file with lines, packing list, checklist and stages", async () => {
    await page.goto(`/v/${venture}/shipments`);
    await page.getByRole("button", { name: "New file" }).first().click();
    await page.getByLabel("Buyer", { exact: true }).fill("Al Noor Trading LLC");
    await page.getByLabel("Country", { exact: true }).fill("AE");
    await page.getByLabel("Email", { exact: true }).fill("buy@alnoor.example");
    await page.getByLabel("Incoterm").selectOption("CIF");
    await page.getByLabel("Port / airport of loading").fill("Nhava Sheva");
    await page.getByLabel("Port / airport of discharge").fill("Jebel Ali");
    await page.getByRole("button", { name: "Open the file" }).click();
    await expect(page).toHaveURL(/\/shipments\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/EXP\/\d\d-\d\d\/0001/).first()).toBeVisible();

    await page.getByRole("tab", { name: "Lines & packing" }).click();
    await page.getByRole("button", { name: "Add line" }).click();
    await page.getByLabel("Line 1 description").fill("1121 Basmati rice, 25 kg PP bags");
    await page.getByLabel("Line 1 HS code").fill("10063020");
    await page.getByLabel("Line 1 quantity").fill("40");
    await page.getByLabel("Line 1 unit", { exact: true }).fill("MT");
    await page.getByLabel("Line 1 unit price").fill("1150");
    await page.getByLabel("Freight", { exact: true }).fill("2400");
    await page.getByRole("button", { name: "Save lines" }).click();
    await expect(page.getByText("Lines saved")).toBeVisible();
    await page.getByRole("button", { name: "Add row" }).click();
    await page.getByLabel("Row 1 marks").fill("AN/1-1600");
    await page.getByLabel("Row 1 kind of package").fill("Bags");
    await page.getByLabel("Row 1 number of packages").fill("1600");
    await page.getByLabel("Row 1 net kg").fill("40000");
    await page.getByLabel("Row 1 gross kg").fill("40320");
    await page.getByRole("button", { name: "Save packing list" }).click();
    await expect(page.getByText("Packing list saved")).toBeVisible();
    await shot(page, "41-shipment-lines");

    await page.getByRole("tab", { name: /Documents/ }).click();
    await page.getByLabel("Commercial invoice status").selectOption("done");
    await expect(page.getByLabel("Commercial invoice status")).toHaveValue("done");
    await page.getByLabel("Add a document").selectOption("phytosanitary");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Phytosanitary certificate")).toBeVisible();
    await shot(page, "42-shipment-docs");

    await page.getByRole("button", { name: "Shipped", exact: true }).click();
    await expect(page.getByText("Moved to Shipped")).toBeVisible();
    await page.getByRole("tab", { name: "Money" }).click();
    await expect(page.getByLabel("Realise proceeds by")).not.toHaveValue("");
    await page.getByRole("tab", { name: "Details" }).click();
    await shot(page, "43-shipment-details");
  });

  test("printed export invoice and packing list", async () => {
    const url = page.url();
    const [, file] = url.match(/shipments\/([0-9a-f-]{36})/)!;
    await page.goto(`/print/shipment/${venture}/${file}?doc=invoice`);
    await expect(page.getByRole("heading", { name: "EXPORT INVOICE" })).toBeVisible();
    await expect(page.getByText("US Dollars Forty-Eight Thousand Four Hundred Only")).toBeVisible();
    await expect(page.getByText(/under LUT \(ARN AD0704260012345\)/)).toBeVisible();
    await shot(page, "44-export-invoice");
    await page.goto(`/print/shipment/${venture}/${file}?doc=packing`);
    await expect(page.getByRole("heading", { name: "PACKING LIST" })).toBeVisible();
    await expect(page.getByText("1600 Bags")).toBeVisible();
    await page.goto(url);
  });

  test("status update waits for a yes", async () => {
    await page.getByRole("button", { name: "Send update" }).click();
    await page.getByLabel("Add a line (optional)").fill("Original documents couriered today.");
    await page.getByRole("button", { name: "Draft the update" }).click();
    await expect(page.getByText("Update drafted")).toBeVisible();
  });

  test("bill a C&F job and see the list", async () => {
    await page.goto(`/v/${venture}/shipments/${job}`);
    await page.getByRole("tab", { name: "Charges" }).click();
    await page.getByRole("button", { name: "Bill the client" }).click();
    await expect(page.getByText("Bill made")).toBeVisible();
    await page.goto(`/v/${venture}/shipments`);
    await expect(page.getByRole("link", { name: /JOB\/\d\d-\d\d\/0001/ })).toBeVisible();
    await shot(page, "45-shipments");
  });
});
