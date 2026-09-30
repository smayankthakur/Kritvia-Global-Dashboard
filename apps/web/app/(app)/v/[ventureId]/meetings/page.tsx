"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, Mic, Plus, Square, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input } from "@/components/ui/field";
import { FileDrop } from "@/components/ui/file-drop";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatBytes, formatDateTime, formatTimestamp } from "@/lib/format";
import { extensionFor, useRecorder } from "@/lib/recorder";
import { useVenture } from "@/lib/venture";

function Recorder({ onRecorded }: { onRecorded: (f: File) => void }) {
  const rec = useRecorder();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const recording = rec.state === "recording";
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        {recording ? (
          <Button
            variant="danger"
            icon={<Square className="h-4 w-4" />}
            onClick={async () => {
              const blob = await rec.stop();
              if (!blob) return;
              const name = `meeting-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${extensionFor(blob.type)}`;
              const file = new File([blob], name, { type: blob.type });
              if (url) URL.revokeObjectURL(url);
              setUrl(URL.createObjectURL(blob));
              onRecorded(file);
            }}
          >
            Stop recording
          </Button>
        ) : (
          <Button icon={<Mic className="h-4 w-4" />} onClick={() => void rec.start()} disabled={!rec.supported || rec.state === "stopping"}>
            Record in browser
          </Button>
        )}
        {recording ? (
          <span className="flex items-center gap-1.5 text-sm text-danger" aria-live="polite">
            <Circle className="h-2.5 w-2.5 animate-pulse fill-current" aria-hidden /> Recording {formatTimestamp(rec.elapsed)}
          </span>
        ) : (
          <span className="text-xs text-subtle">{rec.supported ? "Uses your microphone. Tell attendees they are being recorded." : "Recording isn't supported in this browser."}</span>
        )}
      </div>
      {rec.error ? <p className="mt-2 text-sm text-danger">{rec.error}</p> : null}
      {url && !recording ? <audio controls src={url} className="mt-3 w-full" aria-label="Recorded audio preview" /> : null}
    </div>
  );
}

