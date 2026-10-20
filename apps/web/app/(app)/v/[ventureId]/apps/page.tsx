"use client";

import { AppStore } from "@/components/apps/app-store";
import { PageHeader } from "@/components/ui/page";
import { useVenture } from "@/lib/venture";

export default function AppsPage() {
  const v = useVenture();
  return (
    <div className="space-y-6">
      <PageHeader
        title="App store"
        description="Give the assistant more apps: any MCP server, the official MCP Registry, a GitHub project, or any web app with an API. Once connected, one request can use them all."
      />
      <AppStore ventureId={v.id} canAdmin={Boolean(v.can_admin || v.is_owner)} />
    </div>
  );
}
