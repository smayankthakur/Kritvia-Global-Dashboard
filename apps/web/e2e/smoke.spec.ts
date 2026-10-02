import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke test of the whole command center against the real API (no LLM gateway locally,
 * so workflow runs fail at their first model step — which exercises the failure/retry UI).
 */

const SHOTS = path.resolve(process.cwd(), "e2e/screenshots");
mkdirSync(SHOTS, { recursive: true });

const suffix = Date.now().toString(36);
const email = `e2e-${suffix}@example.com`;
const password = "correct horse battery staple";

async function shot(page: Page, name: string, opts: { mobile?: boolean } = { mobile: true }) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.screenshot({ path: path.join(SHOTS, `${name}-desktop.png`), fullPage: true });
  if (opts.mobile) {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `${name}-mobile.png`), fullPage: true });
    if (vp) await page.setViewportSize(vp);
    await page.waitForTimeout(200);
  }
}

function csv(name: string, body: string) {
  return { name, mimeType: "text/csv", buffer: Buffer.from(body) };
}

test.describe.serial("Kritvia command center", () => {
  let page: Page;
  const ids: Record<string, string> = {};

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("login page renders and unauthenticated users are redirected", async () => {
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/login\?next=%2Finbox/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await shot(page, "01-login");
  });

  test("register and onboard an organisation with three ventures", async () => {
    await page.goto("/register");
    await expect(page.getByRole("button", { name: "Sign up with Google" })).toBeVisible();
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByText("Enter your name")).toBeVisible();
    await shot(page, "01b-register");
    // An emailed code can't be read here, so the account is created through the password API.
    const origin = new URL(page.url()).origin;
    const reg = await page.request.post("/api/auth/register", {
      data: { full_name: "Mayank Thakur", email, password },
      headers: { origin },
    });
    expect(reg.ok()).toBeTruthy();
    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter the business name")).toBeVisible();
    await page.getByLabel("Business name").fill("Sitelytc");
    await page.getByRole("radio", { name: /Agency or services/ }).click();
    await page.getByRole("button", { name: "I run another business" }).click();
    await page.getByLabel("Business name").nth(1).fill("Truhome Finance");
    await page.getByRole("radio", { name: /Loans & real estate/ }).nth(1).click();
    await page.getByRole("button", { name: "I run another business" }).click();
    await page.getByLabel("Business name").nth(2).fill("Cloud Kitchen");
    await page.getByRole("radio", { name: /Restaurant or cloud kitchen/ }).nth(2).click();
    await page.getByLabel("Group name").fill(`E2E Group ${suffix}`);
    await shot(page, "02a-onboarding-business");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Your roles and workflows" })).toBeVisible();
    await expect(page.getByText("Demand forecast & purchase orders")).toBeVisible();
    await shot(page, "02-onboarding-roles");
    await page.getByRole("button", { name: "Finish setup" }).click();

    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /Good to see you, Mayank/ })).toBeVisible();

    const access = await (await page.request.get("/api/k/me/access")).json();
    for (const v of access.ventures as { venture_name: string; venture_id: string; roles: string[] }[]) ids[v.venture_name] = v.venture_id;
    expect(Object.keys(ids).sort()).toEqual(["Cloud Kitchen", "Sitelytc", "Truhome Finance"]);
    const truhome = (access.ventures as { venture_name: string; roles: string[] }[]).find((v) => v.venture_name === "Truhome Finance");
    expect(truhome?.roles).toContain("loan_officer");

    await expect(page.getByRole("link", { name: "Sitelytc" })).toBeVisible();
    await shot(page, "03-dashboard");
  });

  test("rate card can be edited and saved", async () => {
    await page.goto(`/v/${ids["Sitelytc"]}/rate-card`);
    await page.getByRole("button", { name: "Add first item" }).click();
    await page.getByLabel("Code").first().fill("nextjs_page");
    await page.getByLabel("Name", { exact: true }).first().fill("Next.js page");
    await page.getByLabel("Rate (₹)").first().fill("12500");
    await page.getByRole("button", { name: "Add item" }).click();
    await page.getByLabel("Code").nth(1).fill("ai_workflow");
    await page.getByLabel("Name", { exact: true }).nth(1).fill("AI automation workflow");
    await page.getByLabel("Unit", { exact: true }).nth(1).selectOption("workflow");
    await page.getByLabel("Rate (₹)").nth(1).fill("295000");
    await page.getByRole("button", { name: "Save rate card" }).click();
    await expect(page.getByText("Rate card saved")).toBeVisible();
    await expect(page.getByText("₹2,95,000.00")).toBeVisible();
    await shot(page, "04-rate-card");
  });

  test("a new inquiry starts a run that fails without models and can be retried", async () => {
    await page.goto(`/v/${ids["Sitelytc"]}/leads`);
    await page.getByRole("button", { name: "New inquiry" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Asha Rao");
    await dialog.getByLabel("Email").fill("asha@raofoods.example");
    await dialog.getByLabel("Company").fill("Rao Foods");
    await dialog.getByLabel("Inquiry").fill("We need an 8-page Next.js website with a WhatsApp ordering bot. Budget about 3 lakh, launch in 6 weeks.");
    await dialog.getByRole("button", { name: "Start triage" }).click();
    await expect(dialog.getByText("Triage started")).toBeVisible();
    await dialog.getByRole("link", { name: "View run" }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByText("This run failed")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await shot(page, "05-run-failed");

    await page.goto(`/v/${ids["Sitelytc"]}/runs`);
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await shot(page, "06-runs");

    await page.goto("/");
    await expect(page.getByText("Recent failures")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await shot(page, "07-dashboard-failures");
  });

  test("a loan application is created with consent, and a client upload link works", async ({ browser }) => {
    await page.goto(`/v/${ids["Truhome Finance"]}/loans`);
    await page.getByRole("button", { name: "New application" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Full name").fill("Rohit Sharma");
    await dialog.getByLabel("Email").fill("rohit@example.com");
    await dialog.getByLabel("PAN").fill("ABCDE1234F");
    await dialog.getByLabel("Amount (₹)").fill("2500000");
    await dialog.getByRole("button", { name: "Create application" }).click();
    await expect(dialog.getByText("Consent is required before any document is processed")).toBeVisible();
    await dialog.getByLabel("The applicant has given consent to process their documents for this loan").check();
    await dialog.getByRole("button", { name: "Create application" }).click();
    await expect(page).toHaveURL(/\/loans\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: /TRU-/ })).toBeVisible();
    await expect(page.getByText("₹25,00,000.00")).toBeVisible();

    await page.getByRole("button", { name: "Create link" }).click();
    const link = page.locator("code").filter({ hasText: "/upload/" });
    await expect(link).toBeVisible();
    await shot(page, "08-loan-detail");
    const url = new URL((await link.textContent())!.trim());

    const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const client = await anon.newPage();
    await client.goto(url.pathname);
    await expect(client.getByText("Secure document upload")).toBeVisible();
    await expect(client.getByText(/Application TRU-/)).toBeVisible();
    await shot(client, "09-public-upload");
    await client.goto("/upload/this-token-does-not-exist-000000");
    await expect(client.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await anon.close();

    await page.goto(`/v/${ids["Truhome Finance"]}/loans`);
    await expect(page.getByRole("link", { name: /TRU-/ })).toBeVisible();
    await shot(page, "10-loans");
  });

  test("a text document is uploaded to the knowledge base", async () => {
    await page.goto(`/v/${ids["Sitelytc"]}/knowledge`);
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "sitelytc-pricing-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Sitelytc pricing notes.\nNext.js marketing sites start at 1.5 lakh for 8 pages.\nVAPT assessments are quoted per application."),
    });
    await dialog.getByLabel("Title").fill("Pricing notes");
    await dialog.getByRole("button", { name: "Upload" }).click();
    await expect(dialog.getByText(/Added to the knowledge base|Already in the knowledge base/)).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("link", { name: "Pricing notes" })).toBeVisible();
  });

  test("a knowledge note is added and opens with its chunks", async () => {
    await page.getByRole("button", { name: "Add note" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill("Discount policy");
    await dialog.getByLabel("Text").fill("Repeat clients get 10% off the second project. Founders approve anything above 15%.");
    await dialog.getByRole("button", { name: "Add note" }).click();
    await expect(dialog.getByText(/Added to the knowledge base|Already in the knowledge base/)).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("link", { name: "Discount policy" })).toBeVisible();
    await shot(page, "11-knowledge");
    await page.getByRole("link", { name: "Discount policy" }).click();
    await expect(page.getByText("Repeat clients get 10% off")).toBeVisible();
    await shot(page, "12-document");
  });

  test("kitchen reference data is imported from CSV", async () => {
    const k = ids["Cloud Kitchen"];
    const imports: [string, string, string][] = [
      ["dishes", "Dishes", "code,name,price_inr,active\npaneer_tikka,Paneer Tikka,249,true\ndal_makhani,Dal Makhani,199,true\nveg_biryani,Veg Biryani,229,true\n"],
      ["ingredients", "Ingredients", "code,name,unit\npaneer,Paneer,kg\nurad_dal,Urad dal,kg\nbasmati,Basmati rice,kg\ncream,Fresh cream,l\n"],
      ["vendors", "Vendors", "code,name,email,phone,lead_days,active\nfresh_dairy,Fresh Dairy Co,orders@freshdairy.example,9800000000,1,true\nazadpur,Azadpur Mandi Traders,sales@azadpur.example,9811111111,1,true\n"],
      ["recipes", "Recipes", "dish_code,ingredient_code,qty_per_portion,wastage_pct\npaneer_tikka,paneer,0.15,5\ndal_makhani,urad_dal,0.08,2\ndal_makhani,cream,0.02,0\nveg_biryani,basmati,0.12,3\n"],
      ["vendor_items", "Vendor items", "vendor_code,ingredient_code,sku,pack_size,price_per_pack,min_order_packs\nfresh_dairy,paneer,PN-1KG,1,380,1\nfresh_dairy,cream,CR-1L,1,210,1\nazadpur,urad_dal,UD-5KG,5,650,1\nazadpur,basmati,BR-10KG,10,1150,1\n"],
    ];
    for (const [entity, label, body] of imports) {
      await page.goto(`/v/${k}/kitchen/reference?tab=${entity}`);
      await expect(page.getByRole("heading", { name: `Import ${label.toLowerCase()} from CSV` })).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles(csv(`${entity}.csv`, body));
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await expect(page.getByText(/row\(s\) saved/).first()).toBeVisible();
      await expect(page.getByText("No errors.")).toBeVisible();
    }
    await page.goto(`/v/${k}/kitchen/reference?tab=dishes`);
    await expect(page.getByRole("cell", { name: "Paneer Tikka", exact: true })).toBeVisible();
    await shot(page, "13-kitchen-reference");
  });

  test("sales CSV upload feeds the 30-day chart, and stock is counted", async () => {
    const k = ids["Cloud Kitchen"];
    const lines = ["date,dish,qty,channel,revenue"];
    const today = new Date();
    for (let d = 20; d >= 1; d--) {
      const day = new Date(today.getTime() - d * 86400_000).toISOString().slice(0, 10);
      lines.push(`${day},paneer_tikka,${30 + (d % 7) * 3},swiggy,${(30 + (d % 7) * 3) * 249}`);
      lines.push(`${day},Dal Makhani,${22 + (d % 5) * 2},zomato,${(22 + (d % 5) * 2) * 199}`);
      lines.push(`${day},veg_biryani,${18 + (d % 4)},direct,${(18 + (d % 4)) * 229}`);
    }
    await page.goto(`/v/${k}/kitchen/sales`);
    await page.locator('input[type="file"]').setInputFiles(csv("sales.csv", lines.join("\n") + "\n"));
    await page.getByRole("button", { name: "Upload sales" }).click();
    await expect(page.getByText(/row\(s\) saved/)).toBeVisible();
    await expect(page.getByText("Days with sales")).toBeVisible();

    await page.getByLabel("New count for Paneer in kg").fill("4");
    await page.getByLabel("New count for Basmati rice in kg").fill("12.5");
    await page.getByRole("button", { name: "Save count" }).click();
    await expect(page.getByText("Stock count recorded")).toBeVisible();
    await expect(page.getByRole("cell", { name: "12.5 kg" })).toBeVisible();
    await shot(page, "14-kitchen-sales");
  });

  test("kitchen daily plan and events render", async () => {
    const k = ids["Cloud Kitchen"];
    await page.goto(`/v/${k}/kitchen/events`);
    await page.getByRole("textbox", { name: "Event", exact: true }).fill("India vs Australia final");
    await page.getByLabel("Demand multiplier").fill("1.4");
    await page.getByRole("button", { name: "Add event" }).click();
    await expect(page.getByText("India vs Australia final", { exact: true })).toBeVisible();
    await shot(page, "15-kitchen-events", { mobile: false });

    await page.goto(`/v/${k}/kitchen/plan`);
    await expect(page.getByRole("heading", { name: "Daily plan" })).toBeVisible();
    await page.getByRole("button", { name: "Run plan now" }).first().click();
    await expect(page.getByText("Planning run started.")).toBeVisible();
    await page.waitForTimeout(8000);
    await page.reload();
    await shot(page, "16-kitchen-plan");
  });

  test("compliance: consent is recorded and withdrawn, and an access request is executed", async () => {
    await page.goto(`/v/${ids["Truhome Finance"]}/compliance`);
    await page.getByLabel("Email, phone or PAN", { exact: true }).fill("priya@example.com");
    await page.getByLabel("Purpose").fill("loan_marketing");
    await page.getByRole("button", { name: "Record consent" }).click();
    await expect(page.getByText("Consent recorded")).toBeVisible();
    await expect(page.getByRole("cell", { name: "loan_marketing" }).first()).toBeVisible();
    await shot(page, "17-compliance");
    await page.getByRole("button", { name: "Withdraw" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click();
    await expect(page.getByText("Consent withdrawn")).toBeVisible();

    await page.getByRole("tab", { name: "Data requests" }).click();
    await expect(page.getByRole("heading", { name: "Log a request" })).toBeVisible();
    await page.getByLabel("Email, phone or PAN", { exact: true }).fill("priya@example.com");
    await page.getByRole("button", { name: "Log request" }).click();
    await expect(page.getByText("Request logged")).toBeVisible();
    await page.getByRole("button", { name: "Execute export" }).click();
    await expect(page.getByRole("heading", { name: "Access export" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    await shot(page, "18-dpdp", { mobile: false });
  });

  test("inbox: a real purchase-order draft is edited, diffed and approved", async () => {
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Approval inbox" })).toBeVisible();
    const item = page.getByRole("button", { name: /Send PO-/ }).first();
    await expect(item).toBeVisible({ timeout: 30_000 });
    await item.click();
    await expect(page.getByRole("heading", { name: /Send PO-/ })).toBeVisible();
    await expect(page.getByText(/^(orders@freshdairy|sales@azadpur)\.example$/)).toBeVisible();
    await shot(page, "19-inbox-detail");

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const subject = page.getByLabel("Subject");
    await subject.fill((await subject.inputValue()) + " (confirm by 8 AM)");
    await page.getByRole("button", { name: "Review changes" }).click();
    await expect(page.getByText("Review your changes")).toBeVisible();
    await expect(page.getByText("(confirm by 8 AM)").first()).toBeVisible();
    await shot(page, "20-inbox-diff", { mobile: false });
    await page.getByRole("button", { name: "Approve with edits" }).click();
    await expect(page.getByText("Decision recorded: edited")).toBeVisible();
    await expect(page.getByText("What you changed")).toBeVisible();
    await shot(page, "21-inbox-decided", { mobile: false });
  });

  test("autonomy and settings screens render", async () => {
    await page.goto(`/v/${ids["Sitelytc"]}/trust`);
    await expect(page.getByRole("heading", { name: "Earned autonomy" })).toBeVisible();
    await shot(page, "22-trust", { mobile: false });

    await page.goto(`/v/${ids["Sitelytc"]}/settings?tab=workflows`);
    await expect(page.getByRole("heading", { name: "Inbound lead triage & proposal" })).toBeVisible();
    await shot(page, "23-settings-workflows", { mobile: false });

    await page.goto(`/v/${ids["Sitelytc"]}/settings?tab=connectors`);
    await page.getByRole("button", { name: "Create webhook" }).click();
    await expect(page.getByRole("heading", { name: "Webhook ready" })).toBeVisible();
    await expect(page.getByText(/^whsec_/)).toBeVisible();
    await shot(page, "24-webhook-secret", { mobile: false });
    await page.getByRole("button", { name: "I've stored the secret" }).click();

    await page.goto(`/v/${ids["Sitelytc"]}/settings?tab=members`);
    await expect(page.getByRole("heading", { name: /Members of/ })).toBeVisible();
    await shot(page, "25-settings-members");

    await page.goto("/settings/connectors?google=denied&venture=" + ids["Sitelytc"]);
    await expect(page.getByText("Google connection cancelled")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\?tab=connectors$/);
  });

  test("voice: vocabulary, settings and the floating widget", async () => {
    await page.goto(`/v/${ids["Sitelytc"]}/voice?tab=vocabulary`);
    await page.getByRole("button", { name: "Add term" }).click();
    await page.getByLabel("Correct spelling").fill("Sitelytc");
    await page.getByLabel("Add a way it is misheard").fill("site lytic");
    await page.keyboard.press("Enter");
    await page.getByLabel("Who uses it").selectOption("shared");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("cell", { name: "site lytic" })).toBeVisible();
    await expect(page.getByText("Everyone")).toBeVisible();
    await shot(page, "25a-voice-vocabulary", { mobile: false });

    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("switch", { name: "Mask profanity" }).click();
    await page.getByRole("button", { name: "Change push-to-talk key" }).click();
    await page.keyboard.press("F8");
    await expect(page.locator("kbd", { hasText: "F8" })).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Voice settings saved")).toBeVisible();
    await expect(page.getByRole("button", { name: /Dictate \(Type mode\)\. Hold F8/ })).toBeVisible();
    await shot(page, "25b-voice-settings", { mobile: false });

    await page.getByRole("tab", { name: "Insights" }).click();
    await expect(page.getByText("No dictation yet")).toBeVisible();
  });

  test("mobile navigation opens the sidebar sheet", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const nav = page.getByRole("dialog", { name: "Navigation" });
    await expect(nav.getByRole("link", { name: /^Inbox/ })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "26-mobile-nav-mobile.png") });
    await nav.getByRole("link", { name: "Runs" }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("audit chain verifies as intact", async () => {
    await page.goto("/audit");
    await expect(page.getByText(/^[a-z_]+\.(insert|update|delete)$/).first()).toBeVisible();
    await page.getByRole("button", { name: "Verify chain" }).click();
    await expect(page.getByText("Chain intact")).toBeVisible();
    await shot(page, "27-audit");
  });
});
