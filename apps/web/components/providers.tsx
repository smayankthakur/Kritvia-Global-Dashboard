"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { LanguageRoot } from "@/components/i18n/language";
import { ConsentProvider } from "@/components/legal/consent";
import { ScrollActivity } from "@/components/shell/scroll-activity";
import { ToastProvider } from "@/components/ui/toast";
import { listenForInstall } from "@/lib/install";
import { registerServiceWorker } from "@/lib/pwa";
import { makeQueryClient } from "@/lib/query";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  useEffect(registerServiceWorker, []);
  useEffect(listenForInstall, []);
  return (
    <QueryClientProvider client={client}>
      {/* Animations made with motion follow the visitor's reduced-motion setting. */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <ConsentProvider>{children}</ConsentProvider>
        </ToastProvider>
        <ScrollActivity />
        <LanguageRoot />
      </MotionConfig>
    </QueryClientProvider>
  );
}
