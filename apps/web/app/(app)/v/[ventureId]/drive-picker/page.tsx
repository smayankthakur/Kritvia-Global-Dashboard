"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderDown } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Notice, PageHeader } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { api, errorMessage, unwrap } from "@/lib/api";
import { pickDriveFiles } from "@/lib/google-picker";
import { useVenture } from "@/lib/venture";

/** The one page allowed to run Google's file picker (its CSP lists Google's hosts; see lib/csp.ts).
 * Opened with a full page load from Settings → Connectors so the browser applies that policy. */
export default function DrivePickerPage() {
  const v = useVenture();
  const cfg = useQuery({
    queryKey: ["drive-picker", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors/google/picker", { params: { path: { venture_id: v.id } } })),
  });
  const pick = useMutation({
    mutationFn: async () => {
      const ids = await pickDriveFiles(cfg.data!);
      if (!ids.length) return null;
      return unwrap(api.POST("/ventures/{venture_id}/connectors/google/drive-picked", { params: { path: { venture_id: v.id } }, body: { file_ids: ids } }));
    },
  });
  const back = `/v/${v.id}/settings?tab=connectors`;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader eyebrow={v.venture_name} title="Choose files from Google Drive" description="Only the files you choose are shared with Kritvia and added to business memory. Kritvia can't see the rest of your Drive." />
      {cfg.isPending ? <SkeletonRows rows={3} /> : null}
      {cfg.isError ? <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} /> : null}
      {cfg.data && !cfg.data.ready ? (
        <Notice tone="warning">Google Drive isn&apos;t ready for this business. Reconnect Google in Settings → Connectors, or ask the server admin to set up the Google picker.</Notice>
      ) : null}
      {cfg.data?.ready ? (
        <Card>
          <CardHeader title="Google Drive" description={cfg.data.account_email ? `Signed in as ${cfg.data.account_email}` : undefined} />
          <div className="space-y-3 p-4">
            {pick.isError ? <Notice tone="danger">{errorMessage(pick.error)}</Notice> : null}
            {pick.data ? (
              <Notice tone="success">
                {pick.data.imported} file{pick.data.imported === 1 ? "" : "s"} added to business memory{pick.data.skipped ? `, ${pick.data.skipped} already there` : ""}.
              </Notice>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<FolderDown className="h-4 w-4" />} loading={pick.isPending} disabled={!(v.can_admin || v.is_owner)} onClick={() => pick.mutate()}>
                Choose files
              </Button>
              <Link href={back} className="inline-flex items-center px-3 text-sm text-accent hover:underline">
                Back to connectors
              </Link>
            </div>
            <p className="text-xs text-subtle">Google&apos;s own window opens on this page. Documents, sheets, PDFs and text files work best.</p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
