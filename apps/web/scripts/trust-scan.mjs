#!/usr/bin/env node
/**
 * Trust scan: dark patterns, unsupported claims, hidden fees, third-party code and licences.
 *
 *   node scripts/trust-scan.mjs            report every finding (exit 1 if any)
 *   node scripts/trust-scan.mjs --licences also check production dependency licences (needs pnpm)
 *
 * Runs in CI through tests/trust-scan.test.ts. A finding that a person has reviewed and judged
 * fair goes in ALLOW below with the reason — never silence a rule globally.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["app", "components", "lib"];

/** User-facing copy rules. Each matches text a visitor could read. */
export const RULES = [
  // Fake urgency and scarcity (CCPA India Dark Patterns Guidelines 2023: false urgency)
  { id: "false-urgency", re: /\b(only \d+ (left|remaining|spots?)|hurry|act now|limited[- ]time|offer ends|expires in \d|last chance|selling fast)\b/i },
  // Fake social proof: numbers of customers, star ratings, testimonials we can't evidence
  { id: "social-proof", re: /\b(trusted by|loved by|used by (over )?\d|join(ed)? (over )?\d[\d,]*|\d[\d,]*\+ (businesses|customers|users|teams)|happy (customers|clients)|rated \d(\.\d)? ?(\/|out of) ?5)\b|★|⭐|testimonial/i },
  // Superlatives and absolute claims that need proof
  { id: "unsupported-claim", re: /(#1\b|number one|best[- ]in[- ]class|world'?s (best|first|leading)|industry[- ]leading|guaranteed|100% (secure|safe|accurate|uptime|private)|unhackable|military[- ]grade|bank[- ]grade|zero risk|never (fails|goes down))/i },
  // Confirmshaming and nagging
  { id: "confirmshaming", re: /no thanks,? i (don'?t|do not) (want|like|care)|i('| a)m fine (paying|losing)|i prefer to (lose|miss)/i },
  // Pre-ticked consent boxes
  { id: "pre-ticked", re: /defaultChecked(=\{true\})?(?!=\{false\})/ },
  // Drip pricing / hidden fees
  { id: "hidden-fee", re: /\b(convenience|processing|service|platform|handling) fee\b/i },
  // Disguised ads and forced continuity wording
  { id: "forced-continuity", re: /\bfree trial\b(?![^.]*\b(no card|cancel))/i },
];

/** Reviewed exceptions: file + rule + why it is fair. Keep this short. */
export const ALLOW = [
  { file: "scripts/trust-scan.mjs", rule: "*", why: "the rules themselves" },
  { file: "lib/legal/", rule: "unsupported-claim", why: "legal text quoting what we do not do (e.g. no guarantee)" },
  { file: "lib/legal/", rule: "hidden-fee", why: "policies state there are no other fees" },
  { file: "lib/consent.ts", rule: "pre-ticked", why: "comment describing the rule" },
  { file: "app/upload/[token]/page.tsx", rule: "false-urgency", why: "true statement: upload links do expire (security), shown only after one has" },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const allowed = (file, rule) => ALLOW.some((a) => file.startsWith(a.file) && (a.rule === "*" || a.rule === rule));

export function scanCopy(root = ROOT) {
  const findings = [];
  for (const d of SCAN_DIRS) {
    for (const f of walk(join(root, d))) {
      const rel = relative(root, f);
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const r of RULES) if (r.re.test(line) && !allowed(rel, r.id)) findings.push({ file: rel, line: i + 1, rule: r.id, text: line.trim().slice(0, 160) });
        });
    }
  }
  return findings;
}

/** Any price shown on a public page must say GST is extra on the same page. */
export function scanPrices(root = ROOT) {
  const findings = [];
  for (const f of walk(join(root, "app", "(public)"))) {
    const src = readFileSync(f, "utf8");
    if (/₹\s?\d|rupees\(|PricingTable|PublicPricing/.test(src) && !/GST/.test(src)) findings.push({ file: relative(root, f), line: 1, rule: "price-without-gst", text: "shows prices but never mentions GST" });
  }
  return findings;
}

/** No third-party script, frame or pixel: every src/href to another origin in markup is reported. */
export function scanThirdParty(root = ROOT) {
  const findings = [];
  const re = /<(script|iframe|img|link)\b[^>]*\b(src|href)=["'{`]+(https?:)?\/\/(?!(app\.)?sitelytc\.com)[^"'`}\s]+/i;
  for (const d of SCAN_DIRS) {
    for (const f of walk(join(root, d))) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (re.test(line)) findings.push({ file: relative(root, f), line: i + 1, rule: "third-party-embed", text: line.trim().slice(0, 160) });
        });
    }
  }
  const csp = readFileSync(join(root, "lib", "csp.ts"), "utf8");
  if (/https?:\/\//.test(csp.split("export function makeNonce")[0])) findings.push({ file: "lib/csp.ts", line: 1, rule: "csp-third-party", text: "CSP allows an outside origin" });
  return findings;
}

/** Licences that would oblige us to publish our own code, or are unknown, fail the scan. */
export const BLOCKED_LICENCES = /\b(A?GPL|SSPL|BUSL|CC-BY-NC|Commons Clause|UNLICENSED|UNKNOWN)\b/i;

export function scanLicences(root = ROOT) {
  const json = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const byLicence = JSON.parse(json);
  const findings = [];
  for (const [licence, pkgs] of Object.entries(byLicence)) {
    if (BLOCKED_LICENCES.test(licence) && !/LGPL/i.test(licence)) for (const p of pkgs) findings.push({ file: "package.json", line: 0, rule: "licence", text: `${p.name}@${p.versions?.join(",")}: ${licence}` });
  }
  return { findings, summary: Object.fromEntries(Object.entries(byLicence).map(([l, p]) => [l, p.length])) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = [...scanCopy(), ...scanPrices(), ...scanThirdParty()];
  if (process.argv.includes("--licences")) {
    const { findings, summary } = scanLicences();
    all.push(...findings);
    console.log("Production dependency licences:", summary);
  }
  for (const f of all) console.log(`${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
  console.log(all.length ? `\n${all.length} finding(s).` : "Trust scan: no findings.");
  process.exit(all.length ? 1 : 0);
}