export default function MeetingsPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [speakers, setSpeakers] = useState<{ label: string; name: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [started, setStarted] = useState<Record<string, string>>({}); // document_id -> run_id (this session)

  const docs = useQuery({
    queryKey: ["documents", v.id, "meeting"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/documents", { params: { path: { venture_id: v.id }, query: { kind: "meeting", limit: 100 } } })),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status !== "ready" && d.status !== "error") ? 5000 : false),
  });
  const runs = useQuery({
    queryKey: ["runs", v.id, { workflow: "meeting_digest" }],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/runs", { params: { path: { venture_id: v.id }, query: { workflow: "meeting_digest", limit: 200 } } })),
  });
  const runByTitle = useMemo(() => {
    const m = new Map<string, { id: string; status: string }>();
    for (const r of runs.data ?? []) if (!m.has(r.title)) m.set(r.title, { id: r.id, status: r.status });
    return m;
  }, [runs.data]);
  const runById = useMemo(
    () => new Map((runs.data ?? []).map((r) => [r.id, { id: r.id, status: r.status }] as const)),
    [runs.data],
  );

  const up = useMutation({
    mutationFn: () => {
      const names = Object.fromEntries(speakers.filter((s) => s.label.trim() && s.name.trim()).map((s) => [s.label.trim(), s.name.trim()]));
      return unwrap(
        api.POST("/ventures/{venture_id}/meetings", {
          params: { path: { venture_id: v.id } },
          body: multipart<Schemas["Body_upload_meeting_ventures__venture_id__meetings_post"]>({
            file: files[0]!,
            title: title.trim(),
            sensitive,
            speaker_names: Object.keys(names).length ? JSON.stringify(names) : null,
          }),
        }),
      );
    },
    onSuccess: (out) => {
      setStarted((s) => ({ ...s, [out.document_id]: out.run_id }));
      toast.success("Recording uploaded", "Transcription and digest are running.");
      setFiles([]);
      setTitle("");
      setSpeakers([]);
      void qc.invalidateQueries({ queryKey: ["documents", v.id] });
      void qc.invalidateQueries({ queryKey: ["runs", v.id] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!files.length) errs.file = "Choose or record audio";
    if (!title.trim()) errs.title = "Give the meeting a title";
    setErrors(errs);
    if (!Object.keys(errs).length) up.mutate();
  };

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Meetings"
        description="Upload or record a meeting. It is transcribed, speakers are separated, and decisions and tasks are extracted with timestamp citations."
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_26rem]">
        <Card className="order-2 xl:order-1">
          <CardHeader title="Recordings" />
          <QueryState query={docs} empty={<EmptyState icon={Mic} title="No meetings yet" description="Your first digest will appear here a few minutes after upload." />}>
            {(data) => (
              <Table label="Meeting recordings">
                <THead>
                  <tr>
                    <Th>Meeting</Th>
                    <Th>Status</Th>
                    <Th className="hidden md:table-cell">Recorded</Th>
                    <Th className="text-right">Links</Th>
                  </tr>
                </THead>
                <TBody>
                  {data.map((d) => {
                    const meta = (d.meta ?? {}) as { transcript_document_id?: string; duration_s?: number; run_id?: string };
                    const run = started[d.id]
                      ? { id: started[d.id]!, status: "" }
                      : meta.run_id
                        ? (runById.get(meta.run_id) ?? { id: meta.run_id, status: "" })
                        : runByTitle.get(`Meeting: ${d.title.slice(0, 120)}`);
                    return (
                      <Tr key={d.id}>
                        <Td className="max-w-[16rem]">
                          <Link href={`/v/${v.id}/knowledge/${d.id}`} className="block truncate font-medium hover:text-accent">
                            {d.title}
                          </Link>
                          <span className="text-xs text-subtle">
                            {formatBytes(d.size_bytes)}
                            {meta.duration_s ? ` · ${formatTimestamp(meta.duration_s)}` : ""}
                          </span>
                        </Td>
                        <Td>
                          <StatusBadge status={d.status} />
                        </Td>
                        <Td className="hidden whitespace-nowrap text-muted md:table-cell">{formatDateTime(d.created_at)}</Td>
                        <Td className="text-right">
                          <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs">
                            {run ? (
                              <Link className="text-accent hover:underline" href={`/v/${v.id}/runs/${run.id}`}>
                                Run
                              </Link>
                            ) : null}
                            {meta.transcript_document_id ? (
                              <>
                                <Link className="text-accent hover:underline" href={`/v/${v.id}/knowledge/${meta.transcript_document_id}`}>
                                  Transcript
                                </Link>
                                <Link className="text-accent hover:underline" href={`/v/${v.id}/tasks?document=${meta.transcript_document_id}&status=all`}>
                                  Tasks
                                </Link>
                                <Link className="text-accent hover:underline" href={`/v/${v.id}/tasks?kind=decision&document=${meta.transcript_document_id}`}>
                                  Decisions
                                </Link>
                              </>
                            ) : null}
                          </div>
                        </Td>
                      </Tr>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </QueryState>
        </Card>
        <Card className="order-1 h-fit xl:order-2">
          <CardHeader title="Add a meeting" />
          <form onSubmit={submit} noValidate className="space-y-4 p-4">
            <FormError message={up.isError ? errorMessage(up.error) : null} />
            <Recorder
              onRecorded={(f) => {
                setFiles([f]);
                if (!title) setTitle(`Meeting ${formatDateTime(new Date()).replace(" IST", "")}`);
              }}
            />
            <FileDrop files={files} onChange={setFiles} accept="audio/*,video/*,.m4a,.mp3,.wav,.webm,.ogg,.mp4" label="…or upload a recording" hint="Audio or video, up to 25 MB" />
            {errors.file ? <p className="text-xs text-danger">{errors.file}</p> : null}
            <Field label="Title" error={errors.title} required>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Weekly ops review" />
            </Field>
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium">Speaker names (optional)</legend>
              <p className="mb-2 text-xs text-subtle">Map diarised labels to people, e.g. SPEAKER_00 → Mayank.</p>
              <div className="space-y-2">
                {speakers.map((s, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      aria-label={`Speaker label ${i + 1}`}
                      value={s.label}
                      placeholder={`SPEAKER_0${i}`}
                      onChange={(e) => setSpeakers((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      className="font-mono text-[13px]"
                    />
                    <Input
                      aria-label={`Speaker name ${i + 1}`}
                      value={s.name}
                      placeholder="Name"
                      onChange={(e) => setSpeakers((xs) => xs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <Button variant="ghost" size="icon" aria-label="Remove speaker" onClick={() => setSpeakers((xs) => xs.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setSpeakers((xs) => [...xs, { label: `SPEAKER_0${xs.length}`, name: "" }])}>
                  Add speaker
                </Button>
              </div>
            </fieldset>
            <Checkbox label="Sensitive" hint="Transcribe and digest with local models only" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
            <Button type="submit" variant="primary" icon={<Upload className="h-4 w-4" />} loading={up.isPending} className="w-full">
              Upload & digest
            </Button>
            {up.data ? (
              <Notice tone="success">
                Digest started.{" "}
                <Link className="font-medium underline" href={`/v/${v.id}/runs/${up.data.run_id}`}>
                  Follow the run
                </Link>
              </Notice>
            ) : null}
          </form>
        </Card>
      </div>
    </>
  );
}
