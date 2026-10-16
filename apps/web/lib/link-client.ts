"use client";

/** Browser side of QR sign-in (see lib/bff/link.ts). The secret stays in an httpOnly cookie. */
export type LinkPath = "request" | "claim" | "peek" | "redeem";

export interface LinkReply<T = Record<string, unknown>> {
  status: number;
  data: T & { detail?: string };
}

export async function linkPost<T = Record<string, unknown>>(path: LinkPath, body: Record<string, unknown> = {}): Promise<LinkReply<T>> {
  try {
    const res = await fetch(`/api/auth/link/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = {} as T & { detail?: string };
    try {
      data = (await res.json()) as T & { detail?: string };
    } catch {
      /* empty body */
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { detail: "You seem to be offline." } as T & { detail?: string } };
  }
}

/** The token a QR code carries: everything after '#' in https://…/link#<token>. */
export function tokenFromHash(hash: string): string | null {
  const t = hash.replace(/^#/, "").trim();
  return /^[A-Za-z0-9_-]{32,64}$/.test(t) ? t : null;
}

/** "2:41" from seconds left. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
