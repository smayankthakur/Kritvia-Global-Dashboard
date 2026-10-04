import { CheckCircle2, Languages, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ApprovalPreview } from "@/components/public/approval-preview";
import { Logo } from "./logo";

const POINTS = [
  { icon: CheckCircle2, text: "Agents draft replies, proposals and follow-ups. You approve what goes out." },
  { icon: Languages, text: "Works in Hindi, Hinglish and English." },
  { icon: ShieldCheck, text: "Each business sealed off in the database, encrypted per business." },
];

/** Sign-in and sign-up frame: the form on the right, what Kritvia does on the left (large screens). */
export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(28rem,36rem)]">
      <aside className="relative isolate hidden flex-col justify-between overflow-hidden border-r border-border bg-surface px-12 py-10 lg:flex">
        <div className="kv-grid-bg pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <Logo />
        <div className="mx-auto w-full max-w-lg">
          <h2 className="text-3xl leading-tight font-bold tracking-tight text-fg">
            Your business, run by agents <span className="text-accent">you approve.</span>
          </h2>
          <ul className="mt-6 space-y-3">
            {POINTS.map((p) => (
              <li key={p.text} className="flex gap-3 text-sm text-muted">
                <p.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                {p.text}
              </li>
            ))}
          </ul>
          <ApprovalPreview className="mt-10" />
        </div>
        <p className="text-xs text-subtle">© {new Date().getFullYear()} Sitelytc Digital Media Pvt. Ltd.</p>
      </aside>
      <div className="relative isolate flex flex-col items-center justify-center px-4 py-10">
        <div className="kv-grid-bg pointer-events-none absolute inset-0 -z-10 lg:hidden" aria-hidden />
        <div className="w-full max-w-[400px] animate-fade-up">
          <Logo className="mb-8 justify-center lg:hidden" />
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-pop sm:p-8">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
            <div className="mt-6">{children}</div>
          </div>
          {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
        </div>
      </div>
    </main>
  );
}
