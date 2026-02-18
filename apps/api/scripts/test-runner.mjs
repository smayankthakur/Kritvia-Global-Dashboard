import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import dotenv from "dotenv";

function run(command, env) {
  console.log(`[test-runner] ${command}`);
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

function parseBool(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function loadEnvFiles() {
  const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      break;
    }
  }

  if (!process.env.DATABASE_URL_TEST) {
    const envExampleCandidates = [
      resolve(process.cwd(), ".env.example"),
      resolve(process.cwd(), "../../.env.example")
    ];
    for (const candidate of envExampleCandidates) {
      if (!existsSync(candidate)) {
        continue;
      }
      const parsed = dotenv.parse(readFileSync(candidate));
      if (parsed.DATABASE_URL_TEST) {
        process.env.DATABASE_URL_TEST = parsed.DATABASE_URL_TEST;
        break;
      }
    }
  }
}

function resolveTestDatabaseUrl() {
  const allowFallback =
    process.env.ALLOW_DATABASE_URL_FALLBACK_FOR_TESTS === "true" ||
    process.env.ALLOW_DATABASE_URL_FALLBACK_FOR_TESTS === "1";
  return process.env.DATABASE_URL_TEST || (allowFallback ? process.env.DATABASE_URL : "");
}

function baseTestEnv() {
  return {
    ...process.env,
    NODE_ENV: "test",
    COOKIE_SECURE: "false",
    JWT_SECRET: process.env.JWT_SECRET || "kritviya_test_jwt_secret",
    API_PORT: process.env.API_PORT || "4000",
    JOBS_ENABLED: "false"
  };
}

function e2eEnv() {
  const databaseUrl = resolveTestDatabaseUrl();

  if (!databaseUrl) {
    console.error(
      "Missing DATABASE_URL_TEST for tests. Add DATABASE_URL_TEST (or set it in .env/.env.example) before running test scripts."
    );
    process.exit(1);
  }

  if (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) {
    console.error(
      "RUN_E2E=true requires a non-localhost DATABASE_URL_TEST. Provide a reachable CI/remote Postgres URL."
    );
    process.exit(1);
  }

  return {
    ...baseTestEnv(),
    DATABASE_URL: databaseUrl,
    DATABASE_URL_TEST: databaseUrl
  };
}

function parseDbHostPort(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname;
    const port = Number(parsed.port || 5432);
    return { host, port };
  } catch {
    return null;
  }
}

async function ensureDbReachable(databaseUrl) {
  const target = parseDbHostPort(databaseUrl);
  if (!target || !target.host || Number.isNaN(target.port)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(2500);

    socket.once("error", () => {
      socket.destroy();
      reject(
        new Error(
          `Cannot reach test database at ${target.host}:${target.port}. Start Postgres and verify DATABASE_URL_TEST.`
        )
      );
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(
        new Error(
          `Timed out reaching test database at ${target.host}:${target.port}. Start Postgres and verify DATABASE_URL_TEST.`
        )
      );
    });
    socket.connect(target.port, target.host, () => {
      socket.end();
      resolve(undefined);
    });
  });
}

const mode = process.argv[2];
loadEnvFiles();
const ciFast = parseBool(process.env.CI_FAST, parseBool(process.env.CI, false));
const runE2E = parseBool(process.env.RUN_E2E, false);

if (mode === "setup") {
  const env = e2eEnv();
  await ensureDbReachable(env.DATABASE_URL).catch((error) => {
    console.error(error instanceof Error ? error.message : "Failed test DB preflight check.");
    process.exit(1);
  });
  run("npx prisma migrate deploy --schema prisma/schema.prisma", env);
  run("npx ts-node --project tsconfig.json prisma/seed-test.ts", env);
  process.exit(0);
}

if (mode === "test") {
  const env = runE2E ? e2eEnv() : baseTestEnv();
  if (runE2E) {
    await ensureDbReachable(env.DATABASE_URL).catch((error) => {
      console.error(error instanceof Error ? error.message : "Failed test DB preflight check.");
      process.exit(1);
    });
    run("npx jest --config test/jest-e2e.config.js --runInBand", env);
    process.exit(0);
  }
  run("npx jest --config test/jest-unit.config.js --runInBand --passWithNoTests", env);
  process.exit(0);
}

if (mode === "ci") {
  if (ciFast && !runE2E) {
    const env = baseTestEnv();
    run("npx tsc -p tsconfig.build.json --noEmit", env);
    run("npx eslint \"src/**/*.ts\"", env);
    run("npx jest --config test/jest-unit.config.js --runInBand --passWithNoTests", env);
    process.exit(0);
  }

  if (!runE2E) {
    console.error(
      "CI requested non-fast mode but RUN_E2E is not true. Set RUN_E2E=true to execute E2E suite."
    );
    process.exit(1);
  }

  const env = e2eEnv();
  await ensureDbReachable(env.DATABASE_URL).catch((error) => {
    console.error(error instanceof Error ? error.message : "Failed test DB preflight check.");
    process.exit(1);
  });
  run("npx prisma migrate reset --force --skip-seed --schema prisma/schema.prisma", env);
  run("npx ts-node --project tsconfig.json prisma/seed-test.ts", env);
  run("npx jest --config test/jest-e2e.config.js --runInBand", env);
  process.exit(0);
}

console.error("Unknown mode. Use one of: setup | test | ci");
process.exit(1);
