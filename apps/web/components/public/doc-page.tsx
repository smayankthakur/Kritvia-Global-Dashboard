import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/shell/logo";

export const COMPANY = "Sitelytc Digital Media Pvt. Ltd.";
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@sitelytc.com";

const LINKS = [
  ["/security", "Security"],
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/help", "Help"],
  ["/status", "Status"],
] as const;

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" aria-label="Kritvia home">
            <Logo />
          </Link>
          <nav className="flex flex-wrap gap-4 text-sm text-muted" aria-label="Kritvia">
            {LINKS.map(([href, label]) => (
              <Link key={href} href={href} className="hover:text-fg">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-4xl px-4 py-10">
        {children}
      </main>
      <footer className="border-t border-border py-6 text-center text-xs text-subtle">
        © {new Date().getFullYear()} {COMPANY} · New Delhi, India ·{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-fg">
          {SUPPORT_EMAIL}
        </a>
      </footer>
    </div>
  );
}

export function Doc({ title, updated, lead, children }: { title: string; updated?: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <PublicShell>
      <article className="space-y-6 text-[15px] leading-relaxed text-muted [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-fg">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {updated ? <p className="mt-1 text-sm text-subtle">Last updated {updated}</p> : null}
          {lead ? <p className="mt-4 text-base text-fg">{lead}</p> : null}
        </header>
        {children}
      </article>
    </PublicShell>
  );
}
