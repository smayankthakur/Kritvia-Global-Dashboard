"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_SECONDS = 25 * 60;

function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function FocusTimerCard() {
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_SECONDS);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (secondsLeft === 0) {
      setRunning(false);
    }
  }, [secondsLeft]);

  const progress = useMemo(() => 1 - secondsLeft / DEFAULT_SECONDS, [secondsLeft]);
  const circumference = 2 * Math.PI * 58;
  const dashOffset = circumference * (1 - progress);

  function onReset(): void {
    setRunning(false);
    setSecondsLeft(DEFAULT_SECONDS);
  }

  return (
    <section className="kv-card kv-glass kv-focus-card">
      <div className="kv-focus-head">
        <h2 className="kv-section-title kv-serif">Focus Timer</h2>
        <span className="kv-pill">Pomodoro</span>
      </div>
      <div className="kv-focus-ring-wrap" aria-live="polite">
        <svg className="kv-focus-ring" viewBox="0 0 140 140" role="img" aria-label="Focus timer progress">
          <circle className="kv-focus-ring-track" cx="70" cy="70" r="58" />
          <circle
            className="kv-focus-ring-progress"
            cx="70"
            cy="70"
            r="58"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="kv-focus-time">{formatTimer(secondsLeft)}</div>
      </div>
      <div className="kv-row">
        <button type="button" className="kv-btn-primary" onClick={() => setRunning((current) => !current)}>
          {running ? "Pause" : "Start"}
        </button>
        <button type="button" className="kv-btn-ghost" onClick={onReset}>
          Reset
        </button>
      </div>
    </section>
  );
}
