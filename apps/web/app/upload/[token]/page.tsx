"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Lock, ShieldCheck } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileDrop } from "@/components/ui/file-drop";
import { Notice } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const ALLOWED = /\.(pdf|jpe?g|png|webp)$/i;
const MAX_FILES = 10;
const MAX_MB = 25;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <p className="text-lg font-semibold tracking-tight">Truhome Finance</p>
          <p className="text-sm text-muted">Secure document upload</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">{children}</div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-subtle">
          <Lock className="h-3.5 w-3.5" aria-hidden /> Files are encrypted and seen only by your loan officer.
        </p>
        <p className="mt-3 text-center text-xs leading-relaxed text-subtle">
          Privacy notice: Truhome Finance collects these documents only to verify your loan application, and is responsible for
          them under India&apos;s Digital Personal Data Protection Act, 2023. They are stored and processed in India by its software
          provider, Kritvia, and are not used for any other purpose. To see, correct or delete your data, or withdraw consent, contact
          your loan officer.
        </p>
      </div>
    </main>
  );
}

export default function PublicUploadPage() {
  const { token } = useParams<{ token: string }>();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ["public-upload", token],
    queryFn: () => unwrap(api.GET("/public/upload/{token}", { params: { path: { token } } })),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const up = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/public/upload/{token}", {
          params: { path: { token } },
          body: multipart<Schemas["Body_public_upload_public_upload__token__post"]>({ files }),
        }),
      ),
  });

  const submit = () => {
    const bad = files.filter((f) => !ALLOWED.test(f.name));
    if (!files.length) return setError("Choose at least one file");
    if (files.length > MAX_FILES) return setError(`You can upload up to ${MAX_FILES} files at a time`);
    if (bad.length) return setError(`Only PDF, JPG and PNG files are accepted: ${bad.map((f) => f.name).join(", ")}`);
    const big = files.filter((f) => f.size > MAX_MB * 1024 * 1024);
    if (big.length) return setError(`Files must be under ${MAX_MB} MB: ${big.map((f) => f.name).join(", ")}`);
    setError(null);
    up.mutate();
  };

  if (info.isPending)
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-subtle">
          <Spinner /> Checking your link…
        </div>
        <Skeleton className="mt-4 h-24" />
      </Shell>
    );

  if (info.isError) {
    const expired = info.error instanceof ApiError && info.error.status === 404;
    return (
      <Shell>
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-subtle">
            <Clock className="h-5 w-5" aria-hidden />
          </div>
          <h1 className="text-base font-semibold">{expired ? "This link has expired" : "We couldn't open this link"}</h1>
          <p className="mt-1 text-sm text-muted">
            {expired
              ? "Upload links are valid for a limited time. Please ask your Truhome loan officer to send you a new one."
              : errorMessage(info.error)}
          </p>
        </div>
      </Shell>
    );
  }

  if (up.data) {
    return (
      <Shell>
        <div className="flex flex-col items-center text-center" role="status">
          <CheckCircle2 className="mb-3 h-10 w-10 text-success" aria-hidden />
          <h1 className="text-base font-semibold">Thank you — {up.data.uploaded} file(s) received</h1>
          <p className="mt-1 text-sm text-muted">Your loan officer will review them and contact you if anything else is needed.</p>
          {up.data.warnings.length ? (
            <Notice tone="warning" className="mt-4 w-full text-left" title="Some files could not be read">
              <ul className="list-disc pl-4">
                {up.data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <Button className="mt-5" onClick={() => up.reset()}>
            Upload more
          </Button>
        </div>
      </Shell>
    );
  }

  const d = info.data;
  return (
    <Shell>
      <h1 className="text-base font-semibold">Upload documents</h1>
      <p className="mt-1 text-sm text-muted">
        Application <span className="font-mono font-medium text-fg">{d.reference}</span>
      </p>
      {d.needed.length ? (
        <div className="mt-4 rounded-md bg-surface-2 p-3">
          <p className="text-sm font-medium">Still needed</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {d.needed.map((n) => (
              <li key={n} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">Upload the documents your loan officer asked for.</p>
      )}
      <div className="mt-5 space-y-3">
        {error || up.isError ? <Notice tone="danger">{error ?? errorMessage(up.error)}</Notice> : null}
        <FileDrop
          files={files}
          onChange={setFiles}
          multiple
          maxFiles={MAX_FILES}
          accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png"
          label="Choose PDF, JPG or PNG files"
          hint={`Drag and drop, or tap to browse · up to ${MAX_FILES} files`}
        />
        <Button variant="primary" className="w-full" loading={up.isPending} disabled={!files.length} onClick={submit} icon={<ShieldCheck className="h-4 w-4" />}>
          Upload securely
        </Button>
        <p className="text-center text-xs text-subtle">This link expires {formatDateTime(d.expires_at)}.</p>
      </div>
    </Shell>
  );
}
