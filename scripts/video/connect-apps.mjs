// Records the "How to connect your apps" walkthrough (apps/web/public/videos/connect-apps.*).
// Run from apps/web (it needs @playwright/test) with serve_demo.py on :8000 and the web app on :3000:
//   cp ../../scripts/video/connect-apps.mjs . && node connect-apps.mjs && rm connect-apps.mjs
// then trim the first ~2 s and encode (see README.md next to this file).
import { chromium } from "@playwright/test";
const SP = process.env.OUT_DIR || "/tmp/kritvia-video";
const API = "http://localhost:8000";
const WEB = "http://localhost:3000";
const j = async (path, opts = {}, token) => {
  const r = await fetch(API + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 300)}`); return b;
};
const reg = await j("/auth/register", { method: "POST", body: JSON.stringify({ email: `owner-${Date.now()}@example.com`, full_name: "Neha Kapoor", password: "correct horse battery" }) });
const tok = reg.access_token;
await j("/auth/me/terms", { method: "POST", body: JSON.stringify({ version: "2026-10-13", adult: true }) }, tok);
const org = await j("/orgs", { method: "POST", body: JSON.stringify({ name: "Kapoor Services", slug: `kap-${Date.now().toString(36)}` }) }, tok);
const v = await j(`/orgs/${org.id}/ventures`, { method: "POST", body: JSON.stringify({ name: "Clean Co", slug: "clean", kind: "general" }) }, tok);
await j(`/ventures/${v.id}/settings`, { method: "PUT", body: JSON.stringify({ kind: "general", business_name: "Clean Co", city: "Delhi" }) }, tok);
await j(`/ventures/${v.id}/workflow-configs/inbox_assistant`, { method: "PUT", body: JSON.stringify({ enabled: true, settings: {}, instructions: "" }) }, tok);
const { token: botToken } = await j("/__tg_secret");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: `${SP}/vid`, size: { width: 1280, height: 720 } } });
await context.addCookies([
  { name: "kv_at", value: tok, domain: "localhost", path: "/", httpOnly: true },
  { name: "kv_rt", value: reg.refresh_token, domain: "localhost", path: "/", httpOnly: true },
  { name: "kv_org", value: org.id, domain: "localhost", path: "/" },
]);
// Captions, a title card and a visible pointer, kept across page loads.
await context.addInitScript(() => {
  const css = `
    #kv-cap,#kv-ptr{inset:auto;border:0;padding:0;overflow:visible}
    #kv-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:900px;z-index:2147483647;margin:0;border:0;
      background:rgba(15,23,42,.92);color:#fff;font:600 20px/1.4 system-ui,Segoe UI,sans-serif;padding:12px 22px;border-radius:14px;
      box-shadow:0 10px 30px rgba(0,0,0,.35);text-align:center;transition:opacity .3s;pointer-events:none}
    #kv-cap.top{bottom:auto;top:84px}
    #kv-cap small{display:block;font-weight:500;font-size:15px;opacity:.8;margin-top:2px}
    #kv-title{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#1e3a8a,#4338ca 55%,#0e7490);color:#fff;font:700 44px/1.2 system-ui,Segoe UI,sans-serif;text-align:center;
      transition:opacity .5s;pointer-events:none}
    #kv-title p{font-weight:500;font-size:22px;opacity:.85;margin-top:14px}
    #kv-ptr{position:fixed;left:640px;top:360px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;z-index:2147483647;
      background:rgba(245,158,11,.85);border:3px solid #fff !important;box-shadow:0 0 0 2px rgba(245,158,11,.6),0 4px 12px rgba(0,0,0,.3);
      transition:left .7s ease,top .7s ease,transform .15s;pointer-events:none}
    .kv-hl{outline:3px solid #f59e0b !important;outline-offset:4px;border-radius:14px}`;
  const add = () => {
    if (document.getElementById("kv-style")) return;
    const st = document.createElement("style"); st.id = "kv-style"; st.textContent = css; document.head.appendChild(st);
    const p = document.createElement("div"); p.id = "kv-ptr"; p.setAttribute("popover", "manual"); document.body.appendChild(p);
    try { p.showPopover(); } catch {}
  };
  // Popovers live in the browser's top layer, so captions and the pointer stay above open dialogs.
  const raise = (el) => { try { if (el.matches(":popover-open")) el.hidePopover(); el.showPopover(); } catch {} };
  window.__kv = {
    cap(text, sub, top) {
      add();
      let el = document.getElementById("kv-cap");
      if (!el) { el = document.createElement("div"); el.id = "kv-cap"; el.setAttribute("popover", "manual"); document.body.appendChild(el); }
      el.classList.toggle("top", !!top);
      el.innerHTML = ""; el.appendChild(document.createTextNode(text));
      if (sub) { const s = document.createElement("small"); s.textContent = sub; el.appendChild(s); }
      el.style.opacity = text ? "1" : "0";
      raise(el); raise(document.getElementById("kv-ptr"));
    },
    title(text, sub) {
      add();
      let el = document.getElementById("kv-title");
      const ptr = document.getElementById("kv-ptr"); if (ptr) ptr.style.opacity = text ? "0" : "1";
      if (!text) { if (el) el.style.opacity = "0"; return; }
      if (!el) { el = document.createElement("div"); el.id = "kv-title"; document.body.appendChild(el); }
      el.innerHTML = ""; el.appendChild(document.createTextNode(text));
      if (sub) { const s = document.createElement("p"); s.textContent = sub; el.appendChild(s); }
      el.style.opacity = "1";
    },
    ptr(x, y, press) { add(); const p = document.getElementById("kv-ptr"); p.style.left = x + "px"; p.style.top = y + "px"; p.style.transform = press ? "scale(.7)" : "scale(1)"; },
  };
  document.addEventListener("DOMContentLoaded", add);
});

