export const ALERT_TYPES = {
  JOB_FAILURE_SPIKE: "JOB_FAILURE_SPIKE",
  WEBHOOK_FAILURE_SPIKE: "WEBHOOK_FAILURE_SPIKE",
  APP_COMMAND_FAILURE_SPIKE: "APP_COMMAND_FAILURE_SPIKE",
  OAUTH_REFRESH_FAILURE: "OAUTH_REFRESH_FAILURE"
} as const;

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

export type AlertSeverity = "MEDIUM" | "HIGH" | "CRITICAL";
export type EscalationStepRoute =
  | "WEBHOOK"
  | "EMAIL"
  | "SLACK"
  | "ONCALL_PRIMARY"
  | "ONCALL_SECONDARY"
  | "ONCALL_PRIMARY_GLOBAL"
  | "ONCALL_PRIMARY_EMAIL"
  | "ONCALL_SECONDARY_EMAIL";
export type EscalationStep = {
  afterMinutes: number;
  routeTo: EscalationStepRoute[];
  minSeverity: AlertSeverity;
};

export interface AlertFailureMeta {
  queue?: string;
  jobName?: string;
  jobId?: string;
  endpointId?: string;
  appInstallId?: string;
  reason?: string;
  [key: string]: unknown;
}

export const DEFAULT_ALERT_RULES: Array<{
  type: AlertType;
  thresholdCount: number;
  windowMinutes: number;
  severity: AlertSeverity;
  autoMitigation?: { action: "DISABLE_WEBHOOK" | "PAUSE_APP_INSTALL" | "OPEN_CIRCUIT" } | null;
}> = [
  {
    type: ALERT_TYPES.JOB_FAILURE_SPIKE,
    thresholdCount: 5,
    windowMinutes: 10,
    severity: "HIGH"
  },
  {
    type: ALERT_TYPES.WEBHOOK_FAILURE_SPIKE,
    thresholdCount: 10,
    windowMinutes: 10,
    severity: "HIGH",
    autoMitigation: { action: "DISABLE_WEBHOOK" }
  },
  {
    type: ALERT_TYPES.APP_COMMAND_FAILURE_SPIKE,
    thresholdCount: 20,
    windowMinutes: 10,
    severity: "CRITICAL",
    autoMitigation: { action: "PAUSE_APP_INSTALL" }
  },
  {
    type: ALERT_TYPES.OAUTH_REFRESH_FAILURE,
    thresholdCount: 5,
    windowMinutes: 60,
    severity: "HIGH",
    autoMitigation: { action: "OPEN_CIRCUIT" }
  }
];

export const DEFAULT_ESCALATION_POLICY_STEPS: EscalationStep[] = [
  {
    afterMinutes: 10,
    routeTo: ["SLACK"],
    minSeverity: "CRITICAL"
  },
  {
    afterMinutes: 30,
    routeTo: ["EMAIL", "WEBHOOK"],
    minSeverity: "HIGH"
  },
  {
    afterMinutes: 180,
    routeTo: ["EMAIL"],
    minSeverity: "MEDIUM"
  }
];
