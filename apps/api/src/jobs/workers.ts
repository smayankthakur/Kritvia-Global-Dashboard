import { INestApplication, Logger } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { AlertRoutingService } from "../alerts/alert-routing.service";
import { AlertingService } from "../alerts/alerting.service";
import { AlertsService } from "../alerts/alerts.service";
import { AiActionsService } from "../ai-actions/ai-actions.service";
import { AiService } from "../ai/ai.service";
import { LlmService } from "../llm/llm.service";
import { WebhookService } from "../org-webhooks/webhook.service";
import { PrismaService } from "../prisma/prisma.service";
import { SchedulerService } from "../scheduler/scheduler.service";
import { StatusService } from "../status/status.service";
import { RiskEngineService } from "../graph/risk/risk-engine.service";
import { JobsRunService } from "./jobs-run.service";
import { QUEUE_NAMES, getQueue } from "./queues";
import { parseBool, safeGetRedis } from "./redis";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";

type WorkerHandle = {
  name: string;
  worker: Worker;
};

const logger = new Logger("BullWorkers");

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function ensureRedisReadyForWorkers(redis: Redis): Promise<boolean> {
  const maxAttempts = toPositiveInt(process.env.JOBS_REDIS_CONNECT_ATTEMPTS, 5);
  const baseDelayMs = toPositiveInt(process.env.JOBS_REDIS_CONNECT_BASE_DELAY_MS, 1000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await redis.ping();
      if (attempt > 1) {
        logger.log(`Redis became available on attempt ${attempt}/${maxAttempts}.`);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logger.warn(
        `Redis unavailable for workers (attempt ${attempt}/${maxAttempts}): ${message}`
      );
      if (attempt < maxAttempts) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  logger.warn("Skipping worker startup because Redis is unavailable after retries.");
  return false;
}

export async function startJobWorkers(app: INestApplication): Promise<WorkerHandle[]> {
  if (!parseBool(process.env.JOBS_ENABLED, false)) {
    logger.log("Jobs disabled (JOBS_ENABLED!=true), workers not started.");
    return [];
  }
  const redis = safeGetRedis();
  if (!redis) {
    logger.warn("JOBS_ENABLED=true but REDIS_URL missing; skipping worker startup.");
    return [];
  }
  const redisReady = await ensureRedisReadyForWorkers(redis);
  if (!redisReady) {
    return [];
  }

  const aiService = app.get(AiService);
  const aiActionsService = app.get(AiActionsService);
  const llmService = app.get(LlmService);
  const webhookService = app.get(WebhookService);
  const jobsRunService = app.get(JobsRunService);
  const schedulerService = app.get(SchedulerService);
  const statusService = app.get(StatusService);
  const riskEngineService = app.get(RiskEngineService);
  const alertRoutingService = app.get(AlertRoutingService);
  const alertingService = app.get(AlertingService);
  const alertsService = app.get(AlertsService);
  const prisma = app.get(PrismaService);

  const aiConcurrency = toPositiveInt(process.env.JOBS_CONCURRENCY_AI, 2);
  const webhookConcurrency = toPositiveInt(process.env.JOBS_CONCURRENCY_WEBHOOKS, 5);
  const maintenanceConcurrency = toPositiveInt(process.env.JOBS_CONCURRENCY_MAINT, 1);

  const aiWorker = new Worker(
    QUEUE_NAMES.ai,
    async (job: Job) => {
      if (job.name === "schedule-health") {
        return schedulerService.handleScheduledTick("schedule-health");
      }

      if (job.name === "schedule-insights") {
        return schedulerService.handleScheduledTick("schedule-insights");
      }
      if (job.name === "risk-recompute-nightly") {
        return schedulerService.handleScheduledTick("risk-recompute-nightly");
      }

      if (job.name === "schedule-actions") {
        return schedulerService.handleScheduledTick("schedule-actions");
      }

      if (job.name === "schedule-briefing") {
        return schedulerService.handleScheduledTick("schedule-briefing");
      }

      if (job.name === "schedule-invoice-scan") {
        return schedulerService.handleScheduledTick("schedule-invoice-scan");
      }

      if (job.name === "schedule-uptime") {
        return schedulerService.handleScheduledTick("schedule-uptime");
      }

      if (job.name === "compute-health-score") {
        const orgId = String(job.data.orgId ?? "");
        logger.log(`job=${job.id} queue=ai name=compute-health-score orgId=${orgId}`);
        return schedulerService.runHealthScoreForOrg(orgId);
      }

      if (job.name === "compute-insights") {
        const orgId = String(job.data.orgId ?? "");
        logger.log(`job=${job.id} queue=ai name=compute-insights orgId=${orgId}`);
        return aiService.computeInsights(orgId);
      }
      if (job.name === "graph-risk-recompute") {
        const orgId = String(job.data.orgId ?? "");
        logger.log(`job=${job.id} queue=ai name=graph-risk-recompute orgId=${orgId}`);
        return riskEngineService.computeOrgRisk(orgId, {
          maxNodes:
            typeof job.data.maxNodes === "number"
              ? (job.data.maxNodes as number)
              : undefined
        });
      }

      if (job.name === "compute-actions") {
        const orgId = String(job.data.orgId ?? "");
        logger.log(`job=${job.id} queue=ai name=compute-actions orgId=${orgId}`);
        return aiActionsService.computeActions(orgId);
      }

      if (job.name === "llm-generate-report") {
        const orgId = String(job.data.orgId ?? "");
        const actorUserId = String(job.data.actorUserId ?? "");
        const reportType = String(job.data.reportType ?? "ceo-daily-brief");
        logger.log(`job=${job.id} queue=ai name=llm-generate-report orgId=${orgId}`);
        if (reportType === "score-drop-explain") {
          return llmService.generateScoreDropExplain(orgId, actorUserId);
        }
        const periodDays = Number(job.data.periodDays ?? 7);
        return llmService.generateCeoDailyBrief(orgId, actorUserId, periodDays);
      }

      if (job.name === "invoice-overdue-scan") {
        const orgId = String(job.data.orgId ?? "");
        logger.log(`job=${job.id} queue=ai name=invoice-overdue-scan orgId=${orgId}`);
        return jobsRunService.runInvoiceOverdueScanForOrg(orgId);
      }

      throw new Error(`Unsupported ai job: ${job.name}`);
    },
    {
      connection: redis as never,
      concurrency: aiConcurrency
    }
  );

  const webhookWorker = new Worker(
    QUEUE_NAMES.webhooks,
    async (job: Job) => {
      if (job.name !== "webhook-dispatch") {
        throw new Error(`Unsupported webhooks job: ${job.name}`);
      }
      const payload = job.data as Record<string, unknown>;
      logger.log(
        `job=${job.id} queue=webhooks name=webhook-dispatch orgId=${String(payload.orgId ?? "")}`
      );
      return webhookService.processDispatchJob(payload);
    },
    {
      connection: redis as never,
      concurrency: webhookConcurrency
    }
  );

  const maintenanceWorker = new Worker(
    QUEUE_NAMES.maintenance,
    async (job: Job) => {
      if (job.name === "autopilot-run") {
        logger.log(`job=${job.id} queue=maintenance name=autopilot-run`);
        return jobsRunService.run();
      }

      if (job.name === "retention-run") {
        logger.log(`job=${job.id} queue=maintenance name=retention-run`);
        return jobsRunService.runRetention();
      }

      if (job.name === "retention-run-org") {
        const orgId = String(job.data.orgId ?? "");
        logger.log(`job=${job.id} queue=maintenance name=retention-run-org orgId=${orgId}`);
        return jobsRunService.runRetentionForOrg(orgId);
      }

      if (job.name === "schedule-retention") {
        logger.log(`job=${job.id} queue=maintenance name=schedule-retention`);
        return schedulerService.handleScheduledTick("schedule-retention");
      }

      if (job.name === "schedule-uptime") {
        logger.log(`job=${job.id} queue=maintenance name=schedule-uptime`);
        return schedulerService.handleScheduledTick("schedule-uptime");
      }

      if (job.name === "uptime-scan") {
        logger.log(`job=${job.id} queue=maintenance name=uptime-scan`);
        return statusService.runUptimeScan();
      }

      throw new Error(`Unsupported maintenance job: ${job.name}`);
    },
    {
      connection: redis as never,
      concurrency: maintenanceConcurrency
    }
  );

  const dlqWorker = new Worker(
    QUEUE_NAMES.dlq,
    async (job: Job) => {
      if (job.name !== "record-failed-job") {
        throw new Error(`Unsupported dlq job: ${job.name}`);
      }
      const payload = job.data as Record<string, unknown>;
      const orgIdRaw = typeof payload.orgId === "string" ? payload.orgId : undefined;
      const queue = String(payload.queue ?? "unknown");
      const jobName = String(payload.jobName ?? "unknown");
      const queueJobId = String(payload.jobId ?? "unknown");
      const error = String(payload.error ?? payload.failedReason ?? "unknown");
      const attemptsMade = Number(payload.attemptsMade ?? 0);
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(payload.payload ?? {}))
        .digest("hex");

      await prisma.failedJob.create({
        data: {
          orgId: orgIdRaw,
          queue,
          jobName,
          jobId: queueJobId,
          error,
          attemptsMade,
          payloadHash
        }
      });

      return { stored: true };
    },
    {
      connection: redis as never,
      concurrency: 1
    }
  );

  const alertsWorker = new Worker(
    QUEUE_NAMES.alerts,
    async (job: Job) => {
      if (job.name === "schedule-escalation") {
        return schedulerService.handleScheduledTick("schedule-escalation");
      }
      if (job.name === "alert-escalation-scan") {
        logger.log(`job=${job.id} queue=alerts name=alert-escalation-scan`);
        return alertsService.runEscalationScan();
      }
      if (job.name !== "alert-delivery") {
        throw new Error(`Unsupported alerts job: ${job.name}`);
      }
      logger.log(`job=${job.id} queue=alerts name=alert-delivery orgId=${String(job.data.orgId ?? "")}`);
      return alertRoutingService.processDeliveryJob(job.data as Record<string, unknown>);
    },
    {
      connection: redis as never,
      concurrency: 5
    }
  );

  for (const worker of [aiWorker, webhookWorker, maintenanceWorker, dlqWorker, alertsWorker]) {
    worker.on("failed", (job, error) => {
      logger.error(
        `job=${job?.id ?? "unknown"} queue=${worker.name} failed=${error instanceof Error ? error.message : "unknown"}`
      );
      const orgId =
        job && typeof job.data === "object" && job.data && "orgId" in job.data
          ? String((job.data as Record<string, unknown>).orgId ?? "")
          : "";

      const alertType: "WEBHOOK_FAILURE_SPIKE" | "JOB_FAILURE_SPIKE" =
        worker.name === QUEUE_NAMES.webhooks ? "WEBHOOK_FAILURE_SPIKE" : "JOB_FAILURE_SPIKE";

      if (orgId) {
        void alertingService.recordFailure(alertType, orgId, {
          queue: worker.name,
          jobName: job?.name,
          jobId: job?.id?.toString(),
          endpointId:
            job && typeof job.data === "object" && job.data
              ? typeof (job.data as Record<string, unknown>).endpointId === "string"
                ? ((job.data as Record<string, unknown>).endpointId as string)
                : undefined
              : undefined,
          appInstallId:
            job && typeof job.data === "object" && job.data
              ? typeof (job.data as Record<string, unknown>).appInstallId === "string"
                ? ((job.data as Record<string, unknown>).appInstallId as string)
                : undefined
              : undefined,
          reason: error instanceof Error ? error.message : "unknown",
          attemptsMade: job?.attemptsMade ?? 0
        }).catch(() => undefined);
      }

      if (worker.name === QUEUE_NAMES.dlq) {
        return;
      }

      void getQueue(QUEUE_NAMES.dlq)
        .add(
          "record-failed-job",
          {
            queue: worker.name,
            jobName: job?.name ?? "unknown",
            jobId: job?.id?.toString() ?? "unknown",
            orgId: orgId || undefined,
            error: error instanceof Error ? error.message : "unknown",
            failedReason: job?.failedReason,
            attemptsMade: job?.attemptsMade ?? 0,
            payload: job?.data ?? {}
          },
          {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: false
          }
        )
        .catch(() => undefined);
    });
  }

  // Ensure queues exist eagerly.
  void getQueue(QUEUE_NAMES.ai);
  void getQueue(QUEUE_NAMES.webhooks);
  void getQueue(QUEUE_NAMES.maintenance);
  void getQueue(QUEUE_NAMES.dlq);
  void getQueue(QUEUE_NAMES.alerts);

  return [
    { name: QUEUE_NAMES.ai, worker: aiWorker },
    { name: QUEUE_NAMES.webhooks, worker: webhookWorker },
    { name: QUEUE_NAMES.maintenance, worker: maintenanceWorker },
    { name: QUEUE_NAMES.dlq, worker: dlqWorker },
    { name: QUEUE_NAMES.alerts, worker: alertsWorker }
  ];
}

export async function stopJobWorkers(handles: WorkerHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.worker.close()));
}
