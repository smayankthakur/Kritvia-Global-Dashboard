import type { Schemas } from "@/lib/api";

/** One review's stable identity: its reply's id, or (before a reply is drafted) who wrote it and when.
 * Never its position: the list re-reads from Google and a new review shifts everything down, so a
 * position key would leave one review's reply box under another review. */
export function reviewKey(r: Pick<Schemas["ReviewOut"], "author" | "when" | "text" | "reply">): string {
  return r.reply?.id ?? `${r.author}|${r.when}|${r.text.slice(0, 60)}`;
}
