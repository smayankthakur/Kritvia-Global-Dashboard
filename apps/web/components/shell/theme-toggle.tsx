"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { readCookie, writeCookie } from "@/lib/cookies-client";

type Theme = "light" | "dark" | "system";
const ORDER: Theme[] = ["system", "light", "dark"];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const t = readCookie("kv_theme");
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const apply = (t: Theme) => {
    setTheme(t);
    writeCookie("kv_theme", t);
    const el = document.documentElement;
    el.classList.remove("light", "dark");
    if (t !== "system") el.classList.add(t);
  };
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => apply(next)}
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
