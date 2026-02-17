import { QueueName } from "./queues";

export type AIQueueJobName =
  | "compute-health-score"
  | "compute-insights"
  | "compute-actions"
  | "llm-generate-report"
  | "invoice-overdue-scan"
  | "schedule-health"
  | "schedule-insights"
  | "schedule-actions"
  | "schedule-briefing"
  | "schedule-invoice-scan";
export type WebhookQueueJobName = "webhook-dispatch";
export type MaintenanceQueueJobName =
  | "retention-run"
  | "autopilot-run"
  | "retention-run-org"
  | "schedule-retention"
  | "uptime-scan"
  | "schedule-uptime";
export type DlqQueueJobName = "record-failed-job";
export type AlertsQueueJobName = "alert-delivery" | "alert-escalation-scan" | "schedule-escalation";

export type JobName =
  | AIQueueJobName
  | WebhookQueueJobName
  | MaintenanceQueueJobName
  | DlqQueueJobName
  | AlertsQueueJobName;

export interface JobEnqueueResult {
  queue: QueueName;
  jobId: string;
  status: "queued";
}
