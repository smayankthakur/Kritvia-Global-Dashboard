import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const failures = [];
const warnings = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function warn(condition, message) {
  if (!condition) {
    warnings.push(message);
  }
}

const rootPkgPath = path.join(repoRoot, "package.json");
const rootPkg = readJson(rootPkgPath);
const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
expect(rootPkg.private === true, "Root package.json must set private=true.");
expect(workspaces.includes("apps/*"), 'Root workspaces must include "apps/*".');

const turboPath = path.join(repoRoot, "turbo.json");
if (fs.existsSync(turboPath)) {
  const turbo = readJson(turboPath);
  const outputs = turbo?.tasks?.build?.outputs ?? [];
  expect(
    Array.isArray(outputs) && outputs.includes("apps/web/.next/**"),
    'turbo.json build.outputs must include "apps/web/.next/**".'
  );
} else {
  warnings.push("turbo.json not found; turbo pipeline checks skipped.");
}

const prismaClientDts = path.join(repoRoot, "node_modules", ".prisma", "client", "index.d.ts");
warn(
  fs.existsSync(prismaClientDts),
  "Prisma client is not generated. Run: npm --workspace @kritviya/api run prisma:generate"
);

const routesManifest = path.join(repoRoot, "apps", "web", ".next", "routes-manifest.json");
warn(
  fs.existsSync(routesManifest),
  "Next routes manifest missing. Run: npm --workspace @kritviya/web run build"
);

if (warnings.length) {
  console.log("[doctor] warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (failures.length) {
  console.error("[doctor] failures:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[doctor] OK");
