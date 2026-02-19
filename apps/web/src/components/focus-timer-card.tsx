"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_MINUTES = 90;
const STORAGE_KEY = "focusTimerMinutes";

function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function FocusTimerCard() {
  const [configuredMinutes, setConfiguredMinutes] = useState(DEFAULT_MINUTES);
  const [editMinutes, setEditMinutes] = useState(String(DEFAULT_MINUTES));
  const [editError, setEditError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_MINUTES * 60);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 180) {
      return;
    }
    setConfiguredMinutes(parsed);
    setEditMinutes(String(parsed));
    setSecondsLeft(parsed * 60);
  }, []);

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

  const configuredSeconds = configuredMinutes * 60;
  const progress = useMemo(() => 1 - secondsLeft / configuredSeconds, [secondsLeft, configuredSeconds]);
  const circumference = 2 * Math.PI * 58;
  const dashOffset = circumference * (1 - progress);

  function onReset(): void {
    setRunning(false);
    setSecondsLeft(configuredSeconds);
  }

  function onSaveDuration(): void {
    const nextMinutes = Number(editMinutes);
    if (!Number.isFinite(nextMinutes) || nextMinutes < 1 || nextMinutes > 180) {
      setEditError("Set minutes between 1 and 180.");
      return;
    }
    setConfiguredMinutes(nextMinutes);
    setSecondsLeft(nextMinutes * 60);
    setRunning(false);
    setEditError(null);
    window.localStorage.setItem(STORAGE_KEY, String(nextMinutes));
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
      <div className="kv-focus-edit">
        <label htmlFor="focusMinutes" className="kv-note">
          Duration (minutes)
        </label>
        <div className="kv-row">
          <input
            id="focusMinutes"
            type="number"
            min={1}
            max={180}
            value={editMinutes}
            onChange={(event) => setEditMinutes(event.target.value)}
            className="kv-focus-edit-input"
          />
          <button type="button" className="kv-btn-ghost" onClick={onSaveDuration}>
            Edit
          </button>
        </div>
        {editError ? <p className="kv-error">{editError}</p> : null}
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
