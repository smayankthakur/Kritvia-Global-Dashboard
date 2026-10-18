"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Star, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { useAccess } from "@/lib/access";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { initials, TEAM_COLOR, TEAM_COLORS, type TeamColor } from "@/lib/collab";
import { titleCase } from "@/lib/format";

type Team = Schemas["TeamOut"];
type Person = Schemas["TeamPerson"];

function Editor({
  orgId,
  team,
  people,
  open,
  onClose,
}: {
  orgId: string;
  team: Team | null;
  people: Person[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [color, setColor] = useState<TeamColor>(team?.color ?? "blue");
  const [members, setMembers] = useState<Record<string, boolean>>(
    Object.fromEntries((team?.members ?? []).map((m) => [m.user_id, m.is_lead])),
  );
  const [filter, setFilter] = useState("");
  const body = {
    name: name.trim(),
    description: description.trim() || null,
    color,
    members: Object.entries(members).map(([user_id, is_lead]) => ({ user_id, is_lead })),
  };
  const save = useMutation({
    mutationFn: () =>
      team
        ? unwrap(api.PUT("/orgs/{org_id}/teams/{team_id}", { params: { path: { org_id: orgId, team_id: team.id } }, body }))
        : unwrap(api.POST("/orgs/{org_id}/teams", { params: { path: { org_id: orgId } }, body })),
    onSuccess: (t) => {
      toast.success(team ? "Team saved" : `Team “${t.name}” created`);
      void qc.invalidateQueries({ queryKey: ["teams", orgId] });
      void qc.invalidateQueries({ queryKey: ["venture-teams"] });
      void qc.invalidateQueries({ queryKey: ["collab"] });
      onClose();
    },
  });
  const shown = people.filter((p) => `${p.full_name} ${p.email}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (id: string) =>
    setMembers((m) => {
      const n = { ...m };
      if (id in n) delete n[id];
      else n[id] = false;
      return n;
    });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={team ? `Edit ${team.name}` : "New team"}
      description="A group of people who work together, across your businesses. Project boards can belong to a team."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {team ? "Save team" : "Create team"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Team name" required>
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Platform, Sales, Design…" autoFocus />
        </Field>
        <Field label="What the team does">
          <Textarea rows={2} value={description} maxLength={280} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Colour on the mind map</legend>
          <div className="flex flex-wrap gap-2">
            {TEAM_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={color === c}
                aria-label={titleCase(c)}
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-[var(--surface)] ${color === c ? "ring-2 ring-fg" : ""}`}
                style={{ background: TEAM_COLOR[c] }}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">
            Members <span className="font-normal text-subtle">({Object.keys(members).length})</span>
          </legend>
          {people.length > 8 ? (
            <Input aria-label="Find a person" placeholder="Find a person…" className="mb-2" value={filter} onChange={(e) => setFilter(e.target.value)} />
          ) : null}
          <ul className="max-h-64 space-y-1 overflow-auto">
            {shown.map((p) => {
              const inTeam = p.user_id in members;
              return (
                <li key={p.user_id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    id={`m-${p.user_id}`}
                    className="accent-[var(--accent)]"
                    checked={inTeam}
                    onChange={() => toggle(p.user_id)}
                  />
                  <label htmlFor={`m-${p.user_id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-sm">{p.full_name || p.email}</span>
                    <span className="block truncate text-xs text-subtle">{p.email}</span>
                  </label>
                  {inTeam ? (
                    <button
                      type="button"
                      aria-pressed={members[p.user_id]}
                      aria-label={`${p.full_name || p.email} leads the team`}
                      onClick={() => setMembers((m) => ({ ...m, [p.user_id]: !m[p.user_id] }))}
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${members[p.user_id] ? "border-accent text-accent" : "border-border text-subtle"}`}
                    >
                      <Star className="h-3 w-3" aria-hidden /> Lead
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </fieldset>
        <FormError message={save.isError ? errorMessage(save.error) : null} />
      </div>
    </Dialog>
  );
}

export default function TeamsPage() {
  const { org, venture } = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const [removing, setRemoving] = useState<Team | null>(null);
  const q = useQuery({
    queryKey: ["teams", org?.id],
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/teams", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org),
  });
  const remove = useMutation({
    mutationFn: (t: Team) => unwrap(api.DELETE("/orgs/{org_id}/teams/{team_id}", { params: { path: { org_id: org!.id, team_id: t.id } } })),
    onSuccess: () => {
      toast.success("Team deleted");
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ["teams", org?.id] });
      void qc.invalidateQueries({ queryKey: ["venture-teams"] });
    },
    onError: (e) => toast.error("Could not delete the team", errorMessage(e)),
  });
  const canEdit = q.data?.can_edit ?? false;
  return (
    <>
      <PageHeader
        eyebrow={org?.name}
        title="Teams"
        description="Group your people into teams. Project boards can belong to a team, and the mind map's People & projects view shows who works with whom, in and across teams."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" aria-hidden /> New team
            </Button>
          ) : undefined
        }
      />
      <QueryState query={q} loading={<SkeletonRows rows={4} />}>
        {(d) => (
          <div className="space-y-4">
            {!d.can_edit ? <Notice tone="info">Only your organisation&apos;s owners create and change teams.</Notice> : null}
            {!d.teams.length ? (
              <Card>
                <EmptyState
                  icon={Users}
                  title="No teams yet"
                  description="Make teams like Sales, Design or Platform and add people to them. Then put project boards in a team from the board's settings."
                  action={
                    d.can_edit ? (
                      <Button variant="primary" onClick={() => setEditing("new")}>
                        Create the first team
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {d.teams.map((t) => (
                  <Card key={t.id} className="flex flex-col p-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full" style={{ background: TEAM_COLOR[t.color] }} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate font-semibold">{t.name}</h2>
                        {t.description ? <p className="mt-0.5 text-sm text-muted">{t.description}</p> : null}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {t.members.length ? (
                        t.members.map((m) => (
                          <Badge key={m.user_id} tone={m.is_lead ? "accent" : "neutral"} className="gap-1.5">
                            <span
                              className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                              style={{ background: TEAM_COLOR[t.color] }}
                              aria-hidden
                            >
                              {initials(m.full_name || m.email)}
                            </span>
                            {m.full_name || m.email}
                            {m.is_lead ? " · lead" : ""}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-sm text-subtle">No members yet</span>
                      )}
                    </div>
                    <p className="mt-3 text-xs text-subtle">
                      {t.members.length} member{t.members.length === 1 ? "" : "s"} · {t.boards} project board{t.boards === 1 ? "" : "s"}
                    </p>
                    {d.can_edit ? (
                      <div className="mt-auto flex gap-2 pt-3">
                        <Button size="sm" onClick={() => setEditing(t)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setRemoving(t)}>
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </Card>
                ))}
              </div>
            )}
            {venture ? (
              <p className="text-sm text-subtle">
                See how they work together:{" "}
                <Link href={`/v/${venture.venture_id}/map?view=people`} className="text-accent hover:underline">
                  {venture.venture_name} → Mind map → People &amp; projects
                </Link>
              </p>
            ) : null}
            {editing ? (
              <Editor
                key={editing === "new" ? "new" : editing.id}
                orgId={org!.id}
                team={editing === "new" ? null : editing}
                people={d.people}
                open
                onClose={() => setEditing(null)}
              />
            ) : null}
            <ConfirmDialog
              open={!!removing}
              onClose={() => setRemoving(null)}
              onConfirm={() => removing && remove.mutate(removing)}
              loading={remove.isPending}
              title={`Delete ${removing?.name ?? "team"}?`}
              description="The people and their work stay; project boards in this team just won't have a team."
              confirmLabel="Delete team"
            />
          </div>
        )}
      </QueryState>
    </>
  );
}
