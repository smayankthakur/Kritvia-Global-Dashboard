"use client";

import { useEffect, useRef, useState } from "react";

export type MicCheck = "off" | "asking" | "listening" | "denied" | "no-device" | "error";

/** Live microphone level (0..1) without recording: for the "can we hear you?" step. */
export function useMicLevel(active: boolean, attempt = 0): { level: number; status: MicCheck } {
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<MicCheck>("off");
  const stop = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    setStatus("asking");
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let last = 0;
        const tick = (t: number) => {
          if (t - last > 80) {
            last = t;
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += ((v - 128) / 128) ** 2;
            setLevel(Math.round(Math.min(1, Math.sqrt(sum / buf.length) * 3) * 20) / 20);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        setStatus("listening");
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof Error ? e.name : "";
        setStatus(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "no-device" : "error");
      }
    })();
    stop.current = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      setLevel(0);
    };
    return () => stop.current();
  }, [active, attempt]);

  return { level, status: active ? status : "off" };
}
