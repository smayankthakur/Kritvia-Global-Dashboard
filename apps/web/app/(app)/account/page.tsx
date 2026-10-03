"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice, PageHeader } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { meKey } from "@/lib/access";

export default function AccountPage() {
  const toast = useToast();
  const me = useQuery({ queryKey: meKey, queryFn: () => unwrap(api.GET("/auth/me")) });
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const exportData = useMutation({
    mutationFn: () => unwrap(api.GET("/auth/me/export")),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `kritvia-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.POST("/auth/me/delete", { body: { confirm: "DELETE" } })),
    onSuccess: async () => {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      window.location.assign("/login");
    },
    onError: (e) => {
      setConfirm(false);
      setErr(errorMessage(e));
    },
  });

  return (
    <>
      <PageHeader title="Your account" description={me.data ? `${me.data.full_name} · ${me.data.email}` : undefined} />
      <div className="grid max-w-3xl gap-4">
        <Card>
          <CardHeader title="Download your data" description="Your profile, memberships, voice settings, personal vocabulary and approval history, as a JSON file." />
          <div className="p-4">
            <Button icon={<Download className="h-4 w-4" />} loading={exportData.isPending} onClick={() => exportData.mutate()}>
              Download my data
            </Button>
            <p className="mt-2 text-xs text-subtle">A business&apos;s own records (documents, leads, loans) belong to that business; its owner can export them.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Delete your account" description="Signs you out everywhere, removes your access and personal data, and frees your email address." />
          <div className="space-y-3 p-4">
            {err ? <Notice tone="danger">{err}</Notice> : null}
            <p className="text-sm text-muted">
              If you own an organisation on your own, it is closed straight away and its business data is erased after 30 days. If other people work in it, make one
              of them an owner first.
            </p>
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm(true)}>
              Delete my account
            </Button>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete your account?"
        description="This cannot be undone."
        typeToConfirm="DELETE"
        confirmLabel="Delete account"
      />
    </>
  );
}
