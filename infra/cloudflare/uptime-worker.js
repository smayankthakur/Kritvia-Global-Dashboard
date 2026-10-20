/**
 * Kritvia outside monitor: a Cloudflare Worker that checks Kritvia from outside AWS every minute and tells
 * the owner on Telegram (and/or email) when it stops answering, and again when it is back.
 *
 * Why outside: the server's own watchdog (infra/scripts/healthcheck.sh) restarts what it can and alerts, but
 * if the whole server, its network or AWS is down, nothing on it can say so. This runs on Cloudflare.
 *
 * What it checks (every minute, cron "* * * * *"):
 *   READY_URL   e.g. https://app.sitelytc.com/api/k/readyz   the API and database answer
 *   LIVE_URL    e.g. https://app.sitelytc.com/api/k/livez    the workers are alive and runs aren't piling up
 * A check must fail twice, 20 seconds apart, before it counts, so one slow answer never alerts.
 *
 * Settings (Workers → kritvia-uptime → Settings):
 *   Variables:  READY_URL, LIVE_URL (optional)
 *   Secrets:    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (a bot you create with @BotFather; your chat id)
 *   KV binding: STATE (a KV namespace; written only when the state changes, well inside the free tier)
 *   Optional:   an Email Routing "send email" binding named MAIL, with ALERT_TO = a verified address
 * Trigger:      Cron "* * * * *"
 */

async function check(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "kritvia-uptime/1" }, cf: { cacheTtl: 0 } });
    let detail = `HTTP ${r.status}`;
    if (r.headers.get("content-type")?.includes("json")) {
      const j = await r.json().catch(() => null);
      if (j && typeof j.worker_age_s === "number") detail += `, worker heartbeat ${j.worker_age_s}s ago, ${j.queued ?? 0} waiting`;
    }
    return { ok: r.ok, detail };
  } catch (e) {
    return { ok: false, detail: `no answer (${String(e).slice(0, 80)})` };
  }
}

async function probe(env) {
  const urls = [env.READY_URL, env.LIVE_URL].filter(Boolean);
  const out = [];
  for (const url of urls) {
    let res = await check(url);
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 20000));
      res = await check(url);
    }
    out.push({ url, ...res });
  }
  return out;
}

async function tell(env, text) {
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      }),
    );
  }
  if (env.MAIL && env.ALERT_TO) {
    const { EmailMessage } = await import("cloudflare:email");
    const from = env.ALERT_FROM || "uptime@sitelytc.com";
    const subject = text.split("\n")[0];
    const raw = `From: Kritvia uptime <${from}>\r\nTo: ${env.ALERT_TO}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
    jobs.push(env.MAIL.send(new EmailMessage(from, env.ALERT_TO, raw)));
  }
  await Promise.allSettled(jobs);
}

async function run(env) {
  const results = await probe(env);
  const down = results.filter((r) => !r.ok);
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const was = (await env.STATE.get("state")) || "up";
  if (down.length && was === "up") {
    await env.STATE.put("state", "down");
    await env.STATE.put("since", now);
    await tell(env, `Kritvia is DOWN (${now})\n` + down.map((d) => `- ${d.url}: ${d.detail}`).join("\n") +
      "\nThe server's own watchdog restarts what it can; if this lasts, check AWS (EC2 i-0177e8d81131819d7) and Cloudflare.");
  } else if (!down.length && was === "down") {
    const since = (await env.STATE.get("since")) || "?";
    await env.STATE.put("state", "up");
    await tell(env, `Kritvia is back UP (${now}); it was down since ${since}.`);
  }
  return { state: down.length ? "down" : "up", results };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // GET /  -> a fresh check and the remembered state, without sending anything (to test the set-up)
  async fetch(_request, env) {
    const results = await probe(env);
    const state = (await env.STATE.get("state")) || "up";
    return new Response(JSON.stringify({ state, results }, null, 2), { headers: { "content-type": "application/json" } });
  },
};
