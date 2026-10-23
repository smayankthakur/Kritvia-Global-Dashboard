"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A countdown for "send again" buttons: `start()` begins it, `left` is the seconds remaining (0 = ready).
 * Unlike a one-shot flag, it re-arms every time, so a slow or lost email never leaves the person stuck.
 */
export function useCooldown(seconds: number, startNow = false) {
  const [until, setUntil] = useState<number>(() => (startNow ? Date.now() + seconds * 1000 : 0));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until <= now) return;
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [until, now]);

  const start = useCallback(() => {
    const t = Date.now();
    setNow(t);
    setUntil(t + seconds * 1000);
  }, [seconds]);

  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return { left, ready: left === 0, start };
}

/** Keeps only the digits of a pasted or typed code ("123 456", "123-456" → "123456"). */
export const digitsOnly = (s: string, max = 6) => s.replace(/\D/g, "").slice(0, max);
