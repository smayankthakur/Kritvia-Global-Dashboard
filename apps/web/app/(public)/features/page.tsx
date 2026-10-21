import type { Metadata } from "next";
import Link from "next/link";
import { Doc } from "@/components/public/doc-page";
import { buttonClass } from "@/components/ui/button";
import { FEATURES, UNDERNEATH } from "@/lib/features";
import { INDEX, share } from "@/lib/site";

const TITLE = "What Kritvia does";
const DESCRIPTION =
  "Every job Kritvia's AI agents do for an Indian business: WhatsApp and email replies, proposals, invoices and UPI, bookings, reviews, calls and more.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: INDEX,
  alternates: { canonical: "/features" },
  ...share(TITLE, DESCRIPTION, "/features"),
};

export default function FeaturesPage() {
  return (
    <Doc
      title="What Kritvia does, job by job"
      lead="Kritvia is a set of AI agents for Indian small businesses. They read your messages, draft the work in Hindi, Hinglish or English, and wait for your yes before anything is sent, paid or changed. Here is each job, and which plan includes it."
    >
      <nav aria-label="On this page" className="glass rounded-2xl border p-4">
        <p className="text-xs font-semibold tracking-wider text-subtle uppercase">On this page</p>
        <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f.id} className="!ml-0 !list-none">
              <a href={`#${f.id}`} className="text-accent hover:underline">
                {f.title}
              </a>
            </li>
          ))}
          <li className="!ml-0 !list-none">
            <a href="#underneath" className="text-accent hover:underline">
              What every agent shares
            </a>
          </li>
        </ul>
      </nav>

      {FEATURES.map((f) => (
        <section key={f.id} aria-labelledby={f.id} className="scroll-mt-24">
          <h2 id={f.id}>{f.title}</h2>
          <p className="mt-2 text-fg">{f.answer}</p>
          <ul className="mt-3 space-y-1.5">
            {f.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            <strong>Plans:</strong> {f.plans}
          </p>
        </section>
      ))}

      <section aria-labelledby="underneath" className="scroll-mt-24">
        <h2 id="underneath">What every agent shares</h2>
        <ul className="mt-3 space-y-1.5">
          {UNDERNEATH.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          More on this in{" "}
          <Link href="/security" className="font-medium text-accent hover:underline">
            how Kritvia keeps your business safe
          </Link>
          .
        </p>
      </section>

      <section aria-label="Try Kritvia" className="glass mt-10 rounded-2xl border p-6 text-center">
        <p className="text-base font-semibold text-fg">Try it on your own business for 15 days, free.</p>
        <p className="mt-1 text-sm">No card needed. Compare the plans on the pricing table.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          <Link href="/register" className={buttonClass("primary", "md")}>
            Start free trial
          </Link>
          <Link href="/welcome#pricing" className={buttonClass("secondary", "md")}>
            See pricing
          </Link>
        </div>
      </section>
    </Doc>
  );
}
