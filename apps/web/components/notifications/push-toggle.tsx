"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { currentSubscription, pushSupported, subscribeBrowser, unsubscribeBrowser } from "@/lib/pwa";

const key = ["me", "push"] as const;

/** "Tell me on this device when a draft needs my yes." */
export function PushToggle() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/me/push")) });
  const [here, setHere] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    setSupported(pushSupported());
    void currentSubscription().then(setHere);
  }, []);
  const turnOn = useMutation({
    mutationFn: async () => {
      const sub = await subscribeBrowser(q.data?.public_key ?? "");
      await unwrap(api.POST("/me/push", { body: { ...sub, user_agent: navigator.userAgent.slice(0, 300) } }));
      return sub.endpoint;
    },
    onSuccess: (endpoint) => {
      setHere(endpoint);
      void qc.invalidateQueries({ queryKey: key });
      toast.success("Notifications on", "You'll hear when a draft needs your yes.");
    },
    onError: (e) => toast.error("Could not turn notifications on", errorMessage(e)),
  });
  const turnOff = useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeBrowser();
      if (endpoint) await unwrap(api.POST("/me/push/unsubscribe", { body: { endpoint } }));
    },
    onSuccess: () => {
      setHere(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Could not turn notifications off", errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => unwrap(api.POST("/me/push/test")),
    onSuccess: (r) => toast.success("Test sent", `${r.sent} of ${r.browsers} device(s) reached.`),
    onError: (e) => toast.error("Test failed", errorMessage(e)),
  });
  const enabled = q.data?.enabled ?? false;
  const on = Boolean(here);
  return (
    <Card>
      <CardHeader
        title="Notifications"
        description="A push on this phone or laptop the moment an agent has a draft for you — even with Kritvia closed."
        actions={
          on ? (
            <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate()} icon={<BellRing className="h-3.5 w-3.5" />}>
              Send a test
            </Button>
          ) : null
        }
      />
      <CardBody className="flex items-center justify-between gap-4">
        <div className="text-sm">
          <p className="font-medium text-fg">Tell me on this device</p>
          <p className="text-xs text-subtle">
            {!supported
              ? "This browser cannot show notifications. On iPhone, add Kritvia to the Home Screen first."
              : !enabled
                ? "Not set up on this server yet."
                : on
                  ? "On for this device."
                  : `${q.data?.subscribed ?? 0} other device(s) subscribed.`}
          </p>
        </div>
        <Switch
          checked={on}
          disabled={!supported || !enabled || turnOn.isPending || turnOff.isPending}
          onChange={(v) => (v ? turnOn.mutate() : turnOff.mutate())}
          label="Notifications on this device"
        />
      </CardBody>
    </Card>
  );
}
