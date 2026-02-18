import { spawnSync } from "node:child_process";

const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 1500;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runBuild() {
  return spawnSync("npx", ["next", "build"], {
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32"
  });
}

function isTraceEperm(output) {
  return (
    output.includes("EPERM: operation not permitted") &&
    output.toLowerCase().includes("trace")
  );
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const result = runBuild();
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

  const shouldRetry = attempt < MAX_ATTEMPTS && isTraceEperm(combinedOutput);
  if (!shouldRetry) {
    process.exit(result.status ?? 1);
  }

  console.warn(
    `[build:web] Detected transient EPERM trace lock. Retrying (${attempt}/${MAX_ATTEMPTS})...`
  );
  sleep(RETRY_WAIT_MS * attempt);
}

process.exit(1);