const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
const wait = (ms) => page.waitForTimeout(ms);
const cap = (t, s, top) => page.evaluate(([a, b, c]) => window.__kv.cap(a, b, c), [t, s ?? "", !!top]);
const title = (t, s) => page.evaluate(([a, b]) => window.__kv.title(a, b), [t ?? "", s ?? ""]);
const unhl = () => page.evaluate(() => document.querySelectorAll(".kv-hl").forEach((e) => e.classList.remove("kv-hl")));
async function point(loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (b) await page.evaluate(([x, y]) => window.__kv.ptr(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
  await wait(800);
}
async function click(loc) {
  await point(loc);
  const b = await loc.boundingBox();
  if (b) await page.evaluate(([x, y]) => window.__kv.ptr(x, y, true), [b.x + b.width / 2, b.y + b.height / 2]);
  await wait(150);
  await loc.click();
  if (b) await page.evaluate(([x, y]) => window.__kv.ptr(x, y, false), [b.x + b.width / 2, b.y + b.height / 2]);
}
async function hl(loc) {
  await unhl();
  await loc.scrollIntoViewIfNeeded();
  await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await loc.evaluate((e) => e.classList.add("kv-hl"));
}
const card = (name) => page.locator("div.glass.rounded-2xl").filter({ has: page.getByText(name, { exact: true }) }).first();

// 1. Title
await page.goto(`${WEB}/v/${v.id}/settings?tab=connectors`);
await page.waitForSelector("text=Telegram bot", { timeout: 30000 });
await title("Connect your apps to Kritvia", "Gmail · email forwarding · WhatsApp · Telegram · Slack · Tally · any MCP app");
await wait(3500);
await title();
await wait(400);

// 2. Connectors page
await cap("Open Settings → Connectors for your business", "Only the business's admins can connect apps");
await point(page.getByRole("tab", { name: "Connectors" }));
await wait(2600);

// 3. Google
const google = card("Google Workspace");
await hl(google);
await point(page.getByRole("button", { name: "Connect Google" }));
await cap("Google: click Connect Google and sign in", "Approved emails and invites go out from your own Gmail");
await wait(3600);

// 4. Email forwarding
await hl(card("Email forwarding"));
await cap("Email forwarding: get your own Kritvia address", "No access to your mailbox needed");
await click(page.getByRole("button", { name: "Set up forwarding" }));
await page.waitForSelector("text=Your forwarding address", { timeout: 15000 });
await wait(600);
await point(page.getByText("Your forwarding address"));
await cap("Forward your business mail to this address", "Gmail: Settings → Forwarding → Add a forwarding address", true);
await wait(3600);

// 5. WhatsApp
await hl(card("WhatsApp Business"));
await point(page.getByRole("button", { name: "Connect WhatsApp" }));
await cap("WhatsApp: click Connect WhatsApp and log in with Facebook", "Pick your business number — about 2 minutes");
await wait(3800);

// 6. Telegram
await hl(card("Telegram bot"));
await cap("Telegram: make a bot with @BotFather (/newbot)", "Then click Connect a bot");
await click(page.getByRole("button", { name: "Connect a bot" }));
await page.waitForSelector("text=Connect a Telegram bot");
await unhl();
await wait(800);
await cap("Paste the token BotFather gives you", "It is checked with Telegram and stored encrypted");
const tokenInput = page.getByLabel("Bot token");
await click(tokenInput);
await tokenInput.pressSequentially(botToken, { delay: 25 });
await wait(500);
await click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
await page.waitForSelector("text=Link for customers", { timeout: 15000 });
await wait(500);
await hl(card("Telegram bot"));
await point(page.getByText("https://t.me/CleanCoBot"));
await cap("Connected! Share your bot's t.me link with customers", "On your website, visiting cards and Google profile", true);
await wait(3800);

// 7. Slack
await hl(card("Slack"));
await cap("Slack: your team hears when something needs a person", "Add Slack's Incoming Webhooks app to a channel");
await click(page.getByRole("button", { name: "Connect Slack" }));
await page.waitForSelector("text=Connect a Slack channel");
await unhl();
await cap("Paste the address Slack gives you", "It is stored encrypted, like every key");
await wait(700);
const hook = page.getByLabel("Webhook URL");
await click(hook);
await hook.pressSequentially("https://hooks.slack." + "com/services/" + ["T0DEMO123", "B0DEMO456", "x".repeat(24)].join("/"), { delay: 12 });
const ch = page.getByLabel("Channel name");
await click(ch);
await ch.pressSequentially("#team", { delay: 60 });
await cap("Paste the webhook address, then Connect", "Kritvia posts a hello to check it");
await wait(1200);
await click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));
await page.waitForSelector("text=#team", { timeout: 15000 });
await hl(card("Slack"));
await cap("Slack connected", "Posts say who needs attention — never what a customer wrote");
await wait(3000);

