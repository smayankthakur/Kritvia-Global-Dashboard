import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke of Teams and the mind map's People & projects view (patch 0069) against a real API on :8000
 * and `next start` on :3000: an owner makes a team, puts a project board in it, two people work on
 * it, and the map shows who works with whom, per person, per project and as a list.
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

async function person(request: APIRequestContext, first: string, full: string) {
  const reg = await request.post(`${API}/auth/register`, {
    data: { email: `${first}-${Date.now().toString(36)}@example.com`, full_name: full, password: "correct horse battery" },
  });
  expect(reg.ok()).toBeTruthy();
  const tok = await reg.json();
  const h = { Authorization: `Bearer ${tok.access_token}` };
  const me = await (await request.get(`${API}/auth/me`, { headers: h })).json();
  await request.post(`${API}/auth/me/terms`, { headers: h, data: { version: me.terms_current, adult: true } });
  return { tok, h, id: me.id as string, email: me.email as string };
}

test.describe.serial("Teams and who works with whom", () => {
  let page: Page;
  let venture = "";

  test.beforeAll(async ({ browser, request }) => {
    const owner = await person(request, "owner", "Meera Kapoor");
    const suffix = Date.now().toString(36);
    const org = (await (await request.post(`${API}/orgs`, { headers: owner.h, data: { name: "Brightpath Labs", slug: `bpl-${suffix}` } })).json()).id;
    venture = (await (await request.post(`${API}/orgs/${org}/ventures`, { headers: owner.h, data: { name: "Brightpath", slug: `bp-${suffix}` } })).json()).id;
    const people = [];
    for (const [first, full] of [["priya", "Priya Iyer"], ["vikram", "Vikram Rao"], ["ana", "Ana Fernandes"]] as const) {
      const p = await person(request, first, full);
      const inv = await (await request.post(`${API}/orgs/${org}/invitations`, { headers: owner.h, data: { email: p.email, role: "operator", venture_id: venture } })).json();
      await request.post(`${API}/invitations/accept`, { headers: p.h, data: { token: inv.token } });
      people.push(p);
    }
    const [priya, vikram, ana] = people;
    const board = await (await request.post(`${API}/ventures/${venture}/boards`, { headers: owner.h, data: { name: "Acme rollout" } })).json();
    const detail = await (await request.get(`${API}/ventures/${venture}/boards/${board.id}`, { headers: owner.h })).json();
    const card = async (by: typeof priya, to: typeof priya, title: string) => {
      const c = await (await request.post(`${API}/ventures/${venture}/cards`, { headers: by!.h, data: { list_id: detail.lists[0].id, title } })).json();
      await request.patch(`${API}/ventures/${venture}/cards/${c.id}`, { headers: by!.h, data: { assignee_id: to!.id, clear_assignee: false, clear_due_date: false } });
    };
    await card(vikram, vikram, "API contract");
    await card(vikram, priya, "Data import");
    await card(priya, priya, "Go-live checklist");
    await card(ana, ana, "Onboarding screens");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
    await ctx.addCookies([
      { name: "kv_at", value: owner.tok.access_token, url: "http://localhost:3000" },
      { name: "kv_rt", value: owner.tok.refresh_token, url: "http://localhost:3000" },
      { name: "kv_org", value: org, url: "http://localhost:3000" },
    ]);
    page = await ctx.newPage();
  });

  test("an owner makes a team", async () => {
    await page.goto("/teams");
    await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByLabel("Team name").fill("Platform");
    await page.getByLabel("Priya Iyer").check();
    await page.getByLabel("Vikram Rao").check();
    await page.getByRole("button", { name: "Vikram Rao leads the team" }).click();
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(page.getByText("Team “Platform” created")).toBeVisible();
    await expect(page.getByText("Vikram Rao · lead")).toBeVisible();
    await shot(page, "50-teams");
  });

  test("a project board joins the team", async () => {
    await page.goto(`/v/${venture}/tasks`);
    await page.getByRole("tab", { name: /Acme rollout/ }).click();
    await page.getByRole("button", { name: "Board settings" }).click();
    await page.getByLabel("Team", { exact: true }).selectOption({ label: "Platform" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Board saved")).toBeVisible();
  });

  test("the map shows who works with whom", async () => {
    await page.goto(`/v/${venture}/map?view=people`);
    await expect(page.getByRole("tab", { name: "People & projects" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: /Priya Iyer & Vikram Rao|Vikram Rao & Priya Iyer/ })).toBeVisible();
    await shot(page, "51-people-map");
    await page.getByRole("button", { name: /^Priya Iyer$/ }).first().click();
    await expect(page.getByRole("heading", { name: "Priya Iyer" })).toBeVisible();
    await expect(page.getByText(/1 task handed over · same team/)).toBeVisible();
    await page.getByLabel("Project", { exact: true }).selectOption({ label: "Acme rollout" });
    await expect(page.getByText("Project: Acme rollout")).toBeVisible();
    await page.getByRole("button", { name: "Show as a list" }).click();
    await expect(page.getByRole("table", { name: "Who works with whom" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /same team/ }).first()).toBeVisible();
    await shot(page, "52-people-list");
  });
});
