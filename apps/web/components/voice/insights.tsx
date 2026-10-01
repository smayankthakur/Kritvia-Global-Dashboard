"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { hotkeyLabel } from "@/lib/voice/hotkey";
import { useVoice } from "./voice-provider";

type Insights = Schemas["InsightsOut"];

const ENGINE_LABEL: Record<string, string> = { sarvam: "Sarvam", whisper: "Whisper (hosted)", local: "Local (on our server)" };
const SURFACE_LABEL: Record<string, string> = { web: "Web app", desktop: "Desktop companion" };
const MODE_LABEL: Record<string, string> = { type: "Typed into a field", note: "Saved as a note", ask: "Asked Kritvia" };

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Sequential single hue (the accent) in four steps; empty days use a neutral surface. */
function step(words: number, max: number): number {
  if (words <= 0 || max <= 0) return 0;
  const r = words / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}
const STEP_CLASS = ["bg-surface-3", "bg-accent/25", "bg-accent/50", "bg-accent/75", "bg-accent"];

export function ActivityHeatmap({ days, weeks = 12 }: { days: Insights["days"]; weeks?: number }) {
  const [hover, setHover] = useState<{ day: string; words: number; n: number; x: number; y: number } | null>(null);
  const grid = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end);
    start.setDate(end.getDate() - (weeks * 7 - 1));
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday: one column per week
    const cells: { day: string; words: number; n: number; future: boolean }[] = [];
    const d = new Date(start);
    while (d <= end || cells.length % 7 !== 0) {
      const key = isoDay(d);
      const row = byDay.get(key);
      cells.push({ day: key, words: row?.words ?? 0, n: row?.dictations ?? 0, future: d > end });
      d.setDate(d.getDate() + 1);
    }
    const max = Math.max(0, ...cells.map((c) => c.words));
    return { cells, max };
  }, [days, weeks]);

  const cols = grid.cells.length / 7;
  return (
    <div className="relative">
      <div
        className="grid grid-flow-col gap-[3px]"
        style={{ gridTemplateRows: "repeat(7, 12px)", gridTemplateColumns: `repeat(${cols}, 12px)` }}
        role="img"
        aria-label={`Dictation activity over the last ${weeks} weeks`}
        onMouseLeave={() => setHover(null)}
      >
        {grid.cells.map((c) => (
          <div
            key={c.day}
            className={`h-3 w-3 rounded-[3px] ${c.future ? "bg-transparent" : STEP_CLASS[step(c.words, grid.max)]}`}
            onMouseEnter={(e) => {
              if (c.future) return;
              const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
              const t = e.currentTarget.getBoundingClientRect();
              setHover({ day: c.day, words: c.words, n: c.n, x: t.left - r.left + 6, y: t.top - r.top });
            }}
          />
        ))}
      </div>
      {hover ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-[var(--shadow-lg)]"
          style={{ left: hover.x, top: hover.y - 6 }}
        >
          <div className="font-medium">{new Date(hover.day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</div>
          <div className="text-muted tabular-nums">
            {hover.words.toLocaleString("en-IN")} words · {hover.n} dictation{hover.n === 1 ? "" : "s"}
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-subtle" aria-hidden>
        Less
        {STEP_CLASS.map((c) => (
          <span key={c} className={`h-2.5 w-2.5 rounded-[2px] ${c}`} />
        ))}
        More
      </div>
      <table className="sr-only">
        <caption>Words dictated per day</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{d.words} words</td>
              <td>{d.dictations} dictations</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One series per panel, so one hue; the value is written beside the bar in text ink. */
export function BreakdownBars({ title, rows, labels }: { title: string; rows: Insights["by_engine"]; labels?: Record<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => r.words));
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-subtle">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-subtle">—</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="group" title={`${r.words.toLocaleString("en-IN")} words in ${r.dictations} dictations`}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
                <span className="truncate">{labels?.[r.key] ?? r.key.toUpperCase()}</span>
                <span className="text-muted tabular-nums">{r.words.toLocaleString("en-IN")}</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface-3">
                <div className="h-1.5 rounded-full bg-accent group-hover:bg-accent-hover" style={{ width: `${(r.words / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const LANG_NAMES: Record<string, string> = {
  en: "English", hi: "Hindi", bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi", gu: "Gujarati", kn: "Kannada",
  ml: "Malayalam", pa: "Punjabi", or: "Odia", od: "Odia", ur: "Urdu", unknown: "Unknown",
};

export function VoiceInsights({ ventureId }: { ventureId: string }) {
  const voice = useVoice();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [scope, setScope] = useState<"venture" | "all">("all");
  const q = useQuery({
    queryKey: ["dictation-insights", scope, ventureId],
    queryFn: () =>
      unwrap(api.GET("/me/dictation/insights", { params: { query: scope === "venture" ? { venture_id: ventureId } : {} } })),
  });
  const clear = useMutation({
    mutationFn: () => unwrap(api.DELETE("/me/dictation/history")),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dictation-insights"] });
      toast.success("Dictation statistics cleared");
      setConfirm(false);
    },
    onError: (e) => toast.error("Could not clear", errorMessage(e)),
  });
  if (q.isPending) return <SkeletonRows />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Scope" className="inline-flex rounded-md border border-border p-0.5">
          {(["all", "venture"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className={`rounded px-2.5 py-1 text-xs ${scope === s ? "bg-accent-soft font-medium text-accent-soft-fg" : "text-muted hover:bg-surface-2"}`}
            >
              {s === "all" ? "All ventures" : "This venture"}
            </button>
          ))}
        </div>
        <span className="text-xs text-subtle">Only your own dictation. Kritvia stores counts, never the words or audio.</span>
      </div>
      {d.dictations === 0 ? (
        <Card>
          <EmptyState
            icon={Mic}
            title="No dictation yet"
            description={`Hold ${hotkeyLabel(voice.settings.hotkey)} anywhere in Kritvia, speak, and release — or click the floating mic. Your words land in the field you were typing in.`}
          />
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <StatGrid className="sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Dictations" value={d.dictations.toLocaleString("en-IN")} />
              <Stat label="Words" value={d.words.toLocaleString("en-IN")} />
              <Stat
                label="Average speed"
                value={d.avg_wpm ? `${d.avg_wpm} wpm` : "—"}
                hint={d.avg_wpm ? "vs ~40 wpm typing" : "after a few minutes of dictation"}
              />
              <Stat label="Time saved" value={d.time_saved_minutes >= 120 ? `${Math.round(d.time_saved_minutes / 60)} h` : `${d.time_saved_minutes} min`} hint="compared with typing" tone="success" />
              <Stat label="Streak" value={`${d.streak_days} day${d.streak_days === 1 ? "" : "s"}`} />
              <Stat label="Vocabulary" value={d.vocabulary_terms} hint="terms that fix spelling" />
            </StatGrid>
          </Card>
          <Card>
            <CardHeader title="Activity" description="Words dictated per day, last 12 weeks" />
            <div className="overflow-x-auto p-4">
              <ActivityHeatmap days={d.days} />
            </div>
          </Card>
          <Card className="grid gap-6 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <BreakdownBars title="Engine" rows={d.by_engine} labels={ENGINE_LABEL} />
            <BreakdownBars title="Language" rows={d.by_language} labels={LANG_NAMES} />
            <BreakdownBars title="Where" rows={d.by_surface} labels={SURFACE_LABEL} />
            <BreakdownBars title="What for" rows={d.by_mode} labels={MODE_LABEL} />
          </Card>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
              Clear my statistics
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Clear your dictation statistics?"
        description="Removes your counts, streak and activity history. Your vocabulary and notes are not affected."
        confirmLabel="Clear"
        loading={clear.isPending}
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}
