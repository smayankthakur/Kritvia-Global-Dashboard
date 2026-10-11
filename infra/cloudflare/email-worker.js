// Kritvia email forwarding: Cloudflare Email Routing -> this Worker -> POST /public/email-in.
//
// Each business forwards its mail to <name>@in.sitelytc.com. Email Routing's catch-all rule for
// in.sitelytc.com sends every message to this Worker, which signs the raw message and posts it to
// the API. Unknown addresses are bounced; a temporary API failure makes the sender retry later.
//
// Worker settings (Settings -> Variables and Secrets):
//   KRITVIA_INBOUND_URL     https://api.sitelytc.com/public/email-in      (plain variable)
//   KRITVIA_INBOUND_SECRET  the same value as INBOUND_EMAIL_SECRET in the server's .env (secret)

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const ts = String(Math.floor(Date.now() / 1000));
    const prefix = new TextEncoder().encode(ts + ".");
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix, 0);
    signed.set(raw, prefix.length);
    const signature = "sha256=" + (await hmacHex(env.KRITVIA_INBOUND_SECRET, signed));
    const res = await fetch(env.KRITVIA_INBOUND_URL, {
      method: "POST",
      headers: { "content-type": "message/rfc822", "x-kritvia-to": message.to, "x-kritvia-timestamp": ts,
                 "x-kritvia-signature": signature },
      body: raw,
    });
    if (res.status === 404) {
      message.setReject("No such Kritvia address");
      return;
    }
    if (!res.ok) {
      // A thrown error makes Email Routing report a temporary failure, so the sender retries.
      throw new Error(`Kritvia answered HTTP ${res.status}`);
    }
  },
};
