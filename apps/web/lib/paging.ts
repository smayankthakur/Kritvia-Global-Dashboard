import { unwrap } from "@/lib/api";

/** One page of a list the API pages with a cursor: a full page carries `X-Next-Cursor` for the next one. */
export interface Page<T> {
  items: T;
  next: string | null;
}

/** Like `unwrap`, but also reads the `X-Next-Cursor` response header (round 3, B13). */
export async function unwrapPage<R extends { data?: unknown; error?: unknown; response: Response }>(call: Promise<R>): Promise<Page<Exclude<R["data"], undefined>>> {
  let response: Response | undefined;
  const items = await unwrap(
    call.then((r) => {
      response = r.response;
      return r;
    }),
  );
  return { items, next: response?.headers.get("x-next-cursor") || null };
}

/** All loaded pages as one list. */
export function flatPages<T>(pages: readonly Page<T[]>[] | undefined): T[] {
  return (pages ?? []).flatMap((p) => p.items);
}

/** How many rows one page holds on the Leads and Proposals pages. */
export const PAGE_SIZE = 200;
