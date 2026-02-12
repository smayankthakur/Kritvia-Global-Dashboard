export type Role = "CEO" | "OPS" | "SALES" | "FINANCE" | "ADMIN";
export type LeadStage = "NEW" | "QUALIFIED" | "DISQUALIFIED";
export type DealStage = "OPEN" | "WON" | "LOST";
export type WorkItemStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type InvoiceStatus = "DRAFT" | "SENT" | "PAID" | "OVERDUE";

export interface AuthMeResponse {
  id: string;
  name: string;
  email: string;
  role: Role;
  orgId: string;
}
