// Typed Kritvia API client. Types are generated from the FastAPI OpenAPI schema
// (packages/shared-types), so a backend change that breaks the frontend fails at
// compile time. Every browser call goes through the BFF proxy at /api/k, which adds
// the bearer token from an httpOnly cookie — the page never handles tokens.
import createClient from "openapi-fetch";
import type { components, paths } from "@kritvia/shared-types";
import { csrfHeaders } from "@/lib/bff/csrf";

export type Schemas = components["schemas"];
export type Paths = paths;

export const api = createClient<paths>({ baseUrl: "/api/k" });
// Every state-changing call carries the CSRF token the BFF checks (lib/bff/csrf.ts).
api.use({
  onRequest({ request }) {
    if (request.method !== "GET" && request.method !== "HEAD") for (const [k, v] of Object.entries(csrfHeaders())) request.headers.set(k, v);
    return request;
  },
});

/** Field-level messages from a FastAPI 422, keyed by dotted body path ("applicant.pan"). */
export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly fieldErrors: FieldErrors;
  readonly retryAfter: number | null;

  constructor(status: number, detail: string, fieldErrors: FieldErrors = {}, retryAfter: number | null = null) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.fieldErrors = fieldErrors;
    this.retryAfter = retryAfter;
  }

  get isNotFound() {
    return this.status === 404;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  get isConflict() {
    return this.status === 409;
  }
}

interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
}

function cleanMsg(msg: string): string {
  return msg.replace(/^Value error, /, "").replace(/^String should/, "Should");
}

export function parseErrorBody(status: number, body: unknown, retryAfter: number | null = null): ApiError {
  let detail = defaultMessage(status);
  const fieldErrors: FieldErrors = {};
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") detail = d;
    else if (Array.isArray(d)) {
      for (const item of d as ValidationItem[]) {
        const loc = (item.loc ?? []).filter((p) => p !== "body" && p !== "query" && p !== "path");
        const key = loc.join(".") || "_";
        if (!(key in fieldErrors)) fieldErrors[key] = cleanMsg(item.msg ?? "invalid value");
      }
      const first = Object.entries(fieldErrors)[0];
      detail = first ? (first[0] === "_" ? first[1] : `${first[0]}: ${first[1]}`) : "Some fields are invalid";
    }
  } else if (typeof body === "string" && body.trim() && body.length < 300) {
    detail = body.trim();
  }
  return new ApiError(status, detail, fieldErrors, retryAfter);
}

export function defaultMessage(status: number): string {
  switch (status) {
    case 0:
      return "Network error — check your connection";
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return "This request was refused";
    case 404:
      return "Not found, or you don't have access";
    case 409:
      return "This changed in the meantime";
    case 413:
      return "The file is too large";
    case 422:
      return "Some fields are invalid";
    case 429:
      return "Too many requests — please wait a moment and try again";
    case 502:
    case 503:
      return "The service is temporarily unavailable";
    default:
      return `Request failed (${status})`;
  }
}

type FetchResult = { data?: unknown; error?: unknown; response: Response };

/** Resolve an openapi-fetch call to its data, or throw an ApiError with the API's `detail`. */
export async function unwrap<R extends FetchResult>(call: Promise<R>): Promise<Exclude<R["data"], undefined>> {
  let res: R;
  try {
    res = await call;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, defaultMessage(0));
  }
  if (!res.response.ok) {
    const ra = res.response.headers.get("retry-after");
    throw parseErrorBody(res.response.status, res.error, ra ? Number(ra) || null : null);
  }
  return res.data as Exclude<R["data"], undefined>;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "Not found, or you don't have access.";
    if (e.status === 429) return e.retryAfter ? `Too many requests — try again in ${e.retryAfter}s.` : defaultMessage(429);
    return e.detail;
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

/**
 * Multipart bodies. The generated types model binary parts as `string`; this helper
 * takes the same keys but accepts Blob/File values and builds a FormData (openapi-fetch
 * passes FormData through untouched so the browser sets the multipart boundary).
 */
type MultipartValue<V> = V extends string[]
  ? Blob[]
  : V extends string
    ? string | Blob
    : V extends boolean
      ? boolean
      : V extends null
        ? null
        : V;
export type MultipartFields<T> = { [K in keyof T]: MultipartValue<T[K]> };

export function multipart<T>(fields: MultipartFields<T>): T {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) fd.append(k, item instanceof Blob ? item : String(item));
    } else if (v instanceof Blob) {
      fd.append(k, v, v instanceof File ? v.name : "upload");
    } else {
      fd.append(k, String(v));
    }
  }
  return fd as unknown as T;
}

/** Download a binary response (e.g. an original document) through the proxy. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api/k${path}`, { credentials: "same-origin" });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not json */
    }
    throw parseErrorBody(res.status, body);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^";]+)"?/i.exec(cd);
  saveBlob(blob, m?.[1] ?? fallbackName);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Compile-time exhaustive list of a string union taken from the schema, e.g. rate-card
 * units. If the backend adds or removes a value, this stops compiling.
 */
export function enumValues<T extends string>() {
  return <const A extends readonly T[]>(...values: A & ([T] extends [A[number]] ? unknown : never)): A => values;
}
