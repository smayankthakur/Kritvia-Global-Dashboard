/**
 * Hindi interface: the app is written in English, and in Hindi mode every piece of interface text that
 * has a translation in hi.json is shown in Hindi, including text that appears later (dialogs, toasts,
 * new rows), via a MutationObserver.
 *
 * - Only exact, whole interface strings are translated (a text node or a placeholder, label or title),
 *   so what people and customers wrote is never touched; containers of user content and legal text carry
 *   translate="no" and are skipped entirely.
 * - Legal pages stay in English: the English text is the binding version.
 * - The dictionary loads only when Hindi is chosen (a separate chunk), and switching back reloads the page.
 */

export type Lang = "en" | "hi";
const KEY = "kv-lang";
const ATTRS = ["placeholder", "aria-label", "title", "alt"] as const;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "NOSCRIPT", "KBD", "SVG"]);

/** A few interface strings built with numbers or dates. */
const PATTERNS: [RegExp, string][] = [
  [/^(\d+) unpaid$/, "$1 बकाया"],
  [/^(\d+) invoices?$/, "$1 इनवॉइस"],
  [/^(\d+) days? overdue$/, "$1 दिन बकाया"],
  [/^Due in (\d+) days?$/, "$1 दिन में देय"],
  [/^Paid (.+)$/, "भुगतान $1"],
  [/^Due (\d.+)$/, "देय $1"],
  [/^(\d+) drafts? waiting$/, "$1 ड्राफ़्ट इंतज़ार में"],
  [/^(\d+) of (\d+) steps done$/, "$2 में से $1 क़दम पूरे"],
  [/^Every day at (.+)$/, "हर दिन $1 बजे"],
  [/^Every (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(.*) at (.+)$/, "हर $1$2 को $3 बजे"],
  [/^Step (\d+) of (\d+)$/, "क़दम $1 / $2"],
];
const DAYS: Record<string, string> = {
  Monday: "सोमवार", Tuesday: "मंगलवार", Wednesday: "बुधवार", Thursday: "गुरुवार", Friday: "शुक्रवार",
  Saturday: "शनिवार", Sunday: "रविवार",
};

export function storedLang(): Lang {
  try {
    return window.localStorage.getItem(KEY) === "hi" ? "hi" : "en";
  } catch {
    return "en";
  }
}

export function setLang(lang: Lang): void {
  try {
    window.localStorage.setItem(KEY, lang);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  document.cookie = `${KEY}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;
  window.location.reload();
}

export function translateString(dict: Record<string, string>, s: string): string | null {
  const key = s.replace(/\s+/g, " ").trim();
  if (!key) return null;
  const hit = dict[key];
  if (hit) return hit;
  for (const [re, out] of PATTERNS) {
    if (re.test(key)) return key.replace(re, out).replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, (d) => DAYS[d] ?? d);
  }
  return null;
}

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName.toUpperCase())) return true;
    if (e.getAttribute("translate") === "no" || e.hasAttribute("data-no-i18n") || e.getAttribute("contenteditable") === "true") return true;
  }
  return false;
}

export function translateTree(dict: Record<string, string>, root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(dict, root as Text);
    return;
  }
  if (!(root instanceof Element) || skipped(root)) return;
  translateAttrs(dict, root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n instanceof Element && (SKIP_TAGS.has(n.tagName.toUpperCase()) || n.getAttribute("translate") === "no" || n.hasAttribute("data-no-i18n"))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(dict, n as Text);
    else translateAttrs(dict, n as Element);
  }
}

function translateTextNode(dict: Record<string, string>, node: Text): void {
  const raw = node.nodeValue;
  if (!raw || !/[A-Za-z]/.test(raw) || skipped(node.parentElement)) return;
  const hi = translateString(dict, raw);
  if (!hi) return;
  const lead = raw.match(/^\s*/)?.[0] ?? "";
  const trail = raw.match(/\s*$/)?.[0] ?? "";
  const next = lead + hi + trail;
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttrs(dict: Record<string, string>, el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    const hi = translateString(dict, v);
    if (hi && hi !== v) el.setAttribute(a, hi);
  }
}

/** Translates the page now and keeps translating what appears later. Returns a stop function. */
export function startHindi(dict: Record<string, string>): () => void {
  document.documentElement.lang = "hi";
  translateTree(dict, document.body);
  const titleHi = translateString(dict, document.title);
  if (titleHi) document.title = titleHi;
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") translateTree(dict, r.target);
      else if (r.type === "attributes" && r.target instanceof Element) translateAttrs(dict, r.target);
      else r.addedNodes.forEach((n) => translateTree(dict, n));
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  return () => obs.disconnect();
}
