const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PipelineAgingBucket = "0_7" | "8_14" | "15_30" | "30_plus";
export type PipelineStageBand = "early" | "mid" | "late";

export function roundTo(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

export function safePct(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return roundTo((part / total) * 100, 1);
}

export function bucketizeDealAge(createdAt: Date, now: Date): PipelineAgingBucket {
  const ageDays = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY));
  if (ageDays <= 7) {
    return "0_7";
  }
  if (ageDays <= 14) {
    return "8_14";
  }
  if (ageDays <= 30) {
    return "15_30";
  }
  return "30_plus";
}

export function averageCloseDays(
  deals: Array<{
    createdAt: Date;
    wonAt: Date | null;
  }>
): number {
  const durations = deals
    .filter((deal) => deal.wonAt)
    .map((deal) => Math.max(0, (deal.wonAt as Date).getTime() - deal.createdAt.getTime()) / MS_PER_DAY);

  if (durations.length === 0) {
    return 0;
  }

  const total = durations.reduce((sum, value) => sum + value, 0);
  return roundTo(total / durations.length, 1);
}

export function averagePaymentDelayDays(
  invoices: Array<{
    sentAt: Date | null;
    paidAt: Date | null;
  }>
): number {
  const durations = invoices
    .filter((invoice) => invoice.sentAt && invoice.paidAt)
    .map(
      (invoice) =>
        Math.max(0, (invoice.paidAt as Date).getTime() - (invoice.sentAt as Date).getTime()) / MS_PER_DAY
    );

  if (durations.length === 0) {
    return 0;
  }

  const total = durations.reduce((sum, value) => sum + value, 0);
  return roundTo(total / durations.length, 1);
}

export function stageProbability(stage: string): number {
  const normalized = stage.trim().toLowerCase();
  if (
    normalized.includes("proposal") ||
    normalized.includes("negotiation") ||
    normalized.includes("closing") ||
    normalized.includes("won")
  ) {
    return 0.7;
  }
  if (normalized.includes("qualified") || normalized.includes("discovery") || normalized.includes("open")) {
    return 0.4;
  }
  return 0.2;
}

export function computePipelineWeightedForecast(
  openDeals: Array<{
    valueAmount: number;
    stage: string;
    expectedCloseDate: Date | null;
  }>,
  now: Date
): {
  pipelineWeighted30: number;
  pipelineWeighted60: number;
} {
  const day30 = new Date(now.getTime() + 30 * MS_PER_DAY);
  const day60 = new Date(now.getTime() + 60 * MS_PER_DAY);
  let pipelineWeighted30 = 0;
  let pipelineWeighted60 = 0;

  for (const deal of openDeals) {
    const probability = stageProbability(deal.stage);
    const weightedValue = Math.max(0, deal.valueAmount) * probability;

    if (deal.expectedCloseDate) {
      if (deal.expectedCloseDate <= day30) {
        pipelineWeighted30 += weightedValue;
      }
      if (deal.expectedCloseDate <= day60) {
        pipelineWeighted60 += weightedValue;
      }
      continue;
    }

    pipelineWeighted30 += weightedValue * 0.3;
    pipelineWeighted60 += weightedValue * 0.6;
  }

  return {
    pipelineWeighted30: Math.round(pipelineWeighted30),
    pipelineWeighted60: Math.round(pipelineWeighted60)
  };
}

