export interface InsightSummaryResponse {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface InsightListItem {
  id: string;
  type: string;
  severity: string;
  scoreImpact: number;
  title: string;
  explanation: string;
  entityType: string | null;
  entityId: string | null;
  meta: unknown;
  isResolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
}
