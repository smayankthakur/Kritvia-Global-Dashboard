export type DealTimelineMilestoneType =
  | "LEAD_CREATED"
  | "DEAL_CREATED"
  | "WORK_ROOT_CREATED"
  | "INVOICE_SENT"
  | "INVOICE_PAID";

export interface DealTimelineMilestoneDto {
  type: DealTimelineMilestoneType;
  timestamp: string;
  durationFromPreviousHours: number | null;
  isBottleneck: boolean;
}

export interface DealTimelineResponseDto {
  dealId: string;
  policyThresholdHours: number;
  totalCycleHours: number | null;
  milestones: DealTimelineMilestoneDto[];
}

