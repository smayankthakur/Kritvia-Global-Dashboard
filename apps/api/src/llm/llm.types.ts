export type LlmReportType =
  | "CEO_DAILY_BRIEF"
  | "SCORE_DROP_EXPLAIN"
  | "ACTIONS_SUMMARY"
  | "BOARD_MEMO";

export interface LlmUsage {
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
}

export interface LlmProviderResult {
  json: unknown;
  text?: string;
  usage?: LlmUsage;
  model?: string;
  provider?: string;
}

export interface CtxRiskItem {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  why: string;
  deepLink: string;
}

export interface CtxActionItem {
  title: string;
  reason: string;
  ownerRole: "CEO" | "OPS" | "SALES" | "FINANCE" | "ADMIN";
  deepLink: string;
}

export interface CeoDailyBriefJson {
  title: string;
  date: string;
  executiveSummary: string;
  topRisks: CtxRiskItem[];
  topOpportunities: Array<{ title: string; why: string; deepLink: string }>;
  recommendedNextActions: CtxActionItem[];
  numbersToWatch: Array<{ label: string; value: string; deltaHint?: string }>;
}

export interface ScoreDropExplainJson {
  headline: string;
  whatChanged: string[];
  likelyDrivers: Array<{ driver: string; evidence: string }>;
  whatToDoNow: Array<{ step: string; deepLink: string }>;
}
