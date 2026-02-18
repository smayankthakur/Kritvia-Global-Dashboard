import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
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

  const allowFallback =
    process.env.ALLOW_DATABASE_URL_FALLBACK_FOR_TESTS === "true" ||
    process.env.ALLOW_DATABASE_URL_FALLBACK_FOR_TESTS === "1";
  const databaseUrl = process.env.DATABASE_URL_TEST || (allowFallback ? process.env.DATABASE_URL : "");
  if (!databaseUrl) {
    console.error(
      "Missing DATABASE_URL_TEST for tests. Add DATABASE_URL_TEST (or set it in .env/.env.example) before running test scripts."
    );
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
const env = testEnv();
await ensureDbReachable(env.DATABASE_URL).catch((error) => {
  console.error(error instanceof Error ? error.message : "Failed test DB preflight check.");
  process.exit(1);
});

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
