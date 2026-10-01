// Bundle main, preload and the two renderer pages with esbuild into dist/.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/renderer", { recursive: true });
const common = { bundle: true, sourcemap: true, logLevel: "warning", target: "es2022" };

await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "cjs",
  external: ["electron", "uiohook-napi"] });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js", platform: "node", format: "cjs",
  external: ["electron"] });
for (const page of ["bubble", "settings"]) {
  await build({ ...common, entryPoints: [`src/renderer/${page}.ts`], outfile: `dist/renderer/${page}.js`, platform: "browser",
    format: "iife" });
  cpSync(`src/renderer/${page}.html`, `dist/renderer/${page}.html`);
  cpSync(`src/renderer/${page}.css`, `dist/renderer/${page}.css`);
}
console.log("built dist/");
