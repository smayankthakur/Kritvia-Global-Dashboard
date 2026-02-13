import { HealthScoreBreakdown } from "./dto/health-score-response.dto";

export interface HealthScoreMetricInputs {
  overdueWorkPct: number;
  overdueInvoicePct: number;
  staleDealsPct: number;
  hygieneCount: number;
  staleDays: number;
}

export function computeHealthScore(inputs: HealthScoreMetricInputs): {
  score: number;
  breakdown: HealthScoreBreakdown;
} {
  const overdueWorkPenalty = Math.min(40, Math.round(inputs.overdueWorkPct * 40));
  const overdueInvoicePenalty = Math.min(30, Math.round(inputs.overdueInvoicePct * 30));
  const staleDealsPenalty = Math.min(20, Math.round(inputs.staleDealsPct * 20));
  const hygienePenalty = Math.min(10, Math.round((Math.min(inputs.hygieneCount, 50) / 50) * 10));

  const penaltiesTotal =
    overdueWorkPenalty + overdueInvoicePenalty + staleDealsPenalty + hygienePenalty;
  const score = Math.max(0, 100 - penaltiesTotal);

  return {
    score,
    breakdown: {
      overdueWorkPct: inputs.overdueWorkPct,
      overdueInvoicePct: inputs.overdueInvoicePct,
      staleDealsPct: inputs.staleDealsPct,
      hygieneCount: inputs.hygieneCount,
      penalties: {
        overdueWorkPenalty,
        overdueInvoicePenalty,
        staleDealsPenalty,
        hygienePenalty
      },
      thresholds: {
        staleDays: inputs.staleDays
      }
    }
  };
}
