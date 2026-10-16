"use client";

import { Languages } from "lucide-react";
import { useEffect, useState } from "react";
import { setLang, startHindi, storedLang, type Lang } from "@/lib/i18n/translate";

/** Turns on the Hindi interface after the page has loaded (so server and browser render the same HTML). */
export function LanguageRoot() {
  useEffect(() => {
    if (storedLang() !== "hi") return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@/lib/i18n/hi.json").then((m) => {
      if (!cancelled) stop = startHindi(m.default as Record<string, string>);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return null;
}

/** "हिन्दी / English": the interface language for this browser. Legal pages stay in English. */
export function LanguageSwitch({ className }: { className?: string }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => setLangState(storedLang()), []);
  const next: Lang = lang === "hi" ? "en" : "hi";
  return (
    <button
      type="button"
      translate="no"
      lang={next}
      onClick={() => setLang(next)}
      className={className ?? "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-fg"}
      aria-label={next === "hi" ? "हिन्दी में देखें (Switch to Hindi)" : "View in English (अंग्रेज़ी में देखें)"}
    >
      <Languages className="h-4 w-4" aria-hidden />
      {next === "hi" ? "हिन्दी" : "English"}
    </button>
  );
}

/** Shown above legal text in Hindi mode: the English text is the binding one. */
export function LegalLanguageNote() {
  const [hi, setHi] = useState(false);
  useEffect(() => setHi(storedLang() === "hi"), []);
  if (!hi) return null;
  return (
    <p className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm" lang="hi" translate="no">
      क़ानूनी पाठ सिर्फ़ अंग्रेज़ी में है, और अंग्रेज़ी पाठ ही मान्य है।
    </p>
  );
}
