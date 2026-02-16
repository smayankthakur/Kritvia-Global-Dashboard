import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ActivityEntityType, DealStage, InvoiceStatus, Role, WorkItemStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { BillingService } from "../billing/billing.service";
import { PrismaService } from "../prisma/prisma.service";
import { GenericHttpLlmProvider } from "./providers/generic-http.provider";
import { LlmGenerateResult, LlmProvider } from "./providers/provider.interface";
import { MockLlmProvider } from "./providers/mock.provider";
import { CeoDailyBriefJson, LlmReportType, ScoreDropExplainJson } from "./llm.types";

const MAX_CONTEXT_BYTES = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type CeoContextBundle = {
  mode: "ceo-brief" | "score-drop";
  org: { id: string; name: string };
  period: { start: string; end: string; periodDays: number };
  kpis: {
    overdueInvoices: { count: number; amount: number };
    overdueWorkItems: { count: number };
    stalledDeals: { count: number };
    securityCritical: { count: number };
    revenueForecast?: { next30Days: number };
  };
  insights: Array<{
    id: string;
    type: string;
    severity: string;
    scoreImpact: number;
    title: string;
    explanation: string;
  }>;
  actions: {
    stats: {
      proposed: number;
      approved: number;
      executed: number;
      failed: number;
    };
    topExecuted: Array<{
      id: string;
      type: string;
      title: string;
      status: string;
      executedAt: string;
    }>;
  };
};

