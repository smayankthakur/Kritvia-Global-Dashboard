import {
  AuthMeResponse,
  DealStage,
  InvoiceStatus,
  LeadStage,
  Role,
  WorkItemStatus
} from "../types/auth";
import { clearAccessToken, getAccessToken, setAccessToken } from "./auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:4000" : "");
const REQUEST_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS ?? 10000);

export class ApiError extends Error {
  status: number;
  code?: string;
  upgradeUrl?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (code === "UPGRADE_REQUIRED") {
      this.upgradeUrl = "/billing";
    }
  }
}

async function parseResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    let message = fallbackMessage;
    let code: string | undefined;
    try {
      const json = (await response.json()) as {
        message?: string | string[];
        error?: { message?: string; code?: string };
      };
      if (Array.isArray(json.message)) {
        message = json.message.join(", ");
      } else if (json.message) {
        message = json.message;
      } else if (json.error?.message) {
        message = json.error.message;
      }
      code = json.error?.code;
    } catch {
      // ignore JSON parse error
    }

    if (code === "UPGRADE_REQUIRED" && typeof window !== "undefined") {
      const upgradeMessage = `${message} Open /billing to upgrade.`;
      window.alert(upgradeMessage);
      message = upgradeMessage;
    }

    throw new ApiError(message, response.status, code);
  }

  return response.json() as Promise<T>;
}

let refreshPromise: Promise<string> | null = null;

