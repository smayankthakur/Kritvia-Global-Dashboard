export type AIActionType = "CREATE_NUDGE" | "CREATE_WORK_ITEM" | "LOCK_INVOICE" | "REASSIGN_WORK";
export type AIActionStatus = "PROPOSED" | "APPROVED" | "EXECUTED" | "FAILED" | "CANCELED";

export interface ComputeActionsResponse {
  created: number;
  skipped: number;
  totalProposed: number;
}
