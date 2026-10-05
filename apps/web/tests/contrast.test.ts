// @vitest-environment node
/**
 * WCAG 2.2 AA contrast for the design tokens, in light and dark: body text 4.5:1 and large/bold
 * UI text and focus rings 3:1, measured on the page background and on glass surfaces composited
 * over it (the worst case behind a frosted panel is the page colour itself).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABEL_COLORS } from "@/lib/taskboard";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgb = c.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
  throw new Error(`unparsed colour ${c}`);
}
const over = (top: RGBA, bottom: RGBA): RGBA => [0, 1, 2].map((i) => top[i]! * top[3] + bottom[i]! * (1 - top[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => {
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
export const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

for (const [theme, tokens] of [["light", block(":root")], ["dark", { ...block(":root"), ...block(".dark") }]] as const) {
  describe(`${theme} theme contrast`, () => {
    const bg = parse(tokens.bg!);
    const surfaces = { page: bg, surface: over(parse(tokens.surface!), bg), "surface-strong": over(parse(tokens["surface-strong"]!), bg) };

    for (const [name, min] of [["fg", 4.5], ["fg-muted", 4.5], ["fg-subtle", 4.5], ["accent", 4.5]] as const) {
      for (const [sname, s] of Object.entries(surfaces)) {
        it(`${name} text on ${sname} ≥ ${min}:1`, () => {
          expect(ratio(parse(tokens[name]!), s)).toBeGreaterThanOrEqual(min);
        });
      }
    }

    it("button text on the accent ≥ 4.5:1 (both ends of the gradient)", () => {
      expect(ratio(parse(tokens["accent-fg"]!), parse(tokens.accent!))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(parse(tokens["accent-fg"]!), parse(tokens["accent-2"]!))).toBeGreaterThanOrEqual(4.5);
    });

    for (const tone of ["success", "warning", "danger", "info", "accent-soft"] as const) {
      it(`${tone} badge text ≥ 4.5:1`, () => {
        const fg = parse(tokens[tone === "accent-soft" ? "accent-soft-fg" : `${tone}-fg`]!);
        const soft = over(parse(tokens[tone === "accent-soft" ? "accent-soft" : `${tone}-soft`]!), surfaces["surface-strong"]);
        expect(ratio(fg, soft)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it("focus ring ≥ 3:1 against the page", () => {
      expect(ratio(parse(tokens.ring!), bg)).toBeGreaterThanOrEqual(3);
    });
  });
}

describe("task label colours", () => {
  for (const l of LABEL_COLORS) {
    it(`${l.name} label text ≥ 4.5:1`, () => {
      expect(ratio(parse(l.fg), parse(l.bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
