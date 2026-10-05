#!/usr/bin/env node
/**
 * Accessibility audit with axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on the public pages and,
 * with a signed-in session, the main app screens — in light and dark, desktop and phone width.
 *
 *   BASE=http://localhost:3000 node scripts/a11y-audit.mjs                 public pages
 *   BASE=… SESSION=path/to/seed.json node scripts/a11y-audit.mjs           + app screens
 *     (seed.json: {"token","refresh","org","site"} from a test account)
 *
 * Prints every violation (rule, impact, page, element) and exits 1 if there are any.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const session = process.env.SESSION ? JSON.parse(fs.readFileSync(process.env.SESSION, "utf8")) : null;
const PUBLIC = ["/welcome", "/login", "/register", "/help", "/status", "/security", "/privacy", "/terms", "/cookies", "/refunds", "/privacy-request"];
const APP = session
  ? ["/", "/inbox", `/v/${session.site}/tasks`, `/v/${session.site}/leads`, `/v/${session.site}/agents`, `/v/${session.site}/knowledge`, `/v/${session.site}/settings`, "/billing", "/account", "/businesses",
     // a lead open in the drawer (e.g. a prospect with its WhatsApp message), when the session names one
     ...(session.lead ? [`/v/${session.site}/leads?lead=${session.lead}`] : [])]
  : [];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWS = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

const browser = await chromium.launch();
const found = new Map(); // rule|target -> record
for (const theme of ["light", "dark"]) {
  for (const view of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height }, reducedMotion: "reduce" });
    const host = new URL(BASE).hostname;
    const cookies = [{ name: "kv_theme", value: theme, domain: host, path: "/" }];
    if (session) cookies.push({ name: "kv_at", value: session.token, domain: host, path: "/" }, { name: "kv_rt", value: session.refresh, domain: host, path: "/" }, { name: "kv_org", value: session.org, domain: host, path: "/" });
    for (const path of [...PUBLIC, ...APP]) {
      const isApp = APP.includes(path);
      await ctx.clearCookies();
      await ctx.addCookies(isApp ? cookies : cookies.slice(0, 1));
      const page = await ctx.newPage();
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      for (const v of res.violations) {
        for (const n of v.nodes) {
          const key = `${v.id}|${n.target.join(" ")}`;
          const rec = found.get(key) ?? { rule: v.id, impact: v.impact, help: v.help, target: n.target.join(" "), summary: n.failureSummary?.split("\n").slice(0, 3).join(" ").slice(0, 300), where: new Set() };
          rec.where.add(`${path} (${theme}, ${view.name})`);
          found.set(key, rec);
        }
      }
      await page.close();
    }
    await ctx.close();
  }
}
// Keyboard: the first Tab lands on "Skip to content", Enter moves focus into the page, and
// Tab keeps moving forward through visible controls with a visible focus indicator (no traps).
const kb = await browser.newContext({ viewport: { width: 1366, height: 900 } });
for (const path of ["/welcome", "/login", "/privacy-request"]) {
  const page = await kb.newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  // A page that puts the cursor straight into its first field (sign-in) starts past the skip link.
  const autofocused = await page.evaluate(() => document.activeElement && document.activeElement !== document.body);
  const first = autofocused
    ? await page.evaluate(() => document.querySelector("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")?.textContent?.trim())
    : (await page.keyboard.press("Tab"), await page.evaluate(() => document.activeElement?.textContent?.trim()));
  if (first !== "Skip to content") found.set(`kbd-skip|${path}`, { rule: "keyboard-skip-link", impact: "serious", help: "First Tab should reach the skip link", target: String(first), summary: "", where: new Set([path]) });
  await page.keyboard.press("Enter");
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (!el.dataset.kvSeen) el.dataset.kvSeen = String(Math.random());
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { id: el.dataset.kvSeen, key: el.outerHTML.slice(0, 80), visible: r.width > 0 && r.height > 0, ring: st.outlineStyle !== "none" || st.boxShadow !== "none" };
    });
    if (!info) break;
    if (!info.visible || !info.ring) found.set(`kbd-focus|${info.key}`, { rule: "keyboard-focus-visible", impact: "serious", help: "Focused element must be visible with a focus indicator", target: info.key, summary: JSON.stringify(info), where: new Set([path]) });
    // Coming back to an element already visited after only a couple of stops means focus is stuck;
    // coming back after many stops is the normal wrap-around through the browser chrome.
    if (seen.has(info.id) && seen.size < 3) found.set(`kbd-trap|${path}`, { rule: "keyboard-trap", impact: "critical", help: "Focus is stuck", target: info.key, summary: "", where: new Set([path]) });
    seen.add(info.id);
  }
  await page.close();
}
await kb.close();
await browser.close();
const list = [...found.values()].sort((a, b) => a.rule.localeCompare(b.rule));
for (const r of list) {
  const where = [...r.where];
  console.log(`[${r.impact}] ${r.rule}: ${r.help}\n   ${r.target}\n   ${r.summary}\n   on ${where.slice(0, 4).join("; ")}${where.length > 4 ? ` and ${where.length - 4} more` : ""}\n`);
}
console.log(list.length ? `${list.length} distinct violation(s).` : "Accessibility audit: no violations.");
process.exit(list.length ? 1 : 0);
