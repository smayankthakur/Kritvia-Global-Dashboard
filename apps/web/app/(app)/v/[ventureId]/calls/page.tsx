"use client";

import { useQuery } from "@tanstack/react-query";
import { CallList, PlaceCall, TestCall, VoiceSettings, voiceKey } from "@/components/calls/calls";
import { Notice, PageHeader } from "@/components/ui/page";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { api, unwrap } from "@/lib/api";
import { useVenture } from "@/lib/venture";

export default function CallsPage() {
  const v = useVenture();
  const voice = useQuery({
    queryKey: voiceKey(v.id),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/voice", { params: { path: { venture_id: v.id } } })),
  });
  const canWrite = v.access === "write";
  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone calls"
        description="Kritvia answers your business number: it answers questions, takes messages and booking requests, and puts callers through. It can also phone your customers after your yes."
      />
      <QueryState query={voice} loading={<SkeletonRows rows={2} />}>
        {(s) => (
          <div className="space-y-6">
            {!s.plan_includes ? (
              <Notice tone="info" title="Comes with Growth">
                AI phone calls are part of the Growth, Scale and Enterprise plans. You can still try a test call here.
              </Notice>
            ) : s.answering ? (
              <Notice tone="success" title="Answering">
                Calls to {s.number?.number} are answered by Kritvia.
              </Notice>
            ) : (
              <Notice tone="info" title="Not answering calls yet">
                {s.number ? "Switch answering on below." : "Connect your Twilio number below, then switch answering on."}
              </Notice>
            )}
            {canWrite ? <TestCall ventureId={v.id} /> : null}
            <CallList ventureId={v.id} canAdmin={s.can_admin} />
            {canWrite ? <PlaceCall ventureId={v.id} live={s.outbound_enabled && s.answering} /> : null}
            {s.can_admin ? <VoiceSettings ventureId={v.id} voice={s} /> : null}
          </div>
        )}
      </QueryState>
    </div>
  );
}
