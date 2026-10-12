/** Content-Security-Policy for rendered pages. Scripts are allowed only with the
 * per-request nonce (Next.js applies it to its own inline and chunk scripts);
 * styles allow 'unsafe-inline' because React style props and Next's font/style
 * injection need it. Recordings play from blob: URLs.
 *
 * The one exception to "no outside origins": the Drive picker page (PICKER_PAGE, opened from
 * Settings → Connectors) runs Google's file picker, which loads Google's scripts from our nonce'd
 * code ('strict-dynamic' admits them), opens a Google frame and talks to Google's APIs. Only that
 * page gets these hosts (middleware.ts); every other page keeps the strict policy. The "Connect
 * WhatsApp" page is the second, for Meta's signup (WHATSAPP_CONNECT_PAGE below). */
export const PICKER_PAGE = /^\/v\/[0-9a-f-]{36}\/drive-picker$/;
/** The second exception: the "Connect WhatsApp" page runs Meta's signup (Facebook's SDK, its login
 * frame and popup). Only that page gets Meta's hosts. */
export const WHATSAPP_CONNECT_PAGE = /^\/v\/[0-9a-f-]{36}\/whatsapp-connect$/;
// trust-scan: allowed-origins-start
export const GOOGLE_PICKER = {
  frame: ["https://docs.google.com", "https://accounts.google.com", "https://content.googleapis.com"],
  connect: ["https://www.googleapis.com", "https://content.googleapis.com", "https://accounts.google.com"],
  img: ["https://*.googleusercontent.com", "https://ssl.gstatic.com", "https://www.gstatic.com"],
  style: ["https://accounts.google.com"],
};
export const META_SIGNUP = {
  frame: ["https://www.facebook.com", "https://web.facebook.com", "https://business.facebook.com"],
  connect: ["https://graph.facebook.com", "https://www.facebook.com", "https://connect.facebook.net"],
  img: ["https://*.facebook.com", "https://*.fbcdn.net"],
  style: [] as string[],
};
// trust-scan: allowed-origins-end

export function buildCsp(nonce: string, dev = false, opts: { googlePicker?: boolean; metaSignup?: boolean } = {}): string {
  const g = opts.googlePicker ? GOOGLE_PICKER : opts.metaSignup ? META_SIGNUP : { frame: [] as string[], connect: [] as string[], img: [] as string[], style: [] as string[] };
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'", ...g.style],
    "img-src": ["'self'", "data:", "blob:", ...g.img],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...g.connect, ...(dev ? ["ws:"] : [])],
    "frame-src": ["'self'", ...g.frame],
    "media-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