// 8. Tally
await hl(card("Tally"));
await point(page.getByRole("button", { name: "Import from Tally" }));
await cap("Tally: export XML from Tally and import it here", "Sales, purchases and who owes you become searchable");
await wait(3400);
await unhl();

// 9. Connected apps (MCP)
await cap("Any other app: open the Assistant page", "Connected apps work with any app that has an MCP server");
await click(page.getByRole("link", { name: "Assistant" }).first());
await page.waitForSelector("text=Connected apps", { timeout: 20000 });
await page.getByText("Connected apps").first().scrollIntoViewIfNeeded();
await wait(800);
await hl(page.locator("[aria-labelledby=apps-heading]"));
const nm = page.getByLabel("Short name");
await click(nm);
await nm.pressSequentially("crm", { delay: 80 });
const url = page.getByLabel("MCP server address");
await click(url);
await url.pressSequentially("https://mcp.example-crm.com/mcp", { delay: 25 });
const tk = page.getByLabel("Token (if the app needs one)");
await click(tk);
await tk.pressSequentially("demo-token", { delay: 40 });
await cap("Give it a short name, its MCP address and token", "Reading runs straight away; changes wait for your approval");
await wait(1200);
await click(page.locator("[aria-labelledby=apps-heading]").getByRole("button", { name: "Connect" }));
await page.waitForSelector("text=find_contact", { timeout: 15000 });
await cap("Connected — the assistant can now use the app's tools", "Ask in plain words, e.g. “find Ravi in the CRM”");
await wait(3600);
await unhl();

// 10. A customer writes on Telegram
const { secret } = await j("/__tg_secret");
const connectors = await j(`/ventures/${v.id}/connectors`, {}, tok);
const tgc = connectors.find((c) => c.provider === "telegram");
await j(`/hooks/telegram/${tgc.id}`, { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
  body: JSON.stringify({ update_id: 5001, message: { message_id: 1, date: 1700000000, chat: { id: 661234111, type: "private" },
    from: { id: 661234111, is_bot: false, first_name: "Ravi", username: "ravi_s" }, photo: [{ file_id: "x" }], caption: "Can you get this stain off the sofa?" } }) });
await cap("Customer chats then arrive on the Chats page", "WhatsApp and Telegram together");
await click(page.getByRole("link", { name: "Chats" }).first());
await page.waitForSelector("text=Ravi", { timeout: 20000 });
await wait(700);
await click(page.getByText("Ravi").first());
await page.waitForSelector("text=Kritvia drafted a reply", { timeout: 20000 });
await cap("Kritvia drafts each reply — it goes out when you approve it", "", true);
await point(page.getByText("Review the draft"));
await wait(3800);

// 11. End card
await cap("");
await title("That's it — your apps are connected", "Need help? Help → Contact us, or support@sitelytc.com");
await wait(3200);

await context.close();
const path = await page.video().path();
console.log("video", path);
await browser.close();
