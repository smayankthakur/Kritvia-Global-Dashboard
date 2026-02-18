import { Injectable, Logger } from "@nestjs/common";
import { HealthScoreService } from "../health-score/health-score.service";
import { assertFeatureEnabled, isFeatureEnabled } from "../common/feature-flags";
import { JobService } from "../jobs/job.service";
import { QueueName, QUEUE_NAMES, getQueue } from "../jobs/queues";
import { parseBool, safeGetRedis } from "../jobs/redis";
import { PrismaService } from "../prisma/prisma.service";

type ProcessMode = "api" | "worker";
type SchedulerJobName =
  | "schedule-health"
  | "risk-recompute-nightly"
  | "schedule-insights"
  | "schedule-actions"
  | "schedule-briefing"
  | "schedule-invoice-scan"
  | "schedule-retention"
  | "schedule-escalation"
  | "schedule-uptime";

type ScheduleDefinition = {
  name: SchedulerJobName;
  queue: QueueName;
  cron: string;
  enabled: boolean;
};

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly repeatableNames: SchedulerJobName[] = [
    "schedule-health",
    "risk-recompute-nightly",
    "schedule-insights",
    "schedule-actions",
    "schedule-briefing",
    "schedule-invoice-scan",
    "schedule-retention",
    "schedule-escalation",
    "schedule-uptime"
  ];
  private processMode: ProcessMode = "api";
  private started = false;

  constructor(
    private readonly jobService: JobService,
    private readonly prisma: PrismaService,
    private readonly healthScoreService: HealthScoreService
  ) {}

  async start(mode: ProcessMode): Promise<void> {
    this.processMode = mode;
    if (!this.shouldRunInCurrentProcess()) {
      this.logger.log(
        `Scheduler disabled for this process mode (mode=${mode}, configured=${process.env.SCHEDULER_MODE ?? "api"}).`
      );
      return;
    }
    if (this.started) {
      return;
    }
    try {
      await this.reload();
    } catch (error) {
      this.logger.warn(
        `Scheduler startup skipped due to queue connectivity issue: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      return;
    }
    this.started = true;
  }

  async reload() {
    if (!this.shouldRunInCurrentProcess()) {
      return { enabled: false, mode: this.processMode, jobs: [] as string[] };
    }

    const schedules = this.getSchedules();
    const queues = [getQueue(QUEUE_NAMES.ai), getQueue(QUEUE_NAMES.maintenance), getQueue(QUEUE_NAMES.alerts)];
    for (const queue of queues) {
      const repeatables = await queue.getRepeatableJobs();
      for (const repeatable of repeatables) {
        if (this.repeatableNames.includes(repeatable.name as SchedulerJobName)) {
          await queue.removeRepeatableByKey(repeatable.key);
        }
      }
    }

    const registered: string[] = [];
    for (const schedule of schedules) {
      if (!schedule.enabled || !schedule.cron.trim()) {
        continue;
      }
      const queue = getQueue(schedule.queue);
      await queue.add(
        schedule.name,
        { source: "scheduler", name: schedule.name },
        {
          jobId: `repeat:${schedule.name}`,
          repeat: {
            pattern: schedule.cron,
            tz: process.env.SCHED_TZ ?? "UTC"
          }
        }
      );
      registered.push(`${schedule.queue}:${schedule.name}`);
    }
    return { enabled: true, mode: this.processMode, jobs: registered };
  }

  async status() {
    const aiRepeatables = await getQueue(QUEUE_NAMES.ai).getRepeatableJobs();
    const maintenanceRepeatables = await getQueue(QUEUE_NAMES.maintenance).getRepeatableJobs();
    const items = [...aiRepeatables, ...maintenanceRepeatables]
      .filter((item) => this.repeatableNames.includes(item.name as SchedulerJobName))
      .map((item) => ({
        name: item.name,
        key: item.key,
        next: item.next,
        pattern: item.pattern
      }));

    return {
      enabled: this.shouldRunInCurrentProcess(),
      processMode: this.processMode,
      timezone: process.env.SCHED_TZ ?? "UTC",
      items
    };
  }

  async runOnce(name: string, orgId: string) {
    if (name === "health") {
      return this.jobService.runNow(QUEUE_NAMES.ai, "compute-health-score", { orgId });
    }
    if (name === "risk") {
      assertFeatureEnabled("FEATURE_RISK_ENGINE");
      return this.jobService.runNow(QUEUE_NAMES.ai, "graph-risk-recompute", { orgId });
    }
    if (name === "insights") {
      return this.jobService.runNow(QUEUE_NAMES.ai, "compute-insights", { orgId });
    }
    if (name === "actions") {
      return this.jobService.runNow(QUEUE_NAMES.ai, "compute-actions", { orgId });
    }
    if (name === "briefing") {
      return this.jobService.runNow(QUEUE_NAMES.ai, "llm-generate-report", {
        orgId,
        actorUserId: await this.resolveActorUserId(orgId),
        reportType: "ceo-daily-brief",
        periodDays: 7
      });
    }
    if (name === "invoice-scan") {
      return this.jobService.runNow(QUEUE_NAMES.ai, "invoice-overdue-scan", { orgId });
    }
    if (name === "retention") {
      return this.jobService.runNow(QUEUE_NAMES.maintenance, "retention-run-org", { orgId });
    }
    if (name === "escalation") {
      return this.jobService.runNow(QUEUE_NAMES.alerts, "alert-escalation-scan", { orgId });
    }
    if (name === "uptime") {
      return this.jobService.runNow(QUEUE_NAMES.maintenance, "uptime-scan", { orgId });
    }
    throw new Error(`Unsupported run-once job name: ${name}`);
  }

  async handleScheduledTick(jobName: SchedulerJobName): Promise<{
    job: SchedulerJobName;
    orgsEnqueued: number;
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const maxOrgs = toPositiveInt(process.env.SCHED_MAX_ORGS_PER_RUN, 200);
    const orgs = await this.prisma.org.findMany({
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: maxOrgs
    });

    let enqueued = 0;
    if (jobName === "schedule-health") {
      for (const org of orgs) {
        await this.jobService.enqueue(QUEUE_NAMES.ai, "compute-health-score", { orgId: org.id });
        enqueued += 1;
      }
    } else if (jobName === "risk-recompute-nightly") {
      if (isFeatureEnabled("FEATURE_RISK_ENGINE")) {
        for (const org of orgs) {
          await this.jobService.enqueue(QUEUE_NAMES.ai, "graph-risk-recompute", { orgId: org.id });
          enqueued += 1;
        }
      }
    } else if (jobName === "schedule-insights") {
      if (this.isFeatureAiEnabled()) {
        for (const org of orgs) {
          await this.jobService.enqueue(QUEUE_NAMES.ai, "compute-insights", { orgId: org.id });
          enqueued += 1;
        }
      }
    } else if (jobName === "schedule-actions") {
      if (this.isFeatureAiEnabled()) {
        for (const org of orgs) {
          await this.jobService.enqueue(QUEUE_NAMES.ai, "compute-actions", { orgId: org.id });
          enqueued += 1;
        }
      }
    } else if (jobName === "schedule-briefing") {
      if (this.isFeatureAiEnabled() && this.isLlmEnabled()) {
        for (const org of orgs) {
          const actorUserId = await this.resolveActorUserId(org.id);
          if (!actorUserId) {
            continue;
          }
          await this.jobService.enqueue(QUEUE_NAMES.ai, "llm-generate-report", {
            orgId: org.id,
            actorUserId,
            reportType: "ceo-daily-brief",
            periodDays: 7
          });
          enqueued += 1;
        }
      }
    } else if (jobName === "schedule-invoice-scan") {
      for (const org of orgs) {
        await this.jobService.enqueue(QUEUE_NAMES.ai, "invoice-overdue-scan", { orgId: org.id });
        enqueued += 1;
      }
    } else if (jobName === "schedule-retention") {
      for (const org of orgs) {
        await this.jobService.enqueue(QUEUE_NAMES.maintenance, "retention-run-org", { orgId: org.id });
        enqueued += 1;
      }
    } else if (jobName === "schedule-escalation") {
      await this.jobService.enqueue(QUEUE_NAMES.alerts, "alert-escalation-scan", {
        source: "scheduler"
      });
      enqueued = orgs.length;
    } else if (jobName === "schedule-uptime") {
      await this.jobService.enqueue(QUEUE_NAMES.maintenance, "uptime-scan", { source: "scheduler" });
      enqueued = 1;
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      JSON.stringify({
        event: "scheduler_tick",
        job: jobName,
        orgsEnqueued: enqueued,
        durationMs
      })
    );
    return { job: jobName, orgsEnqueued: enqueued, durationMs };
  }

  async runHealthScoreForOrg(orgId: string) {
    return this.healthScoreService.computeForOrg(orgId);
  }

  private getSchedules(): ScheduleDefinition[] {
    return [
      {
        name: "schedule-health",
        queue: QUEUE_NAMES.ai,
        cron: process.env.SCHED_HEALTH_CRON ?? "0 2 * * *",
        enabled: true
      },
      {
        name: "risk-recompute-nightly",
        queue: QUEUE_NAMES.ai,
        cron: process.env.SCHED_RISK_CRON ?? "0 2 * * *",
        enabled: isFeatureEnabled("FEATURE_RISK_ENGINE")
      },
      {
        name: "schedule-insights",
        queue: QUEUE_NAMES.ai,
        cron: process.env.SCHED_INSIGHTS_CRON ?? "10 2 * * *",
        enabled: this.isFeatureAiEnabled()
      },
      {
        name: "schedule-actions",
        queue: QUEUE_NAMES.ai,
        cron: process.env.SCHED_ACTIONS_CRON ?? "20 2 * * *",
        enabled: this.isFeatureAiEnabled()
      },
      {
        name: "schedule-briefing",
        queue: QUEUE_NAMES.ai,
        cron: process.env.SCHED_BRIEFING_CRON ?? "30 6 * * *",
        enabled: this.isFeatureAiEnabled() && this.isLlmEnabled()
      },
      {
        name: "schedule-invoice-scan",
        queue: QUEUE_NAMES.ai,
        cron: process.env.SCHED_INVOICE_SCAN_CRON ?? "0 * * * *",
        enabled: true
      },
      {
        name: "schedule-retention",
        queue: QUEUE_NAMES.maintenance,
        cron: process.env.SCHED_RETENTION_CRON ?? "0 3 * * 0",
        enabled: true
      },
      {
        name: "schedule-escalation",
        queue: QUEUE_NAMES.alerts,
        cron: process.env.SCHED_ESCALATION_SCAN_CRON ?? "*/5 * * * *",
        enabled: true
      },
      {
        name: "schedule-uptime",
        queue: QUEUE_NAMES.maintenance,
        cron: process.env.SCHED_UPTIME_CRON ?? "*/5 * * * *",
        enabled: true
      }
    ];
  }

  private isFeatureAiEnabled(): boolean {
    return (process.env.FEATURE_AI_ENABLED ?? "true").toLowerCase() === "true";
  }

  private isLlmEnabled(): boolean {
    return (process.env.LLM_ENABLED ?? "false").toLowerCase() === "true";
  }

  private shouldRunInCurrentProcess(): boolean {
    const jobsEnabled = parseBool(process.env.JOBS_ENABLED, true);
    if (!jobsEnabled) {
      return false;
    }
    if (!safeGetRedis()) {
      return false;
    }
    const enabled = parseBool(process.env.SCHEDULER_ENABLED, true);
    if (!enabled) {
      return false;
    }
    const configuredMode = (process.env.SCHEDULER_MODE ?? "worker").toLowerCase();
    return configuredMode === this.processMode;
  }

  private async resolveActorUserId(orgId: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        orgId,
        isActive: true
      },
      orderBy: [{ role: "desc" }, { createdAt: "asc" }],
      select: { id: true }
    });
    return user?.id ?? null;
  }
}
