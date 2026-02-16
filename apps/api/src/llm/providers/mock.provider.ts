import { Injectable } from "@nestjs/common";
import { LlmProvider, LlmGenerateArgs, LlmGenerateResult } from "./provider.interface";

@Injectable()
export class MockLlmProvider implements LlmProvider {
  async generate(args: LlmGenerateArgs): Promise<LlmGenerateResult> {
    const mode = (process.env.LLM_MOCK_MODE ?? "valid").toLowerCase();
    if (mode === "invalid") {
      return {
        json: {
          bad: true
        },
        text: "invalid"
      };
    }

    const context = this.extractContext(args.user);
    const insights = this.readArray(context, "insights");
    const kpis = this.readRecord(context, "kpis");
    const overdueInvoices = this.readRecord(kpis, "overdueInvoices");
    const overdueWork = this.readRecord(kpis, "overdueWorkItems");
    const now = new Date().toISOString().slice(0, 10);

    const topRisk = insights[0] ?? null;
    const numbers = [
      {
        label: "Overdue invoices",
        value: String(this.readNumber(overdueInvoices, "count")),
        deltaHint: "7-day view"
      },
      {
        label: "Overdue work",
        value: String(this.readNumber(overdueWork, "count"))
      }
    ];

    const brief = {
      title: "CEO Daily Brief",
      date: now,
      executiveSummary:
        this.truncate(
          `Execution risks remain concentrated in invoices (${this.readNumber(overdueInvoices, "count")}) and overdue work (${this.readNumber(overdueWork, "count")}).`,
          600
        ),
      topRisks: topRisk
        ? [
            {
              severity: this.readSeverity(topRisk, "severity"),
              title: this.readString(topRisk, "title"),
              why: this.readString(topRisk, "explanation"),
              deepLink: this.mapInsightLink(this.readString(topRisk, "type"))
            }
          ]
        : [
            {
              severity: "LOW",
              title: "Not enough data",
              why: "Not enough data.",
              deepLink: "/ceo/action-mode"
            }
          ],
      topOpportunities: [
        {
          title: "Approve top AI actions",
          why: "Reduce execution lag by closing highest impact proposed actions.",
          deepLink: "/ceo/action-mode"
        }
      ],
      recommendedNextActions: [
        {
          title: "Clear overdue execution queue",
          reason: "Prioritize overdue work and assign owners.",
          ownerRole: "OPS",
          deepLink: "/ops/work/list?due=overdue"
        },
        {
          title: "Escalate delayed receivables",
          reason: "Overdue invoices are blocking near-term cashflow.",
          ownerRole: "FINANCE",
          deepLink: "/finance/invoices?status=SENT"
        }
      ],
      numbersToWatch: numbers
    };

    if (String(this.readString(context, "mode")) === "score-drop") {
      return {
        json: {
          headline: "Execution score declined",
          whatChanged: ["Overdue work and invoice aging increased."],
          likelyDrivers: [
            {
              driver: "Overdue work growth",
              evidence: `Overdue work count is ${this.readNumber(overdueWork, "count")}.`
            }
          ],
          whatToDoNow: [
            {
              step: "Review top blockers in Action Mode",
              deepLink: "/ceo/action-mode"
            }
          ]
        },
        text: "Execution score declined because overdue work and invoice aging increased.",
        usage: {
          tokensIn: 250,
          tokensOut: 140
        },
        model: process.env.LLM_MODEL || "mock-model",
        provider: "mock"
      };
    }

    return {
      json: brief,
      text: this.renderBriefText(brief),
      usage: {
        tokensIn: 320,
        tokensOut: 180
      },
      model: process.env.LLM_MODEL || "mock-model",
      provider: "mock"
    };
  }

  private extractContext(userPrompt: string): Record<string, unknown> {
    const marker = "CONTEXT_JSON:";
    const markerIndex = userPrompt.indexOf(marker);
    if (markerIndex === -1) {
      return {};
    }
    const jsonText = userPrompt.slice(markerIndex + marker.length).trim();
    try {
      return JSON.parse(jsonText);
    } catch {
      return {};
    }
  }

  private readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private readArray(source: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
    const value = source[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<
      Record<string, unknown>
    >;
  }

  private readNumber(source: Record<string, unknown>, key: string): number {
    const value = source[key];
    return typeof value === "number" ? value : 0;
  }

  private readString(source: Record<string, unknown>, key: string): string {
    const value = source[key];
    return typeof value === "string" ? value : "";
  }

  private readSeverity(
    source: Record<string, unknown>,
    key: string
  ): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
    const value = source[key];
    if (value === "CRITICAL" || value === "HIGH" || value === "MEDIUM" || value === "LOW") {
      return value;
    }
    return "LOW";
  }

  private mapInsightLink(type: string): string {
    if (type === "DEAL_STALL") return "/sales/deals?filter=stale";
    if (type === "CASHFLOW_ALERT") return "/finance/invoices?filter=overdue";
    if (type === "OPS_RISK") return "/ops/work/list?due=overdue";
    if (type === "SHIELD_RISK") return "/shield";
    if (type === "HEALTH_DROP") return "/ceo/action-mode";
    return "/ceo/action-mode";
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max - 3)}...`;
  }

  private renderBriefText(brief: {
    title: string;
    executiveSummary: string;
    topRisks: Array<{ title: string; why: string }>;
    recommendedNextActions: Array<{ title: string; reason: string }>;
  }): string {
    const risks = brief.topRisks.map((risk) => `- ${risk.title}: ${risk.why}`).join("\n");
    const actions = brief.recommendedNextActions
      .map((action) => `- ${action.title}: ${action.reason}`)
      .join("\n");

    return `${brief.title}\n\nSummary: ${brief.executiveSummary}\n\nTop Risks:\n${risks}\n\nNext Actions:\n${actions}`;
  }
}
