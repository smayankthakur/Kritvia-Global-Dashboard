"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { registerServiceWorker } from "@/lib/pwa";
import { makeQueryClient } from "@/lib/query";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  useEffect(registerServiceWorker, []);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