@Injectable()
export class LlmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly activityLogService: ActivityLogService,
    private readonly mockProvider: MockLlmProvider,
    private readonly genericHttpProvider: GenericHttpLlmProvider
  ) {}

  async generateCeoDailyBrief(orgId: string, actorUserId: string, periodDays: number): Promise<{
    id: string;
    type: string;
    cached: boolean;
    contentJson: CeoDailyBriefJson;
    contentText: string | null;
    createdAt: string;
  }> {
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    this.assertLlmEnabled();

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - periodDays * DAY_MS);
    const context = await this.buildCeoContext(orgId, periodStart, periodEnd, "ceo-brief");

    const result = await this.generateReportFromContext({
      orgId,
      actorUserId,
      type: "CEO_DAILY_BRIEF",
      periodStart,
      periodEnd,
      context,
      validator: (value) => this.validateCeoDailyBrief(value),
      renderer: (value) => this.renderCeoDailyBriefText(value),
      systemPrompt: [
        "You are a grounding-only report engine.",
        "You MUST only use provided JSON context.",
        "If data is missing, say 'Not enough data'.",
        "Do not invent facts, external knowledge, or speculation.",
        "Return valid JSON only matching the schema."
      ].join(" "),
      schema: {
        title: "CEO_DAILY_BRIEF",
        type: "object"
      }
    });

    return {
      ...result,
      contentJson: result.contentJson as CeoDailyBriefJson
    };
  }

  async generateScoreDropExplain(orgId: string, actorUserId: string): Promise<{
    id: string;
    type: string;
    cached: boolean;
    contentJson: ScoreDropExplainJson;
    contentText: string | null;
    createdAt: string;
  }> {
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    this.assertLlmEnabled();

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 7 * DAY_MS);
    const context = await this.buildCeoContext(orgId, periodStart, periodEnd, "score-drop");

    const result = await this.generateReportFromContext({
      orgId,
      actorUserId,
      type: "SCORE_DROP_EXPLAIN",
      periodStart,
      periodEnd,
      context,
      validator: (value) => this.validateScoreDropExplain(value),
      renderer: (value) => this.renderScoreDropText(value),
      systemPrompt: [
        "You are a grounding-only report engine.",
        "You MUST only use provided JSON context.",
        "If data is missing, say 'Not enough data'.",
        "No external knowledge or invented facts.",
        "Return valid JSON only matching the schema."
      ].join(" "),
      schema: {
        title: "SCORE_DROP_EXPLAIN",
        type: "object"
      }
    });

    return {
      ...result,
      contentJson: result.contentJson as ScoreDropExplainJson
    };
  }

  async listReports(orgId: string, input: { type?: LlmReportType; limit?: number }) {
    const limit = input.limit ?? 10;
    const rows = await this.prisma.lLMReport.findMany({
      where: {
        orgId,
        type: input.type
      },
      select: {
        id: true,
        type: true,
        periodStart: true,
        periodEnd: true,
        model: true,
        provider: true,
        tokensIn: true,
        tokensOut: true,
        latencyMs: true,
        contentJson: true,
        contentText: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      periodStart: row.periodStart ? row.periodStart.toISOString() : null,
      periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
      model: row.model,
      provider: row.provider,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      latencyMs: row.latencyMs,
      executiveSummary:
        typeof (row.contentJson as Record<string, unknown>).executiveSummary === "string"
          ? ((row.contentJson as Record<string, unknown>).executiveSummary as string)
          : undefined,
      contentText: row.contentText ? row.contentText.slice(0, 400) : null,
      createdAt: row.createdAt.toISOString()
    }));
  }

  private async generateReportFromContext<T>(input: {
    orgId: string;
    actorUserId: string;
    type: LlmReportType;
    periodStart: Date;
    periodEnd: Date;
    context: CeoContextBundle;
    validator: (value: unknown) => T;
    renderer: (value: T) => string;
    systemPrompt: string;
    schema: Record<string, unknown>;
  }): Promise<{ id: string; type: string; cached: boolean; contentJson: T; contentText: string | null; createdAt: string }> {
    const inputHash = this.sha256Stable(input.context);
    const cached = await this.prisma.lLMReport.findUnique({
      where: {
        orgId_type_inputHash: {
          orgId: input.orgId,
          type: input.type,
          inputHash
        }
      }
    });

    if (cached) {
      return {
        id: cached.id,
        type: cached.type,
        cached: true,
        contentJson: cached.contentJson as T,
        contentText: cached.contentText,
        createdAt: cached.createdAt.toISOString()
      };
    }

    const provider = this.getProvider();
    const startedAt = Date.now();
    const result = await provider.generate({
      system: input.systemPrompt,
      user: [
        "Context JSON and schema follow.",
        "Keep response concise and CEO-actionable.",
        "CONTEXT_JSON:",
        JSON.stringify(input.context),
        "SCHEMA_JSON:",
        JSON.stringify(input.schema)
      ].join("\n"),
      jsonSchema: input.schema,
      maxTokens: 1000,
      temperature: 0.1
    });

    const validOutput = this.safeValidate(result, input.validator);
    const contentText = result.text?.trim().length ? result.text.trim() : input.renderer(validOutput);
    const latencyMs = Date.now() - startedAt;

    const created = await this.prisma.lLMReport.create({
      data: {
        orgId: input.orgId,
        type: input.type,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        inputHash,
        model: result.model ?? process.env.LLM_MODEL ?? null,
        provider: result.provider ?? (process.env.LLM_PROVIDER ?? "mock"),
        contentJson: validOutput as unknown as object,
        contentText,
        tokensIn: result.usage?.tokensIn,
        tokensOut: result.usage?.tokensOut,
        latencyMs
      }
    });

    await this.activityLogService.log({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      entityType: ActivityEntityType.AI_INSIGHT,
      entityId: created.id,
      action: "LLM_REPORT_GENERATED",
      after: {
        type: input.type,
        inputHash
      }
    });

    return {
      id: created.id,
      type: created.type,
      cached: false,
      contentJson: created.contentJson as T,
      contentText: created.contentText,
      createdAt: created.createdAt.toISOString()
    };
  }

  private async buildCeoContext(
    orgId: string,
    periodStart: Date,
    periodEnd: Date,
    mode: "ceo-brief" | "score-drop"
  ): Promise<CeoContextBundle> {
    const [
      org,
      insights,
      proposedCount,
      approvedCount,
      executedCount,
      failedCount,
      topExecuted,
      overdueInvoices,
      overdueWorkItems,
      stalledDeals,
      criticalSecurity,
      openDeals
    ] =
      await this.prisma.$transaction([
        this.prisma.org.findUnique({ where: { id: orgId }, select: { id: true, name: true } }),
        this.prisma.aIInsight.findMany({
          where: { orgId, isResolved: false },
          orderBy: [{ createdAt: "desc" }],
          take: 10,
          select: {
            id: true,
            type: true,
            severity: true,
            scoreImpact: true,
            title: true,
            explanation: true
          }
        }),
        this.prisma.aIAction.count({
          where: {
            orgId,
            status: "PROPOSED",
            createdAt: { gte: new Date(periodEnd.getTime() - 7 * DAY_MS) }
          }
        }),
        this.prisma.aIAction.count({
          where: {
            orgId,
            status: "APPROVED",
            createdAt: { gte: new Date(periodEnd.getTime() - 7 * DAY_MS) }
          }
        }),
        this.prisma.aIAction.count({
          where: {
            orgId,
            status: "EXECUTED",
            createdAt: { gte: new Date(periodEnd.getTime() - 7 * DAY_MS) }
          }
        }),
        this.prisma.aIAction.count({
          where: {
            orgId,
            status: "FAILED",
            createdAt: { gte: new Date(periodEnd.getTime() - 7 * DAY_MS) }
          }
        }),
        this.prisma.aIAction.findMany({
          where: {
            orgId,
            status: "EXECUTED",
            executedAt: { gte: new Date(periodEnd.getTime() - 7 * DAY_MS) }
          },
          select: {
            id: true,
            type: true,
            title: true,
            status: true,
            executedAt: true
          },
          orderBy: [{ executedAt: "desc" }],
          take: 10
        }),
        this.prisma.invoice.aggregate({
          where: {
            orgId,
            status: { not: InvoiceStatus.PAID },
            dueDate: { lt: periodEnd }
          },
          _count: { _all: true },
          _sum: { amount: true }
        }),
        this.prisma.workItem.count({
          where: {
            orgId,
            status: { not: WorkItemStatus.DONE },
            dueDate: { lt: periodEnd }
          }
        }),
        this.prisma.deal.count({
          where: {
            orgId,
            stage: DealStage.OPEN,
            updatedAt: { lt: new Date(periodEnd.getTime() - 14 * DAY_MS) }
          }
        }),
        this.prisma.securityEvent.count({
          where: {
            orgId,
            severity: "CRITICAL",
            resolvedAt: null
          }
        }),
        this.prisma.deal.aggregate({
          where: {
            orgId,
            stage: DealStage.OPEN
          },
          _sum: { valueAmount: true }
        })
      ]);

    if (!org) {
      throw new HttpException({ code: "ORG_NOT_FOUND", message: "Organization not found." }, HttpStatus.NOT_FOUND);
    }

    const bundle: CeoContextBundle = {
      mode,
      org: {
        id: org.id,
        name: org.name
      },
      period: {
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
        periodDays: Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS))
      },
      kpis: {
        overdueInvoices: {
          count: overdueInvoices._count._all,
          amount: Number(overdueInvoices._sum.amount ?? 0)
        },
        overdueWorkItems: {
          count: overdueWorkItems
        },
        stalledDeals: {
          count: stalledDeals
        },
        securityCritical: {
          count: criticalSecurity
        },
        revenueForecast: {
          next30Days: Math.round((openDeals._sum.valueAmount ?? 0) * 0.3)
        }
      },
      insights: insights.map((item) => ({
        id: item.id,
        type: item.type,
        severity: item.severity,
        scoreImpact: item.scoreImpact,
        title: item.title,
        explanation: item.explanation
      })),
      actions: {
        stats: {
          proposed: proposedCount,
          approved: approvedCount,
          executed: executedCount,
          failed: failedCount
        },
        topExecuted: topExecuted
          .filter((item) => !!item.executedAt)
          .map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            status: item.status,
            executedAt: item.executedAt ? item.executedAt.toISOString() : periodEnd.toISOString()
          }))
      }
    };

    return this.enforceContextSize(bundle);
  }

  private enforceContextSize(bundle: CeoContextBundle): CeoContextBundle {
    const next: CeoContextBundle = {
      ...bundle,
      insights: [...bundle.insights],
      actions: {
        ...bundle.actions,
        topExecuted: [...bundle.actions.topExecuted]
      }
    };

    while (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_CONTEXT_BYTES) {
      if (next.insights.length > 3) {
        next.insights.pop();
        continue;
      }
      if (next.actions.topExecuted.length > 3) {
        next.actions.topExecuted.pop();
        continue;
      }
      throw new HttpException(
        {
          code: "LLM_CONTEXT_TOO_LARGE",
          message: "LLM context exceeds allowed size."
        },
        HttpStatus.BAD_REQUEST
      );
    }

    return next;
  }

  private safeValidate<T>(result: LlmGenerateResult, validator: (value: unknown) => T): T {
    try {
      return validator(result.json);
    } catch {
      throw new HttpException(
        {
          code: "LLM_INVALID_OUTPUT",
          message: "Provider returned malformed structured output."
        },
        HttpStatus.BAD_GATEWAY
      );
    }
  }

  private validateCeoDailyBrief(value: unknown): CeoDailyBriefJson {
    const obj = this.asRecord(value);
    const topRisks = this.asArray(obj.topRisks);
    const topOpportunities = this.asArray(obj.topOpportunities);
    const actions = this.asArray(obj.recommendedNextActions);
    const numbers = this.asArray(obj.numbersToWatch);

    const parsed: CeoDailyBriefJson = {
      title: this.asString(obj.title),
      date: this.asString(obj.date),
      executiveSummary: this.asString(obj.executiveSummary).slice(0, 600),
      topRisks: topRisks.map((risk) => {
        const rec = this.asRecord(risk);
        return {
          severity: this.asSeverity(rec.severity),
          title: this.asString(rec.title),
          why: this.asString(rec.why),
          deepLink: this.asString(rec.deepLink)
        };
      }),
      topOpportunities: topOpportunities.map((item) => {
        const rec = this.asRecord(item);
        return {
          title: this.asString(rec.title),
          why: this.asString(rec.why),
          deepLink: this.asString(rec.deepLink)
        };
      }),
      recommendedNextActions: actions.map((item) => {
        const rec = this.asRecord(item);
        return {
          title: this.asString(rec.title),
          reason: this.asString(rec.reason),
          ownerRole: this.asRole(rec.ownerRole),
          deepLink: this.asString(rec.deepLink)
        };
      }),
      numbersToWatch: numbers.map((item) => {
        const rec = this.asRecord(item);
        return {
          label: this.asString(rec.label),
          value: this.asString(rec.value),
          deltaHint: typeof rec.deltaHint === "string" ? rec.deltaHint : undefined
        };
      })
    };

    return parsed;
  }

  private validateScoreDropExplain(value: unknown): ScoreDropExplainJson {
    const obj = this.asRecord(value);
    const whatChanged = this.asArray(obj.whatChanged).map((item) => this.asString(item));
    const likelyDrivers = this.asArray(obj.likelyDrivers).map((item) => {
      const rec = this.asRecord(item);
      return {
        driver: this.asString(rec.driver),
        evidence: this.asString(rec.evidence)
      };
    });
    const whatToDoNow = this.asArray(obj.whatToDoNow).map((item) => {
      const rec = this.asRecord(item);
      return {
        step: this.asString(rec.step),
        deepLink: this.asString(rec.deepLink)
      };
    });

    return {
      headline: this.asString(obj.headline),
      whatChanged,
      likelyDrivers,
      whatToDoNow
    };
  }

  private renderCeoDailyBriefText(report: CeoDailyBriefJson): string {
    const riskLines = report.topRisks
      .map((risk) => `- [${risk.severity}] ${risk.title}: ${risk.why}`)
      .join("\n");
    const actionLines = report.recommendedNextActions
      .map((action) => `- (${action.ownerRole}) ${action.title}: ${action.reason}`)
      .join("\n");

    return [
      `# ${report.title}`,
      "",
      `Date: ${report.date}`,
      "",
      "## Executive Summary",
      report.executiveSummary,
      "",
      "## Top Risks",
      riskLines || "- Not enough data",
      "",
      "## Recommended Next Actions",
      actionLines || "- Not enough data"
    ].join("\n");
  }

  private renderScoreDropText(report: ScoreDropExplainJson): string {
    return [
      `# ${report.headline}`,
      "",
      "## What Changed",
      ...report.whatChanged.map((item) => `- ${item}`),
      "",
      "## Likely Drivers",
      ...report.likelyDrivers.map((item) => `- ${item.driver}: ${item.evidence}`),
      "",
      "## What To Do Now",
      ...report.whatToDoNow.map((item) => `- ${item.step} (${item.deepLink})`)
    ].join("\n");
  }

  private assertLlmEnabled(): void {
    if ((process.env.LLM_ENABLED ?? "false").toLowerCase() !== "true") {
      throw new HttpException(
        {
          code: "LLM_DISABLED",
          message: "LLM reports are disabled."
        },
        HttpStatus.NOT_IMPLEMENTED
      );
    }
  }

  private getProvider(): LlmProvider {
    const key = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();
    if (key === "generic-http") {
      return this.genericHttpProvider;
    }
    return this.mockProvider;
  }

  private sha256Stable(value: unknown): string {
    const stable = JSON.stringify(this.sortObject(value));
    return createHash("sha256").update(stable).digest("hex");
  }

  private sortObject(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortObject(item));
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = this.sortObject(record[key]);
          return acc;
        }, {});
    }
    return value;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected object");
    }
    return value as Record<string, unknown>;
  }

  private asArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
      throw new Error("Expected array");
    }
    return value;
  }

  private asString(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Expected non-empty string");
    }
    return value.trim();
  }

  private asSeverity(value: unknown): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
    if (value === "CRITICAL" || value === "HIGH" || value === "MEDIUM" || value === "LOW") {
      return value;
    }
    throw new Error("Invalid severity");
  }

  private asRole(value: unknown): Role {
    if (
      value === Role.CEO ||
      value === Role.ADMIN ||
      value === Role.OPS ||
      value === Role.SALES ||
      value === Role.FINANCE
    ) {
      return value;
    }
    throw new Error("Invalid role");
  }
}
