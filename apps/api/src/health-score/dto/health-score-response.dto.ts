export interface HealthScoreBreakdown {
  overdueWorkPct: number;
  overdueInvoicePct: number;
  staleDealsPct: number;
  hygieneCount: number;
  penalties: {
    overdueWorkPenalty: number;
    overdueInvoicePenalty: number;
    staleDealsPenalty: number;
    hygienePenalty: number;
  };
  thresholds: {
    staleDays: number;
  };
}

export interface HealthScoreResponseDto {
  score: number;
  breakdown: HealthScoreBreakdown;
  computedAt: string;
  dateKey: string;
  trend: {
    yesterdayScore?: number;
    delta?: number;
  };
}
