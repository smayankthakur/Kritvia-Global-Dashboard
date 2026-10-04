import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiUrl } from "@/lib/bff/auth";
import { noticeText, type Lang, type NoticeData } from "@/lib/notice";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(id: string): Promise<NoticeData | null> {
  if (!UUID.test(id)) return null;
  try {
    const r = await fetch(`${apiUrl()}/public/notice/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    return r.ok ? ((await r.json()) as NoticeData) : null;
  } catch {
    return null;
  }
}

type Props = { params: Promise<{ ventureId: string }>; searchParams: Promise<{ lang?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = await load((await params).ventureId);
  return {
    title: d ? `Privacy notice · ${d.business_name}` : "Privacy notice",
    robots: { index: false, follow: false },
  };
}

/** A business's DPDP notice to its own customers. Public, read-only, English or Hindi. */
export default async function NoticePage({ params, searchParams }: Props) {
  const { ventureId } = await params;
  const lang: Lang = (await searchParams).lang === "hi" ? "hi" : "en";
  const d = await load(ventureId);
  if (!d) notFound();
  const t = noticeText(d, lang);
  const updated = new Date(d.updated_at).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <main id="main" lang={lang === "hi" ? "hi" : "en-IN"} className="mx-auto max-w-2xl px-4 py-10 text-[15px] leading-relaxed text-muted">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-accent">{d.business_name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{t.title}</h1>
          <p className="mt-1 text-sm text-subtle">
            {t.updated} {updated}
          </p>
        </div>
        <Link href={`?lang=${lang === "hi" ? "en" : "hi"}`} className="rounded-md border border-border px-3 py-1.5 text-sm text-fg hover:bg-surface-2">
          {t.other}
        </Link>
      </header>
      <p className="text-fg">{t.intro}</p>

      <h2 className="mt-8 text-lg font-semibold text-fg">{t.collectH}</h2>
      <ul className="mt-3 space-y-3">
        {t.items.map((i) => (
          <li key={i.what} className="rounded-lg border border-border bg-surface p-4">
            <p className="font-medium text-fg">{i.what}</p>
            <p className="mt-1 text-sm">{i.why}</p>
            {i.local ? (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-success-fg">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {t.localNote}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-lg font-semibold text-fg">{t.howH}</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        {t.how.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>

      <h2 className="mt-8 text-lg font-semibold text-fg">{t.rightsH}</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        {t.rights.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>

      <h2 className="mt-8 text-lg font-semibold text-fg">{t.contactH}</h2>
      <p className="mt-3">{t.contact}</p>
      <p className="mt-2">
        <a href={`mailto:${d.contact_email}`} className="font-medium text-accent hover:underline">
          {d.contact_email}
        </a>
      </p>
      <p className="mt-2 text-sm">{t.reply}</p>

      <footer className="mt-12 border-t border-border pt-4 text-xs text-subtle">
        {t.poweredBy} ·{" "}
        <Link href="/privacy" className="hover:text-fg">
          Kritvia
        </Link>
      </footer>
    </main>
  );
}
