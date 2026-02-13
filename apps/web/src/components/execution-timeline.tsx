"use client";

import { DealTimelineMilestone } from "../lib/api";

interface ExecutionTimelineProps {
  milestones: DealTimelineMilestone[];
  totalCycleHours: number | null;
}

const milestoneLabels: Record<DealTimelineMilestone["type"], string> = {
  LEAD_CREATED: "Lead Created",
  DEAL_CREATED: "Deal Created",
  WORK_ROOT_CREATED: "Work Root Created",
  INVOICE_SENT: "Invoice Sent",
  INVOICE_PAID: "Invoice Paid"
};

function formatDuration(hours: number | null): string {
  if (hours === null) {
    return "-";
  }
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function ExecutionTimeline({ milestones, totalCycleHours }: ExecutionTimelineProps) {
  if (milestones.length === 0) {
    return (
      <div className="kv-card kv-state" role="status" aria-live="polite">
        <h2 className="kv-section-title">Execution Timeline</h2>
        <p className="kv-subtitle">No lifecycle data yet.</p>
      </div>
    );
  }

  return (
    <section className="kv-card" aria-label="Execution timeline">
      <div className="kv-row" style={{ justifyContent: "space-between" }}>
        <h2 className="kv-section-title" style={{ margin: 0 }}>
          Execution Timeline
        </h2>
        <span className="kv-pill">Total Cycle: {formatDuration(totalCycleHours)}</span>
      </div>

      <ol className="kv-timeline">
        {milestones.map((milestone) => (
          <li key={`${milestone.type}-${milestone.timestamp}`} className="kv-timeline-item">
            <div className="kv-timeline-dot" aria-hidden="true" />
            <div className="kv-timeline-content" aria-label={milestoneLabels[milestone.type]}>
              <div className="kv-row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
                <strong>{milestoneLabels[milestone.type]}</strong>
                {milestone.isBottleneck ? (
                  <span className="kv-badge-danger" aria-label="Delayed milestone">
                    Delayed
                  </span>
                ) : null}
              </div>
              <p className="kv-subtitle" style={{ marginTop: "0.25rem" }}>
                {new Date(milestone.timestamp).toLocaleString()}
              </p>
              {milestone.durationFromPreviousHours !== null ? (
                <p className="kv-subtitle" style={{ marginTop: "0.25rem" }}>
                  Duration from previous: {formatDuration(milestone.durationFromPreviousHours)}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ExecutionTimelineSkeleton() {
  return (
    <section className="kv-card" aria-label="Execution timeline loading">
      <h2 className="kv-section-title">Execution Timeline</h2>
      <div className="kv-stack">
        {[0, 1, 2].map((idx) => (
          <div key={idx} className="kv-timeline-skeleton" />
        ))}
      </div>
    </section>
  );
}

interface ExecutionTimelineErrorProps {
  message: string;
  onRetry: () => void;
}

export function ExecutionTimelineError({ message, onRetry }: ExecutionTimelineErrorProps) {
  return (
    <section className="kv-card kv-state" aria-label="Execution timeline error">
      <h2 className="kv-section-title">Execution Timeline</h2>
      <p className="kv-error">{message}</p>
      <button type="button" onClick={onRetry} style={{ marginTop: "0.5rem" }}>
        Retry
      </button>
    </section>
  );
}
