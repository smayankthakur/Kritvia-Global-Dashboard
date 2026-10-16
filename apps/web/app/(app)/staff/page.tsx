"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge, type Tone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

const HEALTH: Record<string, [Tone, string]> = {
  won: ["success", "first win"],
  getting_started: ["info", "getting started"],
  stuck: ["danger", "stuck"],
  quiet: ["warning", "gone quiet"],
};

/** Kritvia's team: every organisation's progress to its first approved draft. */
export default function StaffPage() {
  const q = useQuery({ queryKey: ["staff", "pilots"], queryFn: () => unwrap(api.GET("/staff/pilots")), refetchInterval: 60_000 });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pilot health"
        description="Every organisation's steps to a first approved draft, and whether it's still in use. Counts only: no customer data."
      />
      <QueryState query={q} loading={<SkeletonRows rows={6} />}>
        {(d: Schemas["PilotsOut"]) => (
          <>
            <Card className="p-4">
              <StatGrid>
                <Stat label="Organisations" value={String(d.pilots.length)} />
                <Stat label="Had a first win" value={String(d.won)} tone="success" />
                <Stat label="Stuck (2+ days, no yes)" value={String(d.stuck)} tone={d.stuck ? "danger" : undefined} />
                <Stat label="Drafts this week" value={String(d.pilots.reduce((a, p) => a + p.drafts_7d, 0))} />
              </StatGrid>
            </Card>
            <Card className="overflow-x-auto p-0">
              <Table label="Organisations">
                <THead>
                  <Tr>
                    <Th>Organisation</Th>
                    <Th>Plan</Th>
                    <Th>Steps</Th>
                    <Th>First yes</Th>
                    <Th>This week</Th>
                    <Th>Last active</Th>
                    <Th>Health</Th>
                  </Tr>
                </THead>
                <TBody>
                  {d.pilots.map((p) => {
                    const [tone, label] = HEALTH[p.health] ?? ["neutral", p.health];
                    return (
                      <Tr key={p.org_id}>
                        <Td>
                          <p className="font-medium">{p.org_name}</p>
                          <p className="text-xs text-muted">
                            {p.owner_email ?? "—"} · {p.businesses} business{p.businesses === 1 ? "" : "es"} · {p.members} people · joined{" "}
                            {formatRelative(p.created_at)}
                          </p>
                        </Td>
                        <Td>{p.plan ?? "trial"}</Td>
                        <Td className="tabular-nums">{p.steps_done}/6</Td>
                        <Td>{p.hours_to_first_yes !== null && p.hours_to_first_yes !== undefined ? `${p.hours_to_first_yes} h` : "—"}</Td>
                        <Td className="tabular-nums">
                          {p.drafts_7d} drafts · {p.decided_7d} decided
                        </Td>
                        <Td>{p.last_active_at ? formatRelative(p.last_active_at) : "—"}</Td>
                        <Td>
                          <Badge tone={tone} dot>
                            {label}
                          </Badge>
                        </Td>
                      </Tr>
                    );
                  })}
                </TBody>
              </Table>
            </Card>
          </>
        )}
      </QueryState>
    </div>
  );
}
