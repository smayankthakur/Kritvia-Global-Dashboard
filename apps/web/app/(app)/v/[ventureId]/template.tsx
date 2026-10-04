import type { ReactNode } from "react";

/** A template remounts on navigation, so each page fades up as it opens (instant under reduced motion). */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="kv-page">{children}</div>;
}
