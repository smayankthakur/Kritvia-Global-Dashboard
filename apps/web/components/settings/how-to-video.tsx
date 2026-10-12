"use client";

import { PlayCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export const CONNECT_VIDEO = "/videos/connect-apps.mp4";
export const CONNECT_VIDEO_WEBM = "/videos/connect-apps.webm";
export const CONNECT_POSTER = "/videos/connect-apps.jpg";

/** The video has no sound: these are the same steps in words (shown under the video). */
export const CONNECT_STEPS: readonly string[] = [
  "Open Settings → Connectors for your business.",
  "Google: Connect Google and sign in. Approved emails and invites go out from your own Gmail.",
  "Email forwarding: Set up forwarding gives your business its own Kritvia address; forward your mail to it.",
  "WhatsApp: Connect WhatsApp, log in with Facebook and pick your number (about 2 minutes).",
  "Telegram: make a bot with @BotFather, paste its token under Telegram bot, and share its t.me link.",
  "Slack: add Slack's Incoming Webhooks app to a channel and paste its address under Slack.",
  "Tally: Import from Tally with an XML export.",
  "Other apps: on the Assistant page, add any app's MCP server address under Connected apps.",
  "Customer chats from WhatsApp and Telegram then appear on the Chats page, with replies for you to approve.",
];

/** "Watch how" button and the walkthrough video of connecting apps. */
export function ConnectVideo({ label = "Watch how to connect your apps (1 min)" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" icon={<PlayCircle className="h-4 w-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="xl" title="How to connect your apps" description="A one-minute walkthrough without sound; the steps are written below it.">
        {open ? (
          <div className="space-y-4">
            {/* No audio track: the steps below are the text alternative. */}
            <video
              poster={CONNECT_POSTER}
              controls
              autoPlay
              muted
              playsInline
              preload="metadata"
              className="aspect-video w-full rounded-lg border border-border bg-black"
              aria-describedby="connect-video-steps"
            >
              {/* H.264 for Safari and most browsers; VP9 for browsers without H.264 */}
              <source src={CONNECT_VIDEO} type="video/mp4" />
              <source src={CONNECT_VIDEO_WEBM} type="video/webm" />
            </video>
            <ol id="connect-video-steps" className="list-decimal space-y-1 pl-5 text-sm text-muted">
              {CONNECT_STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