function normalizeHeaders(headers?: HeadersInit): Headers {
  return new Headers(headers ?? {});
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function request(input: string, init?: RequestInit): Promise<Response> {
  if (!API_BASE_URL) {
    throw new ApiError(
      "API base URL is not configured. Set NEXT_PUBLIC_API_BASE_URL in your deployment.",
      0
    );
  }

  try {
    const response = await fetchWithTimeout(input, {
      ...init,
      credentials: "include"
    });

    const headers = normalizeHeaders(init?.headers);
    const hasAuthHeader = headers.has("Authorization");

    if (response.status === 401 && hasAuthHeader) {
      const refreshedAccessToken = await refreshAccessToken().catch(() => null);
      if (!refreshedAccessToken) {
        clearAccessToken();
        return response;
      }

      headers.set("Authorization", `Bearer ${refreshedAccessToken}`);
      return fetchWithTimeout(input, {
        ...init,
        headers,
        credentials: "include"
      });
    }

    return response;
  } catch (error) {
    const message =
      error instanceof Error
        ? `Cannot reach API at ${API_BASE_URL}. Ensure the deployed API URL is correct and reachable.`
        : "Network request failed";
    throw new ApiError(message, 0);
  }
}

function authHeaders(token?: string): Record<string, string> {
  const effectiveToken = token ?? getAccessToken();
  if (!effectiveToken) {
    throw new ApiError("Unauthorized", 401);
  }
  return {
    Authorization: `Bearer ${effectiveToken}`,
    "Content-Type": "application/json"
  };
}

export async function loginRequest(
  email: string,
  password: string
): Promise<{ accessToken: string }> {
  const response = await request(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  return parseResponse(response, "Invalid email or password");
}

export async function refreshAccessToken(): Promise<string> {
  if (!API_BASE_URL) {
    throw new ApiError(
      "API base URL is not configured. Set NEXT_PUBLIC_API_BASE_URL in your deployment.",
      0
    );
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetchWithTimeout(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include"
      });
      const payload = await parseResponse<{ accessToken: string }>(response, "Session expired");
      setAccessToken(payload.accessToken);
      return payload.accessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

export async function logoutRequest(): Promise<void> {
  await request(`${API_BASE_URL}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  clearAccessToken();
}

export async function meRequest(token?: string): Promise<AuthMeResponse> {
  const response = await request(`${API_BASE_URL}/auth/me`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Unauthorized");
}

export async function switchOrgRequest(
  token: string,
  orgId: string
): Promise<{ accessToken: string }> {
  const response = await request(`${API_BASE_URL}/auth/switch-org`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ orgId })
  });

  return parseResponse(response, "Failed to switch organization");
}

export interface Company {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  ownerUserId: string | null;
  createdAt: string;
  owner?: { id: string; name: string; email: string } | null;
}

export interface Contact {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  ownerUserId: string | null;
  createdAt: string;
}

export interface Lead {
  id: string;
  title: string;
  stage: LeadStage;
  source: string | null;
  notes: string | null;
  companyId: string | null;
  contactId: string | null;
  ownerUserId: string | null;
  createdAt: string;
  company?: { id: string; name: string } | null;
  owner?: { id: string; name: string } | null;
}

export interface Deal {
  id: string;
  title: string;
  stage: DealStage;
  valueAmount: number;
  currency: string;
  expectedCloseDate: string | null;
  wonAt: string | null;
  companyId: string;
  ownerUserId: string | null;
  createdAt: string;
  company?: { id: string; name: string } | null;
  owner?: { id: string; name: string } | null;
}

export type DealTimelineMilestoneType =
  | "LEAD_CREATED"
  | "DEAL_CREATED"
  | "WORK_ROOT_CREATED"
  | "INVOICE_SENT"
  | "INVOICE_PAID";

export interface DealTimelineMilestone {
  type: DealTimelineMilestoneType;
  timestamp: string;
  durationFromPreviousHours: number | null;
  isBottleneck: boolean;
}

export interface DealTimelineResponse {
  dealId: string;
  policyThresholdHours: number;
  totalCycleHours: number | null;
  milestones: DealTimelineMilestone[];
}

export interface WorkItem {
  id: string;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: number;
  dueDate: string | null;
  assignedToUserId: string | null;
  createdByUserId: string;
  companyId: string | null;
  dealId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  assignedToUser?: { id: string; name: string; email: string } | null;
  createdByUser?: { id: string; name: string; email: string } | null;
  company?: { id: string; name: string } | null;
  deal?: { id: string; title: string; stage: DealStage } | null;
}

export interface WorkItemActivity {
  id: string;
  action: string;
  createdAt: string;
  beforeJson: unknown;
  afterJson: unknown;
  actorUser?: { id: string; name: string; email: string } | null;
}

export interface Invoice {
  id: string;
  invoiceNumber: string | null;
  companyId: string;
  dealId: string | null;
  status: InvoiceStatus;
  effectiveStatus: InvoiceStatus;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  lockedAt: string | null;
  lockedByUserId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
  company?: { id: string; name: string } | null;
  deal?: { id: string; title: string } | null;
  lockedByUser?: { id: string; name: string; email: string } | null;
}

export interface InvoiceActivity {
  id: string;
  action: string;
  createdAt: string;
  beforeJson: unknown;
  afterJson: unknown;
  actorUser?: { id: string; name: string; email: string } | null;
}

export interface Nudge {
  id: string;
  targetUserId: string;
  createdByUserId: string;
  type: "MANUAL" | "OVERDUE_INVOICE" | "OVERDUE_WORK" | "STALE_DEAL";
  entityType: "COMPANY" | "CONTACT" | "LEAD" | "DEAL" | "WORK_ITEM" | "INVOICE";
  entityId: string;
  message: string;
  status: "OPEN" | "RESOLVED";
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  priorityScore: number;
  meta?: {
    daysOverdue?: number;
    amount?: number;
    dealValue?: number;
    idleDays?: number;
  } | null;
  actionType?: string | null;
  executedAt?: string | null;
  undoExpiresAt?: string | null;
  createdAt: string;
  resolvedAt: string | null;
  targetUser?: { id: string; name: string; email: string } | null;
  createdByUser?: { id: string; name: string; email: string } | null;
}

export interface AIInsight {
  id: string;
  type: "DEAL_STALL" | "CASHFLOW_ALERT" | "OPS_RISK" | "SHIELD_RISK" | "HEALTH_DROP";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  scoreImpact: number;
  title: string;
  explanation: string;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  isResolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ComputeInsightsSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export type AIActionType = "CREATE_NUDGE" | "CREATE_WORK_ITEM" | "LOCK_INVOICE" | "REASSIGN_WORK";
export type AIActionStatus = "PROPOSED" | "APPROVED" | "EXECUTED" | "FAILED" | "CANCELED";

export interface AIAction {
  id: string;
  orgId: string;
  insightId: string | null;
  type: AIActionType;
  status: AIActionStatus;
  title: string;
  rationale: string;
  payload: Record<string, unknown> | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  executedByUserId: string | null;
  executedAt: string | null;
  undoData: Record<string, unknown> | null;
  undoExpiresAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface ComputeActionsSummary {
  created: number;
  skipped: number;
  totalProposed: number;
}

export interface BriefingLinkItem {
  title: string;
  summary?: string;
  deepLink?: string;
}

export interface CeoBriefingPayload {
  id?: string;
  type?: string;
  periodDays?: number;
  executiveSummary: string;
  topRisks: BriefingLinkItem[];
  recommendedNextActions: BriefingLinkItem[];
  contentText?: string;
  cached?: boolean;
  createdAt?: string;
}

export type FeedItem = Nudge;

export interface UserSummary {
  id: string;
  name: string;
  email?: string;
  role: "CEO" | "OPS" | "SALES" | "FINANCE" | "ADMIN";
  isActive?: boolean;
}

export interface ManagedUser extends UserSummary {
  isActive: boolean;
  createdAt: string;
}

export interface CeoDashboardPayload {
  kpis: {
    openDealsValue: number;
    overdueWorkCount: number;
    invoicesDueTotal: number;
    invoicesOverdueTotal: number;
  };
  bottlenecks: {
    overdueWorkItems: WorkItem[];
    overdueInvoices: Invoice[];
  };
}

export interface RevenueVelocityPayload {
  avgCloseDays: number;
  stageConversion: {
    leadToDealPct: number;
    dealToWonPct: number;
  };
  pipelineAging: {
    "0_7": number;
    "8_14": number;
    "15_30": number;
    "30_plus": number;
  };
  dropOffPct: number;
  counts: {
    leads: number;
    deals: number;
    won: number;
    lost: number;
    open: number;
  };
}

export interface RevenueCashflowPayload {
  outstandingReceivables: number;
  avgPaymentDelayDays: number;
  next30DaysForecast: number;
  next60DaysForecast: number;
  breakdown: {
    invoices: {
      dueIn30: number;
      dueIn60: number;
      overdue: number;
    };
    pipelineWeighted30: number;
    pipelineWeighted60: number;
  };
}

export interface PortfolioGroup {
  id: string;
  name: string;
  role: "OWNER" | "MANAGER" | "VIEWER";
  orgCount: number;
}

export interface PortfolioSummaryRow {
  org: {
    id: string;
    name: string;
  };
  kpis: {
    healthScore: number | null;
    openNudgesCount: number;
    outstandingReceivables: number;
    overdueWorkCount: number;
    criticalShieldCount: number;
  };
  deepLinks: {
    switchOrg: string;
    viewOpsOverdue: string;
    viewInvoicesOverdue: string;
    viewShield: string;
  };
}

export interface PortfolioSummaryPayload {
  group: {
    id: string;
    name: string;
    role: "OWNER" | "MANAGER" | "VIEWER";
  };
  rows: PortfolioSummaryRow[];
}

export interface OrgMemberRow {
  userId: string | null;
  name: string | null;
  email: string;
  role: "CEO" | "OPS" | "SALES" | "FINANCE" | "ADMIN";
  status: "INVITED" | "ACTIVE" | "REMOVED";
  joinedAt: string | null;
}

export type ApiTokenRole = Role | "READ_ONLY";

export interface ApiTokenRecord {
  id: string;
  name: string;
  role: ApiTokenRole | string;
  scopes: string[] | null;
  rateLimitPerHour: number;
  requestsThisHour?: number;
  hourWindowStart?: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  failureCount: number;
  lastFailureAt: string | null;
  createdAt: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  orgId: string;
  endpointId: string;
  event: string;
  statusCode: number | null;
  success: boolean;
  error: string | null;
  durationMs: number;
  requestBodyHash: string;
  responseBodySnippet: string | null;
  attempt: number;
  createdAt: string;
}

export interface MarketplaceAppRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  developerName?: string | null;
  websiteUrl?: string | null;
  iconUrl?: string | null;
  category?: string | null;
  scopes: string[];
  webhookEvents: string[];
  oauthProvider?: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceAppDetail extends MarketplaceAppRecord {
  installed: boolean;
  install?: {
    id: string;
    status: "INSTALLED" | "DISABLED" | "UNINSTALLED";
    installedAt: string;
    disabledAt: string | null;
    uninstalledAt: string | null;
    configVersion: number;
    lastUsedAt: string | null;
    oauthProvider?: string | null;
    oauthConnected?: boolean;
    oauthAccountId?: string | null;
    oauthExpiresAt?: string | null;
  } | null;
}

export interface OrgAppInstallRecord {
  id: string;
  appId: string;
  appKey: string;
  appName: string;
  appDescription: string;
  appCategory: string | null;
  appIconUrl: string | null;
  scopes: string[];
  webhookEvents: string[];
  status: "INSTALLED" | "DISABLED" | "UNINSTALLED";
  installedAt: string;
  disabledAt: string | null;
  uninstalledAt: string | null;
  lastUsedAt: string | null;
  configVersion: number;
  oauthProvider?: string | null;
  oauthConnected?: boolean;
  webhookUrl?: string | null;
}

export interface OrgAppCommandLogRecord {
  id: string;
  orgId: string;
  appInstallId: string;
  command: string;
  idempotencyKey: string;
  success: boolean;
  statusCode: number;
  error: string | null;
  requestHash: string;
  responseSnippet: string | null;
  createdAt: string;
}

export interface PublicOpenApiOperation {
  summary?: string;
  ["x-kritviya-required-scope"]?: string;
}

export interface PublicOpenApiDocument {
  openapi: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url: string }>;
  paths?: Record<string, { get?: PublicOpenApiOperation }>;
}

export interface HygieneItem {
  type: "WORK_OVERDUE" | "WORK_UNASSIGNED" | "INVOICE_OVERDUE";
  workItem?: WorkItem;
  invoice?: Invoice;
  suggestedActions: string[];
}

export interface PolicySettings {
  id: string;
  orgId: string;
  lockInvoiceOnSent: boolean;
  overdueAfterDays: number;
  defaultWorkDueDays: number;
  staleDealAfterDays: number;
  leadStaleAfterHours: number;
  requireDealOwner: boolean;
  requireWorkOwner: boolean;
  requireWorkDueDate: boolean;
  autoLockInvoiceAfterDays: number;
  preventInvoiceUnlockAfterPartialPayment: boolean;
  autopilotEnabled: boolean;
  autopilotCreateWorkOnDealStageChange: boolean;
  autopilotNudgeOnOverdue: boolean;
  autopilotAutoStaleDeals: boolean;
  auditRetentionDays: number;
  securityEventRetentionDays: number;
  ipRestrictionEnabled: boolean;
  ipAllowlist: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobsRunSummary {
  processedOrgs: number;
  invoicesLocked: number;
  dealsStaled: number;
  nudgesCreated: number;
  durationMs?: number;
  perOrg?: Array<{
    orgId: string;
    invoicesLocked: number;
    dealsStaled: number;
    nudgesCreated: number;
    durationMs: number;
  }>;
}

export interface SecurityEvent {
  id: string;
  orgId: string;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
  entityType: string | null;
  entityId: string | null;
  userId: string | null;
  meta: Record<string, unknown> | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AlertRule {
  id: string;
  orgId: string;
  type: string;
  isEnabled: boolean;
  thresholdCount: number;
  windowMinutes: number;
  severity: "MEDIUM" | "HIGH" | "CRITICAL";
  autoMitigation: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertEvent {
  id: string;
  orgId: string;
  ruleId: string | null;
  type: string;
  severity: "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  details: Record<string, unknown>;
  isAcknowledged: boolean;
  acknowledgedByUserId: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface EscalationStepConfig {
  afterMinutes: number;
  routeTo: Array<"WEBHOOK" | "EMAIL" | "SLACK">;
  minSeverity: "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface EscalationPolicy {
  id: string;
  orgId: string;
  name: string;
  isEnabled: boolean;
  timezone: string;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  businessDaysOnly: boolean;
  slaCritical: number;
  slaHigh: number;
  slaMedium: number;
  slaLow: number;
  steps: EscalationStepConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface AlertEscalation {
  id: string;
  orgId: string;
  alertEventId: string;
  stepNumber: number;
  attemptedAt: string;
  routedTo: Array<
    | "WEBHOOK"
    | "EMAIL"
    | "SLACK"
    | "ONCALL_PRIMARY"
    | "ONCALL_SECONDARY"
    | "ONCALL_PRIMARY_GLOBAL"
    | "ONCALL_PRIMARY_EMAIL"
    | "ONCALL_SECONDARY_EMAIL"
  >;
  suppressed: boolean;
  reason: string | null;
}

export interface OnCallSchedule {
  id: string;
  orgId: string;
  name: string;
  timezone: string;
  isEnabled: boolean;
  startAt: string;
  handoffInterval: "DAILY" | "WEEKLY";
  handoffHour: number;
  coverageEnabled?: boolean;
  coverageDays?: string[] | null;
  coverageStart?: string | null;
  coverageEnd?: string | null;
  fallbackScheduleId?: string | null;
  calendars?: Array<{
    calendar: {
      id: string;
      name: string;
      timezone: string;
      isEnabled: boolean;
    };
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface OnCallMember {
  id: string;
  scheduleId: string;
  userId: string;
  tier: "PRIMARY" | "SECONDARY";
  order: number;
  isActive: boolean;
  createdAt: string;
  user?: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

export interface OnCallOverride {
  id: string;
  scheduleId: string;
  tier: "PRIMARY" | "SECONDARY";
  fromUserId: string | null;
  toUserId: string;
  startAt: string;
  endAt: string;
  reason: string | null;
  createdAt: string;
  fromUser?: { id: string; name: string; email: string } | null;
  toUser?: { id: string; name: string; email: string } | null;
}

export interface HolidayCalendar {
  id: string;
  orgId: string;
  name: string;
  timezone: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HolidayEntry {
  id: string;
  calendarId: string;
  startDate: string;
  endDate: string | null;
  title: string | null;
  createdAt: string;
}

export interface IncidentTimelineEntry {
  id: string;
  incidentId: string;
  type: "CREATED" | "ACKNOWLEDGED" | "ESCALATED" | "SEVERITY_CHANGED" | "NOTE" | "MITIGATION" | "RESOLVED";
  message: string | null;
  metadata: Record<string, unknown> | null;
  actorUserId: string | null;
  createdAt: string;
  actorUser?: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null;
}

export interface Incident {
  id: string;
  orgId: string;
  alertEventId: string | null;
  title: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "POSTMORTEM";
  ownerUserId: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  isPublic: boolean;
  publicSummary: string | null;
  publicSlug: string | null;
  publicUpdates?: Array<{ ts: string; message: string }> | null;
  publicComponentKeys?: string[] | null;
  createdAt: string;
  updatedAt: string;
  mttaMinutes?: number | null;
  mttrMinutes?: number | null;
  owner?: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null;
  timeline?: IncidentTimelineEntry[];
}

export interface IncidentPostmortem {
  id: string;
  incidentId: string;
  orgId: string;
  summary: string | null;
  rootCause: string | null;
  impact: string | null;
  detectionGap: string | null;
  correctiveActions: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PublicStatusComponent {
  key: string;
  name: string;
  description: string | null;
  status: "OPERATIONAL" | "DEGRADED" | "PARTIAL_OUTAGE" | "MAJOR_OUTAGE";
  updatedAt: string;
  uptime24h: number;
  uptime7d: number;
}

export interface PublicStatusIncident {
  id: string;
  slug: string | null;
  title: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "POSTMORTEM";
  summary: string | null;
  updates: Array<{ ts: string; message: string }>;
  componentKeys: string[];
  createdAt?: string;
  updatedAt: string;
}

export interface AlertChannel {
  id: string;
  orgId: string;
  type: "WEBHOOK" | "EMAIL" | "SLACK";
  name: string;
  isEnabled: boolean;
  minSeverity: "MEDIUM" | "HIGH" | "CRITICAL";
  hasConfig: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDelivery {
  id: string;
  orgId: string;
  alertEventId: string;
  channelId: string;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  channel?: {
    id: string;
    name: string;
    type: string;
  };
}

export interface BillingPlanPayload {
  subscription: {
    status: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  };
  plan: {
    key: string;
    name: string;
    priceMonthly: number;
    seatLimit: number | null;
    orgLimit: number | null;
    autopilotEnabled: boolean;
    shieldEnabled: boolean;
    portfolioEnabled: boolean;
    revenueIntelligenceEnabled: boolean;
    enterpriseControlsEnabled: boolean;
    developerPlatformEnabled?: boolean;
    maxWorkItems: number | null;
    maxInvoices: number | null;
  };
}

export interface OrgUsagePayload {
  seatsUsed: number;
  seatLimit: number | null;
  workItemsUsed: number;
  maxWorkItems: number | null;
  invoicesUsed: number;
  maxInvoices: number | null;
  updatedAt: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  total: number;
}

function addPaginationParams(
  params: URLSearchParams,
  pagination?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): void {
  if (!pagination) {
    return;
  }
  if (pagination.page !== undefined) {
    params.set("page", String(pagination.page));
  }
  if (pagination.pageSize !== undefined) {
    params.set("pageSize", String(pagination.pageSize));
  }
  if (pagination.sortBy) {
    params.set("sortBy", pagination.sortBy);
  }
  if (pagination.sortDir) {
    params.set("sortDir", pagination.sortDir);
  }
}

export async function listCompanies(
  token: string,
  pagination?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<Company>> {
  const params = new URLSearchParams();
  addPaginationParams(params, pagination);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/companies${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch companies");
}

export async function getCompany(token: string, id: string): Promise<Company> {
  const response = await request(`${API_BASE_URL}/companies/${id}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch company");
}

export async function createCompany(
  token: string,
  payload: { name: string; industry?: string; website?: string }
): Promise<Company> {
  const response = await request(`${API_BASE_URL}/companies`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to create company");
}

export async function updateCompany(
  token: string,
  id: string,
  payload: { name?: string; industry?: string; website?: string }
): Promise<Company> {
  const response = await request(`${API_BASE_URL}/companies/${id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to update company");
}

export async function listCompanyContacts(
  token: string,
  companyId: string,
  pagination?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<Contact>> {
  const params = new URLSearchParams();
  addPaginationParams(params, pagination);
  const query = params.toString();
  const response = await request(
    `${API_BASE_URL}/companies/${companyId}/contacts${query ? `?${query}` : ""}`,
    {
    headers: authHeaders(token),
    cache: "no-store"
    }
  );

  return parseResponse(response, "Failed to fetch contacts");
}

export async function createContact(
  token: string,
  payload: {
    companyId: string;
    name: string;
    email?: string;
    phone?: string;
    title?: string;
  }
): Promise<Contact> {
  const response = await request(`${API_BASE_URL}/contacts`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to create contact");
}

export async function listLeads(
  token: string,
  options?: {
    stage?: LeadStage;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<Lead>> {
  const params = new URLSearchParams();
  if (options?.stage) {
    params.set("stage", options.stage);
  }
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/leads${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch leads");
}

export async function createLead(
  token: string,
  payload: {
    title: string;
    stage?: LeadStage;
    source?: string;
    notes?: string;
    companyId?: string;
    contactId?: string;
  }
): Promise<Lead> {
  const response = await request(`${API_BASE_URL}/leads`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to create lead");
}

export async function updateLead(
  token: string,
  id: string,
  payload: {
    title?: string;
    stage?: LeadStage;
    source?: string;
    notes?: string;
    companyId?: string;
    contactId?: string;
  }
): Promise<Lead> {
  const response = await request(`${API_BASE_URL}/leads/${id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to update lead");
}

export async function convertLeadToDeal(
  token: string,
  id: string,
  payload?: { companyId?: string }
): Promise<Deal> {
  const response = await request(`${API_BASE_URL}/leads/${id}/convert-to-deal`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload ?? {})
  });

  return parseResponse(response, "Failed to convert lead");
}

export async function listDeals(
  token: string,
  options?: {
    stage?: DealStage;
    companyId?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<Deal>> {
  const params = new URLSearchParams();
  if (options?.stage) {
    params.set("stage", options.stage);
  }
  if (options?.companyId) {
    params.set("companyId", options.companyId);
  }
  addPaginationParams(params, options);
  const qs = params.toString();
  const response = await request(`${API_BASE_URL}/deals${qs ? `?${qs}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch deals");
}

export async function createDeal(
  token: string,
  payload: {
    title: string;
    companyId: string;
    valueAmount?: number;
    currency?: string;
    expectedCloseDate?: string;
  }
): Promise<Deal> {
  const response = await request(`${API_BASE_URL}/deals`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to create deal");
}

export async function markDealWon(token: string, id: string): Promise<Deal> {
  const response = await request(`${API_BASE_URL}/deals/${id}/mark-won`, {
    method: "POST",
    headers: authHeaders(token)
  });

  return parseResponse(response, "Failed to mark deal won");
}

export async function markDealLost(token: string, id: string): Promise<Deal> {
  const response = await request(`${API_BASE_URL}/deals/${id}/mark-lost`, {
    method: "POST",
    headers: authHeaders(token)
  });

  return parseResponse(response, "Failed to mark deal lost");
}

export async function getDealTimeline(token: string, id: string): Promise<DealTimelineResponse> {
  const response = await request(`${API_BASE_URL}/deals/${id}/timeline`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch deal execution timeline");
}

export async function listWorkItems(
  token: string,
  filters?: {
    status?: WorkItemStatus;
    assignedTo?: string;
    due?: "overdue" | "today" | "week" | "all";
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<WorkItem>> {
  const params = new URLSearchParams();
  if (filters?.status) {
    params.set("status", filters.status);
  }
  if (filters?.assignedTo) {
    params.set("assignedTo", filters.assignedTo);
  }
  if (filters?.due) {
    params.set("due", filters.due);
  }
  addPaginationParams(params, filters);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/work-items${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch work items");
}

export async function getWorkItem(token: string, id: string): Promise<WorkItem> {
  const response = await request(`${API_BASE_URL}/work-items/${id}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch work item");
}

export async function createWorkItem(
  token: string,
  payload: {
    title: string;
    description?: string;
    status?: WorkItemStatus;
    priority?: number;
    dueDate?: string | null;
    assignedToUserId?: string | null;
    companyId?: string | null;
    dealId?: string | null;
  }
): Promise<WorkItem> {
  const response = await request(`${API_BASE_URL}/work-items`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to create work item");
}

export async function updateWorkItem(
  token: string,
  id: string,
  payload: {
    title?: string;
    description?: string | null;
    status?: WorkItemStatus;
    priority?: number;
    dueDate?: string | null;
    assignedToUserId?: string | null;
    companyId?: string | null;
    dealId?: string | null;
  }
): Promise<WorkItem> {
  const response = await request(`${API_BASE_URL}/work-items/${id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to update work item");
}

export async function transitionWorkItem(
  token: string,
  id: string,
  status: WorkItemStatus
): Promise<WorkItem> {
  const response = await request(`${API_BASE_URL}/work-items/${id}/transition`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ status })
  });

  return parseResponse(response, "Failed to transition work item");
}

export async function completeWorkItem(token: string, id: string): Promise<WorkItem> {
  const response = await request(`${API_BASE_URL}/work-items/${id}/complete`, {
    method: "POST",
    headers: authHeaders(token)
  });

  return parseResponse(response, "Failed to complete work item");
}

export async function listWorkItemActivity(
  token: string,
  id: string,
  pagination?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<WorkItemActivity>> {
  const params = new URLSearchParams();
  addPaginationParams(params, pagination);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/work-items/${id}/activity${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch work item activity");
}

export async function listInvoices(
  token: string,
  filters?: {
    status?: InvoiceStatus;
    companyId?: string;
    dealId?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<Invoice>> {
  const params = new URLSearchParams();
  if (filters?.status) {
    params.set("status", filters.status);
  }
  if (filters?.companyId) {
    params.set("companyId", filters.companyId);
  }
  if (filters?.dealId) {
    params.set("dealId", filters.dealId);
  }
  addPaginationParams(params, filters);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/invoices${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch invoices");
}

export async function getInvoice(token: string, id: string): Promise<Invoice> {
  const response = await request(`${API_BASE_URL}/invoices/${id}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch invoice");
}

export async function createInvoice(
  token: string,
  payload: {
    invoiceNumber?: string;
    companyId: string;
    dealId?: string;
    amount: number;
    currency?: string;
    issueDate?: string;
    dueDate: string;
  }
): Promise<Invoice> {
  const response = await request(`${API_BASE_URL}/invoices`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to create invoice");
}

export async function updateInvoice(
  token: string,
  id: string,
  payload: {
    invoiceNumber?: string;
    companyId?: string;
    dealId?: string;
    amount?: number;
    currency?: string;
    issueDate?: string;
    dueDate?: string;
  }
): Promise<Invoice> {
  const response = await request(`${API_BASE_URL}/invoices/${id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });

  return parseResponse(response, "Failed to update invoice");
}

export async function sendInvoice(token: string, id: string): Promise<Invoice> {
  const response = await request(`${API_BASE_URL}/invoices/${id}/send`, {
    method: "POST",
    headers: authHeaders(token)
  });

  return parseResponse(response, "Failed to send invoice");
}

export async function markInvoicePaid(token: string, id: string): Promise<Invoice> {
  const response = await request(`${API_BASE_URL}/invoices/${id}/mark-paid`, {
    method: "POST",
    headers: authHeaders(token)
  });

  return parseResponse(response, "Failed to mark invoice paid");
}

export async function unlockInvoice(token: string, id: string): Promise<Invoice> {
  const response = await request(`${API_BASE_URL}/invoices/${id}/unlock`, {
    method: "POST",
    headers: authHeaders(token)
  });

  return parseResponse(response, "Failed to unlock invoice");
}

export async function listInvoiceActivity(
  token: string,
  id: string,
  pagination?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<InvoiceActivity>> {
  const params = new URLSearchParams();
  addPaginationParams(params, pagination);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/invoices/${id}/activity${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  return parseResponse(response, "Failed to fetch invoice activity");
}

export async function getCeoDashboard(token: string): Promise<CeoDashboardPayload> {
  const response = await request(`${API_BASE_URL}/dashboard/ceo`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch CEO dashboard");
}

export async function getRevenueVelocity(token: string): Promise<RevenueVelocityPayload> {
  const response = await request(`${API_BASE_URL}/ceo/revenue/velocity`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch revenue velocity");
}

export async function getRevenueCashflow(token: string): Promise<RevenueCashflowPayload> {
  const response = await request(`${API_BASE_URL}/ceo/revenue/cashflow`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch cashflow forecast");
}

export async function getHygieneInbox(token: string): Promise<HygieneItem[]> {
  const response = await request(`${API_BASE_URL}/hygiene/inbox`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch hygiene inbox");
}

export async function createNudge(
  token: string,
  payload: {
    targetUserId: string;
    entityType: "COMPANY" | "CONTACT" | "LEAD" | "DEAL" | "WORK_ITEM" | "INVOICE";
    entityId: string;
    message: string;
  }
): Promise<Nudge> {
  const response = await request(`${API_BASE_URL}/nudges`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create nudge");
}

export async function listNudges(
  token: string,
  filters?: {
    mine?: boolean;
    status?: "OPEN" | "RESOLVED";
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<Nudge>> {
  const params = new URLSearchParams();
  if (filters?.mine !== undefined) {
    params.set("mine", String(filters.mine));
  }
  if (filters?.status) {
    params.set("status", filters.status);
  }
  addPaginationParams(params, filters);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/nudges${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch nudges");
}

export async function resolveNudge(token: string, id: string): Promise<Nudge> {
  const response = await request(`${API_BASE_URL}/nudges/${id}/resolve`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to resolve nudge");
}

export async function executeNudge(
  token: string,
  id: string
): Promise<{ success: true; undoExpiresAt: string }> {
  const response = await request(`${API_BASE_URL}/nudges/${id}/execute`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to execute nudge");
}

export async function undoNudge(token: string, id: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/nudges/${id}/undo`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to undo nudge");
}

export async function listFeed(token: string): Promise<FeedItem[]> {
  const response = await request(`${API_BASE_URL}/feed`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch feed");
}

export async function listCeoInsights(token: string): Promise<AIInsight[]> {
  const response = await request(`${API_BASE_URL}/ceo/insights`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch AI insights");
}

export async function resolveCeoInsight(token: string, id: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/ceo/insights/${id}/resolve`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to resolve insight");
}

export async function computeAiInsights(token: string): Promise<ComputeInsightsSummary> {
  const response = await request(`${API_BASE_URL}/ai/compute-insights`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to refresh insights");
}

export async function listAiActions(
  token: string,
  filters?: {
    status?: AIActionStatus;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<AIAction>> {
  const params = new URLSearchParams();
  if (filters?.status) {
    params.set("status", filters.status);
  }
  addPaginationParams(params, filters);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/ai/actions${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch AI actions");
}

export async function approveAiAction(token: string, id: string): Promise<AIAction> {
  const response = await request(`${API_BASE_URL}/ai/actions/${id}/approve`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to approve AI action");
}

export async function executeAiAction(token: string, id: string): Promise<AIAction> {
  const response = await request(`${API_BASE_URL}/ai/actions/${id}/execute`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to execute AI action");
}

export async function undoAiAction(token: string, id: string): Promise<AIAction> {
  const response = await request(`${API_BASE_URL}/ai/actions/${id}/undo`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to undo AI action");
}

export async function computeAiActions(token: string): Promise<ComputeActionsSummary> {
  const response = await request(`${API_BASE_URL}/ai/compute-actions`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to generate AI actions");
}

export async function generateCeoBriefing(
  token: string,
  periodDays = 7
): Promise<CeoBriefingPayload> {
  const response = await request(`${API_BASE_URL}/llm/reports/ceo-daily-brief`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ periodDays })
  });
  const payload = await parseResponse<
    | CeoBriefingPayload
    | {
        id: string;
        type: string;
        cached?: boolean;
        contentJson: CeoBriefingPayload;
        contentText?: string;
        createdAt?: string;
      }
  >(response, "Failed to generate CEO briefing");

  if ("contentJson" in payload) {
    return {
      ...payload.contentJson,
      id: payload.id,
      type: payload.type,
      cached: payload.cached,
      createdAt: payload.createdAt,
      contentText: payload.contentText ?? payload.contentJson.contentText
    };
  }

  return payload;
}

export async function listCeoBriefingHistory(token: string): Promise<CeoBriefingPayload[]> {
  const response = await request(`${API_BASE_URL}/llm/reports?type=CEO_DAILY_BRIEF`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch CEO briefing history");
}

export async function listUsers(token: string): Promise<UserSummary[]> {
  const response = await request(`${API_BASE_URL}/directory/users`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch users");
}

export async function listManagedUsers(
  token: string,
  options?: {
    active?: "active" | "inactive" | "all";
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<ManagedUser>> {
  const params = new URLSearchParams();
  if (options?.active) {
    params.set("active", options.active);
  }
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/users${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch managed users");
}

export async function createManagedUser(
  token: string,
  payload: {
    name: string;
    email: string;
    role: UserSummary["role"];
    password?: string;
  }
): Promise<{ user: ManagedUser; tempPassword?: string }> {
  const response = await request(`${API_BASE_URL}/users`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create user");
}

export async function updateManagedUser(
  token: string,
  id: string,
  payload: {
    name?: string;
    role?: UserSummary["role"];
  }
): Promise<ManagedUser> {
  const response = await request(`${API_BASE_URL}/users/${id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update user");
}

export async function deactivateManagedUser(token: string, id: string): Promise<ManagedUser> {
  const response = await request(`${API_BASE_URL}/users/${id}/deactivate`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to deactivate user");
}

export async function reactivateManagedUser(token: string, id: string): Promise<ManagedUser> {
  const response = await request(`${API_BASE_URL}/users/${id}/reactivate`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to reactivate user");
}

export async function getPolicySettings(token: string): Promise<PolicySettings> {
  const response = await request(`${API_BASE_URL}/settings/policies`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch policy settings");
}

export async function exportOrgAuditCsv(
  token: string,
  options?: { from?: string; to?: string }
): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams();
  params.set("format", "csv");
  if (options?.from) {
    params.set("from", options.from);
  }
  if (options?.to) {
    params.set("to", options.to);
  }
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/org/audit/export?${query}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

  if (!response.ok) {
    let message = "Failed to export audit CSV";
    let code: string | undefined;
    try {
      const json = (await response.json()) as {
        message?: string | string[];
        error?: { message?: string; code?: string };
      };
      if (Array.isArray(json.message)) {
        message = json.message.join(", ");
      } else if (json.message) {
        message = json.message;
      } else if (json.error?.message) {
        message = json.error.message;
      }
      code = json.error?.code;
    } catch {
      // ignore
    }
    if (code === "UPGRADE_REQUIRED" && typeof window !== "undefined") {
      const upgradeMessage = `${message} Open /billing to upgrade.`;
      window.alert(upgradeMessage);
      message = upgradeMessage;
    }
    throw new ApiError(message, response.status, code);
  }

  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  const filename = filenameMatch?.[1] ?? "audit_export.csv";
  const blob = await response.blob();

  return { blob, filename };
}

export async function getBillingPlan(token: string): Promise<BillingPlanPayload> {
  const response = await request(`${API_BASE_URL}/billing/plan`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch billing plan");
}

export async function getOrgUsage(token: string): Promise<OrgUsagePayload> {
  const response = await request(`${API_BASE_URL}/org/usage`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch org usage");
}

export async function createBillingSubscription(
  token: string,
  planKey: "starter" | "growth" | "pro" | "enterprise"
): Promise<{ subscriptionId: string; razorpayKeyId: string }> {
  const response = await request(`${API_BASE_URL}/billing/create-subscription`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ planKey })
  });
  return parseResponse(response, "Failed to create Razorpay subscription");
}

export async function updatePolicySettings(
  token: string,
  payload: Omit<PolicySettings, "id" | "orgId" | "createdAt" | "updatedAt">
): Promise<PolicySettings> {
  const response = await request(`${API_BASE_URL}/settings/policies`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update policy settings");
}

export async function runAutopilotNow(token: string): Promise<JobsRunSummary> {
  const response = await request(`${API_BASE_URL}/jobs/run`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to run autopilot job");
}

export async function listShieldEvents(
  token: string,
  options?: {
    severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    resolved?: boolean;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<SecurityEvent>> {
  const params = new URLSearchParams();
  if (options?.severity) {
    params.set("severity", options.severity);
  }
  if (options?.resolved !== undefined) {
    params.set("resolved", String(options.resolved));
  }
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/shield/events${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch shield events");
}

export async function resolveShieldEvent(token: string, id: string): Promise<SecurityEvent> {
  const response = await request(`${API_BASE_URL}/shield/events/${id}/resolve`, {
    method: "PATCH",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to resolve security event");
}

export async function createPortfolio(
  token: string,
  payload: { name: string }
): Promise<{ id: string; name: string; ownerUserId: string; createdAt: string }> {
  const response = await request(`${API_BASE_URL}/portfolio`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create portfolio");
}

export async function listPortfolioGroups(
  token: string,
  pagination?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<PortfolioGroup>> {
  const params = new URLSearchParams();
  addPaginationParams(params, pagination);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/portfolio${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch portfolios");
}

export async function attachPortfolioOrg(
  token: string,
  groupId: string,
  orgId: string
): Promise<{ id: string; groupId: string; orgId: string }> {
  const response = await request(`${API_BASE_URL}/portfolio/${groupId}/orgs`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ orgId })
  });
  return parseResponse(response, "Failed to attach organization");
}

export async function detachPortfolioOrg(
  token: string,
  groupId: string,
  orgId: string
): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/portfolio/${groupId}/orgs/${orgId}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to detach organization");
}

export async function getPortfolioSummary(token: string, groupId: string): Promise<PortfolioSummaryPayload> {
  const response = await request(`${API_BASE_URL}/portfolio/${groupId}/summary`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch portfolio summary");
}

export async function listOrgMembers(token: string): Promise<OrgMemberRow[]> {
  const response = await request(`${API_BASE_URL}/org/members`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  const payload = await parseResponse<OrgMemberRow[] | PaginatedResponse<OrgMemberRow>>(
    response,
    "Failed to fetch org members"
  );
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.items;
}

export async function inviteOrgMember(
  token: string,
  payload: { email: string; role: "CEO" | "OPS" | "SALES" | "FINANCE" | "ADMIN" }
): Promise<{ inviteLink: string; expiresAt: string }> {
  const response = await request(`${API_BASE_URL}/org/invite`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create invite");
}

export async function acceptOrgInvite(payload: {
  token: string;
  orgId: string;
  name?: string;
  password?: string;
}): Promise<{
  success: true;
  accessToken?: string;
  user: { id: string; email: string; role: string; orgId: string };
}> {
  const response = await request(`${API_BASE_URL}/org/accept-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to accept invite");
}

export async function listOrgApiTokens(token: string): Promise<ApiTokenRecord[]> {
  const response = await request(`${API_BASE_URL}/org/api-tokens`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  const payload = await parseResponse<ApiTokenRecord[] | PaginatedResponse<ApiTokenRecord>>(
    response,
    "Failed to fetch API tokens"
  );

  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.items;
}

export async function createOrgApiToken(
  token: string,
  payload: {
    name: string;
    role?: ApiTokenRole | string;
    scopes?: string[];
    rateLimitPerHour?: number;
  }
): Promise<ApiTokenRecord & { token: string }> {
  const response = await request(`${API_BASE_URL}/org/api-tokens`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create API token");
}

export async function revokeOrgApiToken(token: string, id: string): Promise<void> {
  const response = await request(`${API_BASE_URL}/org/api-tokens/${id}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  await parseResponse<unknown>(response, "Failed to revoke API token");
}

export async function listOrgWebhooks(token: string): Promise<WebhookEndpointRecord[]> {
  const response = await request(`${API_BASE_URL}/org/webhooks`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  const payload = await parseResponse<
    WebhookEndpointRecord[] | PaginatedResponse<WebhookEndpointRecord>
  >(response, "Failed to fetch webhooks");
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.items;
}

export async function createOrgWebhook(
  token: string,
  payload: { url: string; events: string[] }
): Promise<WebhookEndpointRecord & { secret?: string }> {
  const response = await request(`${API_BASE_URL}/org/webhooks`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create webhook endpoint");
}

export async function deleteOrgWebhook(token: string, id: string): Promise<void> {
  const response = await request(`${API_BASE_URL}/org/webhooks/${id}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  await parseResponse<unknown>(response, "Failed to delete webhook endpoint");
}

export async function listWebhookDeliveries(
  token: string,
  webhookId: string,
  options?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<WebhookDeliveryRecord>> {
  const params = new URLSearchParams();
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(
    `${API_BASE_URL}/org/webhooks/${webhookId}/deliveries${query ? `?${query}` : ""}`,
    {
      headers: authHeaders(token),
      cache: "no-store"
    }
  );
  return parseResponse(response, "Failed to fetch webhook deliveries");
}

export async function retryWebhookDelivery(
  token: string,
  webhookId: string,
  deliveryId: string
): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/webhooks/${webhookId}/retry`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ deliveryId })
  });
  return parseResponse(response, "Failed to retry webhook delivery");
}

export async function listOrgAlerts(
  token: string,
  options?: {
    acknowledged?: boolean;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<PaginatedResponse<AlertEvent>> {
  const params = new URLSearchParams();
  if (options?.acknowledged !== undefined) {
    params.set("acknowledged", String(options.acknowledged));
  }
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/org/alerts${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch alerts");
}

export async function acknowledgeOrgAlert(
  token: string,
  alertId: string
): Promise<AlertEvent> {
  const response = await request(`${API_BASE_URL}/org/alerts/${alertId}/acknowledge`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to acknowledge alert");
}

export async function listAlertRules(token: string): Promise<AlertRule[]> {
  const response = await request(`${API_BASE_URL}/org/alert-rules`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch alert rules");
}

export async function getEscalationPolicy(token: string): Promise<EscalationPolicy> {
  const response = await request(`${API_BASE_URL}/org/escalation-policy`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch escalation policy");
}

export async function saveEscalationPolicy(
  token: string,
  payload: Partial<
    Omit<EscalationPolicy, "id" | "orgId" | "createdAt" | "updatedAt"> & {
      steps: EscalationStepConfig[];
    }
  >
): Promise<EscalationPolicy> {
  const response = await request(`${API_BASE_URL}/org/escalation-policy`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to save escalation policy");
}

export async function listAlertEscalations(
  token: string,
  alertId: string
): Promise<AlertEscalation[]> {
  const response = await request(`${API_BASE_URL}/org/alerts/${alertId}/escalations`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch escalation history");
}

export async function testEscalationPolicy(
  token: string,
  severity: "MEDIUM" | "HIGH" | "CRITICAL" = "HIGH"
): Promise<{ alertEventId: string; escalated: number; suppressed: number; totalProcessed: number }> {
  const response = await request(`${API_BASE_URL}/org/escalation-policy/test`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ severity })
  });
  return parseResponse(response, "Failed to test escalation policy");
}

export async function listOnCallSchedules(token: string): Promise<OnCallSchedule[]> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch on-call schedules");
}

export async function createOnCallSchedule(
  token: string,
  payload: {
    name: string;
    timezone?: string;
    handoffInterval?: "DAILY" | "WEEKLY";
    handoffHour?: number;
    startAt?: string;
    coverageEnabled?: boolean;
    coverageDays?: string[];
    coverageStart?: string;
    coverageEnd?: string;
    fallbackScheduleId?: string;
  }
): Promise<OnCallSchedule> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create on-call schedule");
}

export async function updateOnCallSchedule(
  token: string,
  scheduleId: string,
  payload: Partial<{
    name: string;
    timezone: string;
    handoffInterval: "DAILY" | "WEEKLY";
    handoffHour: number;
    isEnabled: boolean;
    startAt: string;
    coverageEnabled: boolean;
    coverageDays: string[];
    coverageStart: string;
    coverageEnd: string;
    fallbackScheduleId: string | null;
  }>
): Promise<OnCallSchedule> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules/${scheduleId}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update on-call schedule");
}

export async function deleteOnCallSchedule(token: string, scheduleId: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules/${scheduleId}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to remove on-call schedule");
}

export async function listOnCallMembers(token: string, scheduleId: string): Promise<OnCallMember[]> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules/${scheduleId}/members`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch on-call members");
}

export async function createOnCallMember(
  token: string,
  scheduleId: string,
  payload: { userId: string; tier: "PRIMARY" | "SECONDARY"; order: number }
): Promise<OnCallMember> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules/${scheduleId}/members`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create on-call member");
}

export async function updateOnCallMember(
  token: string,
  memberId: string,
  payload: Partial<{ order: number; isActive: boolean }>
): Promise<OnCallMember> {
  const response = await request(`${API_BASE_URL}/org/oncall/members/${memberId}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update on-call member");
}

export async function deleteOnCallMember(token: string, memberId: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/oncall/members/${memberId}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to remove on-call member");
}

export async function listOnCallOverrides(
  token: string,
  scheduleId?: string
): Promise<OnCallOverride[]> {
  const params = new URLSearchParams();
  if (scheduleId) {
    params.set("scheduleId", scheduleId);
  }
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/org/oncall/overrides${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch on-call overrides");
}

export async function createOnCallOverride(
  token: string,
  payload: {
    scheduleId: string;
    tier: "PRIMARY" | "SECONDARY";
    fromUserId?: string;
    toUserId: string;
    startAt: string;
    endAt: string;
    reason?: string;
  }
): Promise<OnCallOverride> {
  const response = await request(`${API_BASE_URL}/org/oncall/overrides`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create on-call override");
}

export async function deleteOnCallOverride(token: string, id: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/oncall/overrides/${id}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to remove on-call override");
}

export async function getOnCallNow(
  token: string
): Promise<{
  scheduleId: string | null;
  activeScheduleId?: string | null;
  inCoverageWindow?: boolean;
  isHoliday?: boolean;
  primary: { id: string; name: string; email: string; role: string } | null;
  secondary: { id: string; name: string; email: string; role: string } | null;
}> {
  const response = await request(`${API_BASE_URL}/org/oncall/now`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to resolve on-call assignment");
}

export async function linkOnCallScheduleCalendar(
  token: string,
  scheduleId: string,
  calendarId: string
): Promise<{ id: string; scheduleId: string; calendarId: string }> {
  const response = await request(`${API_BASE_URL}/org/oncall/schedules/${scheduleId}/calendars`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ calendarId })
  });
  return parseResponse(response, "Failed to link calendar to schedule");
}

export async function unlinkOnCallScheduleCalendar(
  token: string,
  scheduleId: string,
  calendarId: string
): Promise<{ success: true }> {
  const response = await request(
    `${API_BASE_URL}/org/oncall/schedules/${scheduleId}/calendars/${calendarId}`,
    {
      method: "DELETE",
      headers: authHeaders(token)
    }
  );
  return parseResponse(response, "Failed to unlink calendar from schedule");
}

export async function listHolidayCalendars(token: string): Promise<HolidayCalendar[]> {
  const response = await request(`${API_BASE_URL}/org/holidays/calendars`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch holiday calendars");
}

export async function createHolidayCalendar(
  token: string,
  payload: { name: string; timezone?: string }
): Promise<HolidayCalendar> {
  const response = await request(`${API_BASE_URL}/org/holidays/calendars`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create holiday calendar");
}

export async function updateHolidayCalendar(
  token: string,
  calendarId: string,
  payload: Partial<{ name: string; timezone: string; isEnabled: boolean }>
): Promise<HolidayCalendar> {
  const response = await request(`${API_BASE_URL}/org/holidays/calendars/${calendarId}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update holiday calendar");
}

export async function deleteHolidayCalendar(
  token: string,
  calendarId: string
): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/holidays/calendars/${calendarId}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to disable holiday calendar");
}

export async function listHolidayEntries(token: string, calendarId: string): Promise<HolidayEntry[]> {
  const response = await request(`${API_BASE_URL}/org/holidays/calendars/${calendarId}/entries`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch holiday entries");
}

export async function createHolidayEntry(
  token: string,
  calendarId: string,
  payload: { startDate: string; endDate?: string; title?: string }
): Promise<HolidayEntry> {
  const response = await request(`${API_BASE_URL}/org/holidays/calendars/${calendarId}/entries`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create holiday entry");
}

export async function deleteHolidayEntry(token: string, entryId: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/holidays/entries/${entryId}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to remove holiday entry");
}

export async function listIncidents(
  token: string,
  query?: {
    status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "POSTMORTEM";
    severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    page?: number;
    pageSize?: number;
  }
): Promise<PaginatedResponse<Incident>> {
  const params = new URLSearchParams();
  if (query?.status) {
    params.set("status", query.status);
  }
  if (query?.severity) {
    params.set("severity", query.severity);
  }
  params.set("page", String(query?.page ?? 1));
  params.set("pageSize", String(query?.pageSize ?? 20));

  const response = await request(`${API_BASE_URL}/org/incidents?${params.toString()}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch incidents");
}

export async function getIncident(token: string, incidentId: string): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch incident");
}

export async function acknowledgeIncident(token: string, incidentId: string): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/acknowledge`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to acknowledge incident");
}

export async function resolveIncident(token: string, incidentId: string): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/resolve`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to resolve incident");
}

export async function updateIncidentSeverity(
  token: string,
  incidentId: string,
  payload: { severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" }
): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/severity`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update incident severity");
}

export async function addIncidentNote(
  token: string,
  incidentId: string,
  payload: { message: string }
): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/notes`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to add incident note");
}

export async function getIncidentPostmortem(
  token: string,
  incidentId: string
): Promise<IncidentPostmortem | null> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/postmortem`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch incident postmortem");
}

export async function upsertIncidentPostmortem(
  token: string,
  incidentId: string,
  payload: {
    summary?: string;
    rootCause?: string;
    impact?: string;
    detectionGap?: string;
    correctiveActions?: unknown;
  }
): Promise<IncidentPostmortem> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/postmortem`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to save incident postmortem");
}

export async function getIncidentMetrics(
  token: string,
  query?: { range?: string }
): Promise<{
  totalIncidents: number;
  avgMTTA: number;
  avgMTTR: number;
  openIncidents: number;
  resolvedIncidents: number;
  rangeDays: number;
}> {
  const params = new URLSearchParams();
  if (query?.range) {
    params.set("range", query.range);
  }
  const response = await request(`${API_BASE_URL}/org/incidents/metrics?${params.toString()}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch incident metrics");
}

export async function publishIncident(
  token: string,
  incidentId: string,
  payload: { publicSummary: string; componentKeys?: string[] }
): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/publish`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to publish incident");
}

export async function unpublishIncident(token: string, incidentId: string): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/unpublish`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to unpublish incident");
}

export async function addPublicIncidentUpdate(
  token: string,
  incidentId: string,
  payload: { message: string }
): Promise<Incident> {
  const response = await request(`${API_BASE_URL}/org/incidents/${incidentId}/public-update`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to add public incident update");
}

export async function getPublicStatus(): Promise<{
  overallStatus: "OPERATIONAL" | "DEGRADED" | "PARTIAL_OUTAGE" | "MAJOR_OUTAGE";
  components: PublicStatusComponent[];
  activeIncidents: PublicStatusIncident[];
}> {
  const response = await request(`${API_BASE_URL}/status`, {
    cache: "no-store"
  });
  return parseResponse(response, "Failed to load public status");
}

export async function listPublicStatusIncidents(): Promise<PublicStatusIncident[]> {
  const response = await request(`${API_BASE_URL}/status/incidents`, {
    cache: "no-store"
  });
  return parseResponse(response, "Failed to load public incidents");
}

export async function getPublicStatusIncident(slug: string): Promise<PublicStatusIncident> {
  const response = await request(`${API_BASE_URL}/status/incidents/${slug}`, {
    cache: "no-store"
  });
  return parseResponse(response, "Failed to load public incident");
}

export async function listAlertChannels(token: string): Promise<AlertChannel[]> {
  const response = await request(`${API_BASE_URL}/org/alert-channels`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch alert channels");
}

export async function createAlertChannel(
  token: string,
  payload: {
    type: "WEBHOOK" | "EMAIL" | "SLACK";
    name: string;
    minSeverity: "MEDIUM" | "HIGH" | "CRITICAL";
    config: Record<string, unknown>;
  }
): Promise<AlertChannel> {
  const response = await request(`${API_BASE_URL}/org/alert-channels`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to create alert channel");
}

export async function updateAlertChannel(
  token: string,
  channelId: string,
  payload: Partial<{
    name: string;
    minSeverity: "MEDIUM" | "HIGH" | "CRITICAL";
    isEnabled: boolean;
    config: Record<string, unknown>;
  }>
): Promise<AlertChannel> {
  const response = await request(`${API_BASE_URL}/org/alert-channels/${channelId}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
  return parseResponse(response, "Failed to update alert channel");
}

export async function deleteAlertChannel(token: string, channelId: string): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/alert-channels/${channelId}`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to delete alert channel");
}

export async function testAlertChannel(
  token: string,
  channelId: string,
  severity: "MEDIUM" | "HIGH" | "CRITICAL" = "HIGH"
): Promise<{ success: boolean; delivery: AlertDelivery | null }> {
  const response = await request(`${API_BASE_URL}/org/alert-channels/${channelId}/test`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ severity })
  });
  return parseResponse(response, "Failed to test alert channel");
}

export async function listAlertDeliveries(
  token: string,
  options?: { alertEventId?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<AlertDelivery>> {
  const params = new URLSearchParams();
  if (options?.alertEventId) {
    params.set("alertEventId", options.alertEventId);
  }
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/org/alert-deliveries${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch alert deliveries");
}

export async function getPublicOpenApi(token: string): Promise<PublicOpenApiDocument> {
  const response = await request(`${API_BASE_URL}/api/v1/openapi.json`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch public OpenAPI document");
}

export async function listMarketplaceApps(
  token: string,
  options?: {
    q?: string;
    category?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
    sortDir?: "asc" | "desc";
  }
): Promise<MarketplaceAppRecord[]> {
  const params = new URLSearchParams();
  if (options?.q?.trim()) {
    params.set("q", options.q.trim());
  }
  if (options?.category?.trim()) {
    params.set("category", options.category.trim());
  }
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(`${API_BASE_URL}/marketplace/apps${query ? `?${query}` : ""}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  const payload = await parseResponse<
    MarketplaceAppRecord[] | PaginatedResponse<MarketplaceAppRecord>
  >(response, "Failed to fetch marketplace apps");
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.items;
}

export async function getMarketplaceApp(token: string, key: string): Promise<MarketplaceAppDetail> {
  const response = await request(`${API_BASE_URL}/marketplace/apps/${key}`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch marketplace app");
}

export async function listOrgAppInstalls(token: string): Promise<OrgAppInstallRecord[]> {
  const response = await request(`${API_BASE_URL}/org/apps`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch installed apps");
}

export async function installOrgApp(
  token: string,
  appKey: string
): Promise<{
  id: string;
  appKey: string;
  status: "INSTALLED" | "DISABLED" | "UNINSTALLED";
  installedAt: string;
  configVersion: number;
  appSecret: string | null;
}> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/install`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to install app");
}

export async function updateOrgAppConfig(
  token: string,
  appKey: string,
  config: Record<string, unknown>
): Promise<{ id: string; appKey: string; status: string; configVersion: number }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/config`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ config })
  });
  return parseResponse(response, "Failed to update app config");
}

export async function rotateOrgAppSecret(
  token: string,
  appKey: string
): Promise<{ id: string; appKey: string; appSecret: string }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/rotate-secret`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to rotate app secret");
}

export async function disableOrgApp(
  token: string,
  appKey: string
): Promise<{ id: string; appKey: string; status: string; disabledAt: string | null }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/disable`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to disable app");
}

export async function enableOrgApp(
  token: string,
  appKey: string
): Promise<{ id: string; appKey: string; status: string }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/enable`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to enable app");
}

export async function uninstallOrgApp(
  token: string,
  appKey: string
): Promise<{ id: string; appKey: string; status: string; uninstalledAt: string | null }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/uninstall`, {
    method: "DELETE",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to uninstall app");
}

export async function startOrgAppOAuth(token: string, appKey: string): Promise<{ authUrl: string }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/oauth/start?mode=url`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to start OAuth connection");
}

export async function disconnectOrgAppOAuth(
  token: string,
  appKey: string
): Promise<{ id: string; appKey: string; status: string }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/oauth/disconnect`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to disconnect OAuth connection");
}

export async function sendOrgAppTestTrigger(
  token: string,
  appKey: string,
  eventName: string
): Promise<{ success: true; appKey: string; eventName: string }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/test-trigger`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ eventName })
  });
  return parseResponse(response, "Failed to send test trigger");
}

export async function listOrgAppDeliveries(
  token: string,
  appKey: string,
  options?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<WebhookDeliveryRecord>> {
  const params = new URLSearchParams();
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(
    `${API_BASE_URL}/org/apps/${appKey}/deliveries${query ? `?${query}` : ""}`,
    {
      headers: authHeaders(token),
      cache: "no-store"
    }
  );
  return parseResponse(response, "Failed to fetch app deliveries");
}

export async function replayOrgAppDelivery(
  token: string,
  appKey: string,
  deliveryId: string
): Promise<{ success: true }> {
  const response = await request(`${API_BASE_URL}/org/apps/${appKey}/deliveries/${deliveryId}/replay`, {
    method: "POST",
    headers: authHeaders(token)
  });
  return parseResponse(response, "Failed to replay app delivery");
}

export async function listOrgAppCommandLogs(
  token: string,
  appKey: string,
  options?: { page?: number; pageSize?: number; sortBy?: string; sortDir?: "asc" | "desc" }
): Promise<PaginatedResponse<OrgAppCommandLogRecord>> {
  const params = new URLSearchParams();
  addPaginationParams(params, options);
  const query = params.toString();
  const response = await request(
    `${API_BASE_URL}/org/apps/${appKey}/command-logs${query ? `?${query}` : ""}`,
    {
      headers: authHeaders(token),
      cache: "no-store"
    }
  );
  return parseResponse(response, "Failed to fetch app command logs");
}
