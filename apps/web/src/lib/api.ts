import {
  AuthMeResponse,
  DealStage,
  InvoiceStatus,
  LeadStage,
  WorkItemStatus
} from "../types/auth";
import { clearAccessToken, getAccessToken, setAccessToken } from "./auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:4000" : "");
const REQUEST_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS ?? 10000);

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parseResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    let message = fallbackMessage;
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
    } catch {
      // ignore JSON parse error
    }

    throw new ApiError(message, response.status);
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
  entityType: "COMPANY" | "CONTACT" | "LEAD" | "DEAL" | "WORK_ITEM" | "INVOICE";
  entityId: string;
  message: string;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
  resolvedAt: string | null;
  targetUser?: { id: string; name: string; email: string } | null;
  createdByUser?: { id: string; name: string; email: string } | null;
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

export interface HygieneItem {
  type: "WORK_OVERDUE" | "WORK_UNASSIGNED" | "INVOICE_OVERDUE";
  workItem?: WorkItem;
  invoice?: Invoice;
  suggestedActions: string[];
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
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

export async function listCompanyContacts(token: string, companyId: string): Promise<Contact[]> {
  const response = await request(`${API_BASE_URL}/companies/${companyId}/contacts`, {
    headers: authHeaders(token),
    cache: "no-store"
  });

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

export async function listFeed(token: string): Promise<FeedItem[]> {
  const response = await request(`${API_BASE_URL}/feed`, {
    headers: authHeaders(token),
    cache: "no-store"
  });
  return parseResponse(response, "Failed to fetch feed");
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
