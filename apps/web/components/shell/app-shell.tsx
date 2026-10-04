"use client";

import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Menu, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { useAccess } from "@/lib/access";
import { AskDialog } from "./ask-dialog";
import { LogoMark } from "./logo";
import { SidebarContent } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { VoiceBubble } from "@/components/voice/voice-bubble";
import { useVoice, VoiceProvider } from "@/components/voice/voice-provider";
import { VoiceButton } from "./voice-button";

function initials(name: string | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <VoiceProvider>
      <Shell>{children}</Shell>
      <VoiceBubble />
    </VoiceProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me } = useAccess();
  const { setAskHandler } = useVoice();
  const [menuOpen, setMenuOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askSeed, setAskSeed] = useState<string | undefined>(undefined);

  // "Ask" mode of the voice widget opens this dialog with the dictated question
  useEffect(() => {
    setAskHandler((q) => {
      setAskSeed(q);
      setAskOpen(true);
    });
    return () => setAskHandler(null);
  }, [setAskHandler]);
  const [signingOut, setSigningOut] = useState(false);
  const pathname = usePathname();
  const qc = useQueryClient();

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setAskOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      qc.clear();
      window.location.assign("/login");
    }
  };

  return (
    <div className="min-h-dvh lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-surface lg:block" aria-label="Sidebar">
        <SidebarContent />
      </aside>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} side="left" title="Navigation">
        <div className="-mx-5 -my-4 h-full">
          <SidebarContent onNavigate={() => setMenuOpen(false)} />
        </div>
      </Sheet>

      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-surface/80 px-3 backdrop-blur-md backdrop-saturate-150 sm:px-5">
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
          <Menu className="h-5 w-5" />
        </Button>
        <LogoMark className="h-6 w-6 lg:hidden" />
        <button
          type="button"
          onClick={() => setAskOpen(true)}
          className="group ml-1 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface-2/70 px-3 text-left text-sm text-subtle transition-[border-color,color,background-color,box-shadow] duration-150 hover:border-border-strong hover:bg-surface hover:text-muted hover:shadow-card sm:max-w-md"
          aria-label="Ask Kritvia (Command K)"
        >
          <Search className="h-4 w-4 shrink-0 transition-colors duration-150 group-hover:text-accent" aria-hidden />
          <span className="truncate">Ask anything across ventures…</span>
          <kbd className="ml-auto hidden rounded border border-border bg-surface px-1.5 font-sans text-[11px] text-subtle sm:inline">
            ⌘K
          </kbd>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <VoiceButton />
          <ThemeToggle />
          <div className="ml-1 hidden items-center gap-2 border-l border-border pl-3 sm:flex">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-soft-fg ring-1 ring-accent/20"
              aria-hidden
            >
              {initials(me?.full_name)}
            </span>
            <div className="hidden max-w-[10rem] leading-tight md:block">
              <div className="truncate text-[13px] font-medium">{me?.full_name ?? "…"}</div>
              <div className="truncate text-[11px] text-subtle">{me?.email}</div>
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={signOut} loading={signingOut}>
            {signingOut ? null : <LogOut className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1400px] px-4 pt-6 pb-28 sm:px-6 lg:px-8">
        {children}
      </main>

      <AskDialog
        open={askOpen}
        initialQuestion={askSeed}
        onClose={() => {
          setAskOpen(false);
          setAskSeed(undefined);
        }}
      />
    </div>
  );
}
