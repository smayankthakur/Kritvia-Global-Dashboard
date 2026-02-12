import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const env = {
  ...process.env,
  PORT: process.env.WEB_PORT || process.env.PORT || "3000",
  HOSTNAME: process.env.WEB_HOSTNAME || "localhost"
};

const staticSource = resolve(process.cwd(), "apps/web/.next/static");
const staticTarget = resolve(process.cwd(), "apps/web/.next/standalone/apps/web/.next/static");
if (existsSync(staticSource)) {
  cpSync(staticSource, staticTarget, { recursive: true, force: true });
}

const result = spawnSync("npm run start --workspace @kritviya/web", {
  stdio: "inherit",
  shell: true,
  env
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
