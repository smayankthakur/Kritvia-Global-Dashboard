import { Menu, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/shell/logo";
import { buttonClass } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { BUSINESS } from "@/lib/business";
import { SiteFooter } from "./site-footer";

export const COMPANY = BUSINESS.shortName;
export const CIN = BUSINESS.cin;
export const SUPPORT_EMAIL = BUSINESS.email;

const LINKS = [
  ["/security", "Security"],
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/help", "Help"],
  ["/status", "Status"],
] as const;

export function PublicShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? "max-w-6xl" : "max-w-4xl";
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <header className="sticky top-3 z-30 px-3">
        <div className={`glass mx-auto flex h-14 ${width} items-center justify-between gap-3 rounded-2xl border px-3 sm:px-4`}>
          <Link href="/" aria-label="Kritvia home" className="rounded-md">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-1 text-sm text-muted md:flex" aria-label="Kritvia">
            {LINKS.map(([href, label]) => (
              <Link key={href} href={href} className="rounded-md px-2.5 py-1.5 transition-colors duration-150 hover:bg-surface-2 hover:text-fg">
                {label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className={buttonClass("ghost", "sm", "hidden sm:inline-flex")}>
              Sign in
            </Link>
            <Link href="/register" className={buttonClass("primary", "sm")}>
              Try free
            </Link>
            <details className="group relative md:hidden">
              <summary
                className="flex h-8 w-8 list-none items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden"
                aria-label="Menu"
              >
                <Menu className="h-4 w-4 group-open:hidden" aria-hidden />
                <X className="hidden h-4 w-4 group-open:block" aria-hidden />
              </summary>
              <nav
                aria-label="Kritvia"
                className="glass-strong absolute right-0 mt-3 w-52 animate-scale-in rounded-2xl border p-1.5 text-sm"
              >
                {[["/login", "Sign in"] as const, ...LINKS].map(([href, label]) => (
                  <Link key={href} href={href} className="block rounded-md px-3 py-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                    {label}
                  </Link>
                ))}
              </nav>
            </details>
          </div>
        </div>
      </header>
      <main id="main" className={`mx-auto w-full flex-1 ${width} px-4 py-10`}>
        {children}
      </main>
      <SiteFooter wide={wide} />
    </div>
  );
}

export function Doc({ title, updated, lead, children }: { title: string; updated?: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <PublicShell>
      <article className="animate-fade-up space-y-6 text-[15px] leading-relaxed text-muted [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-fg">
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

/** A legal page (Terms, Privacy) written as markdown, so the text matches the reviewed draft line for line. */
export function LegalDoc({ title, updated, markdown }: { title: string; updated: string; markdown: string }) {
  return (
    <PublicShell>
      <article className="animate-fade-up text-[15px] text-muted [&_h2]:text-fg [&_strong]:text-fg">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          <p className="mt-1 text-sm text-subtle">Last updated {updated}</p>
        </header>
        <Markdown className="text-[15px] [&_td]:min-w-[8rem] [&_td]:[overflow-wrap:normal] [&_th]:min-w-[8rem] [&_th]:[overflow-wrap:normal]">{markdown}</Markdown>
      </article>
    </PublicShell>
  );
}
