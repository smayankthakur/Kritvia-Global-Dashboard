import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

function run(command, env) {
  const result = spawnSync(command, {
    stdio: "inherit",
    shell: true,
    env
  });

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
}

function testEnv() {
  const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      break;
    }
  }

  const databaseUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL_TEST (or DATABASE_URL fallback) for tests.");
    process.exit(1);
  }

  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    COOKIE_SECURE: "false",
    JWT_SECRET: process.env.JWT_SECRET || "kritviya_test_jwt_secret",
    API_PORT: process.env.API_PORT || "4000"
  };
}

const mode = process.argv[2];
const env = testEnv();

if (mode === "setup") {
  run("npx prisma migrate deploy --schema prisma/schema.prisma", env);
  run("npx ts-node --project tsconfig.json prisma/seed-test.ts", env);
  process.exit(0);
}

if (mode === "test") {
  run("npx jest --config test/jest-e2e.json --runInBand", env);
  process.exit(0);
}

if (mode === "ci") {
  run("npx prisma migrate reset --force --skip-seed --schema prisma/schema.prisma", env);
  run("npx ts-node --project tsconfig.json prisma/seed-test.ts", env);
  run("npx jest --config test/jest-e2e.json --runInBand", env);
  process.exit(0);
}

console.error("Unknown mode. Use one of: setup | test | ci");
process.exit(1);
