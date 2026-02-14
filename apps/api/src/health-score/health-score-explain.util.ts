import { HealthScoreBreakdown } from "./dto/health-score-response.dto";
import { HealthScoreDriver } from "./dto/health-score-explain-response.dto";

interface DriverDefinition {
  key: HealthScoreDriver["key"];
  title: string;
  deepLink: string;
  metricLabel: string;
  metricSelector: (value: HealthScoreBreakdown) => number;
  penaltySelector: (value: HealthScoreBreakdown) => number;
}

const driverDefinitions: DriverDefinition[] = [
  {
    key: "OVERDUE_WORK",
    title: "Overdue Work",
    deepLink: "/ops/work/list?due=overdue",
    metricLabel: "overdue work %",
    metricSelector: (value) => value.overdueWorkPct,
    penaltySelector: (value) => value.penalties.overdueWorkPenalty
  },
  {
    key: "INVOICE_AGING",
    title: "Invoice Aging",
    deepLink: "/finance/invoices?status=OVERDUE",
    metricLabel: "overdue invoice %",
    metricSelector: (value) => value.overdueInvoicePct,
    penaltySelector: (value) => value.penalties.overdueInvoicePenalty
  },
  {
    key: "STALE_DEALS",
    title: "Stale Deals",
    deepLink: "/sales/deals",
    metricLabel: "stale deals %",
    metricSelector: (value) => value.staleDealsPct,
    penaltySelector: (value) => value.penalties.staleDealsPenalty
  },
  {
    key: "HYGIENE",
    title: "Hygiene Backlog",
    deepLink: "/ops/hygiene",
    metricLabel: "hygiene count",
    metricSelector: (value) => value.hygieneCount,
    penaltySelector: (value) => value.penalties.hygienePenalty
  }
];

function formatMetric(metric: number, key: HealthScoreDriver["key"]): string {
  if (key === "HYGIENE") {
    return String(metric);
  }
  return `${(metric * 100).toFixed(1)}%`;
}

export function explainHealthScoreDelta(
  previous: HealthScoreBreakdown,
  target: HealthScoreBreakdown
): HealthScoreDriver[] {
  const drivers = driverDefinitions
    .map((definition) => {
      const beforeMetric = definition.metricSelector(previous);
      const afterMetric = definition.metricSelector(target);
      const beforePenalty = definition.penaltySelector(previous);
      const afterPenalty = definition.penaltySelector(target);
      const impactPoints = afterPenalty - beforePenalty;

      if (impactPoints <= 0) {
        return null;
      }

      return {
        key: definition.key,
        title: definition.title,
        summary: `${definition.metricLabel} worsened from ${formatMetric(beforeMetric, definition.key)} to ${formatMetric(afterMetric, definition.key)}.`,
        impactPoints,
        before: {
          metricValue: beforeMetric,
          penalty: beforePenalty
        },
        after: {
          metricValue: afterMetric,
          penalty: afterPenalty
        },
        deepLink: definition.deepLink
      } satisfies HealthScoreDriver;
    })
    .filter((value): value is HealthScoreDriver => value !== null);

  return drivers.sort((left, right) => right.impactPoints - left.impactPoints);
}
