import { createConfiguredApp } from "./bootstrap";
import { createServer } from "node:http";
import { closeRedis } from "./jobs/redis";
import { startJobWorkers, stopJobWorkers } from "./jobs/workers";
import { SchedulerService } from "./scheduler/scheduler.service";

async function bootstrap(): Promise<void> {
  const app = await createConfiguredApp();
  const jobsEnabled = (process.env.JOBS_ENABLED ?? "true").toLowerCase() === "true";
  const workerMode = (process.env.JOBS_WORKER_MODE ?? "api").toLowerCase();

  if (jobsEnabled && workerMode === "worker") {
    await app.init();
    const scheduler = app.get(SchedulerService);
    await scheduler.start("worker");
    const workers = await startJobWorkers(app);
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
  if (jobsEnabled && workerMode === "api") {
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
