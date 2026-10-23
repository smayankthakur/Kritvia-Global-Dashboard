/**
 * Pulls the English interface text out of .tsx/.ts source, the way the Hindi translator will meet it on
 * screen: whole JSX text runs, string props people read (label, title, description, placeholder, hint,
 * aria-label, confirm/cancel labels), string values of label-like keys in option lists, and the words
 * given to toasts. Template strings with ${…} are left to the translator's number/date patterns.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const PROPS = new Set(["label", "title", "description", "placeholder", "hint", "aria-label", "confirmLabel", "cancelLabel", "alt"]);
const KEYS = new Set(["label", "title", "description", "hint", "text", "placeholder"]);
const TOAST = new Set(["success", "error", "info"]);

/** Interface text, not code: has a letter, isn't an identifier, path, URL or CSS class list. */
export function isUiText(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (/^[a-z0-9_.:/#@-]+$/.test(t)) return false; // ids, keys, paths, css tokens
  if (/^https?:\/\//.test(t) || /^\/[a-z]/.test(t)) return false;
  if (/^[A-Z0-9_]+$/.test(t)) return false; // CONSTANTS
  if (/(^| )(flex|grid|text-|bg-|px-|py-|rounded|border)/.test(t)) return false;
  return true;
}

function add(out: Set<string>, s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  if (isUiText(t)) out.add(t);
}

function literal(n: ts.Node | undefined): string | null {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** String literals reachable as the value of an expression: "a", cond ? "a" : "b", x ?? "a", "a" || x. */
function values(n: ts.Expression): string[] {
  const l = literal(n);
  if (l !== null) return [l];
  if (ts.isParenthesizedExpression(n)) return values(n.expression);
  if (ts.isConditionalExpression(n)) return [...values(n.whenTrue), ...values(n.whenFalse)];
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(n.operatorToken.kind))
    return [...values(n.left), ...values(n.right)];
  return [];
}

export function stringsIn(file: string): Set<string> {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      // A text run between tags, with the HTML entities written in the source decoded as React shows them.
      add(out, n.getText().replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”").replace(/&rarr;/g, "→"));
    } else if (ts.isJsxAttribute(n) && PROPS.has(n.name.getText())) {
      const init = n.initializer;
      if (init && ts.isStringLiteral(init)) add(out, init.text);
      else if (init && ts.isJsxExpression(init) && init.expression) values(init.expression).forEach((s) => add(out, s));
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      values(n.expression).forEach((s) => add(out, s));
    } else if (ts.isPropertyAssignment(n) && KEYS.has(n.name.getText().replace(/["']/g, ""))) {
      values(n.initializer).forEach((s) => add(out, s));
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && TOAST.has(n.expression.name.text) && /toast/i.test(n.expression.expression.getText())) {
      n.arguments.slice(0, 2).forEach((a) => values(a).forEach((s) => add(out, s)));
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

export function filesUnder(root: string, exts = [".tsx"]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => n.endsWith(e))) out.push(p);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  else out.push(root);
  return out;
}
