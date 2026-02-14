import { HealthScoreBreakdown } from "./health-score-response.dto";

export type HealthScoreDriverKey = "OVERDUE_WORK" | "INVOICE_AGING" | "STALE_DEALS" | "HYGIENE";

export interface HealthScoreDriver {
  key: HealthScoreDriverKey;
  title: string;
  summary: string;
  impactPoints: number;
  before: {
    metricValue: number;
    penalty: number;
  };
  after: {
    metricValue: number;
    penalty: number;
  };
  deepLink: string;
}

export interface HealthScoreExplainResponseDto {
  dateKey: string;
  todayScore: number;
  yesterdayScore: number;
  delta: number;
  drivers: HealthScoreDriver[];
  notes: string[];
  breakdown: {
    today: HealthScoreBreakdown;
    yesterday: HealthScoreBreakdown;
  };
}
