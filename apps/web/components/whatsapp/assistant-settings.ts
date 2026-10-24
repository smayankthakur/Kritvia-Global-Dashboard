"use client";

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "@/lib/api";

type Config = Schemas["WorkflowConfigOut"];

/**
 * The inbox assistant's settings as the Chats-page switches change them. Each change sends only the setting
 * that changed (the API merges it), and `saving` is true while any of these switches is saving, so two
 * quick flips can't undo each other (round 3, B11).
 */
export function useAssistantSettings(ventureId: string) {
  const qc = useQueryClient();
  const configKey = ["workflow-configs", ventureId];
  const mutationKey = ["inbox-assistant-settings", ventureId];
  const configs = useQuery({
    queryKey: configKey,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: ventureId } } })),
  });
  const cfg = configs.data?.find((c) => c.workflow === "inbox_assistant");
  const settings = (cfg?.settings ?? {}) as Record<string, unknown>;
  const saving = useIsMutating({ mutationKey }) > 0;
  const save = useMutation({
    mutationKey,
    mutationFn: (patch: Record<string, unknown>) =>
      unwrap(
        api.PATCH("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: "inbox_assistant" } },
          body: { settings: patch },
        }),
      ),
    onSuccess: (out) => {
      qc.setQueryData<Config[]>(configKey, (list) => [...(list ?? []).filter((c) => c.workflow !== out.workflow), out]);
      void qc.invalidateQueries({ queryKey: configKey });
    },
  });
  return { cfg, settings, saving, save };
}
