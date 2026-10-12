// Kritvia email forwarding: Cloudflare Email Routing -> this Worker -> POST /public/email-in.
//
// Each business forwards its mail to <name>@in.sitelytc.com. Email Routing's catch-all rule for
// in.sitelytc.com sends every message to this Worker, which signs the raw message and posts it to
// the API. Unknown addresses are bounced; a temporary API failure makes the sender retry later.
//
// The company's own domain can route its catch-all here too: mail for any other address on it
// (sales@, a typo of support@) is forwarded to one mailbox instead of bouncing, when
// FORWARD_OTHER_TO is set. Only mail for KRITVIA_DOMAIN goes to Kritvia.
//
// Worker settings (Settings -> Variables and Secrets):
//   KRITVIA_INBOUND_URL     https://api.sitelytc.com/public/email-in      (plain variable)
//   KRITVIA_INBOUND_SECRET  the same value as INBOUND_EMAIL_SECRET in the server's .env (secret)
//   KRITVIA_DOMAIN          in.sitelytc.com                              (plain variable, optional)
//   FORWARD_OTHER_TO        a verified Email Routing destination address  (plain variable, optional)

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when `to` is an address Kritvia should receive (always, unless KRITVIA_DOMAIN says otherwise). */
export function forKritvia(to, domain) {
  if (!domain) return true;
  const at = String(to || "").toLowerCase().trim();
  return at.endsWith("@" + String(domain).toLowerCase().trim());
}

export default {
  async email(message, env) {
    if (!forKritvia(message.to, env.KRITVIA_DOMAIN)) {
      if (env.FORWARD_OTHER_TO) {
        await message.forward(env.FORWARD_OTHER_TO);
      } else {
        message.setReject("No such address");
      }
      return;
    }
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
