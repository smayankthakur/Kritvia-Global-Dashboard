import { spawn } from "node:child_process";

const SCHEMA_PATH = "prisma/schema.prisma";
const TARGET_MIGRATION = "20260218150000_phase6421_whitelabel_status";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const printable = `${command} ${args.join(" ")}`;
    console.log(`\n$ ${printable}`);

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let combinedOutput = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ code: code ?? 1, output: combinedOutput }));
  });
}

function isTargetP3009(output) {
  return output.includes("P3009") && output.includes(TARGET_MIGRATION);
}

function printFailureOutput(label, output) {
  console.error(`\n[render-migrate-recover] ${label} output start`);
  console.error(output || "(no output captured)");
  console.error(`[render-migrate-recover] ${label} output end`);
}

async function main() {
  const recoveryAllowed = process.env.ALLOW_MIGRATION_RECOVERY === "true";
  console.log("[render-migrate-recover] startup");
  console.log(
    `[render-migrate-recover] ALLOW_MIGRATION_RECOVERY=${process.env.ALLOW_MIGRATION_RECOVERY ?? "undefined"}`
  );
  const deployArgs = ["prisma", "migrate", "deploy", "--schema", SCHEMA_PATH];
  const firstDeploy = await runCommand("npx", deployArgs);

  if (firstDeploy.code === 0) {
    console.log("\nPrisma migrate deploy completed successfully.");
    return;
  }

  if (!isTargetP3009(firstDeploy.output)) {
    console.error("\nMigration failed, but not with the targeted auto-recover case.");
    console.error(`Only ${TARGET_MIGRATION} with P3009 is auto-resolved by this script.`);
    printFailureOutput("initial migrate deploy failure", firstDeploy.output);
    process.exit(1);
  }

  if (!recoveryAllowed) {
    console.error(
      "\nDetected targeted P3009 migration failure, but ALLOW_MIGRATION_RECOVERY is not set to true."
    );
    console.error("Render dashboard instructions:");
    console.error("1) Open Render service -> Environment.");
    console.error("2) Add env var: ALLOW_MIGRATION_RECOVERY=true");
    console.error("3) Save changes and trigger a new deploy.");
    console.error("Operator actions:");
    console.error("1) Reset DB (safe for non-production/early-stage environments), OR");
    console.error(
      `2) Run manually: npx prisma migrate resolve --schema ${SCHEMA_PATH} --rolled-back ${TARGET_MIGRATION}`
    );
    console.error(`3) Then run: npx prisma migrate deploy --schema ${SCHEMA_PATH}`);
    process.exit(1);
  }

  console.warn(
    `\nDetected P3009 for ${TARGET_MIGRATION}. Attempting safe recovery by marking it rolled back.`
  );

  const resolveArgs = [
    "prisma",
    "migrate",
    "resolve",
    "--schema",
    SCHEMA_PATH,
    "--rolled-back",
    TARGET_MIGRATION
  ];
  const resolveResult = await runCommand("npx", resolveArgs);
  if (resolveResult.code !== 0) {
    console.error("\nFailed to resolve migration state. Manual intervention required.");
    printFailureOutput("migrate resolve failure", resolveResult.output);
    process.exit(1);
  }

  console.log("\nRetrying prisma migrate deploy after resolve...");
  const secondDeploy = await runCommand("npx", deployArgs);
  if (secondDeploy.code !== 0) {
    console.error("\nPrisma migrate deploy failed after recovery attempt.");
    printFailureOutput("retry migrate deploy failure", secondDeploy.output);
    process.exit(1);
  }

  console.log("\nPrisma migrate deploy succeeded after auto-recovery.");
}

main().catch((error) => {
  console.error("\nUnexpected migration recovery error.");
  console.error(error);
  process.exit(1);
});
