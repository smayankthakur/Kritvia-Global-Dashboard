import { createConfiguredApp } from "./bootstrap";
import { createServer } from "node:http";
import { closeRedis, parseBool, safeGetRedis } from "./jobs/redis";
import { startJobWorkers, stopJobWorkers } from "./jobs/workers";
import { SchedulerService } from "./scheduler/scheduler.service";

function getDatabaseHost(databaseUrl?: string): string {
  if (!databaseUrl) {
    return "not-set";
  }

  try {
    return new URL(databaseUrl).host;
  } catch {
    return "invalid-url";
  }
}

function printStartupBanner(workerMode: string): void {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const dbHost = getDatabaseHost(process.env.DATABASE_URL);
  const recoveryEnabled = process.env.ALLOW_MIGRATION_RECOVERY === "true";
  const entryScript = process.argv[1] ?? "unknown-entry";
  const renderStartCommand =
    "npm --workspace apps/api run migrate:deploy:render && npm run seed:api && npm run start:api";

  console.log("[startup] Kritviya API bootstrap");
  console.log(`[startup] entry=${entryScript}`);
  console.log(`[startup] mode=${workerMode}`);
  console.log(`[startup] NODE_ENV=${nodeEnv}`);
  console.log(`[startup] DATABASE_URL_HOST=${dbHost}`);
  console.log(`[startup] ALLOW_MIGRATION_RECOVERY=${recoveryEnabled}`);
  console.log(`[startup] expected_render_start_command="${renderStartCommand}"`);
}

async function bootstrap(): Promise<void> {
  const jobsEnabled = parseBool(process.env.JOBS_ENABLED, true);
  const jobsRuntimeEnabled = jobsEnabled && !!safeGetRedis();
  const workerMode = (process.env.JOBS_WORKER_MODE ?? "api").toLowerCase();
  printStartupBanner(workerMode);
  const app = await createConfiguredApp();

  if (jobsEnabled && workerMode === "worker") {
    await app.init();
    const scheduler = app.get(SchedulerService);
    await scheduler.start("worker");
    const workers = jobsRuntimeEnabled ? await startJobWorkers(app) : [];
    const port = Number(process.env.PORT ?? process.env.API_PORT ?? process.env.WORKER_PORT ?? 4001);
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "api-worker" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });

    server.listen(port);
    const shutdown = async () => {
      await stopJobWorkers(workers);
      await closeRedis();
      await app.close();
      server.close();
    };

    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    return;
  }

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port);

  let workers: Awaited<ReturnType<typeof startJobWorkers>> = [];
  if (jobsRuntimeEnabled && workerMode === "api") {
    workers = await startJobWorkers(app);
  }
  const scheduler = app.get(SchedulerService);
  await scheduler.start("api");

  const shutdown = async () => {
    await stopJobWorkers(workers);
    await closeRedis();
    await app.close();
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

bootstrap();
