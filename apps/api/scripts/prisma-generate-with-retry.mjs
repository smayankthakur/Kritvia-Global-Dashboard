import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1200;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runGenerate() {
  return spawnSync("npx", ["prisma", "generate", "--schema", "prisma/schema.prisma"], {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}

function isRetryableLockError(output) {
  const text = output.toLowerCase();
  return text.includes("eperm: operation not permitted");
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const result = runGenerate();
  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status === 0) {
    process.exit(0);
  }

  const shouldRetry = attempt < MAX_ATTEMPTS && isRetryableLockError(combinedOutput);
  if (!shouldRetry) {
    process.exit(result.status ?? 1);
  }

  console.warn(
    `[prisma:generate] Detected EPERM lock contention. Retrying (${attempt}/${MAX_ATTEMPTS})...`
  );
  sleep(BASE_DELAY_MS * attempt);
}

process.exit(1);
