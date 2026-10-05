"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/field";
import {
  allowed,
  CATEGORY_TEXT,
  categoriesInUse,
  gpcEnabled,
  needsBanner,
  OPTIONAL_TOOLS,
  readConsent,
  writeConsent,
  type Category,
  type ConsentRecord,
} from "@/lib/consent";

interface ConsentApi {
  record: ConsentRecord | null;
  gpc: boolean;
  allows: (c: Category) => boolean;
  openSettings: () => void;
}

const Ctx = createContext<ConsentApi>({ record: null, gpc: false, allows: () => false, openSettings: () => undefined });
export const useConsent = () => useContext(Ctx);

/**
 * Holds the visitor's cookie choice and shows the banner and settings when — and only when — an
 * optional tool is registered in lib/consent.ts. With none registered it renders its children and
 * nothing else.
 */
export function ConsentProvider({ children }: { children: ReactNode }) {
  const [record, setRecord] = useState<ConsentRecord | null>(null);
  const [gpc, setGpc] = useState(false);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    const load = () => {
      const g = gpcEnabled();
      let rec = readConsent();
      // A GPC signal is a choice already made: record "reject" and don't ask.
      if (!rec && g && OPTIONAL_TOOLS.length) rec = writeConsent([], OPTIONAL_TOOLS, true);
      setGpc(g);
      setRecord(rec);
      setReady(true);
    };
    load();
    window.addEventListener("kv-consent", load);
    return () => window.removeEventListener("kv-consent", load);
  }, []);

  const allows = useCallback((c: Category) => allowed(c, record, gpc), [record, gpc]);
  const value: ConsentApi = { record, gpc, allows, openSettings: () => setSettings(true) };
  return (
    <Ctx.Provider value={value}>
      {children}
      {ready && needsBanner(OPTIONAL_TOOLS, record) ? <ConsentBanner onSettings={() => setSettings(true)} /> : null}
      {OPTIONAL_TOOLS.length ? <ConsentSettings open={settings} onClose={() => setSettings(false)} record={record} gpc={gpc} /> : null}
    </Ctx.Provider>
  );
}

/** Renders its children (an optional script, widget or embed) only after the visitor opts in. */
export function ConsentGate({ category, children, fallback = null }: { category: Category; children: ReactNode; fallback?: ReactNode }) {
  return useConsent().allows(category) ? <>{children}</> : <>{fallback}</>;
}

/** "Cookie settings" link for the footer; hidden while there is nothing to choose. */
export function CookieSettingsLink({ className }: { className?: string }) {
  const { openSettings } = useConsent();
  if (!OPTIONAL_TOOLS.length) return null;
  return (
    <button type="button" onClick={openSettings} className={className}>
      Cookie settings
    </button>
  );
}

function ConsentBanner({ onSettings }: { onSettings: () => void }) {
  const all = categoriesInUse();
  return (
    <section
      aria-label="Cookie choices"
      className="glass-strong fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-2xl animate-fade-up rounded-2xl border p-4 shadow-[var(--shadow-lg)] sm:p-5"
    >
      <h2 className="text-sm font-semibold text-fg">Your choice about optional cookies</h2>
      <p className="mt-1 text-sm text-muted">
        Kritvia works without them. We&apos;d like to use a few optional tools ({all.map((c) => CATEGORY_TEXT[c].title.toLowerCase()).join(", ")}). Nothing optional loads unless you say yes.
        See our{" "}
        <Link href="/cookies" className="text-accent underline">
          Cookie Policy
        </Link>
        .
      </p>
      {/* Equal weight on purpose: rejecting is as easy as accepting. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => writeConsent([])}>Reject all</Button>
        <Button onClick={() => writeConsent(all)}>Accept all</Button>
        <Button variant="ghost" onClick={onSettings}>
          Choose
        </Button>
      </div>
    </section>
  );
}

function ConsentSettings({ open, onClose, record, gpc }: { open: boolean; onClose: () => void; record: ConsentRecord | null; gpc: boolean }) {
  const [picked, setPicked] = useState<Category[]>([]);
  useEffect(() => {
    if (open) setPicked(record?.granted ?? []);
  }, [open, record]);
  const toggle = (c: Category) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Cookie settings"
      description="Strictly necessary cookies keep you signed in and secure; they are always on. Everything else is off unless you turn it on."
      footer={
        <>
          <Button onClick={() => (writeConsent([]), onClose())}>Reject all</Button>
          <Button variant="primary" onClick={() => (writeConsent(picked), onClose())}>
            Save choices
          </Button>
        </>
      }
    >
      {gpc ? <p className="mb-3 text-sm text-muted">Your browser sends Global Privacy Control, so measurement and marketing stay off.</p> : null}
      <ul className="space-y-4">
        {categoriesInUse().map((c) => {
          const tools = OPTIONAL_TOOLS.filter((t) => t.category === c);
          const locked = gpc && c !== "functional";
          return (
            <li key={c} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-fg">{CATEGORY_TEXT[c].title}</p>
                <p className="text-xs text-subtle">{CATEGORY_TEXT[c].body}</p>
                <p className="mt-1 text-xs text-subtle">
                  {tools.map((t) => `${t.name} (${t.provider}): ${t.purpose}`).join("; ")}
                </p>
              </div>
              <Switch checked={!locked && picked.includes(c)} disabled={locked} onChange={() => toggle(c)} label={CATEGORY_TEXT[c].title} />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
