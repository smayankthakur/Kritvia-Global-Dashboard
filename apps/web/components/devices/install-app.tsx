"use client";

import { Download, Share, SquarePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { canPromptInstall, isInstalled, isIos, onInstallChange, promptInstall } from "@/lib/install";

/** "Use Kritvia like an app": the browser's install prompt, or the iPhone steps. Hidden once installed. */
export function InstallApp({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<{ installed: boolean; prompt: boolean; ios: boolean } | null>(null);
  useEffect(() => {
    const read = () => setState({ installed: isInstalled(), prompt: canPromptInstall(), ios: isIos() });
    read();
    return onInstallChange(read);
  }, []);
  if (!state || state.installed) return null;
  if (state.prompt) {
    return (
      <div className={compact ? "" : "rounded-lg border border-border p-3"}>
        {compact ? null : <p className="mb-2 text-sm">Put Kritvia on your home screen. It opens full screen, like an app.</p>}
        <Button variant="primary" icon={<Download className="h-4 w-4" />} onClick={() => void promptInstall()}>
          Install Kritvia
        </Button>
      </div>
    );
  }
  if (state.ios) {
    return (
      <div className="rounded-lg border border-border p-3 text-sm">
        <p className="mb-1 font-medium">Add Kritvia to your home screen</p>
        <p className="text-muted">
          In Safari, tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> Share, then{" "}
          <SquarePlus className="inline h-4 w-4 align-text-bottom" aria-hidden /> <strong>Add to Home Screen</strong>.
        </p>
      </div>
    );
  }
  return compact ? null : (
    <p className="rounded-lg border border-border p-3 text-sm text-muted">
      To use Kritvia like an app, open your browser&apos;s menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.
    </p>
  );
}
